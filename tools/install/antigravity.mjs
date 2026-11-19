// Antigravity: T3 starts each antigravity instance as `agy acp --gemini-dir
// <profile>`, where the profile is <T3 userdata>/providers/antigravity/<the
// SHA-256 of the instance ID> (apps/server antigravityAuthSupport.ts). agy
// discovers a plugin at <profile>/config/plugins/<dir>, but T3 lists an
// Antigravity thread's skills only from ~/.gemini/config/skills, which it
// links in as <profile>/config/skills. So the installer keeps one copy of the
// plugin at ~/.gemini/t3-pstack and links every path below into it. agy loads
// a skill once when all its paths resolve to one file, and reports it under
// config/skills, so a skill finds <plugin root> at <profile>/config, whose
// agents/ is linked too. `agy plugin install` writes ~/.gemini whatever
// GEMINI_HOME says, so the installer makes the copy and links itself.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { check, pluginIntact, readJson, tempBeside } from "./common.mjs";

export const ANTIGRAVITY_MANIFEST = ".antigravity-plugin/plugin.json";
// The install directory, which keys Antigravity's enabled state in config.json.
const DIR = "t3-pstack";

const canonicalPath = (userHome) => join(userHome, ".gemini", DIR);
const userSkills = (userHome) => join(userHome, ".gemini", "config", "skills");
const installedVersion = (path) => (existsSync(join(path, ANTIGRAVITY_MANIFEST)) ? readJson(join(path, ANTIGRAVITY_MANIFEST)).version : undefined);
// config.json wins over the manifest wherever it has an entry, and the
// manifest ships the plugin on.
const enabled = (home) => {
  const config = join(home.dir, "config", "config.json");
  return !existsSync(config) || readJson(config).plugins?.[DIR]?.enabled !== false;
};

// Every link an install owns. `check` names the doctor check that reports it.
// The plugin link replaces the copy earlier installers wrote at that path
// (`copy`).
function links(home, userHome, names) {
  const canonical = canonicalPath(userHome);
  return [
    ...names.map((name) => ({ path: join(userSkills(userHome), name), target: join(canonical, "skills", name), kind: "dir", check: "T3 skills list" })),
    { path: join(home.dir, "config", "skills"), target: userSkills(userHome), kind: "dir", check: "linked" },
    { path: join(home.dir, "config", "plugins", DIR), target: canonical, kind: "dir", check: "linked", copy: true },
    { path: join(home.dir, "config", "agents"), target: join(canonical, "agents"), kind: "dir", check: "linked" },
  ];
}

const inside = (path, dir) => !relative(dir, path).startsWith("..");
const linkTarget = (path) => resolve(dirname(path), readlinkSync(path));

// ok, absent, stale (our link to the wrong place), copy (the copy earlier
// installers wrote), or foreign: the user's own, which the installer never
// touches.
function state(row, canonical) {
  const stat = lstatSync(row.path, { throwIfNoEntry: false });
  if (!stat) return "absent";
  if (stat.isSymbolicLink()) {
    const to = linkTarget(row.path);
    return to === row.target ? "ok" : inside(to, canonical) ? "stale" : "foreign";
  }
  return row.copy && existsSync(join(row.path, ANTIGRAVITY_MANIFEST)) ? "copy" : "foreign";
}

// The state a row was in before it was linked, or undefined when it is left
// as it is. A stale link is unlinked first, so a crash leaves the path absent,
// which the next run links, and no second name for the same skill.
function converge(row, canonical) {
  const before = state(row, canonical);
  if (before === "ok" || before === "foreign") return undefined;
  const aside = before === "copy" ? tempBeside(row.path) : undefined;
  if (aside) renameSync(row.path, aside);
  if (before === "stale") unlinkSync(row.path);
  mkdirSync(dirname(row.path), { recursive: true });
  symlinkSync(row.target, row.path, process.platform === "win32" ? "junction" : row.kind);
  if (aside) rmSync(aside, { recursive: true, force: true });
  return before;
}

