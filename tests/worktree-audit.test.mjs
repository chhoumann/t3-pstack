import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { validatePluginLayout } from "../tools/generate.mjs";

const audit = fileURLToPath(
  new URL("../plugins/pstack/skills/poteto-mode/scripts/worktree-audit.sh", import.meta.url),
);
const pluginRoot = fileURLToPath(new URL("../plugins/pstack", import.meta.url));
const TOOLS = ["git", "jq", "du", "awk", "sort", "date", "mktemp", "grep", "head", "rm", "xargs", "stat"];

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const gitEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...gitEnv },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function commit(cwd, name) {
  writeFileSync(join(cwd, `${name}.txt`), `${name}\n`);
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", name);
}

function createFixture(prefix = "worktree-audit-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(root, "init", "--bare", "remote.git");
  git(repo, "init");
  git(repo, "remote", "add", "origin", join(root, "remote.git"));
  commit(repo, "base");
  git(repo, "push", "-q", "origin", "main");
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const tool of TOOLS) symlinkSync(Bun.which(tool), join(bin, tool));
  return { root, repo, bin };
}

function addWorktree({ root, repo }, name, ...flags) {
  const tree = join(root, name);
  git(repo, "worktree", "add", "-q", ...(flags.length ? flags : ["-b", name]), tree);
  return tree;
}

function runAudit({ root, repo, bin }, ...args) {
  const result = spawnSync(Bun.which("bash"), [audit, ...args, repo], {
    encoding: "utf8",
    env: { ...gitEnv, PATH: bin, HOME: root },
  });
  expect(result.stderr).not.toContain("error:");
  expect(result.status).toBe(0);
  return Object.fromEntries(
    result.stdout
      .trim()
      .split("\n")
      .slice(2)
      .map((line) => line.split("\t"))
      .map((cells) => [
        cells[8].split("/").at(-1),
        { merged: cells[2], dirty: cells[3], pr: cells[5], lastChat: cells[6], bucket: cells[7] },
      ]),
  );
}

