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

import { loadLeadLines, loadModels, noteSkills, parseModels, stampLeadLine } from "../tools/generate.mjs";
import { RUNTIMES } from "../tools/runtimes.mjs";
import { checkSheet, parseEntry, parseSheet } from "../plugins/pstack/skills/setup-pstack/scripts/t3-sheet.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "plugins/pstack/skills/setup-pstack/scripts/t3-sheet.mjs");
const catalogPath = join(root, "tests/fixtures/t3-catalog.json");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const { roles, t3: defaults } = loadModels();
const check = (text, over = catalog) => checkSheet(parseSheet(text), { roles, defaults, catalog: over });
const PANEL = "interrogate reviewers";

describe("parseEntry", () => {
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

  test("rejects a bare alias, an @level, and a repeated option", () => {
    expect(() => parseEntry("opus")).toThrow("does not start with <providerInstanceId>/<modelId>");
    expect(() => parseEntry("claudeAgent/claude-opus-5-5 @high")).toThrow('"@high" is not <optionId>=<value>');
    expect(() => parseEntry("grok/grok-4.7 reasoningEffort=high reasoningEffort=low")).toThrow('sets "reasoningEffort" twice');
  });
});

describe("checkSheet against a catalog", () => {
  test("the shipped default sheet dispatches", () => {
    const mapping = readFileSync(join(root, "plugins/pstack/skills/poteto-mode/references/t3-tools.md"), "utf8");
    const sheet = mapping.match(/```markdown\n(# pstack model configuration \(T3\)[\s\S]*?)```/)[1];
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
  });

  test("exits 0 on a sheet that dispatches", () => {
    expect(run(script, "bug-fix: grok/grok-4.7 reasoningEffort=xhigh\n").status).toBe(0);
  });
});

describe("the models.json t3 block", () => {
  const raw = JSON.parse(readFileSync(join(root, "plugins/pstack/models.json"), "utf8"));
  const parse = (mutate) => {
    const policy = structuredClone(raw);
    mutate(policy);
    return () => parseModels(policy, () => true);
  };

  test("a missing tier, a malformed target, and a one-family panel each throw", () => {
    expect(parse((p) => delete p.t3.strongest)).toThrow('models.json: t3 has no target for tier "strongest"');
    expect(parse((p) => (p.t3.default = "opus"))).toThrow('models.json: t3 "default": "opus" does not start with');
    expect(parse((p) => (p.t3.default = "inherit-parent"))).toThrow('t3 "default" must name a target');
    expect(parse((p) => (p.t3.default = ["grok/grok-4.7", "codex/gpt-6.1-sol"]))).toThrow('t3 "default" must be one target, not a list');
    expect(parse((p) => p.t3.panel.push(p.t3.panel[0]))).toThrow('t3 "panel" lists');
    expect(parse((p) => (p.t3.panel = [["grok/grok-4.7"], "codex/gpt-6.1-sol"]))).toThrow("is not one target written with single spaces");
    expect(parse((p) => (p.t3.default = "grok/grok-4.7  reasoningEffort=high"))).toThrow("is not one target written with single spaces");
    expect(parse((p) => (p.t3.panel = ["claudeAgent/claude-opus-5-5", "codex_pool/claude-opus-5-5"]))).toThrow(
      "models.json: t3 panel needs at least two model families",
    );
  });
});

describe("the T3 preamble", () => {
  const [codex, t3] = ["Codex", "T3"].map((name) => RUNTIMES.find((r) => r.name === name));

  test("replaces another runtime's lead line instead of stacking under it", () => {
    const text = `# Title\n\n${codex.preamble}\n\nBody.\n`;
    expect(stampLeadLine(text, t3.preamble)).toBe(`# Title\n\n${t3.preamble}\n\nBody.\n`);
  });

  test("covers every skill the Codex table lists, so none keeps a Codex-only pointer", () => {
    const listed = (runtime) => noteSkills(runtime, readFileSync(join(root, runtime.tools), "utf8"));
    expect(listed(codex).filter((skill) => !listed(t3).includes(skill))).toEqual([]);
  });

  test("wins on a skill both mapping tables list", () => {
    expect(loadLeadLines().get("plugins/pstack/skills/arena/SKILL.md")).toBe(t3.preamble);
    expect(loadLeadLines().get("plugins/pstack/skills/automate-me/SKILL.md")).toBe(t3.preamble);
  });
});
