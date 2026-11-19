// Antigravity: T3 starts each antigravity instance as `agy acp --gemini-dir
// <profile>`, where the profile is <T3 userdata>/providers/antigravity/<the
// SHA-256 of the instance ID> (apps/server antigravityAuthSupport.ts). agy
// loads every directory under <profile>/config/plugins/ that holds a
// manifest, but T3 lists an Antigravity thread's skills only from
// ~/.gemini/config/skills, which it links in as <profile>/config/skills. So
// the installer keeps one copy of the plugin at ~/.gemini/t3-pstack and links
// every path below into it. agy loads a skill once when all its paths resolve
// to one file, and reports it under config/skills, so a skill finds <plugin
// root> at <profile>/config, whose agents/ is linked too. `agy plugin
// install` writes ~/.gemini whatever GEMINI_HOME says, so the installer makes
// the copy and links itself.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import path, { dirname, join, relative, sep } from "node:path";

import { check, pluginIntact, readJson, tempBeside } from "./common.mjs";

export const ANTIGRAVITY_MANIFEST = ".antigravity-plugin/plugin.json";
// The install directory, which keys Antigravity's enabled state in config.json.
const DIR = "t3-pstack";

const canonicalPath = (userHome) => join(userHome, ".gemini", DIR);
const userSkills = (userHome) => join(userHome, ".gemini", "config", "skills");
// config.json wins over the manifest wherever it has an entry, and the
// manifest ships the plugin on.
const enabled = (home) => {
  const config = join(home.dir, "config", "config.json");
  return !existsSync(config) || readJson(config).plugins?.[DIR]?.enabled !== false;
};

// A link's target as readlink gives it, without the `\\?\` prefix Windows
// puts on a junction's.
export const normalizeLink = (raw) => (raw.startsWith("\\\\?\\UNC\\") ? `\\\\${raw.slice(8)}` : raw.startsWith("\\\\?\\") ? raw.slice(4) : raw);
// Equal as the platform compares paths, so ignoring case on win32.
export const samePath = (a, b, p = path) => p.relative(a, b) === "";
// A symlink whose own text names `target`. A relative link never does.
function linksTo(file, target) {
  const raw = normalizeLink(readlinkSync(file));
  return path.isAbsolute(raw) && samePath(raw, target);
}

// A directory whose manifest names this plugin.
function ours(dir) {
  try {
    return readJson(join(dir, ANTIGRAVITY_MANIFEST)).name === DIR;
  } catch {
    return false;
  }
}

// The leftovers of an interrupted install: tempBeside names for t3-pstack,
// which only this installer writes. agy loads one under config/plugins/ as a
// second plugin.
const LEFTOVER = /^\.t3-pstack\.[0-9a-f-]{36}\.t3-pstack\.tmp$/;
const leftovers = (dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => LEFTOVER.test(name)).map((name) => join(dir, name)) : []);

// Every link an install owns, and who else may write each path. A user skill
// link sits in the user's own skills dir, so only our exact link is ours. The
// profile is T3's private dir, so its links follow T3's own rule: a link
// elsewhere or an empty dir gets replaced, anything else is left. The plugin
// link also migrates the copy earlier installers wrote at that path
// (`legacy`). `check` names the doctor check that reports the row.
function links(home, userHome, names) {
  const canonical = canonicalPath(userHome);
  return [
    ...names.map((name) => ({ path: join(userSkills(userHome), name), target: join(canonical, "skills", name), check: "T3 skills list" })),
    { path: join(home.dir, "config", "skills"), target: userSkills(userHome), check: "linked", profile: true },
    { path: join(home.dir, "config", "plugins", DIR), target: canonical, check: "linked", profile: true, legacy: true },
    { path: join(home.dir, "config", "agents"), target: join(canonical, "agents"), check: "linked", profile: true },
  ];
}

