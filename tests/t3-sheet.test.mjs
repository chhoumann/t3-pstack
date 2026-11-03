// The T3 sheet grammar and its check against an orchestrator_capabilities
// catalog. The fixture is a trimmed copy of a real catalog: Claude names its
// reasoning option `effort`, Codex and Grok name it `reasoningEffort`, and an
// unauthenticated provider lists models it cannot run.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadModels } from "../tools/generate.mjs";
import { checkSheet, family, parseEntry, parseSheet } from "../plugins/pstack/skills/setup-pstack/scripts/t3-sheet.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "plugins/pstack/skills/setup-pstack/scripts/t3-sheet.mjs");
const catalogPath = join(root, "tests/fixtures/t3-catalog.json");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const { roles, tiers: defaults } = loadModels();
const check = (text, over = catalog) => checkSheet(parseSheet(text), { roles, defaults, catalog: over });
const PANEL = "interrogate reviewers";

describe("parseEntry", () => {
  test("keeps a Pi model ID that has its own provider prefix", () => {
    expect(parseEntry("pi/openai-codex/gpt-6.1-sol thinking=medium")).toEqual({
      providerInstanceId: "pi",
      model: "openai-codex/gpt-6.1-sol",
      options: { thinking: "medium" },
    });
    expect(family("openai-codex/gpt-6.1-sol")).toBe(family("gpt-6.1-sol"));
  });

  test("maps an entry onto a delegate_task target", () => {
    expect(parseEntry(" codex/gpt-6.1-sol reasoningEffort=xhigh serviceTier=priority ")).toEqual({
      providerInstanceId: "codex",
      model: "gpt-6.1-sol",
      options: { reasoningEffort: "xhigh", serviceTier: "priority" },
    });
  });

  test("inherit-parent and auto have no target and take no options", () => {
    expect(parseEntry("inherit-parent")).toBeNull();
    expect(parseEntry("auto")).toBeNull();
    expect(() => parseEntry("inherit-parent effort=high")).toThrow("inherit-parent takes no options");
  });

  test("splits at the first slash, so an OpenCode model ID keeps its own", () => {
    expect(parseEntry("opencode/openrouter/x-ai/grok-4.7 reasoningEffort=high")).toEqual({
      providerInstanceId: "opencode",
      model: "openrouter/x-ai/grok-4.7",
      options: { reasoningEffort: "high" },
    });
    expect(() => parseEntry("opencode/openrouter/")).toThrow("does not start with <providerInstanceId>/<modelId>");
  });

  test("a route prefix in the model ID does not decide its family", () => {
    expect(family("openrouter/x-ai/grok-4.7")).toBe("grok");
    expect(family("openrouter/anthropic/claude-opus-5-5")).toBe("claude");
    expect(family("gpt-6.1-sol")).toBe("gpt");
  });

  test("rejects a bare alias, an @level, and a repeated option", () => {
    expect(() => parseEntry("opus")).toThrow("does not start with <providerInstanceId>/<modelId>");
    expect(() => parseEntry("claudeAgent/claude-opus-5-5 @high")).toThrow('"@high" is not <optionId>=<value>');
    expect(() => parseEntry("grok/grok-4.7 reasoningEffort=high reasoningEffort=low")).toThrow('sets "reasoningEffort" twice');
  });
});

describe("checkSheet without a catalog", () => {
  test("checks the grammar and the panel rule, not whether a target dispatches here", () => {
    expect(check("bug-fix: someprovider/unlisted-model effort=max\nsession hook: on\n", null)).toEqual([]);
    expect(check(`bug-fix: claude-opus\n${PANEL}: someprovider/claude-a, otherprovider/claude-b\n`, null)).toEqual([
      'bug-fix: "claude-opus" does not start with <providerInstanceId>/<modelId>',
      `${PANEL}: a panel needs at least two model families among its targets (inherit-parent does not count), got claude`,
    ]);
  });
});

