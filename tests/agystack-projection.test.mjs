// The agystack projection: a flat set of real skill directories in a Gemini
// config skills dir, generated from the agystack plugin source, owned (and
// protected) by a dot-prefixed manifest. These tests exercise the behavior the
// contract fixes: native bytes preserved, relative links resolve, idempotent
// installs, user-owned files untouched, edited generated files rejected before
// any write, the adapter resource copied from the installed package when the
// package provides it, and doctor reporting drift.
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  ADAPTER_SCRIPTS_DIR,
  ADAPTER_SKILL_NAME,
  MANIFEST_NAME,
  adapterNote,
  buildProjection,
  doctor,
  insertNote,
  listSourceSkills,
  project,
  ProjectionBlocked,
} from "../tools/install/agystack.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const repoAdapterSkill = join(repoRoot, "plugins/pstack/skills/t3-agystack/SKILL.md");

let nextId = 0;
function workdir() {
  return realpathSync(mkdtempSync(join(tmpdir(), `agystack-proj-${process.pid}-${(nextId += 1)}-`)));
}

function fixtureSource(root) {
  const skill = (name, files) => {
    for (const [rel, body] of Object.entries(files)) {
      const path = join(root, "skills", name, rel);
      mkdirSync(path.slice(0, path.lastIndexOf("/") + 1), { recursive: true });
      writeFileSync(path, body);
    }
  };
  skill("how", { "SKILL.md": "---\nname: how\ndescription: How.\n---\n\n# How\n\nBody.\n", "references/deep.md": "# Deep\nLong tail content.\n" });
  skill("why", { "SKILL.md": "---\r\nname: why\r\ndescription: Why.\r\n---\r\n\r\n# Why\r\n\r\nCRLF bytes © ünïcode.\r\n" });
  skill("swarm-fixture", { "SKILL.md": "---\nname: swarm-fixture\ndescription: Swarm.\n---\n\nRun it.\n", "scripts/one.py": "print('one')\n" });
  return root;
}

function fixturePackage(root, withResource = true) {
  const base = join(root, "plugins/pstack/skills/t3-agystack");
  mkdirSync(join(base, "scripts"), { recursive: true });
  writeFileSync(join(base, "SKILL.md"), readFileSync(repoAdapterSkill));
  if (withResource) {
    writeFileSync(join(base, "scripts/cloud-run.mjs"), "// fixture bridge entry: dispatch/status/resume/cancel/harvest/list/attach, --json\n");
    writeFileSync(join(base, "scripts/cloud-controller.mjs"), "// fixture controller module\n");
    writeFileSync(join(base, "scripts/cloud-process.mjs"), "// fixture process module\n");
    writeFileSync(join(base, "scripts/cloud-state.mjs"), "// fixture state module\n");
  }
  return root;
}

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const shaBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Run a projection action and return its ProjectionBlocked, failing the test on
// any other outcome so a thrown TypeError never reads as "worked as planned".
function blockedResult(action) {
  try {
    action();
  } catch (error) {
    if (error instanceof ProjectionBlocked) return error;
    throw error;
  }
  throw new Error("the projection should have been blocked");
}

function snapshot(dir) {
  const out = new Map();
  const walk = (cur) => {
    for (const entry of readdirSync(cur).sort()) {
      const path = join(cur, entry);
      const rel = relative(dir, path);
      if (lstatSync(path).isSymbolicLink()) out.set(rel, `link:${readlinkSync(path)}`);
      else if (statSync(path).isDirectory()) walk(path);
      else out.set(rel, shaBytes(readFileSync(path)));
    }
  };
  walk(dir);
  return out;
}