// ok, absent, elsewhere (a profile link to another place), empty (an empty
// profile dir), legacy (an earlier installer's copy), or foreign, which the
// installer never touches.
function state(row) {
  const stat = lstatSync(row.path, { throwIfNoEntry: false });
  if (!stat) return "absent";
  if (stat.isSymbolicLink()) return linksTo(row.path, row.target) ? "ok" : row.profile ? "elsewhere" : "foreign";
  if (!row.profile || !stat.isDirectory()) return "foreign";
  if (readdirSync(row.path).length === 0) return "empty";
  return row.legacy && ours(row.path) ? "legacy" : "foreign";
}

// The state a row was in before it was linked, or undefined when it is left
// as it is. Each step leaves the path absent or linked if it stops midway,
// except the legacy copy, which waits beside config/ where agy does not load
// it, and comes back if the link fails.
function converge(row, profile) {
  const before = state(row);
  if (before === "ok" || before === "foreign") return undefined;
  const link = () => symlinkSync(row.target, row.path, process.platform === "win32" ? "junction" : "dir");
  if (before === "elsewhere") unlinkSync(row.path);
  if (before === "empty") rmdirSync(row.path);
  mkdirSync(dirname(row.path), { recursive: true });
  if (before !== "legacy") {
    link();
    return before;
  }
  const aside = tempBeside(join(profile, DIR));
  renameSync(row.path, aside);
  try {
    link();
  } catch (err) {
    renameSync(aside, row.path);
    throw err;
  }
  rmSync(aside, { recursive: true, force: true });
  return before;
}

// absent, link (any symlink, dangling or not), ours, or foreign.
function canonicalState(dir) {
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return "absent";
  if (stat.isSymbolicLink()) return "link";
  return stat.isDirectory() && ours(dir) ? "ours" : "foreign";
}

const installedVersion = (dir) => (canonicalState(dir) === "ours" ? readJson(join(dir, ANTIGRAVITY_MANIFEST)).version : undefined);

// The copy has every file a session reads: the manifest, each skill, the hook
// file agy runs, and each agent the plugin ships.
const intact = (dir, { pluginRoot, skills }) =>
  pluginIntact(dir, ANTIGRAVITY_MANIFEST, skills) &&
  existsSync(join(dir, "hooks.json")) &&
  readdirSync(join(pluginRoot, "agents")).every((file) => existsSync(join(dir, "agents", file)));

// The canonical copy, swapped in whole by rename, so a session never loads
// half a plugin and files a release dropped do not linger.
function installCanonical(dir, context) {
  const { pluginRoot, version } = context;
  const was = canonicalState(dir);
  if (was === "foreign") throw new Error(`${dir} is not t3-pstack's; move it aside`);
  const before = installedVersion(dir);
  if (before === version && intact(dir, context)) return [];
  mkdirSync(dirname(dir), { recursive: true });
  const fresh = tempBeside(dir);
  const old = was === "ours" ? tempBeside(dir) : undefined;
  try {
    cpSync(pluginRoot, fresh, { recursive: true });
    if (was === "link") unlinkSync(dir);
    if (old) renameSync(dir, old);
    renameSync(fresh, dir);
  } catch (err) {
    if (old && existsSync(old) && !existsSync(dir)) renameSync(old, dir);
    rmSync(fresh, { recursive: true, force: true });
    throw err;
  }
  if (old) rmSync(old, { recursive: true, force: true });
  return [before === undefined ? `installed ${version}` : before === version ? `reinstalled ${version}, whose files were missing` : `updated ${before} to ${version}`];
}

