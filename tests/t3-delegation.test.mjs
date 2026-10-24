import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const skill = (path) => readFileSync(new URL(`../plugins/pstack/skills/${path}`, import.meta.url), "utf8");
const poteto = skill("poteto-mode/SKILL.md");
const playbook = (name) => skill(`poteto-mode/playbooks/${name}.md`);

test("same-conversation continuation excludes independent review rounds", () => {
  const fresh = poteto.split("**Fresh subagents by default.**")[1].split("**Dispatch on T3.**")[0];
  expect(fresh).toContain("`t3_thread_send`");
  expect(fresh).toContain("`childThreadId`");
  expect(fresh).toMatch(/only when.*state that lives in that agent/s);
  expect(fresh).toMatch(/exception never applies to independent review rounds/);
});

test("each independent review round delegates with history and its own retry-stable ID", () => {
  const review = poteto.match(/\*\*Independent review rounds\.\*\*[^\n]+/)?.[0] ?? "";
  expect(review).toMatch(/fresh `delegate_task`/);
  for (const context of ["original brief", "prior findings", "responses", "unresolved objections"]) {
    expect(review).toContain(context);
  }
  expect(review).toMatch(/distinct `clientRequestId`.*stable across retries/);
  expect(review).toContain("`taskId`");
  expect(review).toMatch(/Never.*`t3_thread_send`.*`childThreadId`/);
});

test("worker ownership stays in child tasks and top-level conversations require an explicit request", () => {
  const autopilot = playbook("autopilot-full");
  expect(autopilot).toMatch(/Each owner is a `delegate_task` child/);
  expect(autopilot).toContain('isolation: "worktree"');
  expect(autopilot).not.toMatch(/t3_thread_launch|create_threads/);
  expect(poteto).toMatch(/`t3_thread_launch` and `create_threads`.*only.*explicit.*user request/);

  const orchestrate = playbook("orchestrate");
  expect(orchestrate).toMatch(/lifecycle.*`delegate_task`.*`task_status`.*`task_cancel`/);
  expect(orchestrate).toMatch(/same-conversation.*independent review rounds.*fresh `delegate_task`/);
});

test("writing children use T3 worktree isolation from committed parent state", () => {
  for (const [name, text] of [
    ["poteto-mode", poteto],
    ["swarm", skill("swarm/SKILL.md")],
    ["orchestrate", playbook("orchestrate")],
    ["autopilot-full", playbook("autopilot-full")],
    ["feature", playbook("feature")],
    ["opening-a-pr", playbook("opening-a-pr")],
    ["shipping", playbook("shipping")],
  ]) {
    expect(text, name).toContain('isolation: "worktree"');
    expect(text, name).not.toContain("git worktree add");
  }
  expect(poteto).toMatch(/parent's local commit.*project setup/);
  expect(poteto).toMatch(/Uncommitted edits are not copied/);
  expect(playbook("opening-a-pr")).not.toContain("Subagents inherit it");
});

test("verifiers select a committed target inside their assigned worktree and refresh setup", () => {
  const swarm = skill("swarm/SKILL.md");
  expect(swarm).toContain("leave the parent checkout unchanged");
  expect(swarm).toMatch(/Before dispatch.*exact SHA.*brief/);
  expect(swarm).toMatch(/initially.*parent's local commit.*setup at that commit/);
  expect(swarm).toMatch(/Inside.*assigned worktree.*`git checkout --detach <sha>`.*`git rev-parse HEAD`/);
  expect(swarm).toMatch(/reruns the project's setup as needed for that target before.*verification/);
  expect(swarm).not.toContain("put the parent on that branch");

  const shipping = playbook("shipping");
  expect(shipping).toMatch(/Resolve each PR head to an exact committed SHA.*brief/);
  expect(shipping).toMatch(/assigned worktree.*\*\*swarm\*\*.*target checkout and setup/);
  expect(shipping).not.toContain("from the parent's committed PR head");
  expect(playbook("autopilot-full")).toContain("at the code-ready SHA per the **swarm** skill");
});

test("swarm's documented recipe verifies an owned PR head while the parent stays on main", () => {
  const swarm = skill("swarm/SKILL.md");
  // Execute the commands shipped to workers, so stale or missing guidance fails CI.
  const resolve = swarm.match(/`(git rev-parse --verify <target>\^\{commit\})`/)?.[1];
  const checkout = swarm.match(/`(git checkout --detach <sha>)`/)?.[1];
  const head = swarm.match(/`(git rev-parse HEAD)`/)?.[1];
  expect(resolve).toBeDefined();
  expect(checkout).toBeDefined();
  expect(head).toBeDefined();

  const root = mkdtempSync(join(tmpdir(), "t3-verifier-target-"));
  const parent = join(root, "parent");
  const owner = join(root, "owner");
  const verifier = join(root, "verifier");
  const git = (cwd, ...args) => execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  }).trim();
  const setup = (cwd) => execFileSync(process.execPath, ["setup.mjs"], { cwd });
  try {
    git(root, "init", "-q", "-b", "main", parent);
    writeFileSync(join(parent, ".gitignore"), "installed.txt\n");
    writeFileSync(join(parent, "requirements.txt"), "trunk dependencies\n");
    writeFileSync(join(parent, "setup.mjs"), 'import { copyFileSync } from "node:fs"; copyFileSync("requirements.txt", "installed.txt");\n');
    git(parent, "add", ".");
    git(parent, "commit", "-qm", "trunk setup fixture");
    const parentHead = git(parent, "rev-parse", "HEAD");
    git(parent, "worktree", "add", "-qb", "pr-owner", owner);
    writeFileSync(join(owner, "requirements.txt"), "PR dependencies\n");
    git(owner, "commit", "-qam", "PR target fixture");
    const target = git(parent, ...resolve.replace("<target>", "pr-owner").split(" ").slice(1));
    writeFileSync(join(owner, "live-owner.txt"), "owner still active\n");
    const ownerStatus = git(owner, "status", "--porcelain");
    expect(() => git(parent, "checkout", "pr-owner")).toThrow(/already (used by worktree|checked out)/);

    // Model T3's initial worktree and setup at the parent's commit; no live task is spawned.
    git(parent, "worktree", "add", "-q", "--detach", verifier, parentHead);
    setup(verifier);
    expect(readFileSync(join(verifier, "installed.txt"), "utf8")).toBe("trunk dependencies\n");
    git(verifier, ...checkout.replace("<sha>", target).split(" ").slice(1));
    expect(git(verifier, ...head.split(" ").slice(1))).toBe(target);
    setup(verifier);
    expect(readFileSync(join(verifier, "installed.txt"), "utf8")).toBe("PR dependencies\n");
    expect(git(verifier, "branch", "--show-current")).toBe("");
    expect(git(parent, "branch", "--show-current")).toBe("main");
    expect(git(parent, "rev-parse", "HEAD")).toBe(parentHead);
    expect(git(parent, "status", "--porcelain")).toBe("");
    expect(git(owner, "branch", "--show-current")).toBe("pr-owner");
    expect(git(owner, "rev-parse", "HEAD")).toBe(target);
    expect(git(owner, "status", "--porcelain")).toBe(ownerStatus);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