describe("projection planning", () => {
  test("lists portable source skills and rejects non-portable and reserved names before planning", () => {
    const root = workdir();
    fixtureSource(root);
    const names = listSourceSkills(root).map((s) => s.name);
    expect(names).toEqual(["how", "swarm-fixture", "why"]);

    const bad = workdir();
    mkdirSync(join(bad, "skills", "Bad_Name_2"), { recursive: true });
    writeFileSync(join(bad, "skills", "Bad_Name_2", "SKILL.md"), "---\nname: oops\n---\nbody");
    expect(() => listSourceSkills(bad)).toThrow(/portable/);

    const reserved = workdir();
    fixtureSource(reserved);
    mkdirSync(join(reserved, "skills", ADAPTER_SKILL_NAME), { recursive: true });
    writeFileSync(join(reserved, "skills", ADAPTER_SKILL_NAME, "SKILL.md"), "x");
    expect(() => listSourceSkills(reserved)).toThrow(/reserved/);
    for (const dir of [root, bad, reserved]) rmSync(dir, { recursive: true, force: true });
  });

  test("the native body survives the note byte-for-byte, frontmatter included", () => {
    const native = readFileSync(join(fixtureSource(workdir()), "skills/why/SKILL.md"), "utf8");
    const built = insertNote(native, adapterNote("deadbeef"));

    const frontEnd = native.indexOf("\n---\r\n") + "\n---\r\n".length;
    expect(built.startsWith(native.slice(0, frontEnd))).toBe(true);
    expect(built.slice(frontEnd).startsWith(adapterNote("deadbeef"))).toBe(true);
    // The note is the only insertion; stripping it reduces to the original bytes.
    expect(built.replace(adapterNote("deadbeef"), "")).toBe(native);
    // A file without frontmatter takes the note at the top.
    const bare = "No frontmatter here.\n";
    expect(insertNote(bare, adapterNote("x")).endsWith(bare)).toBe(true);
  });
});

