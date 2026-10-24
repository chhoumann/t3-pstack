import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const cli = join(repo, "plugins/pstack/skills/t3-agystack/scripts/cloud-run.mjs");
const node = spawnSync("which", ["node"], { encoding: "utf8" }).stdout.trim();
const fixtures = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });

function fixture(initial = {}) {
  const root = mkdtempSync(join(repo, ".cloud-test-"));
  const bin = join(root, "bin");
  const source = join(root, "source");
  mkdirSync(bin); mkdirSync(join(source, "skills/swarm/scripts"), { recursive: true });
  writeFileSync(join(source, "skills/swarm/scripts/cloud_dispatch.py"), "fake entry point\n");
  const script = readFileSync(join(repo, "tests/fixtures/cloud/fake-service.mjs"), "utf8");
  for (const name of ["python3", "gcloud"]) {
    writeFileSync(join(bin, name), `#!${node}\n${script}`);
    chmodSync(join(bin, name), 0o755);
  }
  const manifest = join(root, "manifest.json");
  writeFileSync(manifest, JSON.stringify([{ brief: "Implement scoped change" }, { brief: "Review scoped change" }]));
  let config = initial;
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  const env = { ...process.env, PATH: bin, CLOUD_FIXTURE: root, XDG_STATE_HOME: join(root, "state"), AGYSTACK_DISPATCH_SCRIPT: "", GH_TOKEN: "CLOUD_SENTINEL_SECRET_DO_NOT_DISCLOSE" };
  const children = [];
  const dispatch = ["dispatch", "--client-request-id", "request-one", "--manifest", manifest, "--agystack-source", source, "--controller-task-id", "task-provenance"];
  const f = {
    root, bin, source, manifest, env, dispatch,
    set(patch) { config = { ...config, ...patch }; writeFileSync(join(root, "config.json"), JSON.stringify(config)); },
    run(args = dispatch, extraEnv = {}) {
      const p = spawnSync(node, [cli, ...args, "--json"], { cwd: root, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 15000 });
      let data; try { data = JSON.parse(p.stdout); } catch { /* Failed commands may have no JSON output. */ }
      return { ...p, data };
    },
    start(args = dispatch) {
      const p = spawn(node, [cli, ...args, "--json"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
      p.output = ""; p.errors = "";
      p.stdout.on("data", (data) => { p.output += data; });
      p.stderr.on("data", (data) => { p.errors += data; });
      p.done = new Promise((done) => p.on("close", (code) => done(code)));
      children.push(p); return p;
    },
    events() { return existsSync(join(root, "events.jsonl")) ? readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : []; },
    record() {
      const dir = join(root, "state/t3-pstack/agystack/runs");
      const file = readdirSync(dir).find((name) => /^run-[a-f0-9]+\.json$/.test(name));
      return JSON.parse(readFileSync(join(dir, file), "utf8"));
    },
    ageRecord() {
      const record = this.record();
      record.updatedAt = record.createdAt = "2000-01-01T00:00:00.000Z";
      writeFileSync(join(root, "state/t3-pstack/agystack/runs", `${record.id}.json`), JSON.stringify(record));
    },
    release(name) { writeFileSync(join(root, `${name}.release`), ""); },
    dispose() {
      for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
      for (const name of ["launching", "attached", "harvesting"]) {
        try { process.kill(Number(readFileSync(join(root, name), "utf8")), "SIGKILL"); } catch { /* Already exited. */ }
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
  fixtures.push(f); return f;
}
async function until(predicate) {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error("fixture did not reach expected state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function ok(result) { expect(result.status, result.stderr).toBe(0); return result.data; }
function error(result, code) { expect(result.status).not.toBe(0); expect(result.stderr).toContain(code); }

test("dispatch uses real engine flags, persists a safe plan and deduplicates a request", () => {
  const f = fixture();
  const run = ok(f.run());
  expect(run.state).toBe("running");
  expect(run.execution).toBe("swarm-abcde");
  expect(run.controllerTaskId).toBe("task-provenance");
  expect(run.cwd).toBe(f.root);
  expect(run.plan.project).toBe("test-project");
  expect(run.manifestFingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(ok(f.run()).id).toBe(run.id);
  const launches = f.events().filter((event) => event.kind === "launch");
  expect(launches).toHaveLength(1);
  expect(launches[0].args).toContain("--no-wait");
  expect(launches[0].args).toContain("--session-id");
  expect(JSON.stringify(f.record())).not.toContain("CLOUD_SENTINEL");
  const stateDir = join(f.root, "state/t3-pstack/agystack/runs");
  for (const name of readdirSync(stateDir)) expect(readFileSync(join(stateDir, name), "utf8")).not.toContain("CLOUD_SENTINEL");
  expect(JSON.stringify(run)).not.toContain("gcloud_command");
  expect(ok(f.run(["list"])).map((item) => item.id)).toEqual([run.id]);
});

test("same request with changed manifest or options fails without launch", () => {
  const f = fixture(); ok(f.run());
  error(f.run([...f.dispatch, "--model", "different-model"]), "REQUEST_COLLISION");
  writeFileSync(f.manifest, '[{"brief":"changed"}]');
  error(f.run(), "REQUEST_COLLISION");
  expect(f.events().filter((event) => event.kind === "launch")).toHaveLength(1);
});

test("concurrent identical processes launch once and a live lock never expires", async () => {
  const f = fixture({ holdLaunch: true });
  const first = f.start();
  await until(() => existsSync(join(f.root, "launching")));
  const run = f.record();
  expect(run.state).toBe("launching");
  expect(run.sessionId).toMatch(/^t3-[a-f0-9]+$/);
  f.ageRecord();
  error(f.run(), "BUSY");
  error(f.run(["cancel", run.id]), "BUSY");
  f.release("launching");
  expect(await first.done).toBe(0);
  expect(f.events().filter((event) => event.kind === "launch")).toHaveLength(1);
});

test("killed controller recovers its launch without repeating it", async () => {
  const f = fixture({ holdLaunch: true }); const p = f.start();
  await until(() => existsSync(join(f.root, "launching")));
  const run = f.record();
  p.kill("SIGKILL");
  f.release("launching");
  await p.done;
  expect(ok(f.run(["resume", run.id])).execution).toBe("swarm-abcde");
  ok(f.run());
  expect(f.events().filter((event) => event.kind === "launch")).toHaveLength(1);
});

test("simultaneous first dispatches cannot create duplicate launches", async () => {
  const f = fixture({ holdLaunch: true });
  const children = Array.from({ length: 6 }, () => f.start());
  await until(() => existsSync(join(f.root, "launching")));
  f.release("launching");
  const codes = await Promise.all(children.map((child) => child.done));
  expect(codes).toContain(0);
  for (let i = 0; i < codes.length; i++) {
    if (codes[i] !== 0) expect(children[i].errors).toContain("BUSY");
  }
  expect(f.events().filter((event) => event.kind === "launch")).toHaveLength(1);
});

test("launch errors and repeated empty scans never authorize another launch", () => {
  const f = fixture({ launchFailure: true, emptyList: true });
  error(f.run(), "LAUNCH_UNCERTAIN");
  const run = f.record();
  expect(run.state).toBe("unknown");
  for (let i = 0; i < 2; i++) expect(ok(f.run(["resume", run.id])).state).toBe("unknown");
  expect(ok(f.run()).state).toBe("unknown");
  expect(f.events().filter((event) => event.kind === "launch")).toHaveLength(1);
});

test("recovery finds a later-page handle, rejects ambiguity and incomplete scans", () => {
  const f = fixture({ hideHandle: true, others: 105 });
  const run = ok(f.run());
  expect(ok(f.run(["resume", run.id])).execution).toBe("swarm-abcde");
  const g = fixture({ hideHandle: true, ambiguous: true });
  const ambiguous = ok(g.run());
  error(g.run(["resume", ambiguous.id]), "AMBIGUOUS_EXECUTION");
  expect(g.record().execution).toBeNull();
  g.set({ ambiguous: false, pageToken: true });
  error(g.run(["resume", ambiguous.id]), "RECOVERY_INCOMPLETE");
  g.set({ pageToken: false, others: 1001 });
  error(g.run(["resume", ambiguous.id]), "RECOVERY_INCOMPLETE");
}, 15000);

test.each(["wrongJob", "wrongSession"])("recovery refuses an execution with %s", (flag) => {
  const f = fixture({ hideHandle: true, [flag]: true }); const run = ok(f.run());
  expect(ok(f.run(["resume", run.id])).execution).toBeNull();
});

test("cancel remains cancelling until the service confirms completion", () => {
  const f = fixture(); const run = ok(f.run());
  expect(ok(f.run(["cancel", run.id])).state).toBe("cancelling");
  expect(ok(f.run(["cancel", run.id])).state).toBe("cancelling");
  expect(f.events().filter((e) => e.kind === "cancel")).toHaveLength(1);
  f.set({ remote: "cancelled" });
  expect(ok(f.run(["status", run.id])).state).toBe("cancelled");
});

test("denied cancellation preserves remote outcome and redacts provider errors", () => {
  const f = fixture({ cancelDenied: true }); const run = ok(f.run());
  const result = f.run(["cancel", run.id]);
  error(result, "CANCEL_UNCONFIRMED");
  expect(result.stderr).not.toContain("CLOUD_SENTINEL");
  expect(f.record().state).not.toBe("cancelled");
  f.set({ remote: "failed" });
  expect(ok(f.run(["status", run.id])).state).toBe("failed");
});

test.each(["succeeded", "failed"])("cancellation completion race preserves %s", (state) => {
  const f = fixture({ cancelTerminal: state }); const run = ok(f.run());
  expect(ok(f.run(["cancel", run.id])).state).toBe(state);
  ok(f.run(["cancel", run.id]));
  expect(f.events().filter((e) => e.kind === "cancel")).toHaveLength(1);
});

test.each(["running", "succeeded", "failed", "cancelled"])("v2 remote conditions report %s", (state) => {
  const f = fixture(); const run = ok(f.run()); f.set({ v2: true, remote: state });
  expect(ok(f.run(["status", run.id])).state).toBe(state);
});

test("harvest records metadata without declaring a running job successful", () => {
  const f = fixture(); const run = ok(f.run());
  const harvested = ok(f.run(["harvest", run.id]));
  expect(harvested.state).toBe("running");
  expect(harvested.harvest.status).toBe("downloaded");
  expect(existsSync(join(run.cwd, ".slices", run.sessionId, "patch.diff"))).toBe(true);
  expect(JSON.stringify(harvested)).not.toContain("CLOUD_SENTINEL");
});

test("attach streams progress before exit and does not block cancellation", async () => {
  const f = fixture(); const run = ok(f.run()); const p = f.start(["attach", run.id]);
  await until(() => existsSync(join(f.root, "attached")));
  await until(() => p.errors.includes("1/2 succeeded"));
  expect(p.exitCode).toBeNull();
  expect(p.errors).not.toContain("CLOUD_SENTINEL");
  expect(ok(f.run(["cancel", run.id])).state).toBe("cancelling");
  f.release("attached");
  expect(await p.done).toBe(0);
  expect(JSON.parse(p.output).state).toBe("cancelling");
});

test("interrupting attach stops only observation and does not cancel the job", async () => {
  const f = fixture(); const run = ok(f.run()); const p = f.start(["attach", run.id]);
  await until(() => existsSync(join(f.root, "attached")));
  p.kill("SIGINT"); expect(await p.done).toBe(130);
  expect(f.events().filter((e) => e.kind === "cancel")).toHaveLength(0);
  expect(ok(f.run(["status", run.id])).state).toBe("running");
});

test("harvest and cancel mutations cannot overwrite each other", async () => {
  const f = fixture({ holdHarvest: true }); const run = ok(f.run());
  const p = f.start(["harvest", run.id]);
  await until(() => existsSync(join(f.root, "harvesting")));
  error(f.run(["cancel", run.id]), "BUSY");
  f.release("harvesting"); expect(await p.done).toBe(0);
  const cancelled = ok(f.run(["cancel", run.id]));
  expect(cancelled.harvest.status).toBe("downloaded");
  expect(cancelled.state).toBe("cancelling");
});

test("missing engine, executable, and credentials fail before launch without secret output", () => {
  const f = fixture({ dryFailure: true });
  const result = f.run(); error(result, "PLAN_FAILED");
  expect(result.stderr).not.toContain("CLOUD_SENTINEL");
  expect(f.events().filter((event) => event.kind === "launch")).toHaveLength(0);
  error(f.run(["dispatch", "--client-request-id", "missing", "--manifest", f.manifest, "--agystack-source", join(f.root, "absent")]), "ENGINE_MISSING");
  rmSync(join(f.bin, "gcloud"));
  error(f.run(), "PREREQUISITE_MISSING");
});

test("run identifiers and unsupported flags cannot escape the state directory", () => {
  const f = fixture();
  error(f.run(["status", "../../escape"]), "INVALID_ARGUMENT");
  error(f.run([...f.dispatch, "--force"]), "INVALID_ARGUMENT");
  expect(f.events()).toHaveLength(0);
});

test("launch intent is synced as a file and directory before the engine starts", () => {
  const f = fixture();
  f.env.NODE_OPTIONS = `--import=${join(repo, "tests/fixtures/cloud/durability-probe.mjs")}`;
  ok(f.run());
  const events = f.events();
  const launch = events.findIndex((event) => event.kind === "launch");
  const intent = events.slice(0, launch).filter((event) => event.state === "launching").map((event) => event.kind);
  expect(intent).toEqual(["sync-file", "rename", "sync-directory"]);
});

test.each(["before-rename", "after-rename", "directory"])("interrupted intent write at %s cannot duplicate a launch", (fault) => {
  const f = fixture();
  f.env.NODE_OPTIONS = `--import=${join(repo, "tests/fixtures/cloud/durability-probe.mjs")}`;
  f.env.CLOUD_SYNC_FAULT = fault;
  expect(f.run().status).not.toBe(0);
  expect(f.events().filter((event) => event.kind === "launch")).toHaveLength(0);
  delete f.env.CLOUD_SYNC_FAULT;
  const run = ok(f.run());
  expect(run.state).toBe(fault === "before-rename" ? "running" : "launching");
  ok(f.run());
  expect(f.events().filter((event) => event.kind === "launch")).toHaveLength(fault === "before-rename" ? 1 : 0);
});

test("crash while saving the execution handle recovers the existing execution", () => {
  const f = fixture();
  f.env.NODE_OPTIONS = `--import=${join(repo, "tests/fixtures/cloud/durability-probe.mjs")}`;
  f.env.CLOUD_SYNC_FAULT = "handle";
  expect(f.run().status).not.toBe(0);
  const run = f.record();
  expect(run.state).toBe("launching");
  expect(run.execution).toBeNull();
  delete f.env.CLOUD_SYNC_FAULT;
  expect(ok(f.run(["resume", run.id])).execution).toBe("swarm-abcde");
  ok(f.run());
  expect(f.events().filter((event) => event.kind === "launch")).toHaveLength(1);
});

test("failed remote observation and failed harvest preserve independent metadata", () => {
  const f = fixture(); const run = ok(f.run());
  f.set({ harvestFailure: true });
  error(f.run(["harvest", run.id]), "HARVEST_FAILED");
  expect(f.record().state).toBe("running");
  expect(f.record().harvest.status).toBe("failed");
  f.set({ harvestFailure: false, gcloudFailure: true });
  error(f.run(["harvest", run.id]), "REMOTE_FAILED");
  expect(f.record().harvest.status).toBe("downloaded");
  expect(f.record().state).toBe("running");
});

test("engine file override works and status does not need the engine or manifest", () => {
  const f = fixture();
  const args = f.dispatch.filter((value, index, all) => value !== "--agystack-source" && all[index - 1] !== "--agystack-source");
  const run = ok(f.run(args, { AGYSTACK_DISPATCH_SCRIPT: join(f.source, "skills/swarm/scripts/cloud_dispatch.py") }));
  rmSync(f.source, { recursive: true }); rmSync(f.manifest);
  expect(ok(f.run(["status", run.id])).state).toBe("running");
});

test("harvesting from another working directory keeps the launch output directory", () => {
  const f = fixture(); const run = ok(f.run());
  const result = spawnSync(node, [cli, "harvest", run.id, "--json"], { cwd: repo, env: f.env, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(join(f.root, ".slices", run.sessionId, "patch.diff"))).toBe(true);
});

test("an explicitly new request gets a distinct session without replacing prior handles", () => {
  const f = fixture(); const first = ok(f.run());
  const second = ok(f.run(f.dispatch.map((arg) => arg === "request-one" ? "request-two" : arg)));
  expect(second.sessionId).not.toBe(first.sessionId);
  expect(ok(f.run(["list"]))).toHaveLength(2);
  expect(f.events().filter((event) => event.kind === "launch")).toHaveLength(2);
});

test("state permissions fail closed and never invoke the engine", () => {
  const f = fixture();
  const stateDir = join(f.root, "state/t3-pstack/agystack/runs");
  mkdirSync(stateDir, { recursive: true, mode: 0o755 }); chmodSync(stateDir, 0o755);
  error(f.run(), "STATE_PERMISSIONS");
  expect(f.events()).toHaveLength(0);
});