// Our links of a skill this release no longer ships: the exact link an
// earlier release wrote for that name.
function droppedLinks(userHome, skills) {
  const dir = userSkills(userHome);
  const shipped = join(canonicalPath(userHome), "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isSymbolicLink() && !skills.has(entry.name) && linksTo(join(dir, entry.name), join(shipped, entry.name)))
    .map((entry) => join(dir, entry.name));
}

export function installAntigravity(home, context) {
  const { userHome, skills } = context;
  // T3 creates the profile private, and keeps it so when it starts the instance.
  mkdirSync(home.dir, { recursive: true, mode: 0o700 });
  const steps = [];
  for (const path of [join(home.dir, "config", "plugins"), home.dir, join(userHome, ".gemini")].flatMap(leftovers)) {
    rmSync(path, { recursive: true, force: true });
    steps.push(`removed ${path}, left by an interrupted install`);
  }
  steps.push(...installCanonical(canonicalPath(userHome), context));
  const changed = links(home, userHome, [...skills.keys()])
    .map((row) => ({ ...row, before: converge(row, home.dir) }))
    .filter((row) => row.before);
  const skillLinks = changed.filter((row) => row.check === "T3 skills list").length;
  if (skillLinks) steps.push(`linked ${skillLinks} skill${skillLinks === 1 ? "" : "s"} in ${userSkills(userHome)}`);
  for (const row of changed.filter((row) => row.check === "linked")) steps.push(`linked ${row.path}${row.before === "legacy" ? ", replacing its copy" : ""}`);
  for (const path of droppedLinks(userHome, skills)) {
    unlinkSync(path);
    steps.push(`removed ${path}, a skill this release dropped`);
  }
  return steps;
}

export function doctorAntigravity(home, context) {
  const { version, skills, hint, userHome } = context;
  const canonical = canonicalPath(userHome);
  const owner = canonicalState(canonical);
  const installed = installedVersion(canonical);
  const whole = installed !== undefined && intact(canonical, context);
  const on = enabled(home);
  // A link to the right place whose target is gone is not ok.
  const rows = links(home, userHome, [...skills.keys()]).map((row) => {
    const at = state(row);
    return { ...row, state: at === "ok" && !existsSync(row.path) ? "dangling" : at };
  });
  const why = (row) =>
    row.state === "foreign" ? `${row.path} does not link to ${row.target}` : row.state === "dangling" ? `${row.path} links to ${row.target}, which is missing` : `${row.path} is not linked`;
  const profile = rows.filter((row) => row.check === "linked");
  const bad = profile.filter((row) => row.state !== "ok");
  const foreign = bad.filter((row) => row.state === "foreign").map((row) => row.path);
  const stray = leftovers(join(home.dir, "config", "plugins"));
  const listed = rows.filter((row) => row.check === "T3 skills list");
  const own = listed.filter((row) => row.state === "foreign").map((row) => row.path.slice(userSkills(userHome).length + sep.length));
  const missing = listed.filter((row) => row.state !== "ok" && row.state !== "foreign").length;
  const dropped = droppedLinks(userHome, skills).length;
  return [
    owner === "foreign"
      ? check("installed", false, `${canonical} is not t3-pstack's`, `move ${canonical} aside, then ${hint}`)
      : check(
          "installed",
          installed === version && whole,
          !installed ? "not installed" : installed !== version ? `${installed}, expected ${version}` : whole ? installed : `${installed}, but its files at ${canonical} are missing`,
          hint,
        ),
    check(
      "linked",
      bad.length === 0 && stray.length === 0,
      bad.length === 0 && stray.length === 0
        ? profile.map((row) => relative(home.dir, row.path)).join(", ")
        : [...bad.map(why), ...stray.map((path) => `${path} is left by an interrupted install, and Antigravity loads it as a second plugin`)].join(", "),
      foreign.length ? `move ${foreign.join(", ")} aside, then ${hint}` : hint,
    ),
    check("enabled", on, on ? "yes" : `no, ${join(home.dir, "config", "config.json")} turns it off`, `turn t3-pstack on in that file's "plugins" map`),
    check(
      "T3 skills list",
      own.length === 0 && missing === 0 && dropped === 0,
      [
        own.length && `your own ${own.join(", ")} in ${userSkills(userHome)} hide${own.length === 1 ? "s" : ""} the plugin's`,
        missing && `${missing} of ${listed.length} skills not linked in ${userSkills(userHome)}`,
        dropped && `${dropped} link${dropped === 1 ? "" : "s"} to skills this release dropped in ${userSkills(userHome)}`,
      ]
        .filter(Boolean)
        .join("; ") || `${listed.length} skills in ${userSkills(userHome)}`,
      own.length ? `rename or remove your own ${own.join(", ")} in ${userSkills(userHome)}, then ${hint}` : hint,
    ),
  ];
}