describe("install behavior", () => {
  test("installs generated skills, individual resource links, and the manifest", () => {
    const home = workdir();
    const source = fixtureSource(workdir());
    const destSkills = join(home, ".gemini", "config", "skills");
    const pack = fixturePackage(workdir(), false); // the package does not ship the cloud bridge yet
    const result = project({ build: buildProjection({ sourceRoot: source, destSkillsDir: destSkills, packageRoot: pack }) });

    const manifest = JSON.parse(readFileSync(join(destSkills, MANIFEST_NAME), "utf8"));
    expect(manifest.schema).toBe(1);
    expect(manifest.source).toBe(realpathSync(source));
    const paths = manifest.entries.map((e) => e.path);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toContain("how/SKILL.md");
    expect(paths).toContain("how/references/deep.md");
    expect(paths).toContain("t3-agystack/SKILL.md");
    expect(manifest.entries.some((e) => e.kind === "adapter-resource")).toBe(false);

    // Generated SKILL.md equals exactly the native bytes with the note inserted.
    const nativeHow = readFileSync(join(source, "skills/how/SKILL.md"), "utf8");
    const anchor = manifest.entries.find((e) => e.path === "how/SKILL.md").anchor;
    expect(readFileSync(join(destSkills, "how/SKILL.md"), "utf8")).toBe(insertNote(nativeHow, adapterNote(anchor)));

    // Engine scripts stay behind relative links that resolve to native content.
    const link = join(destSkills, "swarm-fixture/scripts/one.py");
    expect(statSync(link).isFile()).toBe(true);
    expect(readFileSync(link, "utf8")).toBe("print('one')\n");
    expect(readlinkSync(link).startsWith("..")).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(join(source, "skills/swarm-fixture/scripts/one.py")));
    expect(sha(realpathSync(join(destSkills, "how/references/deep.md")))).toBe(sha(join(source, "skills/how/references/deep.md")));

    expect(result.applied.length).toBe(manifest.entries.length);
    for (const dir of [home, source, pack]) rmSync(dir, { recursive: true, force: true });
  });

  test("a second install changes nothing", () => {
    const home = workdir();
    const source = fixtureSource(workdir());
    const pack = fixturePackage(workdir());
    const destSkills = join(home, ".gemini", "config", "skills");
    const build = buildProjection({ sourceRoot: source, destSkillsDir: destSkills, packageRoot: pack });
    project({ build });
    const before = snapshot(destSkills);
    const again = project({ build: buildProjection({ sourceRoot: source, destSkillsDir: destSkills, packageRoot: pack }) });
    expect(again.applied).toEqual([]);
    expect(again.removed).toEqual([]);
    expect(snapshot(destSkills)).toEqual(before);
    for (const dir of [home, source, pack]) rmSync(dir, { recursive: true, force: true });
  });

  test("a destination reached through a symlinked home installs working links on the first run and stays idempotent", () => {
    const realHome = workdir();
    const linkHome = workdir();
    mkdirSync(join(realHome, ".gemini", "config"), { recursive: true });
    symlinkSync(join(realHome, ".gemini"), join(linkHome, ".gemini"));
    const source = fixtureSource(workdir());
    const pack = fixturePackage(workdir());
    const destSkills = join(linkHome, ".gemini", "config", "skills");
    const first = project({ build: buildProjection({ sourceRoot: source, destSkillsDir: destSkills, packageRoot: pack }) });
    expect(first.applied.length).toBeGreaterThan(0);

    const linkReport = JSON.parse(JSON.stringify({ links: first.applied.filter((e) => e.kind === "resource-link").length }));
    expect(linkReport.links).toBeGreaterThan(0);
    for (const path of first.applied.filter((e) => e.kind === "resource-link").map((e) => e.path)) {
      expect(existsSync(join(destSkills, path)), path).toBe(true);
    }
    expect(existsSync(join(realHome, ".gemini", "config", "skills/how/references/deep.md"))).toBe(true);

    const before = snapshot(destSkills);
    const again = project({ build: buildProjection({ sourceRoot: source, destSkillsDir: destSkills, packageRoot: pack }) });
    expect(again.applied).toEqual([]);
    expect(snapshot(destSkills)).toEqual(before);
    const report = doctor({ sourceRoot: source, destSkillsDir: destSkills, packageRoot: pack });
    expect(report.status, JSON.stringify([report.drift, report.brokenLinks])).toBe("ok");
    for (const dir of [linkHome, realHome, source, pack]) rmSync(dir, { recursive: true, force: true });
  });

  test("an owned path replaced by a directory is drift, not a crash", () => {
    const home = workdir();
    const source = fixtureSource(workdir());
    const destSkills = join(home, ".gemini", "config", "skills");
    const pack = fixturePackage(workdir());
    project({ build: buildProjection({ sourceRoot: source, destSkillsDir: destSkills, packageRoot: pack }) });
    rmSync(join(destSkills, "how/SKILL.md"));
    mkdirSync(join(destSkills, "how/SKILL.md"), { recursive: true });

    const blocked = blockedResult(() => project({ build: buildProjection({ sourceRoot: source, destSkillsDir: destSkills, packageRoot: pack }) }));
    expect(blocked.problems.some((p) => p.code === "drift" && p.path === "how/SKILL.md")).toBe(true);
    const report = doctor({ sourceRoot: source, destSkillsDir: destSkills, packageRoot: pack });
    expect(report.status).toBe("degraded");
    expect(report.drift).toContain("how/SKILL.md");
    for (const dir of [home, source, pack]) rmSync(dir, { recursive: true, force: true });
  });

  test("a symlinked source directory, like the standard plugin install, still links without dangling", () => {
    const home = workdir();
    const realSource = fixtureSource(workdir());
    const alias = join(home, "alias-source");
    symlinkSync(realSource, alias);
    const destSkills = join(home, ".gemini", "config", "skills");
    const pack = fixturePackage(workdir(), false);
    project({ build: buildProjection({ sourceRoot: alias, destSkillsDir: destSkills, packageRoot: pack }) });

    expect(statSync(join(destSkills, "swarm-fixture/scripts/one.py")).isFile()).toBe(true);
    expect(readFileSync(join(destSkills, "swarm-fixture/scripts/one.py"), "utf8")).toBe("print('one')\n");
    expect(realpathSync(join(destSkills, "swarm-fixture/scripts/one.py"))).toBe(realpathSync(join(realSource, "skills/swarm-fixture/scripts/one.py")));
    expect(doctor({ sourceRoot: alias, destSkillsDir: destSkills, packageRoot: pack }).brokenLinks).toEqual([]);
    for (const dir of [home, realSource, pack]) rmSync(dir, { recursive: true, force: true });
  });

  test("pre-existing user-owned files block the whole install before any write", () => {
    const home = workdir();
    const source = fixtureSource(workdir());
    const destSkills = join(home, ".gemini", "config", "skills");
    mkdirSync(join(destSkills, "how"), { recursive: true });
    writeFileSync(join(destSkills, "how/SKILL.md"), "the user wrote this first\n");
    const pack = fixturePackage(workdir());
    const build = buildProjection({ sourceRoot: source, destSkillsDir: destSkills, packageRoot: pack });
    const blocked = blockedResult(() => project({ build }));
    expect(blocked.problems.some((p) => p.code === "collision" && p.path === "how/SKILL.md")).toBe(true);
    expect(readFileSync(join(destSkills, "how/SKILL.md"), "utf8")).toBe("the user wrote this first\n");
    expect(existsSync(join(destSkills, "why"))).toBe(false);
    expect(existsSync(join(destSkills, MANIFEST_NAME))).toBe(false);
    for (const dir of [home, source, pack]) rmSync(dir, { recursive: true, force: true });
  });

  test("edited generated files are drift: installation aborts without touching anything else", () => {
    const home = workdir();
    const source = fixtureSource(workdir());
    const destSkills = join(home, ".gemini", "config", "skills");
    const pack = fixturePackage(workdir());
    project({ build: buildProjection({ sourceRoot: source, destSkillsDir: destSkills, packageRoot: pack }) });
    const slug = join(destSkills, "why/SKILL.md");
    writeFileSync(slug, readFileSync(slug, "utf8") + "\nhuman edit\n");

    const blocked = blockedResult(() => project({ build: buildProjection({ sourceRoot: source, destSkillsDir: destSkills, packageRoot: pack }) }));
    expect(blocked.problems.some((p) => p.code === "drift" && p.path === "why/SKILL.md")).toBe(true);
    expect(blocked.problems.every((p) => p.code === "drift")).toBe(true);
    expect(readFileSync(slug, "utf8")).toContain("human edit\n");
    expect(readFileSync(join(destSkills, "how/SKILL.md"), "utf8")).not.toContain("human edit");
    for (const dir of [home, source, pack]) rmSync(dir, { recursive: true, force: true });
  });

  test("a projection whose manifest was deleted (crash between writes) refuses to be adopted", () => {
    const home = workdir();
    const source = fixtureSource(workdir());
    const destSkills = join(home, ".gemini", "config", "skills");
    const pack = fixturePackage(workdir());
    project({ build: buildProjection({ sourceRoot: source, destSkillsDir: destSkills, packageRoot: pack }) });
    rmSync(join(destSkills, MANIFEST_NAME));

    const blocked = blockedResult(() => project({ build: buildProjection({ sourceRoot: source, destSkillsDir: destSkills, packageRoot: pack }) }));
    expect(blocked.problems.some((p) => p.code === "collision")).toBe(true);
    expect(readFileSync(join(destSkills, "how/SKILL.md"), "utf8")).not.toBe("restored by an uninvited install");
    for (const dir of [home, source, pack]) rmSync(dir, { recursive: true, force: true });
  });

  test("a manifest that was tampered with is invalid, not trusted", () => {
    const home = workdir();
    const source = fixtureSource(workdir());
    const destSkills = join(home, ".gemini", "config", "skills");
    const pack = fixturePackage(workdir());
    project({ build: buildProjection({ sourceRoot: source, destSkillsDir: destSkills, packageRoot: pack }) });
    writeFileSync(join(destSkills, MANIFEST_NAME), "{ not json");
    expect(() => project({ build: buildProjection({ sourceRoot: source, destSkillsDir: destSkills, packageRoot: pack }) })).toThrow(/manifest/);
    for (const dir of [home, source, pack]) rmSync(dir, { recursive: true, force: true });
  });

  test("skills the source no longer ships are retired on the next install because we own them", () => {
    const home = workdir();
    const pack = fixturePackage(workdir());
    const destSkills = join(home, ".gemini", "config", "skills");
    const source = fixtureSource(workdir());
    project({ build: buildProjection({ sourceRoot: source, destSkillsDir: destSkills, packageRoot: pack }) });
    rmSync(join(source, "skills/why"), { recursive: true, force: true });
    const result = project({ build: buildProjection({ sourceRoot: source, destSkillsDir: destSkills, packageRoot: pack }) });

    expect(result.removed.map((r) => r.path)).toContain("why/SKILL.md");
    expect(existsSync(join(destSkills, "why"))).toBe(false);
    expect(existsSync(join(destSkills, "how"))).toBe(true);
    for (const dir of [home, source, pack]) rmSync(dir, { recursive: true, force: true });
  });

  test("the user's own skills never enter the manifest and survive every install", () => {
    const home = workdir();
    const source = fixtureSource(workdir());
    const destSkills = join(home, ".gemini", "config", "skills");
    mkdirSync(join(destSkills, "users-own"), { recursive: true });
    writeFileSync(join(destSkills, "users-own/SKILL.md"), "---\nname: users-own\ndescription: Mine.\n---\n\nKeep hands off.\n");
    const pack = fixturePackage(workdir());
    const build = buildProjection({ sourceRoot: source, destSkillsDir: destSkills, packageRoot: pack });

    expect(() => project({ build })).not.toThrow();
    const manifest = JSON.parse(readFileSync(join(destSkills, MANIFEST_NAME), "utf8"));
    expect(manifest.entries.some((e) => e.path.startsWith("users-own"))).toBe(false);
    expect(readFileSync(join(destSkills, "users-own/SKILL.md"), "utf8")).toContain("Keep hands off");
    for (const dir of [home, source, pack]) rmSync(dir, { recursive: true, force: true });
  });
});

