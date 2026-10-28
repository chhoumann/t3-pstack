// Unit tests for the generator and the T3 derivation: the regions stamped
// from models.json, the port's frontmatter, the version stamp, the validators,
// and the plan it writes from.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { applyRegions, deriveT3, fenceUnder, section, t3Regions } from "../tools/derive-t3.mjs";
import {
  apply,
  assertChangesHeading,
  changes,
  frozenHookFaults,
  loadModels,
  parseFrontmatter,
  plan,
  PORTABLE_ASSETS,
  problems,
  stampAgentPaths,
  stampVersion,
} from "../tools/generate.mjs";
import { hookDigest } from "../tools/plugin.mjs";
import { walk } from "../tools/validate-skills.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const models = loadModels();

const lines = (text) => text.split("\n");
const spanned = (locate, doc) => {
  const span = locate(doc);
  return span && doc.slice(...span);
};

describe("locators", () => {
  test("section spans from the heading to the next ## heading", () => {
    const doc = lines("# T\n\n## Models\n\nold\n\n## Next\nx");
    expect(spanned(section("Models"), doc)).toEqual(["", "old", ""]);
    expect(spanned(section("Next"), doc)).toEqual(["x"]);
    expect(spanned(section("Absent"), doc)).toBeNull();
  });

  test("fenceUnder spans the inside of the first matching fence after the titled step, whatever its number", () => {
    const doc = lines("### 5. Write the sheet\n\ntext\n```markdown\na\nb\n```\nafter");
    const renumbered = lines("### 6. Write the sheet\n```markdown\na\n```");
    const unclosed = lines("### 5. Write the sheet\n```markdown\nunclosed");
    expect(spanned(fenceUnder("Write the sheet", "markdown"), doc)).toEqual(["a", "b"]);
    expect(spanned(fenceUnder("Write the sheet", "markdown"), renumbered)).toEqual(["a"]);
    expect(spanned(fenceUnder("Write the sheet", "yaml"), doc)).toBeNull();
    expect(spanned(fenceUnder("Write", "markdown"), doc)).toBeNull();
    expect(spanned(fenceUnder("Write the sheet", "markdown"), unclosed)).toBeNull();
  });
});

describe("regions", () => {
  test("every skill a role names gets that role's tier default stamped in its Models section", () => {
    const marked = { ...models, tiers: { default: "x/marker-default", strongest: "x/marker-strongest", panel: ["a/claude-p", "b/gpt-p"] } };
    for (const skill of new Set(models.roles.map((r) => r.skill))) {
      const file = `plugins/pstack/skills/${skill}/SKILL.md`;
      const stamped = applyRegions(file, readFileSync(join(repoRoot, file), "utf8"), marked, { strict: true });
      for (const role of models.roles.filter((r) => r.skill === skill)) {
        const expected = { default: "`x/marker-default`", strongest: "`x/marker-strongest`", panel: "`a/claude-p`, `b/gpt-p`" }[role.tier];
        expect(stamped).toContain(`- ${role.role}: ${expected}`);
      }
    }
  });

  test("applyRegions stamps in place and is idempotent", () => {
    const file = "plugins/pstack/skills/how/SKILL.md";
    const text = "# how\n\n## Models\n\nstale\n\n## After\nkeep\n";
    const once = applyRegions(file, text, models, { strict: true });
    expect(once).not.toContain("stale");
    expect(once).toContain("## After\nkeep\n");
    expect(once).toContain("- how explorer: `claudeAgent/claude-opus-5-5 effort=xhigh`");
    expect(applyRegions(file, once, models, { strict: true })).toBe(once);
  });

  test("a strict stamp throws when an owned file lost its anchor, and a sync stamp leaves it alone", () => {
    const text = "---\nname: setup-pstack\ndescription: d\n---\n\n### 5. Write the rule\n\n```\nold\n```\n";
    expect(() => applyRegions("plugins/pstack/skills/setup-pstack/SKILL.md", text, models, { strict: true })).toThrow(
      "plugins/pstack/skills/setup-pstack/SKILL.md: no anchor for the sheet block to stamp",
    );
    expect(applyRegions("plugins/pstack/skills/setup-pstack/SKILL.md", text, models)).toBe(text);
  });

  test("applyRegions leaves a file no region names untouched", () => {
    const text = "# other\n\n## Models\n\nprose\n";
    expect(applyRegions("plugins/pstack/skills/other/SKILL.md", text, models)).toBe(text);
    expect(t3Regions(models).some((r) => r.file === "plugins/pstack/skills/other/SKILL.md")).toBe(false);
  });
});

