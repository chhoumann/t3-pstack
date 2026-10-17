// The installer end to end, with the real claude and codex CLIs, in a
// throwaway HOME that T3's settings file describes. Opt in with
// T3_PSTACK_E2E=1; it needs both CLIs and takes about a minute. This checkout
// is the marketplace source. The Codex probe turn has no credentials, so it
// fails at the model call, after the session-start hook has run.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { AppServer } from "../tools/install/codex.mjs";
import { resolveCli } from "../tools/install/common.mjs";
import { hookDigest } from "../tools/plugin.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const version = JSON.parse(readFileSync(join(repoRoot, "plugins/pstack/.claude-plugin/plugin.json"), "utf8")).version;
const ROUTING = "You have t3-pstack, pstack for T3 Code.";
const SHEET = "# budget: large (xhigh)\nbug-fix: inherit-parent\nsession hook: on\n";

let root;
let home;
const saved = {};
const ISOLATED = ["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "T3CODE_HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL"];

function sh(bin, args, env = {}) {
  const r = spawnSync(bin, args, { cwd: root, env: { ...process.env, ...env }, encoding: "utf8" });
  expect(r.status, `${bin} ${args.join(" ")}\n${r.stdout}\n${r.stderr}`).toBe(0);
  return r.stdout;
}

// `source` null runs with no --source, as a user does. `extra` adds flags.
function installer(command, source = repoRoot, extra = []) {
  const r = spawnSync("node", [join(repoRoot, "tools/install.mjs"), command, ...(source ? ["--source", source] : []), ...extra, "--json"], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  });
  return { status: r.status, report: JSON.parse(r.stdout) };
}

const row = (report, dir) => report.homes.find((h) => h.dir === join(home, dir));
const failing = (checks) => checks.filter((c) => !c.ok && !c.warn).map((c) => `${c.name}: ${c.detail}`);
const HOOK = "t3-pstack@t3-pstack:hooks/codex-hooks.json:session_start:0:0";

// The plugin as a marketplace of its own, outside this checkout.
function pluginCopy(dir) {
  for (const path of [".claude-plugin", ".agents", "plugins", "tools/frozen-hooks.json"]) {
    cpSync(join(repoRoot, path), join(dir, path), { recursive: true, filter: (src) => !src.includes("node_modules") });
  }
  return dir;
}
const edit = (path, from, to) => writeFileSync(path, readFileSync(path, "utf8").replace(from, to));

async function until(done, ms) {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await new Promise((r) => setTimeout(r, 200))) {
    if (done()) return true;
  }
  return false;
}

// A T3-shaped Codex session: thread/start, then one turn. SessionStart runs
// at the first turn, before the model call.
async function probe(codexHome, cwd = root) {
  const server = await AppServer.start({ dir: codexHome, bin: "codex" });
  try {
    const { thread } = await server.request("thread/start", { cwd, approvalPolicy: "never", sandbox: "read-only" });
    await server.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "ping" }] });
    expect(await until(() => server.notifications.some((m) => m.method === "turn/completed"), 90_000), "turn completed").toBe(true);
    const rollout = readFileSync(thread.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const developer = rollout
      .filter((item) => item.payload?.type === "message" && item.payload.role === "developer")
      .flatMap((item) => item.payload.content.map((part) => part.text ?? ""));
    return {
      hookEvents: server.notifications.filter((m) => m.method.startsWith("hook/")).map((m) => m.method),
      routedMessages: developer.filter((text) => text.includes(ROUTING)).length,
      rollout: thread.path,
    };
  } finally {
    server.close();
  }
}

// Every config file in every home, and the sheet, by content.
function snapshot() {
  const out = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!["cache", "marketplaces", ".tmp", "sessions", "log", "skills", "shell_snapshots"].includes(entry.name)) walk(path);
      } else if (/\.(json|toml|md)$/.test(entry.name)) {
        out[relative(home, path)] = entry.isSymbolicLink()
          ? `-> ${readlinkSync(path)}`
          : createHash("sha256").update(readFileSync(path)).digest("hex");
      }
    }
  };
  walk(home);
  return out;
}

const enabled = process.env.T3_PSTACK_E2E === "1";