describe("adapter resources from the installed package", () => {
  test("when the package ships the bridge scripts the projection copies every one and keeps the skill byte-for-byte", () => {
    const home = workdir();
    const source = fixtureSource(workdir());
    const destSkills = join(home, ".gemini", "config", "skills");
    const pack = fixturePackage(workdir(), true);
    project({ build: buildProjection({ sourceRoot: source, destSkillsDir: destSkills, packageRoot: pack }) });

    const nativeScripts = join(pack, "plugins/pstack/skills", ADAPTER_SCRIPTS_DIR);
    const projectedScripts = join(destSkills, ADAPTER_SCRIPTS_DIR);
    expect(readdirSync(projectedScripts).sort()).toEqual(readdirSync(nativeScripts).sort());
    for (const name of readdirSync(nativeScripts)) {
      expect(statSync(join(projectedScripts, name)).isFile()).toBe(true);
      expect(readFileSync(join(projectedScripts, name), "utf8")).toBe(readFileSync(join(nativeScripts, name), "utf8"));
    }
    expect(sha(join(destSkills, `${ADAPTER_SKILL_NAME}/SKILL.md`))).toBe(sha(join(nativeScripts, "..", "SKILL.md")));
    const entries = JSON.parse(readFileSync(join(destSkills, MANIFEST_NAME), "utf8")).entries.filter((e) => e.kind === "adapter-resource");
    expect(entries.map((e) => e.path).sort()).toEqual(["t3-agystack/scripts/cloud-controller.mjs", "t3-agystack/scripts/cloud-process.mjs", "t3-agystack/scripts/cloud-run.mjs", "t3-agystack/scripts/cloud-state.mjs"]);
    for (const dir of [home, source, pack]) rmSync(dir, { recursive: true, force: true });
  });
});

