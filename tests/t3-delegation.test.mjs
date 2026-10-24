import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

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
  expect(skill("swarm/SKILL.md")).toMatch(/parent.*branch.*commit.*before dispatch/);
  expect(playbook("opening-a-pr")).not.toContain("Subagents inherit it");
});
