// Claude Code: the marketplace plugin in one config home, at the requested scope.
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  check,
  claudeSource,
  installHint,
  isPlainCopy,
  MARKETPLACE,
  marketplaceCheck,
  PLUGIN_ID,
  pluginIntact,
  readJson,
  runCli,
  updated,
  writeAtomic,
} from "./common.mjs";

const readOr = (path, fallback) => (existsSync(path) ? readJson(path) : fallback);
const RECORDS = "plugins/installed_plugins.json";

// The settings file each scope writes: the home's own, or one in the project.
export const scopeSettings = (dir, project) =>
  !project
    ? join(dir, "settings.json")
    : join(project.dir, ".claude", project.scope === "local" ? "settings.local.json" : "settings.json");

const real = (path) => (existsSync(path) ? realpathSync(path) : path);

// `settings` is the scope's settings file, where the plugin is enabled and
// the marketplace's auto-update is turned on. `record` is the install that
// scope uses: the user-scope one, or the project's at its scope.
function read(dir, project) {
  const path = scopeSettings(dir, project);
  const settings = readOr(path, {});
  const known = readOr(join(dir, "plugins/known_marketplaces.json"), {});
  const records = readOr(join(dir, RECORDS), {}).plugins?.[PLUGIN_ID] ?? [];
  const user = records.find((r) => r.scope === "user");
  const record = project
    ? records.find((r) => r.scope === project.scope && r.projectPath && real(r.projectPath) === real(project.dir))
    : user;
  const own = settings.extraKnownMarketplaces?.[MARKETPLACE];
  // Claude Code merges every layer's declarations. A project install also
  // sees the home's own and the project's other settings file.
  const other = project && scopeSettings(dir, { ...project, scope: project.scope === "local" ? "project" : "local" });
  const others = project ? [join(dir, "settings.json"), other] : [];
  const declared = [own, ...others.map((file) => readOr(file, {}).extraKnownMarketplaces?.[MARKETPLACE])];
  return {
    path,
    settings,
    declaredHere: own !== undefined,
    // Each home fetches the marketplace itself, whatever the project declares.
    known: known[MARKETPLACE] !== undefined,
    marketplace: declared.find(Boolean) ?? known[MARKETPLACE],
    // The sources the settings declare and the one Claude Code last fetched.
    sources: [...declared, known[MARKETPLACE]].filter((m) => m?.source).map((m) => claudeSource(m.source)),
    record,
    user,
    stale: user ? records.filter((r) => isStale(r, user)) : [],
    enabled: settings.enabledPlugins?.[PLUGIN_ID] === true,
    // The project's local settings win over its shared ones.
    localOff:
      project?.scope === "project" &&
      readOr(scopeSettings(dir, { ...project, scope: "local" }), {}).enabledPlugins?.[PLUGIN_ID] === false,
  };
}

const isStale = (record, user) =>
  record.scope !== "user" && (record.version !== user.version || record.installPath !== user.installPath);

const intact = (state, skills) =>
  state.record !== undefined && pluginIntact(state.record.installPath, ".claude-plugin/plugin.json", skills);

// Third-party marketplaces default to no auto-update; the /plugin toggle
// writes this key, and Claude Code copies it into known_marketplaces.json at
// its next start. A directory source loads in place and has nothing to fetch.
const autoUpdates = (marketplace) => marketplace?.autoUpdate === true || marketplace?.source?.source === "directory";

export function installClaude(home, { source, trusted, version, skills, project }) {
  const steps = [];
  const scope = project?.scope ?? "user";
  // From the project, so `--scope project` and `--scope local` write its files.
  const plugin = (...args) => runCli(home.bin, ["plugin", ...args], { CLAUDE_CONFIG_DIR: home.dir }, project?.dir);
  const state = () => read(home.dir, project);
  mkdirSync(home.dir, { recursive: true });
  const before = state();
  // A project install declares the marketplace in the project's own settings
  // too, so that file names where its plugin comes from. Never beside a
  // marketplace of another source.
  if (!before.sources.length || (project && (!before.declaredHere || !before.known) && marketplaceCheck(before.sources, trusted).ok)) {
    plugin("marketplace", "add", ...(project ? ["--scope", scope] : []), source.arg);
    steps.push(`added the ${MARKETPLACE} marketplace from ${source.arg}${project ? ` to ${before.path}` : ""}`);
  }
  // Nothing installs from a marketplace of another source; doctor names it.
  let now = state();
  if (!marketplaceCheck(now.sources, trusted).ok) return steps;
  if (!now.record) {
    plugin("install", PLUGIN_ID, "--scope", scope);
    steps.push(`installed ${state().record?.version}${project ? ` at ${scope} scope` : ""}`);
  } else if (now.record.version !== version) {
    // `plugin update` reads the marketplace as last fetched.
    plugin("marketplace", "update", MARKETPLACE);
    plugin("update", PLUGIN_ID, "--scope", scope);
    steps.push(updated(now.record.version, state().record?.version, version));
  } else if (!intact(now, skills)) {
    plugin("install", PLUGIN_ID, "--scope", scope);
    steps.push(`reinstalled ${state().record?.version}, whose files were missing`);
  }
  if (!state().enabled) {
    plugin("enable", PLUGIN_ID, "--scope", scope);
    steps.push(project ? `enabled it in ${now.path}` : "enabled it");
  }
  now = state();
  if (now.marketplace && !autoUpdates(now.marketplace)) {
    const declared = now.settings.extraKnownMarketplaces?.[MARKETPLACE] ?? { source: now.marketplace.source };
    now.settings.extraKnownMarketplaces = {
      ...now.settings.extraKnownMarketplaces,
      [MARKETPLACE]: { ...declared, autoUpdate: true },
    };
    mkdirSync(dirname(now.path), { recursive: true });
    writeAtomic(now.path, JSON.stringify(now.settings, null, 2) + "\n");
    steps.push(project ? `turned on marketplace auto-update in ${now.path}` : "turned on marketplace auto-update");
  }
  // A project install keeps the project's own record as it is.
  if (!project) steps.push(...syncScopedRecords(home.dir));
  return steps;
}