describe("doctor", () => {
  test("reports ok after a clean install and catches drift, broken links, and a moved source", () => {
    const home = workdir();
    const source = fixtureSource(workdir());
    const destSkills = join(home, ".gemini", "config", "skills");
    const pack = fixturePackage(workdir());
    project({ build: buildProjection({ sourceRoot: source, destSkillsDir: destSkills, packageRoot: pack }) });

    expect(doctor({ sourceRoot: source, destSkillsDir: destSkills, packageRoot: pack }).status).toBe("ok");

    writeFileSync(join(destSkills, "how/SKILL.md"), readFileSync(join(destSkills, "how/SKILL.md"), "utf8") + "\nedit\n");
    const link = join(destSkills, "swarm-fixture/scripts/one.py");
    rmSync(link);
    symlinkSync(join(destSkills, "no/such/file"), link);
    const degraded = doctor({ sourceRoot: source, destSkillsDir: destSkills, packageRoot: pack });
    expect(degraded.status).toBe("degraded");
    expect(degraded.drift).toContain("how/SKILL.md");
    expect(degraded.brokenLinks.map((l) => l.path)).toContain("swarm-fixture/scripts/one.py");

    rmSync(source, { recursive: true, force: true });
    const moved = doctor({ sourceRoot: source, destSkillsDir: destSkills, packageRoot: pack });
    expect(moved.status).toBe("degraded");
    expect(moved.source.present).toBe(false);

    const absent = doctor({ sourceRoot: join(home, "nowhere"), destSkillsDir: join(home, "no-skills"), packageRoot: pack });
    expect(absent.status).toBe("absent");
    for (const dir of [home, pack]) rmSync(dir, { recursive: true, force: true });
  });
});