describe("stampVersion", () => {
  test("rewrites the single version field and keeps formatting", () => {
    const text = '{\n  "name": "x",\n  "version":   "0.1.0",\n  "keywords": []\n}\n';
    expect(stampVersion(text, "0.2.0", "m.json")).toBe(
      '{\n  "name": "x",\n  "version":   "0.2.0",\n  "keywords": []\n}\n',
    );
  });

  test("refuses a manifest with zero or two version fields", () => {
    expect(() => stampVersion('{"name":"x"}', "1.0.0", "m.json")).toThrow('m.json: expected exactly 1 "version" field, found 0');
    expect(() => stampVersion('{"version":"1","dep":{"version":"2"}}', "1.0.0", "m.json")).toThrow("found 2");
  });
});

describe("assertChangesHeading", () => {
  test("requires the current version's heading and one shape for every release heading", () => {
    expect(() => assertChangesHeading("## 0.9.1 - title\n## 0.9.0 - older\n", "0.9.1")).not.toThrow();
    expect(() => assertChangesHeading("## 0.9.10 - title\n", "0.9.1")).toThrow('no "## 0.9.1 - <title>" heading');
    expect(() => assertChangesHeading("## 0.9.1 - title\n## 0.9.0 — em dash\n## 0.8.9\n", "0.9.1")).toThrow(
      'read "## <version> - <title>":\n## 0.9.0 — em dash\n## 0.8.9',
    );
  });

  test("a heading newer than VERSION fails naming both, so an entry without a bump cannot ship", () => {
    expect(() => assertChangesHeading("# Changes\n\n## 0.9.71 - newer\n\n## 0.9.70 - current\n", "0.9.70")).toThrow(
      'CHANGES.md\'s newest release heading is "## 0.9.71 - newer", but VERSION is 0.9.70',
    );
  });

  test("a newer version that only extends VERSION fails like any other", () => {
    expect(() => assertChangesHeading("# Changes\n\n## 0.9.70 - newer\n\n## 0.9.7 - current\n", "0.9.7")).toThrow(
      'CHANGES.md\'s newest release heading is "## 0.9.70 - newer", but VERSION is 0.9.7',
    );
  });

  test.each(["## v0.9.71 - newer", "## [0.9.71] - newer", "##  0.9.71 - newer", "##0.9.71 - newer", "### 0.9.71 - newer", "# 0.9.71 - newer"])(
    "an entry headed %s above the VERSION heading fails, whatever its level, spacing, or decoration",
    (heading) => {
      expect(() => assertChangesHeading(`# Changes\n\n${heading}\n\n## 0.9.70 - current\n`, "0.9.70")).toThrow(
        `CHANGES.md's newest release heading is "${heading}", but VERSION is 0.9.70`,
      );
    },
  );

  test.each(["## About this file", "## Unreleased", "## Format since 0.9.13", "## 2.0 plans"])(
    "a heading that does not lead with a three-part version is no entry and may sit above the newest: %s",
    (heading) => {
      expect(() => assertChangesHeading(`# Changes\n\n${heading}\n\n## 0.9.71 - new\n\n## 0.9.70 - old\n`, "0.9.71")).not.toThrow();
    },
  );

  test("a version that heads two entries fails naming both, so new work under the old number cannot ship", () => {
    expect(() => assertChangesHeading("# Changes\n\n## 0.9.70 - newer work\n\n## 0.9.70 - current\n", "0.9.70")).toThrow(
      "CHANGES.md heads two entries with one version:\n## 0.9.70 - newer work\n## 0.9.70 - current",
    );
  });

  test("a heading that is not a release may sit below the newest entry", () => {
    expect(() => assertChangesHeading("## 0.9.1 - title\n\n## Upstream review\n\n## 0.9.0 - older\n", "0.9.1")).not.toThrow();
  });

  test.each([
    ["an older heading quoted in the newest entry", "## 0.9.71 - new\n\n```\n## 0.9.70 - old\n```\n\n## 0.9.70 - old\n"],
    ["a sample heading above the first entry", "```md\n## 1.2.3 - title\n```\n\n## 0.9.71 - new\n\n## 0.9.70 - old\n"],
    ["a tilde fence", "## 0.9.71 - new\n\n~~~\n## 0.9.70 - old\n~~~\n\n## 0.9.70 - old\n"],
    ["an indented fence", "## 0.9.71 - new\n\n ```\n## 0.9.70 - old\n ```\n\n## 0.9.70 - old\n"],
    ["a longer fence holding a shorter one", "## 0.9.71 - new\n\n````\n```\n## 0.9.70 - old\n```\n````\n\n## 0.9.70 - old\n"],
    ["a tilde line inside a backtick fence", "## 0.9.71 - new\n\n```\n~~~\n## 0.9.70 - old\n~~~\n```\n\n## 0.9.70 - old\n"],
    ["a longer run closing a shorter fence", "```\n## 1.2.3 - sample\n````\n\n## 0.9.71 - new\n\n## 0.9.70 - old\n"],
    ["a marker with an info string inside a fence", "```\n```md\n## 1.2.3 - sample\n```\n\n## 0.9.71 - new\n\n## 0.9.70 - old\n"],
  ])("a heading inside a code fence heads no entry: %s", (_, body) => {
    expect(() => assertChangesHeading(`# Changes\n\n${body}`, "0.9.71")).not.toThrow();
  });

  test.each([
    ["in the middle of a line", "Quote a heading in a ``` fence."],
    ["indented four spaces, which is a code block", "    ```"],
  ])("three backticks %s open no fence", (_, line) => {
    expect(() => assertChangesHeading(`# Changes\n\n${line}\n\n## 0.9.71 - new\n\n## 0.9.70 - old\n`, "0.9.71")).not.toThrow();
  });

  test("a VERSION heading that sits only inside a code fence is no heading", () => {
    expect(() => assertChangesHeading("# Changes\n\n```\n## 0.9.71 - new\n```\n\n## 0.9.70 - old\n", "0.9.71")).toThrow(
      'no "## 0.9.71 - <title>" heading',
    );
  });

  test("a pre-release version heads its own entry", () => {
    expect(() => assertChangesHeading("## 2.0.0-rc.1 - base switch\n\n## 1.0.14 - older\n", "2.0.0-rc.1")).not.toThrow();
    expect(() => assertChangesHeading("## 2.0.0-rc.1 base switch\n\n## 1.0.14 - older\n", "2.0.0-rc.1")).toThrow('read "## <version> - <title>"');
  });
});

