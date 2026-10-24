// Codex: the marketplace plugin in one CODEX_HOME, and trust for its hook.
// Codex runs a plugin hook only once `hooks.state."<key>".trusted_hash` in
// config.toml matches the hook's entry. Its TUI asks for that trust, but
// `codex app-server`, which T3 runs, never does. So the installer trusts the
// hook the way the TUI does, through the app-server, with the hash Codex
// reports, on every install and update, once its hooks file is the one
// tools/frozen-hooks.json pins. Only the hooks file is pinned, not the script
// its command runs. Codex's own trust covers the entry alone, and the script
// changes with each release, so the marketplace source check is what vouches
// for the script.
//
// Codex has no plugin scopes, so a project install enables the plugin in the
// project's .codex/config.toml, a layer Codex reads only for a project the
// home trusts.
import { spawn } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { hookDigest } from "../plugin.mjs";
import {
  check,
  codexSource,
  installHint,
  isPlainCopy,
  launch,
  MARKETPLACE,
  marketplaceCheck,
  neutralCwd,
  PLUGIN_ID,
  pluginIntact,
  runCli,
  updated,
  writeAtomic,
} from "./common.mjs";

const REQUEST_TIMEOUT = 60_000;

// A JSON-RPC client over `codex app-server` stdio.
export class AppServer {
  static async start(home) {
    const server = new AppServer(home);
    await server.request("initialize", { clientInfo: { name: "t3-pstack-installer", version: "1" } });
    server.proc.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    return server;
  }