// The audit reads PR state from Origin's CLI when it can and from gh otherwise.
// Most hosts have no Origin CLI, so the gh path is the one that runs: here it
// gets a PATH with a fake gh and no origin at all.
test("fills the PR column from gh when no origin command is on PATH", () => {
  const fixture = createFixture();
  for (const branch of ["shipped", "in-review", "no-pr"]) commit(addWorktree(fixture, branch), branch);
  const calls = join(fixture.root, "gh-calls");
  writeFileSync(
    join(fixture.bin, "gh"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${calls}"
printf '%s' '[{"number":7,"state":"MERGED","headRefName":"shipped"},{"number":8,"state":"OPEN","headRefName":"in-review"}]'
`,
  );
  chmodSync(join(fixture.bin, "gh"), 0o755);

  const env = { ...gitEnv, PATH: fixture.bin, HOME: fixture.root };
  expect(spawnSync(Bun.which("bash"), ["-c", "command -v origin"], { env }).status).toBe(1);
  const rows = runAudit(fixture);
  expect(readFileSync(calls, "utf8")).toBe(
    "pr list --author @me --state all --limit 1000 --json number,state,headRefName\n",
  );
  const summary = ({ pr, lastChat, bucket }) => ({ pr, lastChat, bucket });
  expect(Object.fromEntries(Object.entries(rows).map(([name, row]) => [name, summary(row)]))).toEqual({
    shipped: { pr: "#7/merged", lastChat: "-", bucket: "safe" },
    "in-review": { pr: "#8/open", lastChat: "-", bucket: "hold-open-pr" },
    "no-pr": { pr: "-", lastChat: "-", bucket: "review" },
  });
});

test("lists every worktree when the checkout and its worktrees sit under a path with spaces", () => {
  const fixture = createFixture("worktree audit ");
  writeFileSync(join(addWorktree(fixture, "notes"), "notes.md"), "run log\n");
  addWorktree(fixture, "idle");
  const rows = runAudit(fixture);
  expect(Object.keys(rows).sort()).toEqual(["idle", "notes"]);
  expect([rows.notes.dirty, rows.notes.bucket]).toEqual(["scratch:1", "hold-scratch"]);
});

test("an ignored file outside build and cache directories holds the worktree, ignored dependencies do not", () => {
  const fixture = createFixture();
  writeFileSync(join(fixture.repo, ".git/info/exclude"), ".env\nnode_modules/\n");
  const secrets = addWorktree(fixture, "secrets");
  writeFileSync(join(secrets, ".env"), "TOKEN=only-here\n");
  const deps = addWorktree(fixture, "deps");
  for (const dir of ["node_modules/pkg", "packages/app/node_modules/pkg"]) {
    mkdirSync(join(deps, dir), { recursive: true });
    writeFileSync(join(deps, dir, "index.js"), "module.exports = {};\n");
  }
  const rows = runAudit(fixture);
  expect([rows.secrets.dirty, rows.secrets.bucket]).toEqual(["ignored:1", "hold-ignored"]);
  expect([rows.deps.dirty, rows.deps.bucket]).toEqual(["clean", "safe"]);
});

test("untracked scratch holds the worktree, and tracked edits beside it print both counts", () => {
  const fixture = createFixture();
  const notes = addWorktree(fixture, "notes");
  writeFileSync(join(notes, "notes.md"), "run log\n");
  const both = addWorktree(fixture, "both");
  writeFileSync(join(both, "base.txt"), "edited\n");
  writeFileSync(join(both, "notes.md"), "run log\n");
  const rows = runAudit(fixture);
  expect([rows.notes.dirty, rows.notes.bucket]).toEqual(["scratch:1", "hold-scratch"]);
  expect([rows.both.dirty, rows.both.bucket]).toEqual(["wip:1,scratch:1", "hold-wip"]);
});

test("an ignored file inside a tracked directory named build still holds the worktree", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.repo, "build"));
  commit(join(fixture.repo, "build"), "run");
  git(fixture.repo, "push", "-q", "origin", "main");
  writeFileSync(join(fixture.repo, ".git/info/exclude"), ".env\n");
  writeFileSync(join(addWorktree(fixture, "tracked-build"), "build/.env"), "TOKEN=only-here\n");
  const rows = runAudit(fixture);
  expect([rows["tracked-build"].dirty, rows["tracked-build"].bucket]).toEqual(["ignored:1", "hold-ignored"]);
});

test("a worktree git cannot read holds instead of reading clean", () => {
  const fixture = createFixture();
  const broken = addWorktree(fixture, "broken");
  writeFileSync(git(broken, "rev-parse", "--path-format=absolute", "--git-path", "index").trim(), "not an index\n");
  const rows = runAudit(fixture);
  expect([rows.broken.dirty, rows.broken.bucket]).toEqual(["unknown", "hold-wip"]);
});

test("a status.showUntrackedFiles=no config hides neither scratch nor ignored files from the audit", () => {
  const fixture = createFixture();
  writeFileSync(join(fixture.repo, ".git/info/exclude"), ".env\n");
  git(fixture.repo, "config", "status.showUntrackedFiles", "no");
  writeFileSync(join(addWorktree(fixture, "secrets"), ".env"), "TOKEN=only-here\n");
  writeFileSync(join(addWorktree(fixture, "notes"), "notes.md"), "run log\n");
  const rows = runAudit(fixture);
  expect([rows.secrets.dirty, rows.secrets.bucket]).toEqual(["ignored:1", "hold-ignored"]);
  expect([rows.notes.dirty, rows.notes.bucket]).toEqual(["scratch:1", "hold-scratch"]);
});

test("a commit only the worktree's HEAD reflog reaches holds it, a rebased branch's old tip does not, even parked at HEAD", () => {
  const fixture = createFixture();
  const detached = addWorktree(fixture, "detached", "--detach");
  commit(detached, "detached work");
  git(detached, "checkout", "-q", "--detach", "origin/main");
  const rebased = addWorktree(fixture, "rebased");
  commit(rebased, "feature");
  const oldTip = git(rebased, "rev-parse", "HEAD").trim();
  const landed = addWorktree(fixture, "landed");
  commit(landed, "trunk moves");
  git(landed, "push", "-q", "origin", "HEAD:main");
  git(rebased, "rebase", "-q", "origin/main");
  git(rebased, "push", "-q", "origin", "HEAD:main");
  const parked = join(fixture.root, "parked");
  git(fixture.repo, "worktree", "add", "-q", "--detach", parked, oldTip);
  git(parked, "reflog", "expire", "--expire=now", "HEAD");
  const rows = runAudit(fixture);
  expect([rows.detached.merged, rows.detached.dirty, rows.detached.bucket]).toEqual(["YES", "reflog:1", "hold-reflog"]);
  expect([rows.rebased.merged, rows.rebased.dirty, rows.rebased.bucket]).toEqual(["YES", "clean", "safe"]);
  expect(rows.parked.dirty).toBe("clean");
});

test("a detached commit HEAD still points at holds the worktree after its reflog expires", () => {
  const fixture = createFixture();
  const old = addWorktree(fixture, "old", "--detach");
  commit(old, "old work");
  git(old, "reflog", "expire", "--expire=now", "HEAD");
  const rows = runAudit(fixture);
  expect([rows.old.dirty, rows.old.bucket]).toEqual(["reflog:1", "hold-reflog"]);
});

test("a HEAD reflog walk that fails holds the worktree instead of reading clean", () => {
  const fixture = createFixture();
  const detached = addWorktree(fixture, "detached", "--detach");
  commit(detached, "detached work");
  commit(detached, "more work");
  const tip = git(detached, "rev-parse", "HEAD").trim();
  git(detached, "checkout", "-q", "--detach", "origin/main");
  const object = join(fixture.repo, ".git/objects", tip.slice(0, 2), tip.slice(2));
  chmodSync(object, 0o644);
  writeFileSync(object, "corrupt\n");
  const rows = runAudit(fixture);
  expect([rows.detached.dirty, rows.detached.bucket]).toEqual(["reflog:?", "hold-reflog"]);
});

test("the audit writes nothing to the repository unless --fetch is given", () => {
  const fixture = createFixture();
  const idle = addWorktree(fixture, "idle");
  // A tracked file whose mtime no longer matches the index, so a plain git
  // status would rewrite the index under another agent's feet.
  utimesSync(join(idle, "base.txt"), new Date(0), new Date(0));
  const index = git(idle, "rev-parse", "--path-format=absolute", "--git-path", "index").trim();
  git(fixture.root, "clone", "-q", "remote.git", "other");
  const other = join(fixture.root, "other");
  commit(other, "later");
  git(other, "push", "-q", "origin", "main");
  const tracked = git(fixture.repo, "rev-parse", "origin/main");
  const indexBytes = readFileSync(index);

  runAudit(fixture);
  expect(git(fixture.repo, "rev-parse", "origin/main")).toBe(tracked);
  expect(readFileSync(index).equals(indexBytes)).toBe(true);

  runAudit(fixture, "--fetch");
  expect(git(fixture.repo, "rev-parse", "origin/main")).toBe(git(other, "rev-parse", "HEAD"));
});

test("the generator check rejects a playbook that force-removes a worktree or deletes one by hand", () => {
  const root = mkdtempSync(join(tmpdir(), "worktree-playbook-"));
  roots.push(root);
  const playbooks = join(root, "skills/poteto-mode/playbooks");
  mkdirSync(playbooks, { recursive: true });
  writeFileSync(join(root, "skills/poteto-mode/SKILL.md"), "---\nname: poteto-mode\n---\n");
  writeFileSync(
    join(playbooks, "worktree-cleanup.md"),
    [
      "5. Prune. Per path, `git worktree remove --force <path>`.",
      "If the dir survives, `rm -rf` it.",
      "A locked one takes `git worktree remove -ff <path>`.",
      "Or `rm -r -f <path>`.",
      "Then `git -C <path> clean -fdx` drops what is left.",
      "Or `rm -f -r <path>`.",
      "Or `git -C <path> clean -e keep -fdx`.",
      "Delete approved scratch with `git -C <path> clean -fd -- <file>`.",
      "Untrack a directory with `git -C <path> rm -r --cached <dir>`.",
      "Then `git worktree prune` drops stale entries.",
      "If git refuses, rm -rf the directory.",
      "Run `git -C <path>` rm -rf it.",
      "Or `git -C x; rm -rf y`.",
    ].join("\n"),
  );
  let message = "";
  try {
    validatePluginLayout(root);
  } catch (err) {
    message = err.message;
  }
  expect([...message.matchAll(/worktree-cleanup\.md:(\d+):/g)].map((hit) => Number(hit[1]))).toEqual([1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 13]);
  expect(() => validatePluginLayout(pluginRoot)).not.toThrow();
});