// A fresh HOME per suite, with T3's settings listing `providerInstances`.
function isolate(providerInstances) {
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "t3-pstack-e2e-")));
    home = join(root, "home");
    for (const name of ISOLATED) saved[name] = process.env[name];
    for (const name of ISOLATED) delete process.env[name];
    Object.assign(process.env, { HOME: home, GIT_CONFIG_GLOBAL: "/dev/null" });
    mkdirSync(join(home, ".t3/userdata"), { recursive: true });
    writeFileSync(join(home, ".t3/userdata/settings.json"), JSON.stringify({ providerInstances }));
  });

  afterAll(() => {
    for (const name of ISOLATED) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    rmSync(root, { recursive: true, force: true });
  });
}

describe.skipIf(!enabled)("the installer, end to end", () => {
  isolate({
    claudeAgent: { driver: "claudeAgent", enabled: true, config: { binaryPath: "claude", homePath: "" } },
    claude_pool: { driver: "claudeAgent", enabled: true, config: { homePath: "~/.claude-pool" } },
    codex: { driver: "codex", enabled: true, config: { binaryPath: "codex", homePath: "" } },
    codex_work: { driver: "codex", enabled: false, config: { homePath: "~/.codex-work" } },
  });

  test("before: a hand-installed Codex home never runs the hook, and doctor says so", async () => {
    // The pre-installer README way, and the released per-home sheet.
    const codexHome = join(home, ".codex");
    mkdirSync(codexHome, { recursive: true });
    sh("codex", ["plugin", "marketplace", "add", repoRoot], { CODEX_HOME: codexHome });
    sh("codex", ["plugin", "add", "t3-pstack@t3-pstack"], { CODEX_HOME: codexHome });
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude/t3-pstack-models.md"), SHEET);
    symlinkSync(join(home, ".claude/t3-pstack-models.md"), join(codexHome, "t3-pstack-models.md"));

    // A second Claude home with a stale project-scope record for the home folder.
    const pool = join(home, ".claude-pool");
    mkdirSync(pool, { recursive: true });
    sh("claude", ["plugin", "marketplace", "add", repoRoot], { CLAUDE_CONFIG_DIR: pool });
    sh("claude", ["plugin", "install", "t3-pstack@t3-pstack", "--scope", "user"], { CLAUDE_CONFIG_DIR: pool });
    const recordsPath = join(pool, "plugins/installed_plugins.json");
    const records = JSON.parse(readFileSync(recordsPath, "utf8"));
    records.plugins["t3-pstack@t3-pstack"].push({
      scope: "project",
      projectPath: home,
      installPath: join(pool, "plugins/cache/t3-pstack/t3-pstack/1.0.11"),
      version: "1.0.11",
      installedAt: "2026-10-13T04:43:26.759Z",
      lastUpdated: "2026-10-13T04:43:26.759Z",
    });
    writeFileSync(recordsPath, JSON.stringify(records, null, 2) + "\n");

    const before = await probe(codexHome);
    console.log("before:", JSON.stringify(before));
    expect(before.hookEvents).toEqual([]);
    expect(before.routedMessages).toBe(0);

    const { status, report } = installer("doctor");
    expect(status).toBe(1);
    expect(failing(row(report, ".codex").checks)).toEqual([
      `session-start hook trusted: ${HOOK} untrusted`,
    ]);
    expect(failing(row(report, ".claude-pool").checks)).toEqual([
      `other-scope records: project ${home} at 1.0.11`,
    ]);
    expect(failing(row(report, ".codex-work").checks)).toEqual(["installed: the home does not exist"]);
    expect(failing(report.sheet.checks)).toEqual([
      `machine sheet: missing; ${join(home, ".claude/t3-pstack-models.md")}, ${join(home, ".codex/t3-pstack-models.md")} not moved yet`,
    ]);
  }, 300_000);

  test("install: every home converges, the hook is trusted, and its routing text reaches the rollout", async () => {
    const { status, report } = installer("install");
    console.log("install:", JSON.stringify(report.homes.map(({ dir, steps }) => ({ dir, steps })).concat(report.sheet.steps)));
    expect(failing([...report.homes.flatMap((h) => h.checks), ...report.sheet.checks])).toEqual([]);
    expect(status).toBe(0);
    expect(row(report, ".codex").steps).toEqual([
      `trusted hook ${HOOK} (was untrusted)`,
    ]);
    expect(row(report, ".codex-work").steps).toEqual([
      `added the t3-pstack marketplace from ${repoRoot.replace(/\/$/, "")}`,
      `installed ${version}`,
      `trusted hook ${HOOK} (was untrusted)`,
    ]);
    const pool = row(report, ".claude-pool").steps;
    expect(pool[0]).toBe(`moved the project-scope record for ${home} from 1.0.11 to ${version}`);
    expect(pool[1]).toStartWith("backed up plugins/installed_plugins.json to ");
    expect(report.sheet.steps).toEqual([
      `moved the sheet from ${join(home, ".claude/t3-pstack-models.md")}`,
      `linked ${join(home, ".claude/t3-pstack-models.md")} to it`,
      `linked ${join(home, ".claude-pool/t3-pstack-models.md")} to it`,
      `linked ${join(home, ".codex-work/t3-pstack-models.md")} to it`,
    ]);
    expect(readFileSync(join(home, ".config/t3-pstack/models.md"), "utf8")).toBe(SHEET);

    const after = await probe(join(home, ".codex"));
    console.log("after:", JSON.stringify(after));
    expect(after.hookEvents).toEqual(["hook/started", "hook/completed"]);
    expect(after.routedMessages).toBe(1);

    // Claude Code needs no trust; the same routing text arrives through its hook.
    const claude = spawnSync("claude", ["-p", "ping", "--output-format", "stream-json", "--verbose"], {
      cwd: root,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: join(home, ".claude-pool"),
        ANTHROPIC_API_KEY: "sk-ant-invalid",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
      },
      encoding: "utf8",
      timeout: 120_000,
    });
    const hookResponse = claude.stdout
      .split("\n")
      .filter((line) => line.includes('"hook_response"'))
      .map((line) => JSON.parse(line))
      .find((event) => event.hook_event === "SessionStart");
    expect(hookResponse?.output ?? hookResponse?.stdout ?? "", "Claude Code's SessionStart hook_response").toContain(ROUTING);
    console.log("claude:", JSON.stringify({ hook: hookResponse.hook_name, routed: true }));
  }, 300_000);

  test("a second install changes nothing, and doctor passes", () => {
    const before = snapshot();
    const { status, report } = installer("update");
    expect(status).toBe(0);
    expect([...report.homes.flatMap((h) => h.steps), ...report.sheet.steps]).toEqual([]);
    expect(snapshot()).toEqual(before);
    console.log(`rerun: ${Object.keys(before).length} config files unchanged`);
    expect(installer("doctor").status).toBe(0);
    expect(existsSync(join(home, ".codex-work/config.toml"))).toBe(true);
  }, 300_000);

  test("install reinstalls a plugin whose files are gone, and enables a disabled one", () => {
    const codexCache = join(home, ".codex/plugins/cache/t3-pstack/t3-pstack", version);
    rmSync(join(codexCache, "skills/how"), { recursive: true });
    const poolRecord = JSON.parse(readFileSync(join(home, ".claude-pool/plugins/installed_plugins.json"), "utf8")).plugins["t3-pstack@t3-pstack"][0];
    rmSync(poolRecord.installPath, { recursive: true });
    edit(join(home, ".codex-work/config.toml"), /(\[plugins\."t3-pstack@t3-pstack"\]\s*enabled = )true/, "$1false");

    const doctor = installer("doctor").report;
    expect(failing(row(doctor, ".codex").checks)).toEqual([`installed: its files in ${codexCache} are missing`]);
    expect(failing(row(doctor, ".claude-pool").checks)).toEqual([
      `installed: ${version}, but its files at ${poolRecord.installPath} are missing`,
    ]);
    expect(failing(row(doctor, ".codex-work").checks)).toEqual(["enabled: no", "session-start hook trusted: no t3-pstack hook listed"]);

    const { status, report } = installer("install");
    expect(row(report, ".codex").steps).toEqual([`reinstalled ${version}, whose files were missing`]);
    expect(row(report, ".claude-pool").steps).toEqual([`reinstalled ${version}, whose files were missing`]);
    expect(row(report, ".codex-work").steps).toEqual(["enabled it"]);
    expect(status).toBe(0);
  }, 300_000);

  test("doctor flags a plain copy of a plugin skill, not a user's own skill that shares a name", () => {
    mkdirSync(join(home, ".agents/skills/how"), { recursive: true });
    mkdirSync(join(home, ".agents/skills/why"), { recursive: true });
    writeFileSync(join(home, ".agents/skills/how/SKILL.md"), "---\nname: how\ndescription: My own notes on how things work.\n---\n");
    cpSync(join(repoRoot, "plugins/pstack/skills/why/SKILL.md"), join(home, ".agents/skills/why/SKILL.md"));
    const { status, report } = installer("doctor");
    expect(failing(row(report, ".codex").checks)).toEqual([`no plain copies of plugin skills: ${join(home, ".agents/skills/why/SKILL.md")}`]);
    expect(status).toBe(1);
    rmSync(join(home, ".agents/skills/why"), { recursive: true });
    expect(installer("doctor").status).toBe(0);
  }, 300_000);
});