  constructor(home) {
    const run = launch(home.bin, ["app-server"]);
    this.proc = spawn(run.file, run.args, {
      ...run.options,
      cwd: neutralCwd(),
      env: { ...process.env, CODEX_HOME: home.dir },
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.nextId = 0;
    this.pending = new Map();
    this.notifications = [];
    const failAll = (err) => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(err);
      }
      this.pending.clear();
    };
    this.proc.on("error", failAll);
    this.proc.stdin.on("error", failAll);
    this.proc.on("exit", (code) => failAll(new Error(`codex app-server exited with ${code}`)));
    let buffer = "";
    this.proc.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        let message;
        try {
          message = line ? JSON.parse(line) : {};
        } catch {
          // Not quoted: the line could hold anything the server printed.
          failAll(new Error("codex app-server printed a line that is not JSON-RPC"));
          this.close();
          return;
        }
        if (message.method) this.notifications.push(message);
        const waiter = this.pending.get(message.id);
        if (!waiter || message.method) continue;
        this.pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(`${waiter.method}: ${JSON.stringify(message.error)}`));
        else waiter.resolve(message.result);
      }
    });
  }

  request(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no reply from codex app-server in ${REQUEST_TIMEOUT / 1000}s`));
      }, REQUEST_TIMEOUT);
      this.pending.set(id, { resolve, reject, method, timer });
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  // On Windows the process may be cmd.exe running npm's shim, and killing it
  // leaves the server it started; closing stdin ends that server too.
  close() {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

async function withServer(home, use) {
  const server = await AppServer.start(home);
  try {
    return await use(server);
  } finally {
    server.close();
  }
}

// Codex keeps one cache directory per installed version and removes the old
// one when it installs another.
const cacheDir = (dir) => join(dir, "plugins/cache", MARKETPLACE, PLUGIN_ID.split("@")[0]);
function installedVersions(dir) {
  const cache = cacheDir(dir);
  return existsSync(cache) ? readdirSync(cache).filter((name) => !name.startsWith(".")) : [];
}

const marketplaceSources = (config) => (config.marketplaces?.[MARKETPLACE] ? [codexSource(config.marketplaces[MARKETPLACE])] : []);

// A project's .codex layers, which Codex reads out even while the project is
// not trusted yet, so a marketplace one names is seen before it loads.
const projectLayers = async (server, project) =>
  project ? (await server.request("config/read", { cwd: project.dir, includeLayers: true })).layers.filter((l) => l.name.type === "project") : [];
const allSources = (config, layers) => [config, ...layers.map((l) => l.config)].flatMap(marketplaceSources);

const listedPlugin = async (server, cwd) => {
  const { marketplaces = [] } = await server.request("plugin/list", cwd ? { cwds: [cwd] } : {});
  return marketplaces.flatMap((m) => m.plugins ?? []).find((p) => p.id === PLUGIN_ID);
};

// `sources` adds the project's marketplaces to the home's `homeSources`.
// `enabled` is as a session sees it: from the project when there is one.
// `homeEnabled` is the home's own setting, and `layer` the project's
// .codex/config.toml as Codex reads it, with `disabledReason` set while the
// project is not trusted.
async function pluginState(server, dir, skills, project) {
  const { config } = await server.request("config/read", {});
  const plugin = await listedPlugin(server);
  const versions = installedVersions(dir);
  const layers = await projectLayers(server, project);
  const state = {
    homeSources: marketplaceSources(config),
    sources: allSources(config, layers),
    installed: plugin?.installed === true,
    enabled: plugin?.enabled === true,
    homeEnabled: plugin?.enabled === true,
    versions,
    intact: versions.length === 1 && pluginIntact(join(cacheDir(dir), versions[0]), ".codex-plugin/plugin.json", skills),
  };
  if (project) {
    const folder = join(project.dir, ".codex");
    state.layer = layers.find((l) => l.name.dotCodexFolder === folder);
    // The layer says so when it exists; a trust the home gives a parent
    // directory, such as the repository's root, counts too.
    state.trusted = state.layer ? !state.layer.disabledReason : config.projects?.[project.dir]?.trust_level === "trusted";
    state.enabled = (await listedPlugin(server, project.dir))?.enabled === true;
  }
  return state;
}

async function pluginHooks(server, project) {
  const { data } = await server.request("hooks/list", project ? { cwds: [project.dir] } : {});
  return data.flatMap((entry) => entry.hooks).filter((hook) => hook.pluginId === PLUGIN_ID);
}

// Codex writes only the home's config, so the installer appends the plugin's
// table to a project's config.toml. A file that already names the plugin or
// has a `plugins` value, which an inline table cannot be extended from, is the
// user's to edit. `parsed` is the file as Codex read it.
const TABLE = `[plugins."${PLUGIN_ID}"]`;
export function enableInProjectConfig(path, parsed) {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (text.includes(PLUGIN_ID) || parsed?.plugins !== undefined) {
    throw new Error(`${path} already has a plugins entry; set \`enabled = true\` under ${TABLE} there`);
  }
  const gap = !text || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  mkdirSync(join(path, ".."), { recursive: true });
  writeAtomic(path, `${text}${gap}${TABLE}\nenabled = true\n`);
}

// A file's text, read once without following a symlink, or null when it is a
// symlink or not a regular file.
function readRegularFile(path) {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) return null;
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    return fstatSync(fd).isFile() ? readFileSync(fd, "utf8") : null;
  } finally {
    closeSync(fd);
  }
}

// The listed hook is an entry of the hooks file the Codex manifest names, read
// at the pinned digest. Codex hashes the file when it lists it, so the listed
// event, matcher, and command must be an entry of that text, with the plugin
// root for ${CLAUDE_PLUGIN_ROOT}, or the hash Codex reports is of other text.
function isPinned(hook, pin) {
  const unix = (path) => path.replaceAll("\\", "/");
  if (!unix(hook.sourcePath).endsWith(`/${pin.path}`)) return false;
  const text = readRegularFile(hook.sourcePath);
  if (text === null || hookDigest(text) !== pin.sha256) return false;
  const root = hook.sourcePath.slice(0, -pin.path.length - 1);
  const entries = Object.entries(JSON.parse(text).hooks).flatMap(([event, groups]) =>
    groups.flatMap((group) => group.hooks.map((entry) => ({ event, matcher: group.matcher ?? null, entry }))),
  );
  const expand = (line) => unix(line.replaceAll("${CLAUDE_PLUGIN_ROOT}", root));
  return entries.some(
    ({ event, matcher, entry }) =>
      event[0].toLowerCase() + event.slice(1) === hook.eventName &&
      matcher === hook.matcher &&
      [entry.command, entry.commandWindows].some((line) => line !== undefined && expand(line) === unix(hook.command)),
  );
}

