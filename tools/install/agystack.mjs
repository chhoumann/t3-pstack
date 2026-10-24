// Projection of the agystack Antigravity plugin into a Gemini config skills
// directory. One flat projection: for each source skill a real projected
// directory holds a generated SKILL.md (the native bytes with a T3-only
// routing note inserted after the frontmatter) and one relative symlink per
// other native file, so skill-internal pointers keep reading native content
// from the plugin source. Real directories beat directory symlinks because a
// directory symlink would let `../` paths escape into the source tree and
// bypass projected overrides.
//
// A dot-prefixed manifest at the projection root records exactly the entries
// this tool owns (paths, hashes, link targets). User-owned files are never
// adopted, modified, or removed. The whole projection is validated against
// the destination before the first write: any collision with an unowned path
// or drift in an owned generated file fails the install without writing.
// Reinstalling an unchanged source changes nothing (idempotent), and owned
// entries the source no longer ships are retired.
//
// Adapter resources are copied, never linked, so live edits to the source
// plugin cannot change an installed projection behind the manifest's back.
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const MANIFEST_NAME = ".t3-agystack-manifest.json";
export const MANIFEST_SCHEMA = 1;
export const ADAPTER_SKILL_NAME = "t3-agystack";
export const ADAPTER_SCRIPTS_DIR = `${ADAPTER_SKILL_NAME}/scripts`;
export const ADAPTER_RESOURCE_PATH = `${ADAPTER_SCRIPTS_DIR}/cloud-run.mjs`;

const PORTABLE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKIP_DIRS = new Set(["node_modules", "__pycache__", ".git"]);
const SKIP_FILES = new Set([".DS_Store"]);

export class ProjectionBlocked extends Error {
  constructor(message, problems) {
    super(message);
    this.name = "ProjectionBlocked";
    this.problems = problems;
  }
}

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const shortHash = (bytes) => sha256Hex(bytes).slice(0, 16);

// Realpath the deepest existing ancestor of `path` and keep the remainder, so
// path comparisons across destinations that do not exist yet (and across
// macOS spellings of the same filesystem) stay consistent. A symlink at the
// path itself is never dereferenced: on a rerun that leaf is one of this
// projection's resource links, and following it would resolve to the source.
export function canonicalPath(path) {
  path = resolve(path);
  const origin = path;
  for (let dir = path; ; dir = dirname(dir)) {
    const st = lstatSync(dir, { throwIfNoEntry: false });
    if (st && st.isSymbolicLink()) break;
    if (st) return realpathSync(dir) + origin.slice(dir.length);
    if (dir === dirname(dir)) return origin;
  }
  return realpathSync(dirname(origin)) + "/" + basename(origin);
}

function writeAtomic(path, bytes) {
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  writeFileSync(temp, bytes);
  renameSync(temp, path);
}

function linkAtomic(target, path) {
  const temp = join(dirname(path), `.${randomUUID()}.lk-tmp`);
  symlinkSync(target, temp);
  renameSync(temp, path);
}

// The routing note every generated SKILL.md carries. Tiny and dead text
// outside T3: it activates only when a callable `delegate_task` exists or the
// ACP fallback (`T3_ACP_MCP_NODE`) is set, and it yields to the native
// instructions otherwise. `anchor` binds the generated file to the native
// source bytes it was built from.
export function adapterNote(anchor) {
  return [
    "> **t3-agystack adapter note.** Applies only inside T3. Check now, in order:",
    "1. a `delegate_task` MCP tool is actually callable in this session, or",
    "2. the environment sets `T3_ACP_MCP_NODE` (the ACP transport fallback).",
    "Neither check passes: ignore this note. Follow only the original instructions below, unchanged; this is the standalone boundary.",
    "Either check passes: this note and the sibling `t3-agystack` skill take precedence over every native orchestration instruction below (`invoke_subagent`, `invoke_task`, `manage_subagents`, watchdog timers, native tier config). Never use native subagents or native descendants as an alternative. Run this skill's playbook yourself as the one explicit coordinator. Create child work only through `delegate_task` or the ACP fallback, and open every child brief with the structured delegate envelope from `t3-agystack` (explicit role and task ownership, never only an adapter filename). Cloud Run swarms stay external batch work: only a child explicitly briefed as `cloud-controller` may create and control one run.",
    "",
    `<!-- t3-agystack generated SKILL.md (t3-pstack tools/antigravity.mjs). Do not edit by hand: any change is drift and the next install aborts. native anchor ${anchor} -->`,
    "",
  ].join("\n");
}