describe("checkSheet against a catalog", () => {
  test("the default sheet setup-pstack writes dispatches", () => {
    const setup = readFileSync(join(root, "plugins/pstack/skills/setup-pstack/SKILL.md"), "utf8");
    const sheet = setup.match(/```markdown\n(# pstack model configuration \(T3\)[\s\S]*?)```/)[1];
    expect(parseSheet(sheet)).toHaveLength(roles.length + 1);
    expect(check(sheet)).toEqual([]);
  });

  test("names each entry that cannot dispatch here", () => {
    expect(
      check(
        [
          "bug-fix: claudeCode/claude-opus-5-5",
          "how explorer: cursor/grok-4.7",
          "why synthesizer: grok/grok-9",
          "swarm workers: claudeAgent/claude-opus-5-5 reasoningEffort=high",
          "feature, refactoring: codex/gpt-6.1-sol reasoningEffort=extreme",
          "hillclimb: claudeAgent/claude-opus-5-5 fastMode=yes",
        ].join("\n"),
      ),
    ).toEqual([
      'bug-fix: claudeCode/claude-opus-5-5: no provider instance "claudeCode" in this T3',
      'how explorer: cursor/grok-4.7: "cursor" cannot run child tasks (Provider is not authenticated.)',
      'why synthesizer: grok/grok-9: "grok" does not list model "grok-9"',
      'swarm workers: claudeAgent/claude-opus-5-5: no option "reasoningEffort" (has effort, fastMode)',
      "feature, refactoring: codex/gpt-6.1-sol: reasoningEffort=extreme is not one of low, medium, high, xhigh, max, ultra",
      "hillclimb: claudeAgent/claude-opus-5-5: fastMode=yes is not one of true, false",
    ]);
  });

  test("a catalog that lists each option's values as a plain array, as orchestrator_capabilities returns, checks values", () => {
    // A copy of a live orchestrator_capabilities result, trimmed to four
    // providers. Its grok instance is disabled, so only the tier defaults that
    // name grok fail; the Claude and Codex defaults at xhigh pass.
    const values = JSON.parse(readFileSync(join(root, "tests/fixtures/t3-catalog-values.json"), "utf8"));
    const problems = (lines) => check(lines.join("\n"), values);
    const onlyGrokDefaults = (p) => p.includes("(no line, tier default): grok/grok-4.7: \"grok\" cannot run child tasks");
    const valid = [
      "bug-fix: claudeAgent/claude-opus-5-5 effort=high fastMode=true",
      "feature, refactoring: codex/gpt-6.1-sol reasoningEffort=xhigh serviceTier=priority",
      "how explorer: cursor/grok-4.7 reasoning_effort=high fastMode=false contextWindow=256k",
    ];
    expect(problems(valid).filter((p) => !onlyGrokDefaults(p))).toEqual([]);
    expect(problems(valid).some(onlyGrokDefaults)).toBe(true);
    const invalid = [
      "bug-fix: claudeAgent/claude-opus-5-5 effort=extreme",
      "hillclimb: claudeAgent/claude-opus-5-5 fastMode=yes",
      "why synthesizer: grok/grok-4.7 reasoningEffort=high",
    ];
    expect(problems(invalid).filter((p) => !onlyGrokDefaults(p))).toEqual([
      "bug-fix: claudeAgent/claude-opus-5-5: effort=extreme is not one of low, medium, high, xhigh, max, ultracode, ultrathink",
      "hillclimb: claudeAgent/claude-opus-5-5: fastMode=yes is not one of false, true",
      'why synthesizer: grok/grok-4.7: "grok" cannot run child tasks (Provider instance is disabled.)',
    ]);
  });

  test("a model whose options are omitted or null reports the option instead of crashing", () => {
    for (const options of [undefined, null]) {
      const bare = structuredClone(catalog);
      bare.providers.find((p) => p.providerInstanceId === "claudeAgent").models.push({ id: "claude-x", options });
      expect(check("bug-fix: claudeAgent/claude-x effort=high", bare)).toEqual([
        'bug-fix: claudeAgent/claude-x: no option "effort" (has none)',
      ]);
    }
  });

  test("a role with no line is checked on its tier default, as on a machine without grok", () => {
    const noGrok = structuredClone(catalog);
    noGrok.providers = noGrok.providers.filter((p) => p.providerInstanceId !== "grok");
    const panelRoles = roles.filter((r) => r.tier === "panel").map((r) => r.role);
    expect(check("session hook: on", noGrok)).toEqual(
      panelRoles.map((role) => `${role} (no line, tier default): grok/grok-4.7: no provider instance "grok" in this T3`),
    );
    const lines = panelRoles.map((role) => `${role}: claudeAgent/claude-opus-5-5, codex/gpt-6.1-sol`).join("\n");
    expect(check(lines, noGrok)).toEqual([]);
  });

  test("a panel on one family fails, whatever providers serve it", () => {
    expect(check(`${PANEL}: claudeAgent/claude-opus-5-5, codex_pool/claude-opus-5-5`)).toEqual([
      `${PANEL}: a panel needs at least two model families among its targets (inherit-parent does not count), got claude`,
    ]);
    expect(check(`${PANEL}: claudeAgent/claude-opus-5-5, grok/grok-4.7`)).toEqual([]);
  });

  test("inherit-parent does not count toward a panel's two families", () => {
    expect(check(`${PANEL}: inherit-parent, grok/grok-4.7`)).toEqual([
      `${PANEL}: a panel needs at least two model families among its targets (inherit-parent does not count), got grok`,
    ]);
    expect(check(`${PANEL}: auto, claudeAgent/claude-fable-5-1, grok/grok-4.7`)).toEqual([]);
  });

  test("an option named like an Object prototype key is checked, not dropped", () => {
    expect(check("bug-fix: claudeAgent/claude-opus-5-5 __proto__=bogus")).toEqual([
      'bug-fix: claudeAgent/claude-opus-5-5: no option "__proto__" (has effort, fastMode)',
    ]);
  });

  test("a panel that repeats a target fails", () => {
    expect(check(`${PANEL}: claudeAgent/claude-opus-5-5, grok/grok-4.7, claudeAgent/claude-opus-5-5`)).toEqual([
      `${PANEL}: lists the same target twice`,
    ]);
  });

  test("a provider that cannot run cross-provider children fails, and its entries do not count as a family", () => {
    const noCross = structuredClone(catalog);
    noCross.providers.find((p) => p.providerInstanceId === "grok").canRunCrossProviderChildTask = false;
    const otherPanels = roles.filter((r) => r.tier === "panel" && r.role !== PANEL).map((r) => r.role);
    expect(check(`${PANEL}: claudeAgent/claude-opus-5-5, grok/grok-4.7`, noCross)).toEqual([
      `${PANEL}: grok/grok-4.7: "grok" cannot run child tasks`,
      `${PANEL}: a panel needs at least two model families among its targets (inherit-parent does not count), got claude`,
      ...otherPanels.map((role) => `${role} (no line, tier default): grok/grok-4.7: "grok" cannot run child tasks`),
    ]);
  });

  test("only a panel role takes a list", () => {
    expect(check("bug-fix: claudeAgent/claude-fable-5-1, grok/grok-4.7")).toEqual(["bug-fix: takes one entry, not a list"]);
  });

  // Upstream renamed the role in 0.15.21. A sheet setup-pstack wrote before
  // that keeps the old label, which still counts.
  test("a strongest judgment line is checked as the hardest tasks role, and setting both fails", () => {
    expect(check("strongest judgment: grok/grok-4.7 reasoningEffort=xhigh")).toEqual([]);
    expect(check("strongest judgment: grok/grok-9")).toEqual(['strongest judgment: grok/grok-9: "grok" does not list model "grok-9"']);
    expect(check("hardest tasks: grok/grok-4.7\nstrongest judgment: grok/grok-4.7")).toEqual([
      '"strongest judgment" appears twice; only one line may set it',
    ]);
  });

  test("a role set twice fails rather than letting the last line win", () => {
    expect(check("swarm workers: grok/grok-4.7 effort=high\nswarm workers: grok/grok-4.7")).toEqual([
      'swarm workers: grok/grok-4.7: no option "effort" (has reasoningEffort)',
      '"swarm workers" appears twice; only one line may set it',
    ]);
  });

  test("a line shaped like a role line but malformed fails instead of being skipped", () => {
    const bad = [
      "bug-fix:  grok/grok-4.7",
      "hillclimb:",
      "  perf-issue: grok/grok-4.7",
      "Bug-fix: grok/grok-9",
      "- bug-fix: grok/grok-9",
      "`bug-fix`: grok/grok-9",
      "**bug-fix**: grok/grok-9",
      "1. bug-fix: grok/grok-9",
      "bug_fix: grok/grok-9",
      "Delete a line to use the tier default.",
    ];
    expect(check(bad.join("\n"))).toEqual(
      bad.map((_, i) => `line ${i + 1}: not a "<role>: <value>" line (lowercase role, one space after the colon, no indent or markup)`),
    );
  });

  test("CRLF line ends and a byte-order mark parse like plain lines", () => {
    expect(check("\uFEFFbug-fix: grok/grok-9\r\nsession hook: on\r\n")).toEqual([
      'bug-fix: grok/grok-9: "grok" does not list model "grok-9"',
    ]);
  });

  test("default effort, an unknown role, and a bad hook value fail; headings and blank lines pass", () => {
    expect(check("# Sheet\n\ndefault effort: session\nhow critics: grok/grok-4.7\nsession hook: of")).toEqual([
      "default effort: T3 entries carry their own options; delete this line",
      '"how critics" is not a pstack role',
      'session hook: "of" is not on or off',
    ]);
  });
});