// Claude Code reads ~/.claude/settings.json as the project settings of the
// home folder, so a session started there under another config home adds a
// project-scope record, and that record keeps the version it found.
// `claude plugin uninstall --scope project` would edit ~/.claude/settings.json,
// which belongs to the main home. So the record is brought to the user-scope
// install in place, after a backup.
export function syncScopedRecords(dir) {
  const path = join(dir, RECORDS);
  const { user, stale } = read(dir);
  if (!stale.length) return [];
  const backup = `${path}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
  copyFileSync(path, backup, constants.COPYFILE_EXCL);
  const data = readJson(path);
  const steps = [];
  for (const record of data.plugins[PLUGIN_ID].filter((r) => isStale(r, user))) {
    steps.push(`moved the ${record.scope}-scope record for ${record.projectPath} from ${record.version} to ${user.version}`);
    Object.assign(record, {
      installPath: user.installPath,
      version: user.version,
      gitCommitSha: user.gitCommitSha,
      lastUpdated: user.lastUpdated,
    });
  }
  writeAtomic(path, JSON.stringify(data, null, 2) + "\n");
  return [...steps, `backed up ${RECORDS} to ${backup}`];
}

export function doctorClaude(home, { version, skills, trusted, project }) {
  const state = read(home.dir, project);
  const hint = installHint(project);
  const installed = state.record?.version;
  const whole = intact(state, skills);
  const plain = [join(home.dir, "skills"), ...(project ? [join(project.dir, ".claude/skills")] : [])].flatMap((skillsDir) =>
    existsSync(skillsDir)
      ? readdirSync(skillsDir)
          .filter((name) => isPlainCopy(name, join(skillsDir, name, "SKILL.md"), skills))
          .map((name) => join(skillsDir, name))
      : [],
  );
  const where = project ? `, in ${state.path}` : "";
  return [
    marketplaceCheck(
      state.sources,
      trusted,
      `remove it with \`CLAUDE_CONFIG_DIR=${home.dir} claude plugin marketplace remove ${MARKETPLACE}\``,
      hint,
    ),
    check(
      "installed",
      installed === version && whole,
      !installed
        ? project
          ? `not installed at ${project.scope} scope for ${project.dir}`
          : "not installed"
        : installed !== version
          ? `${installed}, expected ${version}`
          : whole
            ? installed
            : `${installed}, but its files at ${state.record.installPath} are missing`,
      hint,
    ),
    state.localOff
      ? check("enabled", false, `${scopeSettings(home.dir, { ...project, scope: "local" })} turns it off`, `remove that entry, or ${installHint({ ...project, scope: "local" })}`)
      : check("enabled", state.enabled, `${state.enabled ? "yes" : "no"}${where}`, hint),
    check("marketplace auto-update", autoUpdates(state.marketplace), state.marketplace ? String(autoUpdates(state.marketplace)) : "no marketplace", hint),
    // A project install leaves other records alone, so only the global one checks them.
    ...(project
      ? []
      : [
          check(
            "other-scope records",
            state.stale.length === 0,
            state.stale.length ? state.stale.map((r) => `${r.scope} ${r.projectPath} at ${r.version}`).join("; ") : "none stale",
            hint,
          ),
        ]),
    check(
      "no plain copies of plugin skills",
      plain.length === 0,
      plain.length ? plain.join(", ") : "none",
      "delete these folders; the plugin ships the same skills",
    ),
  ];
}