// Insert the note after the frontmatter, or at the very top when the file has
// none. The native bytes are preserved exactly; the note is the only insertion.
export function insertNote(sourceText, note) {
  if (!/^---\r?\n/.test(sourceText)) return note + sourceText;
  const lines = sourceText.split(/(?<=\n)/);
  for (let i = 1; i < lines.length; i += 1) {
    if (/^---\r?\n?$/.test(lines[i])) return `${lines.slice(0, i + 1).join("")}${note}${lines.slice(i + 1).join("")}`;
  }
  return note + sourceText;
}

// Every skill directory under `<source>/skills` this projection would draw
// from. Names must be portable Agent Skills names, and `t3-agystack` is
// reserved for the adapter itself.
export function listSourceSkills(sourceRoot) {
  const skillsDir = join(sourceRoot, "skills");
  if (!existsSync(skillsDir)) throw new Error(`agystack source ${sourceRoot}: no skills/ directory`);
  const skills = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    if (!PORTABLE_NAME.test(entry.name) || entry.name.length > 64) {
      throw new Error(`agystack source skill "${entry.name}" is not a portable skill name; refusing to project it`);
    }
    if (entry.name === ADAPTER_SKILL_NAME) throw new Error(`agystack source uses the reserved adapter skill name ${ADAPTER_SKILL_NAME}; refusing to project it`);
    skills.push({ name: entry.name, dir: join(skillsDir, entry.name), skillFile });
  }
  return skills;
}

// Build the whole projection as a validated command list. Nothing touches the
// destination here. `packageRoot` is the installed t3-pstack package: it
// always supplies the adapter skill, and it supplies the cloud bridge scripts
// (cloud-run.mjs and its sibling modules under
// `plugins/pstack/skills/t3-agystack/scripts/`) when the cloud unit is installed.
export function buildProjection({ sourceRoot, destSkillsDir, packageRoot }) {
  if (!sourceRoot) throw new Error("a --agystack-source (resolved agystack plugin directory) is required");
  if (!destSkillsDir) throw new Error("a destination skills directory is required");
  if (!packageRoot) throw new Error("the installed t3-pstack package root is required");
  sourceRoot = resolve(sourceRoot);
  destSkillsDir = resolve(destSkillsDir);
  packageRoot = resolve(packageRoot);
  if (!existsSync(sourceRoot)) throw new Error(`agystack source ${sourceRoot}: does not exist`);

  const sourceSkills = listSourceSkills(sourceRoot);
  const adapterSKILLPath = join(packageRoot, "plugins/pstack/skills", ADAPTER_SKILL_NAME, "SKILL.md");
  if (!existsSync(adapterSKILLPath)) {
    throw new Error(`the installed package does not ship the adapter skill (expected ${relative(packageRoot, adapterSKILLPath)}); projection impossible`);
  }
  const entries = [];
  const adapterBytes = readFileSync(adapterSKILLPath);
  entries.push({ kind: "adapter-skill", path: `${ADAPTER_SKILL_NAME}/SKILL.md`, bytes: adapterBytes, hash: sha256Hex(adapterBytes), anchor: shortHash(adapterBytes) });

  // The adapter's bridge scripts ship as a resource set (cloud-run.mjs and the
  // sibling modules it imports). Copy them all generically when the installed
  // package provides them, so the skill's relative references keep working.
  const scriptsDir = join(packageRoot, "plugins/pstack/skills", ADAPTER_SKILL_NAME, "scripts");
  if (existsSync(scriptsDir)) {
    for (const file of listResourceFiles(scriptsDir)) {
      const rel = relative(scriptsDir, file).split("\\").join("/");
      const bytes = readFileSync(file);
      entries.push({ kind: "adapter-resource", path: `${ADAPTER_SCRIPTS_DIR}/${rel}`, bytes, hash: sha256Hex(bytes) });
    }
  }

  for (const skill of sourceSkills) {
    const nativeBytes = readFileSync(skill.skillFile);
    const anchor = shortHash(nativeBytes);
    const bytes = Buffer.from(insertNote(nativeBytes.toString("utf8"), adapterNote(anchor)), "utf8");
    entries.push({ kind: "generated-skill", path: `${skill.name}/SKILL.md`, bytes, hash: sha256Hex(bytes), anchor });
    for (const file of listResourceFiles(skill.dir)) {
      const rel = relative(skill.dir, file).split("\\").join("/");
      const bytes2 = readFileSync(file);
      entries.push({
        kind: "resource-link",
        path: `${skill.name}/${rel}`,
        // Both sides of the link are canonicalized through realpath where the
        // filesystem exists, so macOS aliases like /var vs /private/var and
        // symlinked plugin dirs compute the same climb on both sides.
        target: relative(dirname(canonicalPath(join(destSkillsDir, `${skill.name}/${rel}`))), canonicalPath(file)),
        hash: sha256Hex(bytes2),
      });
    }
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.path)) throw new Error(`projection plan has duplicate path ${entry.path}`);
    seen.add(entry.path);
  }
  return { sourceRoot: canonicalPath(sourceRoot), destSkillsDir, packageRoot: realpathSync(packageRoot), sourceSkillNames: sourceSkills.map((s) => s.name), entries };
}

function listResourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...listResourceFiles(join(dir, entry.name)));
    } else {
      if (entry.name === "SKILL.md" || SKIP_FILES.has(entry.name)) continue;
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

// Read the ownership manifest at the projection root. None found: `{ owned: new Map() }`
// (a fresh destination). Present but unreadable or of another schema: refuse,
// because only an unreadable manifest can guard ownership safely.
export function readOwnedManifest(destSkillsDir) {
  let text;
  try {
    text = readFileSync(join(destSkillsDir, MANIFEST_NAME), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { manifest: null, owned: new Map() };
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProjectionBlocked(`${MANIFEST_NAME} is not valid JSON; fix or remove it by hand before installing`, [{ path: MANIFEST_NAME, code: "manifest-invalid", detail: "unreadable JSON" }]);
  }
  if (parsed?.schema !== MANIFEST_SCHEMA || !Array.isArray(parsed?.entries)) {
    throw new ProjectionBlocked(`${MANIFEST_NAME} has schema ${JSON.stringify(parsed?.schema)}; expected ${MANIFEST_SCHEMA}. Update t3-pstack or remove the manifest by hand`, [{ path: MANIFEST_NAME, code: "manifest-invalid", detail: "wrong schema" }]);
  }
  const owned = new Map();
  for (const entry of parsed.entries) owned.set(entry.path, entry);
  return { manifest: parsed, owned };
}

// Validate the plan against the destination. Returns a problem list; an empty
// list means the install may write. Ownership comes from the manifest, never
// from path shapes, so a user file at the same path is always a collision and
// a user edit in an owned generated file is always drift.
export function checkProjection({ build }) {
  const { destSkillsDir, entries } = build;
  const { owned } = readOwnedManifest(destSkillsDir);
  const problems = [];

  // Owned entries that this source no longer ships must still be intact before
  // the install may retire them.
  const planned = new Set(entries.map((e) => e.path));
  for (const [path, mine] of owned) {
    if (planned.has(path)) continue;
    const at = join(destSkillsDir, path);
    const st = lstatSync(at, { throwIfNoEntry: false });
    if (!st) continue; // already gone; retiring is a no-op
    if (mine.kind === "resource-link") {
      if (!st.isSymbolicLink()) problems.push({ path, code: "drift", detail: "an owned link path now holds something else; restore or remove it by hand" });
    } else if (!st.isSymbolicLink()) {
      if (sha256Hex(readFileSync(at)) !== mine.hash) problems.push({ path, code: "drift", detail: "changed since this projection wrote it; restore or remove it by hand" });
    } else {
      problems.push({ path, code: "drift", detail: "an owned generated file path now holds a symlink; remove it by hand" });
    }
  }

  for (const entry of entries) {
    const path = entry.path;
    const kind = entry.kind;
    const at = join(destSkillsDir, path);
    const st = lstatSync(at, { throwIfNoEntry: false });
    if (!st) continue;
    const mine = owned.get(path);
    if (!mine) {
      problems.push({ path, code: "collision", detail: "a file or directory the projection did not write already holds this path; the projection never adopts or overwrites user files" });
      continue;
    }
    if (kind === "resource-link") {
      if (st.isSymbolicLink()) continue; // a link whose target is stale is repairable below
      problems.push({ path, code: "drift", detail: "the projection owns a link at this path but the destination holds a real file; move it out by hand first" });
      continue;
    }
    if (st.isSymbolicLink()) problems.push({ path, code: "drift", detail: "the projection owns a generated file at this path but the destination holds a symlink; remove it by hand" });
    else if (sha256Hex(readFileSync(at)) !== mine.hash) problems.push({ path, code: "drift", detail: "the manifest says this projection wrote this file, but its bytes changed; restore the committed projection by hand" });
  }

  return problems;
}

export function applyProjection({ build }) {
  const { destSkillsDir, entries } = build;
  const { owned } = readOwnedManifest(destSkillsDir);
  mkdirSync(destSkillsDir, { recursive: true });
  const applied = [];
  const skipped = [];

  for (const entry of entries) {
    const at = join(destSkillsDir, entry.path);
    if (entry.kind === "resource-link") {
      const current = (() => {
        const st = lstatSync(at, { throwIfNoEntry: false });
        return st?.isSymbolicLink() ? readlinkSync(at) : null;
      })();
      if (current === entry.target) {
        skipped.push(entry);
        continue;
      }
      if (current !== null) rmSync(at);
      mkdirSync(dirname(at), { recursive: true });
      linkAtomic(entry.target, at);
      applied.push(entry);
      continue;
    }
    if (existsSync(at) && sha256Hex(readFileSync(at)) === entry.hash) {
      skipped.push(entry);
      continue;
    }
    mkdirSync(dirname(at), { recursive: true });
    writeAtomic(at, entry.bytes);
    applied.push(entry);
  }

  // Retire owned entries this source no longer projects.
  const planned = new Set(entries.map((e) => e.path));
  const removed = [];
  for (const [path] of owned) {
    if (planned.has(path)) continue;
    const at = join(destSkillsDir, path);
    if (!existsSync(at) && !lstatSync(at, { throwIfNoEntry: false })) continue;
    rmSync(at, { recursive: true, force: true });
    removed.push({ path, kind: owned.get(path)?.kind ?? "unknown" });
    for (let dir = dirname(at); dir !== destSkillsDir && dir.startsWith(destSkillsDir); dir = dirname(dir)) {
      if (!existsSync(dir) || readdirSync(dir).length) break;
      rmdirSync(dir);
    }
  }

  const manifest = {
    schema: MANIFEST_SCHEMA,
    source: build.sourceRoot,
    entries: entries.map(({ kind, path, hash, anchor, target }) => (target ? { kind, path, hash, target } : anchor ? { kind, path, hash, anchor } : { kind, path, hash })),
  };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestPath = join(destSkillsDir, MANIFEST_NAME);
  if (!existsSync(manifestPath) || readFileSync(manifestPath, "utf8") !== text) writeAtomic(manifestPath, text);
  return { applied, skipped, removed, manifestPath };
}

// Validate, then apply. Throws ProjectionBlocked (with `.problems`) and
// writes nothing when validation fails.
export function project({ build }) {
  const problems = checkProjection({ build });
  if (problems.length) throw new ProjectionBlocked(`projection blocked before any write (${problems.length} problem${problems.length === 1 ? "" : "s"})`, problems);
  return applyProjection({ build });
}

// Read-only report on the installed projection. `ok` needs a live source, an
// intact manifest, generated files at their recorded hashes, and working
// links. `absent` means neither a source nor a manifest exists at all.
export function doctor({ sourceRoot, destSkillsDir, packageRoot }) {
  const report = { status: "ok", source: { path: sourceRoot, present: false, skills: [] }, manifest: null, drift: [], brokenLinks: [], adapterResource: { bundled: false, projected: false, projectedFiles: 0 }, userOwnedPaths: [], ok: true };
  if (sourceRoot && existsSync(join(resolve(sourceRoot), "skills"))) {
    try {
      report.source = { path: sourceRoot, present: true, skills: listSourceSkills(sourceRoot).map((s) => s.name) };
    } catch (error) {
      report.status = "degraded";
      report.ok = false;
      report.source.problem = String(error.message ?? error);
    }
  }
  if (!destSkillsDir || !existsSync(destSkillsDir)) {
    report.status = "absent";
    return report;
  }

  let owned;
  try {
    ({ owned } = readOwnedManifest(destSkillsDir));
  } catch (error) {
    report.status = "degraded";
    report.ok = false;
    report.manifest = { present: true, invalid: true, reason: String(error.message ?? error) };
    return report;
  }
  const onDisk = [];
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const at = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(at, rel ? `${rel}/${entry.name}` : entry.name);
      } else {
        if (SKIP_FILES.has(entry.name)) continue;
        onDisk.push(rel ? `${rel}/${entry.name}` : entry.name);
      }
    }
  };
  walk(destSkillsDir, "");

  if (!owned.size && !existsSync(join(destSkillsDir, MANIFEST_NAME))) return { ...report, status: "absent", userOwnedPaths: onDisk };

  report.manifest = { present: existsSync(join(destSkillsDir, MANIFEST_NAME)), entries: [...owned.keys()].length };
  for (const [path, mine] of owned) {
    const at = join(destSkillsDir, path);
    const st = lstatSync(at, { throwIfNoEntry: false });
    if (mine.kind === "resource-link") {
      if (!st) report.brokenLinks.push({ path, detail: "link missing" });
      else if (!st.isSymbolicLink()) report.brokenLinks.push({ path, detail: "path holds a real file, not the owned link" });
      else if (!existsSync(at)) report.brokenLinks.push({ path, detail: "dangling link (source moved or file removed)" });
      continue;
    }
    if (!st) report.drift.push(path);
    else if (!st.isSymbolicLink() && sha256Hex(readFileSync(at)) !== mine.hash) report.drift.push(path);
    else if (st.isSymbolicLink()) report.drift.push(path);
  }
  const bundledScripts = join(packageRoot ?? "", "plugins/pstack/skills", ADAPTER_SKILL_NAME, "scripts");
  const projectedScripts = join(destSkillsDir, ADAPTER_SCRIPTS_DIR);
  report.adapterResource = {
    bundled: existsSync(join(bundledScripts, "cloud-run.mjs")),
    projected: existsSync(join(projectedScripts, "cloud-run.mjs")),
    projectedFiles: existsSync(projectedScripts) ? listResourceFiles(projectedScripts).length : 0,
  };
  report.userOwnedPaths = onDisk.filter((path) => path !== MANIFEST_NAME && !owned.has(path));
  if (report.drift.length || report.brokenLinks.length || report.manifest.invalid || !report.source.present) {
    report.status = "degraded";
    report.ok = false;
  }
  return report;
}