describe.skipIf(!enabled)("the installer, on a t3-pstack marketplace from another source", () => {
  isolate({
    claudeAgent: { driver: "claudeAgent", enabled: true, config: { binaryPath: "claude", homePath: "" } },
    codex: { driver: "codex", enabled: true, config: { binaryPath: "codex", homePath: "" } },
    codex_dev: { driver: "codex", enabled: true, config: { homePath: "~/.codex-dev" } },
  });

  test("installs nothing from it, trusts none of its hooks, and doctor names the source", async () => {
    // A marketplace that calls itself t3-pstack, with a hook that leaves a mark.
    const counterfeit = pluginCopy(join(root, "counterfeit"));
    const marked = join(root, "hook-ran");
    edit(join(counterfeit, "plugins/pstack/hooks/codex-hooks.json"), /"command": "[^\n]*",\n/, `"command": "touch ${marked}",\n`);
    for (const [bin, dir, variable] of [["codex", ".codex", "CODEX_HOME"], ["claude", ".claude", "CLAUDE_CONFIG_DIR"]]) {
      mkdirSync(join(home, dir), { recursive: true });
      sh(bin, ["plugin", "marketplace", "add", counterfeit], { [variable]: join(home, dir) });
    }
    sh("codex", ["plugin", "add", "t3-pstack@t3-pstack"], { CODEX_HOME: join(home, ".codex") });

    const { status, report } = installer("install");
    expect(status).toBe(1);
    expect(row(report, ".codex").steps).toEqual([]);
    expect(row(report, ".claude").steps).toEqual([]);
    const foreign = `marketplace: ${counterfeit}, which is neither chhoumann/t3-pstack nor --source`;
    expect(failing(row(report, ".codex").checks)).toEqual([
      foreign,
      `session-start hook trusted: ${HOOK} untrusted, not from the hooks/codex-hooks.json this release pins`,
    ]);
    expect(failing(row(report, ".claude").checks)).toEqual([foreign, "installed: not installed", "enabled: no"]);
    expect(row(report, ".codex-dev").steps).toEqual([
      `added the t3-pstack marketplace from ${repoRoot.replace(/\/$/, "")}`,
      `installed ${version}`,
      `trusted hook ${HOOK} (was untrusted)`,
    ]);

    const after = await probe(join(home, ".codex"));
    expect(after.hookEvents).toEqual([]);
    expect(existsSync(marked)).toBe(false);
  }, 300_000);

  test("a later run without that --source reuses none of its marketplaces", () => {
    const before = snapshot();
    const { status, report } = installer("install", null);
    expect(status).toBe(1);
    expect(report.homes.flatMap((h) => h.steps)).toEqual([]);
    expect(failing(row(report, ".codex-dev").checks)).toEqual([
      `marketplace: ${repoRoot.replace(/\/$/, "")}, which is neither chhoumann/t3-pstack nor --source`,
    ]);
    expect(snapshot()).toEqual(before);
  }, 300_000);
});