// Why `codex plugin add` runs: a first install, an update, a cache with
// missing files, or a disabled plugin, since Codex has no enable command.
// Null when the home is already at `version`.
// A project install enables it in the project instead.
function codexStep(state, version, project) {
  if (!state.installed) return "install";
  if (state.versions.length && state.versions.join() !== version) return "update";
  if (!state.intact) return "repair";
  if (!state.enabled && !project) return "enable";
  return null;
}

export async function installCodex(home, { source, trusted, version, skills, codexHook, project }) {
  const steps = [];
  const plugin = (...args) => runCli(home.bin, ["plugin", ...args], { CODEX_HOME: home.dir });
  const state = () => withServer(home, (server) => pluginState(server, home.dir, skills, project));
  mkdirSync(home.dir, { recursive: true });
  let before = await state();
  // A project's marketplace of another source stops it before the home gains one.
  if (before.sources.length && !marketplaceCheck(before.sources, trusted).ok) return steps;
  if (!before.homeSources.length) {
    plugin("marketplace", "add", source.arg);
    steps.push(`added the ${MARKETPLACE} marketplace from ${source.arg}`);
    before = await state();
  }
  // Nothing installs from a marketplace of another source; doctor names it.
  if (!marketplaceCheck(before.sources, trusted).ok) return steps;
  const step = codexStep(before, version, project);
  if (step) {
    // A local marketplace is read in place; a Git one is a snapshot to refresh.
    if (step !== "enable" && !source.local) plugin("marketplace", "upgrade", MARKETPLACE);
    plugin("add", PLUGIN_ID);
    const after = installedVersions(home.dir).join(", ");
    steps.push(
      {
        install: `installed ${after}`,
        update: updated(before.versions.join(", "), after, version),
        repair: `reinstalled ${after}, whose files were missing`,
        enable: "enabled it",
      }[step],
    );
    // `codex plugin add` enables the plugin in the home; a project install
    // puts back the home's own setting.
    if (project && !before.homeEnabled) {
      await withServer(home, (server) => writeHome(server, "plugins", { [PLUGIN_ID]: { enabled: false } }));
      if (step === "install") steps.push("left it disabled outside the projects that enable it");
    }
  }
  if (project) steps.push(...(await enableInProject(home, project, before)));
  steps.push(...(await withServer(home, (server) => trustHooks(server, trusted, codexHook, project))));
  return steps;
}

const writeHome = (server, keyPath, value) => server.request("config/value/write", { keyPath, mergeStrategy: "upsert", value });

// Trusts the project in the home, then enables the plugin in its config.toml.
async function enableInProject(home, project, state) {
  const steps = [];
  if (!state.trusted) {
    await withServer(home, (server) => writeHome(server, "projects", { [project.dir]: { trust_level: "trusted" } }));
    steps.push(`trusted ${project.dir} in ${join(home.dir, "config.toml")}, so Codex reads its .codex/config.toml`);
  }
  if (state.layer?.config?.plugins?.[PLUGIN_ID]?.enabled !== true) {
    const path = join(project.dir, ".codex/config.toml");
    enableInProjectConfig(path, state.layer?.config);
    steps.push(`enabled it in ${path}`);
  }
  return steps;
}