// Each test spawns real node processes, and the first node start on a cold CI
// runner can take several seconds.
const CLI_TIMEOUT = 30_000;

describe("t3-sheet.mjs CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "t3-sheet-"));
  const run = (path, sheet) => {
    writeFileSync(join(dir, "sheet.md"), sheet);
    return spawnSync("node", [path, join(dir, "sheet.md"), catalogPath], { encoding: "utf8" });
  };

  test("prints each problem and exits 1, through a symlink too", () => {
    symlinkSync(script, join(dir, "linked.mjs"));
    for (const path of [script, join(dir, "linked.mjs")]) {
      const result = run(path, "bug-fix: grok/grok-9\n");
      expect({ status: result.status, stdout: result.stdout }).toEqual({
        status: 1,
        stdout: 'bug-fix: grok/grok-9: "grok" does not list model "grok-9"\n',
      });
    }
  }, CLI_TIMEOUT);

  test("exits 0 on a sheet that dispatches", () => {
    expect(run(script, "bug-fix: grok/grok-4.7 reasoningEffort=xhigh\n").status).toBe(0);
  }, CLI_TIMEOUT);
});

describe("the T3 session-start context", () => {
  const pluginRoot = join(root, "plugins/pstack");

  test.each(["claude", "codex"])("the %s hook tells the session to route and dispatch through T3", (runtime) => {
    const home = mkdtempSync(join(tmpdir(), "t3-session-"));
    const result = spawnSync("sh", [join(pluginRoot, "hooks/session-start.sh"), runtime], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    expect(result.status).toBe(0);
    for (const phrase of ["t3-pstack:poteto-mode", "t3-pstack-models.md", "delegate_task"]) {
      expect(result.stdout).toContain(phrase);
    }
  });
});