describe.skipIf(!enabled)("the installer, on a release that changes the hook entry", () => {
  isolate({});

  test("updates both homes, and trusts the changed hook once the release pins it", async () => {
    const source = pluginCopy(join(root, "source"));
    expect(installer("install", source).status).toBe(0);

    const next = "9.9.9";
    for (const file of [".claude-plugin/marketplace.json", "plugins/pstack/.claude-plugin/plugin.json", "plugins/pstack/.codex-plugin/plugin.json"]) {
      const path = join(source, file);
      writeFileSync(path, readFileSync(path, "utf8").replace(`"version": "${version}"`, `"version": "${next}"`));
    }
    const hooks = join(source, "plugins/pstack/hooks/codex-hooks.json");
    edit(hooks, "startup|resume|clear|compact", "startup|resume|compact|clear");

    const unpinned = installer("update", source);
    expect(unpinned.status).toBe(1);
    expect(row(unpinned.report, ".claude").steps).toEqual([`updated ${version} to ${next}`]);
    expect(row(unpinned.report, ".codex").steps).toEqual([`updated ${version} to ${next}`]);
    expect(failing(row(unpinned.report, ".codex").checks)).toEqual([
      `session-start hook trusted: ${HOOK} modified, not from the hooks/codex-hooks.json this release pins`,
    ]);

    const pins = join(source, "tools/frozen-hooks.json");
    const pinned = JSON.parse(readFileSync(pins, "utf8"));
    pinned["plugins/pstack/hooks/codex-hooks.json"] = { sha256: hookDigest(readFileSync(hooks, "utf8")), changedIn: next };
    writeFileSync(pins, JSON.stringify(pinned, null, 2) + "\n");
    const { status, report } = installer("update", source);
    console.log("release:", JSON.stringify(report.homes.map(({ dir, steps }) => ({ dir: relative(home, dir), steps }))));
    expect(failing([...report.homes.flatMap((h) => h.checks), ...report.sheet.checks])).toEqual([]);
    expect(status).toBe(0);
    expect(row(report, ".claude").steps).toEqual([]);
    expect(row(report, ".codex").steps).toEqual([`trusted hook ${HOOK} (was modified)`]);
    const after = await probe(join(home, ".codex"));
    expect(after.hookEvents).toEqual(["hook/started", "hook/completed"]);
    expect(after.routedMessages).toBe(1);
  }, 300_000);
});