// One app-server session checks the marketplace source, lists the hooks, and
// writes the trust. The write names the config version the source check read,
// so Codex refuses it when config.toml changed in between. A config write
// also makes Codex read the hooks files again, so the listing after it shows
// a hooks file that changed since the check, and then the trust is taken
// back. `upsert`: `replace` would drop the user's other trusted hooks. An
// entry from any other hooks file stays untrusted, and doctor names it.
async function trustHooks(server, trusted, pin, project) {
  const { config, layers } = await server.request("config/read", { includeLayers: true });
  if (!marketplaceCheck(allSources(config, await projectLayers(server, project)), trusted).ok) return [];
  const user = layers.find((layer) => layer.name.type === "user");
  const pending = (await pluginHooks(server, project)).filter(
    (h) => (h.trustStatus === "untrusted" || h.trustStatus === "modified") && isPinned(h, pin),
  );
  if (!pending.length) return [];
  await server.request("config/value/write", {
    keyPath: "hooks.state",
    mergeStrategy: "upsert",
    value: Object.fromEntries(pending.map((h) => [h.key, { trusted_hash: h.currentHash }])),
    expectedVersion: user.version,
  });
  const after = new Map((await pluginHooks(server, project)).map((h) => [h.key, h]));
  const now = (h) => after.get(h.key) ?? {};
  const same = (h) => now(h).command === h.command && now(h).currentHash === h.currentHash;
  const failed = pending.filter((h) => now(h).trustStatus !== "trusted" || !same(h));
  if (failed.length) {
    await server.request("config/value/write", { keyPath: "hooks.state", mergeStrategy: "replace", value: user.config.hooks?.state ?? null });
    const status = (h) => `${h.key} ${now(h).trustStatus ?? "unlisted"}${same(h) ? "" : " with another entry"}`;
    throw new Error(`Codex lists ${failed.map(status).join(", ")} after the trust write, so the installer took that trust back`);
  }
  return pending.map((h) => `trusted hook ${h.key} (was ${h.trustStatus})`);
}

// Why a project's sessions would not load the plugin, or null when they do.
function projectProblem(state, project) {
  const path = join(project.dir, ".codex/config.toml");
  if (state.layer?.config?.plugins?.[PLUGIN_ID]?.enabled !== true) return `not enabled in ${path}`;
  if (!state.trusted) return `${project.dir} is not a trusted project, so Codex ignores ${path}`;
  if (!state.enabled) return `${path} enables it, but a closer .codex/config.toml or a managed layer turns it off`;
  return null;
}

export async function doctorCodex(home, { version, skills, trusted, codexHook, project }) {
  const hint = installHint(project);
  return withServer(home, async (server) => {
    const state = await pluginState(server, home.dir, skills, project);
    const hooks = await pluginHooks(server, project);
    const listed = (await server.request("skills/list", { cwds: [project?.dir ?? neutralCwd()] })).data.flatMap((entry) => entry.skills);
    const plain = listed.filter((skill) => isPlainCopy(skill.name, skill.path, skills)).map((skill) => skill.path);
    const installed = state.versions.join(", ");
    const good = (h) => h.trustStatus === "trusted" && isPinned(h, codexHook);
    const problem = project && projectProblem(state, project);
    return [
      marketplaceCheck(
        state.sources,
        trusted,
        `remove it with \`CODEX_HOME=${home.dir} codex plugin marketplace remove ${MARKETPLACE}\``,
        hint,
      ),
      check(
        "installed",
        state.installed && installed === version && state.intact,
        !state.installed
          ? "not installed"
          : state.versions.length && installed !== version
            ? `${installed}, expected ${version}`
            : state.intact
              ? installed
              : `its files in ${join(cacheDir(home.dir), installed)} are missing`,
        hint,
      ),
      project
        ? check("enabled in the project", !problem, problem ?? `yes, in ${join(project.dir, ".codex/config.toml")}`, hint)
        : check("enabled", state.enabled, state.enabled ? "yes" : "no", hint),
      check(
        "session-start hook trusted",
        hooks.length > 0 && hooks.every(good),
        hooks.length
          ? hooks.map((h) => `${h.key} ${h.trustStatus}${isPinned(h, codexHook) ? "" : `, not from the ${codexHook.path} this release pins`}`).join("; ")
          : "no t3-pstack hook listed",
        hint,
      ),
      check(
        "no plain copies of plugin skills",
        plain.length === 0,
        plain.length ? plain.slice(0, 5).join(", ") + (plain.length > 5 ? ` and ${plain.length - 5} more` : "") : "none",
        "delete these copies, for example from ~/.agents/skills; the plugin ships the same skills",
      ),
    ];
  });
}