describe("shipped artifacts", () => {
  test("the routing note and the adapter skill both predicate on callable tools and a runnable ACP entrypoint", () => {
    for (const text of [adapterNote("x"), readFileSync(repoAdapterSkill, "utf8")]) {
      expect(text).toContain("delegate_task");
      expect(text).toContain("T3_ACP_MCP_NODE");
      expect(text).toContain("runnable file");
      expect(text).toContain("ignore this");
      expect(text).toContain("envelope");
    }
    const skill = readFileSync(repoAdapterSkill, "utf8");
    for (const field of ["role:", "ownership:", "task:", "deliverable:", "cloud-controller"]) expect(skill).toContain(field);
    expect(skill).not.toMatch(/\/Users\//);
    expect(readFileSync(join(repoRoot, "docs/antigravity.md"), "utf8")).not.toMatch(/\/Users\//);
  });
});

describe("hostile manifests, retargeted links, and CLI degradation", () => {
  function run(...args) {
    return spawnSync("node", ["tools/antigravity.mjs", ...args], { cwd: repoRoot, encoding: "utf8" });
  }

  test("a manifest entry whose path escapes the projection authorizes no deletion and blocks install", () => {
    const home = workdir();
    const source = fixtureSource(workdir());
    const destSkills = join(home, ".gemini", "config", "skills");
    const pack = fixturePackage(workdir());
    project({ build: buildProjection({ sourceRoot: source, destSkillsDir: destSkills, packageRoot: pack }) });
    const victim = workdir();
    const before = snapshot(victim);

    const manifest = JSON.parse(readFileSync(join(destSkills, MANIFEST_NAME), "utf8"));
    manifest.entries.push(
      { kind: "adapter-skill", path: `../../${basename(victim)}/neighbors/how/SKILL.md`, hash: "0".repeat(64) },
      { kind: "generated-skill", path: victim, hash: "0".repeat(64) },
    );
    writeFileSync(join(destSkills, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
    expect(snapshot(victim)).toEqual(before);

    const blocked = blockedResult(() => project({ build: buildProjection({ sourceRoot: source, destSkillsDir: destSkills, packageRoot: pack }) }));
    expect(blocked.problems.every((p) => p.code === "manifest-invalid")).toBe(true);
    expect(blocked.problems.some((p) => JSON.stringify(p.detail).includes(basename(victim)))).toBe(true);
    expect(snapshot(victim)).toEqual(before);
    expect(doctor({ sourceRoot: source, destSkillsDir: destSkills, packageRoot: pack }).status).toBe("degraded");
    for (const dir of [home, source, pack]) rmSync(dir, { recursive: true, force: true });
    rmSync(victim, { recursive: true, force: true });
  });

  test("an owned link the projection retargeted is doctor-visible even though its target still resolves", () => {
    const home = workdir();
    const source = fixtureSource(workdir());
    const destSkills = join(home, ".gemini", "config", "skills");
    const pack = fixturePackage(workdir());
    project({ build: buildProjection({ sourceRoot: source, destSkillsDir: destSkills, packageRoot: pack }) });

    writeFileSync(join(source, "skills/swarm-fixture/scripts/mate.py"), "print('mate')\n");
    const link = join(destSkills, "swarm-fixture/scripts/one.py");
    rmSync(link);
    symlinkSync(join(source, "skills/swarm-fixture/scripts/mate.py"), link);

    const report = doctor({ sourceRoot: source, destSkillsDir: destSkills, packageRoot: pack });
    expect(report.brokenLinks.map((l) => l.path)).toContain("swarm-fixture/scripts/one.py");
    expect(report.ok).toBe(false);
    for (const dir of [home, source, pack]) rmSync(dir, { recursive: true, force: true });
  });

  test("a doctor whose source is missing degrades with JSON and exit 1, not a usage error", () => {
    const home = workdir();
    const configHome = join(home, ".gemini", "config");
    mkdirSync(configHome, { recursive: true });
    const checked = run("doctor", "--gemini-home", configHome, "--agystack-source", join(home, "nope"), "--json");
    expect(checked.status).toBe(1);
    const report = JSON.parse(checked.stdout);
    expect(["absent", "degraded"]).toContain(report.status);
    expect(checked.stderr).toBe("");
    rmSync(home, { recursive: true, force: true });
  });

  test("an install that fails planning with --json reports the error instead of a stack trace", () => {
    const home = workdir();
    const configHome = join(home, ".gemini", "config");
    const source = fixtureSource(workdir());
    mkdirSync(join(source, "skills", "Bad_Name_2"), { recursive: true });
    writeFileSync(join(source, "skills", "Bad_Name_2", "SKILL.md"), "---\nname: oops\n---\nbody");
    const failed = run("install", "--gemini-home", configHome, "--agystack-source", source, "--json");
    expect(failed.status).toBe(1);
    const report = JSON.parse(failed.stdout);
    expect(report.status).toBe("error");
    expect(report.message).toMatch(/portable/);
    expect(failed.stderr).toBe("");
    for (const dir of [home, source]) rmSync(dir, { recursive: true, force: true });
  });
});

describe("the CLI", () => {
  function run(...args) {
    return spawnSync("node", ["tools/antigravity.mjs", ...args], { cwd: repoRoot, encoding: "utf8" });
  }

  test("a doctor on an existing skills directory without a manifest reports absent and exits 1", () => {
    const home = workdir();
    const configHome = join(home, ".gemini", "config");
    mkdirSync(join(configHome, "skills"), { recursive: true });
    writeFileSync(join(configHome, "skills", "how.md"), "user file\n");
    const checked = run("doctor", "--gemini-home", configHome, "--agystack-source", join(home, "nope"), "--json");
    expect(checked.status).toBe(1);
    const report = JSON.parse(checked.stdout);
    expect(report.status).toBe("absent");
    expect(report.ok).toBe(false);
    expect(checked.stderr).toBe("");
    for (const dir of [home]) rmSync(dir, { recursive: true, force: true });
  });

  test("install --json, doctor --json, and an idempotent rerun all exit zero", () => {
    const home = workdir();
    const configHome = join(home, ".gemini", "config");
    const source = fixtureSource(workdir());
    const first = run("install", "--gemini-home", configHome, "--agystack-source", source, "--json");
    expect(first.status, first.stderr + first.stdout).toBe(0);
    const out = JSON.parse(first.stdout);
    expect(out.status).toBe("ok");
    expect(existsSync(join(configHome, "skills/how/SKILL.md"))).toBe(true);

    const second = run("install", "--gemini-home", configHome, "--agystack-source", source, "--json");
    expect(JSON.parse(second.stdout).applied).toEqual([]);
    const checked = run("doctor", "--gemini-home", configHome, "--agystack-source", source, "--json");
    expect(checked.status, checked.stderr).toBe(0);
    expect(JSON.parse(checked.stdout).status).toBe("ok");
    for (const dir of [home, source]) rmSync(dir, { recursive: true, force: true });
  });

  test("drift exits nonzero with a JSON report and usage errors exit 2", () => {
    const home = workdir();
    const configHome = join(home, ".gemini", "config");
    const source = fixtureSource(workdir());
    run("install", "--gemini-home", configHome, "--agystack-source", source, "--json");
    writeFileSync(join(configHome, "skills/how/SKILL.md"), "edited by hand\n");
    const blocked = run("install", "--gemini-home", configHome, "--agystack-source", source, "--json");
    expect(blocked.status).toBe(1);
    const report = JSON.parse(blocked.stdout);
    expect(report.status).toBe("blocked");
    expect(report.problems.some((p) => p.code === "drift")).toBe(true);
    const usage = run("frobnicate");
    expect(usage.status).toBe(2);
    for (const dir of [home, source]) rmSync(dir, { recursive: true, force: true });
  });
});