describe("parseFrontmatter", () => {
  test("splits the YAML block from the body", () => {
    expect(parseFrontmatter("---\nname: x\nflag: false \n---\n\nbody\n")).toEqual({
      data: { name: "x", flag: false },
      body: "\nbody\n",
    });
  });

  test("reads a CRLF block", () => {
    expect(parseFrontmatter("---\r\nname: x\r\n---\r\nbody\r\n")).toEqual({ data: { name: "x" }, body: "body\r\n" });
  });

  test("returns null data and the whole text when there is no block", () => {
    expect(parseFrontmatter("# title\n---\nname: x\n---\n")).toEqual({
      data: null,
      body: "# title\n---\nname: x\n---\n",
    });
  });
});

describe("deriveT3", () => {
  const front = (flags, name = "x") => `---\nname: ${name}\ndescription: d\n${flags}---\n\nbody\n`;

  test("drops disable-model-invocation on poteto-mode only, so the session-start hook can invoke it", () => {
    const flag = "disable-model-invocation: true\n";
    expect(deriveT3("plugins/pstack/skills/poteto-mode/SKILL.md", front(flag, "Poteto Mode"), models)).toStartWith(front("", "poteto-mode"));
    expect(deriveT3("plugins/pstack/skills/tdd/SKILL.md", front(flag, "tdd"), models)).toBe(front(flag, "tdd"));
    expect(deriveT3("plugins/pstack/skills/principle-x/SKILL.md", front(flag, "principle-x"), models)).toBe(front(flag, "principle-x"));
  });

  test("names a skill after its directory and an agent after its file, and drops Cursor-only keys", () => {
    const cursorKeys = "mode: true\nicon: crown\ncolor: yellow\nreminder: >-\n  New task?\n  Apply it.\n";
    expect(deriveT3("plugins/pstack/skills/x/SKILL.md", front(cursorKeys, "X Mode"), models)).toBe(front(""));
    expect(deriveT3("plugins/pstack/agents/comment-sicko.md", front("is_background: true\n", "Comment Sicko"), models)).toBe(
      front("", "comment-sicko"),
    );
  });

  test("leaves a reference file's frontmatter alone", () => {
    const text = front("mode: true\n", "Some Reference");
    expect(deriveT3("plugins/pstack/skills/x/references/y.md", text, models)).toBe(text);
  });

  test.each(["|-", ">-"])("drops every paragraph of a %s reminder without changing adjacent fields", (style) => {
    const text = front(`reminder: ${style}\n  First paragraph.\n\n  Second paragraph.\n  \n  Last paragraph.\nallowed-tools:\n  - Read\n`);
    const out = deriveT3("plugins/pstack/skills/x/SKILL.md", text, models);
    expect(parseFrontmatter(out)).toEqual({
      data: { name: "x", description: "d", "allowed-tools": ["Read"] },
      body: parseFrontmatter(text).body,
    });
    expect(deriveT3("plugins/pstack/skills/x/SKILL.md", out, models)).toBe(out);
  });

  test("leaves a flag line in the body alone", () => {
    const text = front("", "poteto-mode") + "disable-model-invocation: true\n";
    expect(deriveT3("plugins/pstack/skills/poteto-mode/SKILL.md", text, models)).toStartWith(text);
  });

  test("appends and stamps a Models section when upstream has none, naming the sheet and the entry grammar", () => {
    const out = deriveT3("plugins/pstack/skills/how/SKILL.md", front(""), models);
    expect(out).toContain("body\n\n## Models\n\nRole defaults on T3, stamped from `plugins/pstack/models.json`.");
    expect(out).toContain("`t3-pstack-models.md`");
    expect(out).toContain("It splits at its first `/`");
    expect(out.endsWith("- how explainer: `claudeAgent/claude-opus-5-5 effort=xhigh`\n")).toBe(true);
    expect(deriveT3("plugins/pstack/skills/how/SKILL.md", out, models)).toBe(out);
  });

  test("names the alias a released sheet may still use", () => {
    const out = deriveT3("plugins/pstack/skills/poteto-mode/SKILL.md", front("", "poteto-mode"), models);
    expect(out).toContain("- hardest tasks: `claudeAgent/claude-fable-5-1 effort=xhigh` (a `strongest judgment` line counts as this role)");
  });

  test("a file no region names passes through", () => {
    const text = "# plain\n\nreference text\n";
    expect(deriveT3("plugins/pstack/skills/how/references/x.md", text, models)).toBe(text);
  });
});