describe.skipIf(!enabled)("the installer, on a Codex home that changes while it trusts the hook", () => {
  isolate({});
  const path = process.env.PATH;
  const hooksFile = () => join(home, ".codex/plugins/cache/t3-pstack/t3-pstack", version, "hooks/codex-hooks.json");
  const configFile = () => join(home, ".codex/config.toml");
  const attack = (at, files) => writeFileSync(process.env.CODEX_ATTACK, JSON.stringify({ at, files }));
  let genuine;
  let config;
  let malicious;
  let marked;

  async function withCodex(use) {
    const server = await AppServer.start({ dir: join(home, ".codex"), bin: "codex" });
    try {
      return await use(server);
    } finally {
      server.close();
    }
  }
  const trustState = () => withCodex(async (server) => (await server.request("config/read", {})).config.hooks?.state ?? null);

  beforeAll(() => {
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec node "${join(repoRoot, "tests/codex-attacker.mjs")}" "$@"\n`, { mode: 0o755 });
    process.env.REAL_CODEX = resolveCli("codex");
    process.env.CODEX_ATTACK = join(root, "attack.json");
    process.env.PATH = `${bin}${delimiter}${path}`;
    expect(installer("install").status).toBe(0);
    genuine = readFileSync(hooksFile(), "utf8");
    config = readFileSync(configFile(), "utf8").replace(/\n\[hooks\.state[^]*$/, "\n");
    marked = join(root, "hook-ran");
    malicious = genuine.replace(/"command": "[^\n]*",\n/, `"command": "touch ${marked}",\n`);
  });

  // Each test starts from the installed plugin with its hook untrusted.
  beforeEach(() => {
    rmSync(process.env.CODEX_ATTACK, { force: true });
    rmSync(hooksFile());
    writeFileSync(hooksFile(), genuine);
    writeFileSync(configFile(), config);
  });

  afterAll(() => {
    process.env.PATH = path;
    delete process.env.REAL_CODEX;
    delete process.env.CODEX_ATTACK;
  });

  test("trusts nothing from a hooks file that is a symlink, even to the pinned text", async () => {
    const copy = join(root, "codex-hooks.json");
    writeFileSync(copy, genuine);
    rmSync(hooksFile());
    symlinkSync(copy, hooksFile());
    const { status, report } = installer("install");
    expect(status).toBe(1);
    expect(row(report, ".codex").steps).toEqual([]);
    expect(failing(row(report, ".codex").checks)).toEqual([
      `session-start hook trusted: ${HOOK} untrusted, not from the hooks/codex-hooks.json this release pins`,
    ]);
    expect(await trustState()).toBe(null);
  }, 300_000);

  test("trusts nothing when the hooks file Codex listed is swapped for the pinned one before the installer reads it", async () => {
    writeFileSync(hooksFile(), malicious);
    attack("after hooks/list", { [hooksFile()]: genuine });
    const { status, report } = installer("install");
    expect(existsSync(process.env.CODEX_ATTACK)).toBe(false);
    expect(status).toBe(1);
    expect(row(report, ".codex").steps).toEqual([]);
    expect(failing(row(report, ".codex").checks)).toEqual([`session-start hook trusted: ${HOOK} untrusted`]);
    expect(await trustState()).toBe(null);

    // The attacker's entry, back for the next session, does not run.
    writeFileSync(hooksFile(), malicious);
    const after = await probe(join(home, ".codex"));
    expect(after.hookEvents).toEqual([]);
    expect(existsSync(marked)).toBe(false);
  }, 300_000);

  test("takes the trust back when the hooks file changes between the check and the trust write", async () => {
    attack("before config/value/write", { [hooksFile()]: malicious });
    const { status, report } = installer("install");
    expect(existsSync(process.env.CODEX_ATTACK)).toBe(false);
    expect(status).toBe(1);
    expect(failing(row(report, ".codex").checks)).toEqual([
      `install: Codex lists ${HOOK} modified with another entry after the trust write, so the installer took that trust back`,
    ]);
    expect(await trustState()).toBe(null);
  }, 300_000);

  test("trusts nothing when config.toml changes between the source check and the trust write", async () => {
    const counterfeit = join(root, "counterfeit");
    mkdirSync(counterfeit, { recursive: true });
    attack("after hooks/list", { [configFile()]: config.replace(/^source = .*$/m, `source = ${JSON.stringify(counterfeit)}`) });
    const { status, report } = installer("install");
    expect(existsSync(process.env.CODEX_ATTACK)).toBe(false);
    expect(status).toBe(1);
    expect(failing(row(report, ".codex").checks)).toEqual([
      'install: config/value/write: {"code":-32600,"data":{"config_write_error_code":"configVersionConflict"},' +
        '"message":"Configuration was modified since last read. Fetch latest version and retry."}',
    ]);
    expect(await trustState()).toBe(null);
  }, 300_000);
});

describe.skipIf(!enabled)("the installer, for one project", () => {
  isolate({});
  let project;
  let elsewhere;
  const source = () => repoRoot.replace(/\/$/, "");

  test("install: the plugin loads in the project's sessions and nowhere else", async () => {
    project = join(root, "project");
    elsewhere = join(root, "elsewhere");
    for (const dir of [project, elsewhere]) mkdirSync(dir, { recursive: true });
    sh("git", ["init", "-q", project]);

    const { status, report } = installer("install", repoRoot, ["--project", project]);
    console.log("project install:", JSON.stringify(report.homes.map(({ dir, steps }) => ({ dir, steps }))));
    expect(failing(report.homes.flatMap((h) => h.checks))).toEqual([]);
    expect(status).toBe(0);
    expect(report.project).toEqual({ scope: "project", dir: project });
    const claudeSettings = join(project, ".claude/settings.json");
    expect(row(report, ".claude").steps).toEqual([
      `added the t3-pstack marketplace from ${source()} to ${claudeSettings}`,
      `installed ${version} at project scope`,
    ]);
    expect(row(report, ".codex").steps).toEqual([
      `added the t3-pstack marketplace from ${source()}`,
      `installed ${version}`,
      "left it disabled outside the projects that enable it",
      `trusted ${project} in ${join(home, ".codex/config.toml")}, so Codex reads its .codex/config.toml`,
      `enabled it in ${join(project, ".codex/config.toml")}`,
      `trusted hook ${HOOK} (was untrusted)`,
    ]);
    expect(JSON.parse(readFileSync(claudeSettings, "utf8")).enabledPlugins).toEqual({ "t3-pstack@t3-pstack": true });
    expect(existsSync(join(home, ".claude/settings.json"))).toBe(false);

    const inside = await probe(join(home, ".codex"), project);
    expect(inside.hookEvents).toEqual(["hook/started", "hook/completed"]);
    expect(inside.routedMessages).toBe(1);
    const outside = await probe(join(home, ".codex"), elsewhere);
    expect(outside.hookEvents).toEqual([]);
    expect(outside.routedMessages).toBe(0);
  }, 300_000);

  test("a second install changes nothing, and the global doctor sees no global install", () => {
    const before = snapshot();
    const { status, report } = installer("update", repoRoot, ["--project", project]);
    expect(status).toBe(0);
    expect(report.homes.flatMap((h) => h.steps)).toEqual([]);
    expect(snapshot()).toEqual(before);
    expect(installer("doctor", repoRoot, ["--project", project]).status).toBe(0);
    const global = installer("doctor").report;
    // Outside the project the plugin is off, so Codex lists none of its hooks.
    expect(failing(row(global, ".codex").checks)).toEqual(["enabled: no", "session-start hook trusted: no t3-pstack hook listed"]);
  }, 300_000);

  test("--local writes the project's local settings, and keeps the Codex config's other lines", () => {
    const local = join(root, "local");
    mkdirSync(join(local, ".codex"), { recursive: true });
    writeFileSync(join(local, ".codex/config.toml"), 'model = "o3"\n');
    const { status, report } = installer("install", repoRoot, ["--local", local]);
    expect(failing(report.homes.flatMap((h) => h.checks))).toEqual([]);
    expect(status).toBe(0);
    expect(existsSync(join(local, ".claude/settings.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(local, ".claude/settings.local.json"), "utf8")).enabledPlugins).toEqual({
      "t3-pstack@t3-pstack": true,
    });
    expect(readFileSync(join(local, ".codex/config.toml"), "utf8")).toBe('model = "o3"\n\n[plugins."t3-pstack@t3-pstack"]\nenabled = true\n');
  }, 300_000);

  test("trusts neither the project nor a hook when the project's own config names another marketplace", () => {
    const counterfeit = pluginCopy(join(root, "counterfeit"));
    const other = join(root, "other");
    mkdirSync(join(other, ".codex"), { recursive: true });
    writeFileSync(join(other, ".codex/config.toml"), `[marketplaces.t3-pstack]\nsource_type = "local"\nsource = "${counterfeit}"\n`);
    const { status, report } = installer("install", repoRoot, ["--project", other]);
    expect(status).toBe(1);
    expect(row(report, ".codex").steps).toEqual([]);
    expect(failing(row(report, ".codex").checks)[0]).toBe(
      `marketplace: ${source()}, ${counterfeit}, which is neither chhoumann/t3-pstack nor --source`,
    );
  }, 300_000);

  test("registers the marketplace in every fresh Claude Code home, at either scope", () => {
    for (const scope of ["project", "local"]) {
      const shared = join(root, `shared-${scope}`);
      mkdirSync(shared, { recursive: true });
      const homes = [`claude-a-${scope}`, `claude-b-${scope}`];
      const { status, report } = installer("install", repoRoot, [`--${scope}`, shared, ...homes.flatMap((h) => ["--claude-home", join(root, h)])]);
      for (const h of homes) expect(failing(row(report, `../${h}`).checks)).toEqual([]);
      expect(status).toBe(0);
    }
  }, 300_000);

  test("adds the home's own marketplace when only the project's config names it", () => {
    const codexHome = join(root, "codex-fresh");
    const named = join(root, "named");
    mkdirSync(join(named, ".codex"), { recursive: true });
    writeFileSync(join(named, ".codex/config.toml"), `[marketplaces.t3-pstack]\nsource_type = "local"\nsource = "${source()}"\n`);
    const { status, report } = installer("install", repoRoot, ["--project", named, "--codex-home", codexHome]);
    expect(failing(row(report, "../codex-fresh").checks)).toEqual([]);
    expect(status).toBe(0);
    expect(row(report, "../codex-fresh").steps.slice(0, 2)).toEqual([`added the t3-pstack marketplace from ${source()}`, `installed ${version}`]);
  }, 300_000);

  test("a later global install enables the plugin everywhere, and a project install keeps it so", () => {
    expect(installer("install").status).toBe(0);
    const next = join(root, "next");
    mkdirSync(next, { recursive: true });
    const { status, report } = installer("install", repoRoot, ["--project", next]);
    expect(status).toBe(0);
    expect(row(report, ".codex").steps).not.toContain("left it disabled outside the projects that enable it");
    expect(installer("doctor").status).toBe(0);
  }, 300_000);
});