// The canonical copy, swapped in whole by rename, so a session never loads
// half a plugin and files a release dropped do not linger.
function installCanonical(path, { pluginRoot, version, skills }) {
  const before = installedVersion(path);
  if (before === version && pluginIntact(path, ANTIGRAVITY_MANIFEST, skills)) return [];
  mkdirSync(dirname(path), { recursive: true });
  const fresh = tempBeside(path);
  cpSync(pluginRoot, fresh, { recursive: true });
  const old = existsSync(path) ? tempBeside(path) : undefined;
  if (old) renameSync(path, old);
  renameSync(fresh, path);
  if (old) rmSync(old, { recursive: true, force: true });
  return [before === undefined ? `installed ${version}` : before === version ? `reinstalled ${version}, whose files were missing` : `updated ${before} to ${version}`];
}

// Links into <canonical>/skills/ for a skill this release no longer ships.
function staleLinks(userHome, skills) {
  const dir = userSkills(userHome);
  const shipped = join(canonicalPath(userHome), "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isSymbolicLink() && !skills.has(entry.name) && inside(linkTarget(join(dir, entry.name)), shipped))
    .map((entry) => join(dir, entry.name));
}

export function installAntigravity(home, context) {
  const { userHome, skills } = context;
  const canonical = canonicalPath(userHome);
  // T3 creates the profile private, and keeps it so when it starts the instance.
  mkdirSync(home.dir, { recursive: true, mode: 0o700 });
  const steps = installCanonical(canonical, context);
  const changed = links(home, userHome, [...skills.keys()])
    .map((row) => ({ ...row, before: converge(row, canonical) }))
    .filter((row) => row.before);
  const skillLinks = changed.filter((row) => row.check === "T3 skills list").length;
  if (skillLinks) steps.push(`linked ${skillLinks} skill${skillLinks === 1 ? "" : "s"} in ${userSkills(userHome)}`);
  for (const row of changed.filter((row) => row.check === "linked")) steps.push(`linked ${row.path}${row.before === "copy" ? ", replacing its copy" : ""}`);
  for (const path of staleLinks(userHome, skills)) {
    unlinkSync(path);
    steps.push(`removed ${path}, a skill this release dropped`);
  }
  return steps;
}

export function doctorAntigravity(home, { version, skills, hint, userHome }) {
  const canonical = canonicalPath(userHome);
  const installed = installedVersion(canonical);
  const whole = pluginIntact(canonical, ANTIGRAVITY_MANIFEST, skills);
  const on = enabled(home);
  const rows = links(home, userHome, [...skills.keys()]).map((row) => ({ ...row, state: state(row, canonical) }));
  const profile = rows.filter((row) => row.check === "linked");
  const bad = profile.filter((row) => row.state !== "ok");
  const foreign = bad.filter((row) => row.state === "foreign").map((row) => row.path);
  const listed = rows.filter((row) => row.check === "T3 skills list");
  const own = listed.filter((row) => row.state === "foreign").map((row) => row.path.slice(userSkills(userHome).length + sep.length));
  const missing = listed.filter((row) => row.state !== "ok" && row.state !== "foreign").length;
  return [
    check(
      "installed",
      installed === version && whole,
      !installed ? "not installed" : installed !== version ? `${installed}, expected ${version}` : whole ? installed : `${installed}, but its files at ${canonical} are missing`,
      hint,
    ),
    check(
      "linked",
      bad.length === 0,
      bad.length === 0 ? profile.map((row) => relative(home.dir, row.path)).join(", ") : bad.map((row) => `${row.path} ${row.state === "foreign" ? "is not a link into the plugin" : "is not linked"}`).join(", "),
      foreign.length ? `move ${foreign.join(", ")} aside, then ${hint}` : hint,
    ),
    check("enabled", on, on ? "yes" : `no, ${join(home.dir, "config", "config.json")} turns it off`, `turn t3-pstack on in that file's "plugins" map`),
    check(
      "T3 skills list",
      own.length === 0 && missing === 0,
      [
        own.length && `your own ${own.join(", ")} in ${userSkills(userHome)} hide${own.length === 1 ? "s" : ""} the plugin's`,
        missing && `${missing} of ${listed.length} skills not linked in ${userSkills(userHome)}`,
      ]
        .filter(Boolean)
        .join("; ") || `${listed.length} skills in ${userSkills(userHome)}`,
      own.length ? `rename or remove your own ${own.join(", ")} in ${userSkills(userHome)}, then ${hint}` : hint,
    ),
  ];
}