describe("plugin agents", () => {
  test("plugin.json lists every agent the plugin ships", () => {
    const listed = JSON.parse(readFileSync(join(repoRoot, "plugins/pstack/.claude-plugin/plugin.json"), "utf8")).agents;
    const shipped = readdirSync(join(repoRoot, "plugins/pstack/agents")).map((f) => `./agents/${f}`).sort();
    expect(listed).toEqual(shipped);
    expect(listed).toContain("./agents/poteto-agent.md");
  });

  test("stamping the agents list keeps every other manifest field", () => {
    const text = '{\n  "name": "pstack",\n  "version": "1.0.0"\n}\n';
    const out = stampAgentPaths(text, ["./agents/a.md"]);
    expect(JSON.parse(out)).toEqual({ name: "pstack", version: "1.0.0", agents: ["./agents/a.md"] });
    expect(stampAgentPaths(out, ["./agents/a.md"])).toBe(out);
  });
});

describe("plan, changes, apply", () => {
  const made = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const scratch = (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    made.push(dir);
    return dir;
  };
  // A copy committed as its own origin/main, which the hooks check compares with.
  const git = (dir, ...args) => {
    const r = spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  };
  const repoCopy = () => {
    const dir = scratch("pstack-generate-");
    cpSync(repoRoot, dir, { recursive: true, filter: (src) => ![".git", "node_modules"].includes(basename(src)) });
    symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "main");
    const origin = scratch("pstack-origin-");
    git(origin, "init", "-q", "--bare");
    git(dir, "remote", "add", "origin", origin);
    git(dir, "push", "-q", "origin", "HEAD:refs/heads/main");
    return dir;
  };
  const snapshot = (dir) => Object.fromEntries(walk(dir).map((path) => [path, readFileSync(path, "utf8")]));
  const quiet = { log: () => {} };
  const STUB = "plugins/pstack/skills/poteto-mode/references/licenses/LICENSE";
  const STRAY = "plugins/pstack/skills/poteto-mode/references/licenses/stray.md";
  const generate = (root, ...args) => spawnSync(process.execPath, [join(root, "tools/generate.mjs"), ...args], { encoding: "utf8" });
  const append = (root, rel, text) => writeFileSync(join(root, rel), readFileSync(join(root, rel), "utf8") + text);

  test("the working tree is what the plan says", () => {
    expect(changes(repoRoot, plan(repoRoot))).toEqual([]);
  });

  test("plan computes from the sources, repeats itself, and writes nothing", () => {
    const root = repoCopy();
    const current = readFileSync(join(root, STUB), "utf8");
    writeFileSync(join(root, STUB), "stale\n");
    writeFileSync(join(root, STRAY), "orphan\n");
    const before = snapshot(root);
    const first = plan(root);
    expect(plan(root)).toEqual(first);
    expect(first.files[STUB]).toBe(current);
    expect(Object.hasOwn(first.files, STRAY)).toBe(false);
    expect(snapshot(root)).toEqual(before);
  });

  test("--check on a stale tree exits 1 naming each stale path, writes nothing, and passes once regenerated", () => {
    const root = repoCopy();
    writeFileSync(join(root, STUB), "stale\n");
    writeFileSync(join(root, STRAY), "orphan\n");
    const before = snapshot(root);
    const stale = generate(root, "--check");
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain(`FAIL: generated output is stale; run bun tools/generate.mjs:\n  write: ${STUB}\n  remove: ${STRAY}\n`);
    expect(snapshot(root)).toEqual(before);
    expect(generate(root).status).toBe(0);
    expect(generate(root, "--check").status).toBe(0);
  });

  test("a hand edit to a stamped Models line or to the sheet block is restored", () => {
    const root = repoCopy();
    const how = "plugins/pstack/skills/how/SKILL.md";
    const setup = "plugins/pstack/skills/setup-pstack/SKILL.md";
    const text = (rel) => readFileSync(join(root, rel), "utf8");
    writeFileSync(join(root, how), text(how).replace(/^- how explorer: .*$/m, "- how explorer: stale"));
    writeFileSync(join(root, setup), text(setup).replace(/^bug-fix: .*$/m, "bug-fix: stale"));
    const { files } = plan(root);
    for (const rel of [how, setup]) expect(files[rel]).toBe(readFileSync(join(repoRoot, rel), "utf8"));
  });

  test("apply rewrites only the files whose bytes differ", () => {
    const root = repoCopy();
    const intended = plan(root);
    writeFileSync(join(root, STUB), "stale\n");
    const past = new Date("2001-01-01T00:00:00Z");
    for (const path of Object.keys(intended.files)) utimesSync(join(root, path), past, past);
    expect(apply(root, intended, quiet)).toEqual([{ kind: "write", path: STUB }]);
    expect(readFileSync(join(root, STUB), "utf8")).toBe(intended.files[STUB]);
    const touched = Object.keys(intended.files).filter((path) => statSync(join(root, path)).mtimeMs !== past.getTime());
    expect(touched).toEqual([STUB]);
  });

  test("apply writes each planned file and removes every other entry in an owned directory", () => {
    const root = scratch("pstack-apply-");
    mkdirSync(join(root, "out/leftover"), { recursive: true });
    writeFileSync(join(root, "out/a.md"), "old");
    writeFileSync(join(root, "out/extra.md"), "orphan");
    const intended = { files: { "out/a.md": "A", "out/b.md": "B", "top/c.json": "C" }, ownedDirs: ["out"] };
    expect(apply(root, intended, quiet)).toEqual([
      { kind: "write", path: "out/a.md" },
      { kind: "write", path: "out/b.md" },
      { kind: "write", path: "top/c.json" },
      { kind: "remove", path: "out/extra.md" },
      { kind: "remove", path: "out/leftover" },
    ]);
    expect(readdirSync(join(root, "out")).sort()).toEqual(["a.md", "b.md"]);
    expect(readFileSync(join(root, "out/a.md"), "utf8")).toBe("A");
    expect(readFileSync(join(root, "top/c.json"), "utf8")).toBe("C");
    expect(changes(root, intended)).toEqual([]);
  });

  test("apply refuses a symlink at a planned path before writing anything", () => {
    const root = scratch("pstack-apply-");
    const outside = join(scratch("pstack-outside-"), "target.md");
    writeFileSync(outside, "original");
    mkdirSync(join(root, "out"));
    symlinkSync(outside, join(root, "out/b.md"));
    const intended = { files: { "out/a.md": "A", "out/b.md": "B" }, ownedDirs: ["out"] };
    expect(() => apply(root, intended, quiet)).toThrow("out/b.md is a symlink; the generator never writes through one");
    expect(readFileSync(outside, "utf8")).toBe("original");
    expect(existsSync(join(root, "out/a.md"))).toBe(false);
  });

  test("apply removes a stray symlink in an owned directory without touching its target", () => {
    const root = scratch("pstack-apply-");
    const outside = scratch("pstack-outside-");
    writeFileSync(join(outside, "target.md"), "original");
    mkdirSync(join(root, "out"));
    symlinkSync(join(outside, "target.md"), join(root, "out/stray.md"));
    symlinkSync(outside, join(root, "out/stray-dir"), "dir");
    apply(root, { files: { "out/a.md": "A" }, ownedDirs: ["out"] }, quiet);
    expect(readdirSync(join(root, "out"))).toEqual(["a.md"]);
    expect(readFileSync(join(outside, "target.md"), "utf8")).toBe("original");
  });

  test("apply refuses a planned path under a symlinked directory", () => {
    const root = scratch("pstack-apply-");
    const outside = scratch("pstack-outside-");
    mkdirSync(join(root, "skills"));
    symlinkSync(outside, join(root, "skills/out"), "dir");
    for (const intended of [
      { files: { "skills/out/a.md": "A" }, ownedDirs: ["skills/out"] },
      { files: { "skills/out/deep/a.md": "A" }, ownedDirs: [] },
    ]) {
      expect(() => apply(root, intended, quiet)).toThrow("skills/out is a symlink; the generator never writes through one");
    }
    expect(readdirSync(outside)).toEqual([]);
  });

  test("apply refuses a symlinked owned directory with no planned files and deletes nothing through it", () => {
    const root = scratch("pstack-apply-");
    const outside = scratch("pstack-outside-");
    writeFileSync(join(outside, "keep.md"), "original");
    symlinkSync(outside, join(root, "out"), "dir");
    expect(() => apply(root, { files: {}, ownedDirs: ["out"] }, quiet)).toThrow(
      "out is a symlink; the generator never writes through one",
    );
    expect(readFileSync(join(outside, "keep.md"), "utf8")).toBe("original");
  });

  test("changes refuses a directory at a planned path", () => {
    const root = scratch("pstack-apply-");
    mkdirSync(join(root, "out/a.md"), { recursive: true });
    expect(() => changes(root, { files: { "out/a.md": "A" }, ownedDirs: ["out"] })).toThrow(
      "out/a.md is not a regular file; the generator never overwrites one",
    );
  });

  test("a planned file nested under an owned directory converges instead of being removed", () => {
    const root = scratch("pstack-apply-");
    const intended = { files: { "out/sub/a.md": "A" }, ownedDirs: ["out"] };
    apply(root, intended, quiet);
    expect(changes(root, intended)).toEqual([]);
    expect(readFileSync(join(root, "out/sub/a.md"), "utf8")).toBe("A");
  });

  test("a pre-release VERSION stamps every manifest", () => {
    const root = repoCopy();
    writeFileSync(join(root, "VERSION"), "9.0.0-rc.2\n");
    append(root, "CHANGES.md", "");
    const changelog = readFileSync(join(root, "CHANGES.md"), "utf8");
    writeFileSync(join(root, "CHANGES.md"), changelog.replace(/^## \S+ - /m, "## 9.0.0-rc.2 - next\n\n$&"));
    const { files } = plan(root);
    for (const manifest of [".claude-plugin/marketplace.json", "plugins/pstack/.claude-plugin/plugin.json", "plugins/pstack/.codex-plugin/plugin.json", "package.json"]) {
      expect(files[manifest]).toContain('"version": "9.0.0-rc.2"');
    }
  });

  test("problems reports every broken contract, and --check prints each and exits 1", () => {
    const root = repoCopy();
    append(root, "plugins/pstack/skills/deslop/SKILL.md", "\n[gone](missing.md)\n");
    const poteto = "plugins/pstack/skills/poteto-mode/SKILL.md";
    writeFileSync(join(root, poteto), readFileSync(join(root, poteto), "utf8").replace("---\n\n", "disable-model-invocation: true\n---\n\n"));
    writeFileSync(join(root, "plugins/pstack/plugin.json"), "{}\n");
    const failures = problems(root);
    expect(failures).toEqual([
      expect.stringContaining("poteto-mode/SKILL.md: disable-model-invocation: true stops the session-start hook"),
      "invalid local markdown links:\ndeslop/SKILL.md -> missing.md (missing)",
      expect.stringContaining("plugins/pstack/plugin.json exists; Codex would truncate"),
    ]);
    const check = generate(root, "--check");
    expect(check.status).toBe(1);
    for (const failure of failures) expect(check.stderr).toContain(`FAIL: ${failure}\n`);
  });

  test("problems reports an agent whose frontmatter strict YAML cannot read", () => {
    const root = repoCopy();
    const agent = "plugins/pstack/agents/comment-sicko.md";
    writeFileSync(
      join(root, agent),
      readFileSync(join(root, agent), "utf8").replace(/^description: .*$/m, "description: `backticked` first"),
    );
    expect(problems(root)).toEqual([
      expect.stringMatching(/^agent frontmatter is not readable YAML:\n\.\/agents\/comment-sicko\.md: /),
    ]);
  });

  test("problems reports an agent whose frontmatter name is not its file name", () => {
    const root = repoCopy();
    const agent = "plugins/pstack/agents/comment-sicko.md";
    writeFileSync(join(root, agent), readFileSync(join(root, agent), "utf8").replace(/^name: .*$/m, "name: sicko"));
    expect(problems(root)).toEqual([
      expect.stringContaining('./agents/comment-sicko.md: frontmatter name "sicko" != file name "comment-sicko"'),
    ]);
  });

  test("problems reports a malformed Codex manifest as one failure and still runs the other checks", () => {
    const root = repoCopy();
    const manifest = "plugins/pstack/.codex-plugin/plugin.json";
    append(root, "plugins/pstack/skills/deslop/SKILL.md", "\n[gone](missing.md)\n");
    writeFileSync(join(root, manifest), readFileSync(join(root, manifest), "utf8") + "}\n");
    expect(problems(root)).toEqual([
      "invalid local markdown links:\ndeslop/SKILL.md -> missing.md (missing)",
      expect.stringContaining("JSON"),
    ]);
  });

  test("problems checks the Codex marketplace and the hooks file the Codex manifest names", () => {
    const root = repoCopy();
    const hooks = "plugins/pstack/hooks/codex-hooks.json";
    writeFileSync(join(root, hooks), readFileSync(join(root, hooks), "utf8").replace("hooks/session-start.ps1", "hooks/gone.ps1"));
    expect(problems(root)).toEqual([
      expect.stringContaining("hooks/gone.ps1 does not exist"),
      expect.stringContaining(`${hooks} changed, which stops its hook`),
    ]);
    const marketplace = ".agents/plugins/marketplace.json";
    writeFileSync(join(root, marketplace), readFileSync(join(root, marketplace), "utf8").replace('"name": "t3-pstack",\n      "source"', '"name": "other",\n      "source"'));
    expect(problems(root)).toContainEqual(expect.stringContaining('plugin name "other" != Codex manifest name "t3-pstack"'));
  });

  test("problems reports a hook path that resolves outside the plugin, through .. or through a symlink", () => {
    const root = repoCopy();
    const hooks = "plugins/pstack/hooks/hooks.json";
    const text = readFileSync(join(root, hooks), "utf8");
    const changed = expect.stringContaining(`${hooks} changed, which stops its hook`);
    writeFileSync(join(root, hooks), text.replace("hooks/session-start.sh", "../../tools/generate.mjs"));
    expect(problems(root)).toEqual([expect.stringContaining("../../tools/generate.mjs does not exist in the plugin"), changed]);
    const outside = join(scratch("pstack-outside-"), "start.sh");
    writeFileSync(outside, "#!/bin/sh\n", { mode: 0o755 });
    symlinkSync(outside, join(root, "plugins/pstack/hooks/linked.sh"));
    writeFileSync(join(root, hooks), text.replace("hooks/session-start.sh", "hooks/linked.sh"));
    expect(problems(root)).toEqual([expect.stringContaining("hooks/linked.sh does not exist in the plugin"), changed]);
  });

  test("problems compares the hooks files with origin/main, so a repinned change cannot keep its old changedIn", () => {
    const root = repoCopy();
    const hooks = "plugins/pstack/hooks/codex-hooks.json";
    const text = readFileSync(join(root, hooks), "utf8").replace("startup|resume|clear|compact", "startup|resume|compact");
    writeFileSync(join(root, hooks), text);
    const pins = JSON.parse(readFileSync(join(root, "tools/frozen-hooks.json"), "utf8"));
    pins[hooks].sha256 = hookDigest(text);
    writeFileSync(join(root, "tools/frozen-hooks.json"), JSON.stringify(pins, null, 2) + "\n");
    const version = readFileSync(join(root, "VERSION"), "utf8").trim();
    expect(problems(root)).toEqual([
      `${hooks} differs from origin/main, which ships ${version}, so this change needs a VERSION newer than that, not ${version}`,
    ]);
    rmSync(join(root, ".git"), { recursive: true });
    expect(problems(root)).toEqual([expect.stringMatching(/^tools\/frozen-hooks.json: cannot fetch origin\/main to compare the hooks files with: fatal: not a git repository/)]);
  });

  test("problems fetches origin/main and compares with it, not with the merge-base, so a release main already shipped cannot be reused", () => {
    const root = repoCopy();
    const hooks = "plugins/pstack/hooks/codex-hooks.json";
    const original = readFileSync(join(root, hooks), "utf8");
    // A release with `matcher` for the hooks file: VERSION, the hooks file, its pin, and a CHANGES entry.
    const release = (version, matcher) => {
      const text = original.replace("startup|resume|clear|compact", matcher);
      writeFileSync(join(root, hooks), text);
      const pins = JSON.parse(readFileSync(join(root, "tools/frozen-hooks.json"), "utf8"));
      pins[hooks] = { sha256: hookDigest(text), changedIn: version };
      writeFileSync(join(root, "tools/frozen-hooks.json"), JSON.stringify(pins, null, 2) + "\n");
      writeFileSync(join(root, "VERSION"), `${version}\n`);
      writeFileSync(join(root, "CHANGES.md"), `# CHANGES\n\n## ${version} - Next\n\nRerun the installer.\n\n` + readFileSync(join(root, "CHANGES.md"), "utf8").replace(/^# CHANGES\n\n/, ""));
    };
    writeFileSync(join(root, "VERSION"), "9.0.0-rc.2\n");
    git(root, "commit", "-qam", "9.0.0-rc.2");
    git(root, "push", "-q", "origin", "HEAD:refs/heads/main");
    git(root, "checkout", "-qb", "branch");
    // Main ships 9.0.0-rc.3 with hook A after the branch is cut, and the
    // branch's own origin/main still points at 9.0.0-rc.2.
    release("9.0.0-rc.3", "startup|resume");
    git(root, "commit", "-qam", "main ships 9.0.0-rc.3 with hook A");
    git(root, "push", "-q", "origin", "HEAD:refs/heads/main");
    git(root, "reset", "-q", "--hard", "HEAD~1");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");

    release("9.0.0-rc.3", "startup|clear");
    expect(problems(root)).toEqual([
      `${hooks} differs from origin/main, which ships 9.0.0-rc.3, so this change needs a VERSION newer than that, not 9.0.0-rc.3`,
    ]);
    git(root, "checkout", "-q", ".");
    release("9.0.0-rc.1", "startup|clear");
    expect(problems(root)).toEqual([
      `${hooks} differs from origin/main, which ships 9.0.0-rc.3, so this change needs a VERSION newer than that, not 9.0.0-rc.1`,
    ]);
    git(root, "checkout", "-q", ".");
    release("9.0.0-rc.4", "startup|clear");
    expect(problems(root)).toEqual([]);
  });

  test("problems reports a root with no plugin directory, down to the last check, and does not throw", () => {
    expect(problems(scratch("pstack-empty-"))).toContainEqual(expect.stringContaining("plugins/pstack/hooks/hooks.json"));
  });
});

describe("frozen hook entries", () => {
  const path = "plugins/pstack/hooks/codex-hooks.json";
  const hooks = '{"hooks":{"SessionStart":[{"matcher":"startup","hooks":[{"type":"command","command":"x"}]}]}}';
  const changed = hooks.replace("startup", "startup|resume");
  const changelog = (body) => `# CHANGES\n\n## 2.1.0 - Next\n\n${body}\n\n## 2.0.0 - Before\n\nRerun the installer.\n`;
  const main = { version: "2.0.0", files: { [path]: hooks } };
  const faults = ({ pins, file = changed, version = "2.1.0", body = "Rerun the installer.", shipped = main }) =>
    frozenHookFaults({ pins, files: { [path]: file }, version, changelog: changelog(body), shipped });

  test("pass while each hooks file matches its pin and main, whatever its formatting", () => {
    const pins = { [path]: { sha256: hookDigest(hooks), changedIn: "2.0.0" } };
    expect(faults({ pins, file: JSON.stringify(JSON.parse(hooks), null, 2), body: "Nothing." })).toEqual([]);
  });

  test("fail on a change until it is pinned to the release that announces it", () => {
    const pins = { [path]: { sha256: hookDigest(hooks), changedIn: "2.0.0" } };
    expect(faults({ pins, body: "Nothing." })).toEqual([
      `${path} changed, which stops its hook in every Codex home until the installer reruns. ` +
        `Pin "sha256": "${hookDigest(changed)}" and "changedIn": "2.1.0" in tools/frozen-hooks.json, ` +
        "and tell users to rerun the installer in CHANGES.md's 2.1.0 entry.",
    ]);
    const repinned = { [path]: { sha256: hookDigest(changed), changedIn: "2.1.0" } };
    expect(faults({ pins: repinned, body: "Nothing." })).toEqual([
      `${path} changes in 2.1.0, but CHANGES.md's 2.1.0 entry does not tell users to rerun the installer`,
    ]);
    expect(faults({ pins: repinned })).toEqual([]);
  });

  test("fail on a repinned change that keeps main's changedIn or main's VERSION", () => {
    const stale = { [path]: { sha256: hookDigest(changed), changedIn: "2.0.0" } };
    const stalePin = `${path} differs from origin/main, so its pin's "changedIn" must be 2.1.0, not 2.0.0`;
    expect(faults({ pins: stale })).toEqual([stalePin]);
    expect(faults({ pins: stale, shipped: { version: "2.0.0", files: {} } })).toEqual([stalePin]);
    expect(faults({ pins: stale, version: "2.0.0" })).toEqual([
      `${path} differs from origin/main, which ships 2.0.0, so this change needs a VERSION newer than that, not 2.0.0`,
    ]);
    expect(faults({ pins: { [path]: { sha256: hookDigest(changed), changedIn: "2.0.0-rc.9" } }, version: "2.0.0-rc.9" })).toEqual([
      `${path} differs from origin/main, which ships 2.0.0, so this change needs a VERSION newer than that, not 2.0.0-rc.9`,
    ]);
  });

  test("fail on a hooks file with no pin and a pin with no file", () => {
    expect(frozenHookFaults({ pins: { "a.json": { sha256: "x" } }, files: { [path]: hooks }, version: "2.1.0", changelog: "", shipped: main })).toEqual([
      `${path} has no pin in tools/frozen-hooks.json`,
      "tools/frozen-hooks.json pins a.json, which no manifest names",
    ]);
  });
});
