import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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
      let detail; try { detail = JSON.parse(p.stderr); } catch { /* Not every failure is a structured bridge error. */ }
      return { ...p, data, detail };
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
function diagnostics(result, secret = "CLOUD_SENTINEL") {
  const path = result.detail?.details?.diagnostics;
  expect(path, result.stderr).toBeTruthy();
  expect(existsSync(path)).toBe(true);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const text = readFileSync(path, "utf8");
  expect(text).not.toContain(secret);
  return text;
}

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
  const busy = f.run();
  error(busy, "BUSY");
  // The loser gets the winner's handle so it can retry the SAME request ID.
  expect(busy.detail.details).toMatchObject({
    runId: run.id,
    clientRequestId: "request-one",
    state: "launching",
    execution: null,
    retryWithSameRequestId: true,
  });
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

test("failures after the launch marker never authorize another launch", () => {
  const f = fixture({ launchFailure: true, emptyList: true });
  const result = f.run();
  error(result, "LAUNCH_UNCERTAIN");
  diagnostics(result);
  const run = f.record();
  expect(run.state).toBe("unknown");
  expect(run.lastFailure).toMatchObject({ code: "LAUNCH_UNCERTAIN", retryable: false, evidence: "launch-marker-present" });
  for (let i = 0; i < 2; i++) expect(ok(f.run(["resume", run.id])).state).toBe("unknown");
  expect(ok(f.run()).state).toBe("unknown");
  expect(f.events().filter((event) => event.kind === "launch")).toHaveLength(1);
});

test("pre-launch failures stay prepared and retry with the same client request ID", () => {
  const f = fixture({ launchPreflightFailure: true, stderrMessage: "Error [Pre-Flight]: quota exceeded for project test-project" });
  const blocked = f.run();
  error(blocked, "PRELAUNCH_FAILED");
  expect(diagnostics(blocked)).toContain("quota exceeded");
  const prepared = f.record();
  expect(prepared.state).toBe("prepared");
  expect(prepared.execution).toBeNull();
  expect(prepared.lastFailure).toMatchObject({ code: "PRELAUNCH_FAILED", retryable: true, evidence: "launch-marker-absent" });
  // The same request ID may retry, and a failing retry still launches nothing.
  error(f.run(), "PRELAUNCH_FAILED");
  expect(f.events().filter((event) => event.kind === "launch")).toHaveLength(0);
  f.set({ launchPreflightFailure: false, stderrMessage: undefined });
  const run = ok(f.run());
  expect(run.state).toBe("running");
  expect(run.execution).toBe("swarm-abcde");
  expect(run.lastFailure).toBeNull();
  expect(ok(f.run()).id).toBe(run.id);
  expect(f.events().filter((event) => event.kind === "launch")).toHaveLength(1);
});

test("a launch process-start failure stays prepared and retries with the same client request ID", () => {
  const f = fixture();
  // The plan invocation poisons the python3 entry after it has exec'd: the plan
  // run completes normally, then the launch execve fails on the broken shebang
  // (ENOENT from an executable regular file) and rejects PROCESS_START_FAILED.
  // The engine never ran a byte in the launch, which is exactly the provable
  // pre-launch case.
  writeFileSync(
    join(f.bin, "python3"),
    `#!${node}\n\nimport { writeFileSync as poison } from "node:fs";\n`
    + `poison(${JSON.stringify(join(f.bin, "python3"))}, ${JSON.stringify("#!/nonexistent-interpreter-ENOENT\\n")});\n`
    + readFileSync(join(repo, "tests/fixtures/cloud/fake-service.mjs"), "utf8"),
  );
  const blocked = f.run();
  error(blocked, "PRELAUNCH_FAILED");
  const prepared = f.record();
  expect(prepared.state).toBe("prepared");
  expect(prepared.execution).toBeNull();
  expect(prepared.lastFailure).toMatchObject({ code: "PRELAUNCH_FAILED", retryable: true, evidence: "process-start-failure" });
  // Repair the harness and retry with the same client request ID: one launch.
  writeFileSync(join(f.bin, "python3"), `#!${node}\n${readFileSync(join(repo, "tests/fixtures/cloud/fake-service.mjs"), "utf8")}`);
  const run = ok(f.run());
  expect(run.state).toBe("running");
  expect(f.events().filter((event) => event.kind === "launch")).toHaveLength(1);
});

test("a plan process-start failure leaves no record and reports a retryable PLAN_FAILED", () => {
  const f = fixture();
  // execve fails on a missing shebang interpreter even though the file is an
  // executable regular file, so the plan spawn rejects PROCESS_START_FAILED.
  writeFileSync(join(f.bin, "python3"), "#!/nonexistent-interpreter-ENOENT\n");
  const blocked = f.run();
  error(blocked, "PLAN_FAILED");
  expect(diagnostics(blocked)).toBeTruthy();
  // Diagnostics live beside run records, so the record itself must be absent.
  const dir = join(f.root, "state/t3-pstack/agystack/runs");
  expect(existsSync(dir) && readdirSync(dir).some((name) => name.endsWith(".json"))).toBe(false);
  // Repair the harness and retry with the same client request ID: one launch.
  writeFileSync(join(f.bin, "python3"), `#!${node}\n${readFileSync(join(repo, "tests/fixtures/cloud/fake-service.mjs"), "utf8")}`);
  expect(ok(f.run()).state).toBe("running");
  expect(f.events().filter((event) => event.kind === "launch")).toHaveLength(1);
});

test("redaction covers unflagged key=value and key: value shapes", () => {
  const f = fixture({ gcloudFailure: true, stderrMessage: "password=supersecretvalue1234 secret: mysecretvalue12345 api_key=AKIAlongkey123 --token tokenval1234567" });
  const run = ok(f.run());
  const described = f.run(["status", run.id]);
  error(described, "REMOTE_FAILED");
  const text = diagnostics(described);
  expect(text).toContain("password=REDACTED");
  expect(text).toContain("secret: REDACTED");
  expect(text).toContain("api_key=REDACTED");
  // Flagged shapes still read as before, keeping the key spelling for diagnosis.
  expect(text).toMatch(/--token[=\s]+REDACTED/);
  for (const secret of ["supersecretvalue1234", "mysecretvalue12345", "AKIAlongkey123", "tokenval1234567"]) {
    expect(text).not.toContain(secret);
  }
});

test("recovery filters server-side and pages instead of refusing large lists", () => {
  const f = fixture({ hideHandle: true, others: 5000, othersRecent: 105 });
  const launch = ok(f.run());
  expect(launch.execution).toBeNull();
  // 5000 executions of the shared job predate this run and are dropped by the
  // server-side filter; the remaining 106 need a second page to reach the handle.
  expect(ok(f.run(["resume", launch.id])).execution).toBe("swarm-abcde");
  const lists = f.events().filter((event) => event.kind === "list");
  expect(lists.length).toBeGreaterThan(1);
  for (const list of lists) expect(list.args.some((arg) => arg.startsWith("--filter=creationTimestamp>="))).toBe(true);
}, 30000);

test("recovery rejects ambiguity and reports an incomplete paginated scan", () => {
  const g = fixture({ hideHandle: true, ambiguous: true });
  const ambiguous = ok(g.run());
  error(g.run(["resume", ambiguous.id]), "AMBIGUOUS_EXECUTION");
  expect(g.record().execution).toBeNull();
  g.set({ ambiguous: false, othersRecent: 2500 });
  error(g.run(["resume", ambiguous.id]), "RECOVERY_INCOMPLETE");
}, 30000);

test.each(["wrongJob", "wrongSession"])("recovery refuses an execution with %s", (flag) => {
  const f = fixture({ hideHandle: true, [flag]: true }); const run = ok(f.run());
  expect(ok(f.run(["resume", run.id])).execution).toBeNull();
});

test("recovery identifies executions by session env rather than a job label", () => {
  const f = fixture({ hideHandle: true, omitJobLabel: true });
  const run = ok(f.run());
  expect(ok(f.run(["resume", run.id])).execution).toBe("swarm-abcde");
});

test("recovery reads the v2 Execution describe shape", () => {
  const f = fixture({ hideHandle: true, v2: true });
  const run = ok(f.run());
  expect(ok(f.run(["resume", run.id])).execution).toBe("swarm-abcde");
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

test("harvest never blocks cancellation and only locks state mutations", async () => {
  const f = fixture({ holdHarvest: true }); const run = ok(f.run());
  const p = f.start(["harvest", run.id]);
  await until(() => existsSync(join(f.root, "harvesting")));
  // The state lock is free during the download, so cancellation proceeds.
  const cancelled = ok(f.run(["cancel", run.id]));
  expect(cancelled.state).toBe("cancelling");
  expect(cancelled.harvest.status).toBe("fetching");
  // A second download is still serialized, but it never blocks cancellation.
  error(f.run(["harvest", run.id]), "BUSY");
  f.release("harvesting"); expect(await p.done).toBe(0);
  const final = ok(f.run(["status", run.id]));
  expect(final.harvest.status).toBe("downloaded");
  expect(final.state).toBe("cancelling");
});

test("plan failures leave no record and retry with the same client request ID", () => {
  const f = fixture({ dryPreflightFailure: true, stderrMessage: "Error [Pre-Flight]: quota exceeded for project test-project" });
  const result = f.run(); error(result, "PLAN_FAILED");
  expect(result.stderr).not.toContain("CLOUD_SENTINEL");
  expect(diagnostics(result)).toContain("quota exceeded");
  expect(f.events().filter((event) => event.kind === "launch")).toHaveLength(0);
  const stateDir = join(f.root, "state/t3-pstack/agystack/runs");
  expect(readdirSync(stateDir).filter((name) => /^run-[a-f0-9]{64}\.json$/.test(name))).toHaveLength(0);
  f.set({ dryPreflightFailure: false, stderrMessage: undefined });
  expect(ok(f.run()).state).toBe("running");
  expect(f.events().filter((event) => event.kind === "launch")).toHaveLength(1);
  error(f.run(["dispatch", "--client-request-id", "missing", "--manifest", f.manifest, "--agystack-source", join(f.root, "absent")]), "ENGINE_MISSING");
  rmSync(join(f.bin, "gcloud"));
  error(f.run(f.dispatch.map((arg) => arg === "request-one" ? "request-two" : arg)), "PREREQUISITE_MISSING");
});

test("diagnostics keep only the last 50 redacted stderr lines", () => {
  const f = fixture({ launchPreflightFailure: true, stderrLines: 120 });
  const result = f.run();
  error(result, "PRELAUNCH_FAILED");
  const lines = readFileSync(result.detail.details.diagnostics, "utf8").trimEnd().split("\n");
  expect(lines).toHaveLength(51);
  expect(lines[0]).toStartWith("# launch failure at ");
  expect(lines[1]).toContain("provider line 70");
  expect(lines.at(-1)).toContain("provider line 119");
  expect(lines.join("\n")).not.toContain("CLOUD_SENTINEL");
});

test("every failing remote verb persists and references redacted diagnostics", () => {
  const f = fixture({ gcloudFailure: true, stderrMessage: "PERMISSION_DENIED: quota project mismatch" });
  const run = ok(f.run());
  const described = f.run(["status", run.id]);
  error(described, "REMOTE_FAILED");
  expect(diagnostics(described)).toContain("PERMISSION_DENIED");
  f.set({ gcloudFailure: false, harvestFailure: true });
  const harvested = f.run(["harvest", run.id]);
  error(harvested, "HARVEST_FAILED");
  expect(diagnostics(harvested)).toContain("PERMISSION_DENIED");
  f.set({ harvestFailure: false, cancelDenied: true });
  const cancelled = f.run(["cancel", run.id]);
  error(cancelled, "CANCEL_UNCONFIRMED");
  expect(diagnostics(cancelled)).toContain("PERMISSION_DENIED");
  expect(f.record().state).toBe("cancelling");
}, 20000);

test("attach failures keep observation separate and reference diagnostics", async () => {
  const f = fixture({ attachFailure: true, stderrMessage: "UNAUTHENTICATED: credentials expired" });
  const run = ok(f.run());
  const p = f.start(["attach", run.id]);
  await until(() => existsSync(join(f.root, "attached")));
  f.release("attached");
  expect(await p.done).toBe(1);
  const payload = JSON.parse(p.errors.trim().split("\n").at(-1));
  expect(payload.error).toBe("ATTACH_FAILED");
  const text = readFileSync(payload.details.diagnostics, "utf8");
  expect(text).toContain("UNAUTHENTICATED");
  expect(text).not.toContain("CLOUD_SENTINEL");
  expect(ok(f.run(["status", run.id])).state).toBe("running");
});

test("prepared reuse keeps the first controller task ID and says so", () => {
  const f = fixture({ launchPreflightFailure: true });
  error(f.run(), "PRELAUNCH_FAILED");
  expect(f.record().controllerTaskId).toBe("task-provenance");
  f.set({ launchPreflightFailure: false });
  const retried = ok(f.run(f.dispatch.map((arg) => arg === "task-provenance" ? "task-other" : arg)));
  expect(retried.controllerTaskId).toBe("task-provenance");
  expect(retried.controllerTaskIdNotice).toContain("task-other");
  expect(f.record().controllerTaskId).toBe("task-provenance");
  expect(f.events().filter((event) => event.kind === "launch")).toHaveLength(1);
});

test("list marks one corrupt record instead of failing the listing", () => {
  const f = fixture(); const run = ok(f.run());
  const dir = join(f.root, "state/t3-pstack/agystack/runs");
  const corrupt = `run-${"a".repeat(64)}`;
  writeFileSync(join(dir, `${corrupt}.json`), "{ this is not json", { mode: 0o600 });
  const listed = ok(f.run(["list"]));
  expect(listed.find((item) => item.id === run.id).state).toBe("running");
  expect(listed.find((item) => item.id === corrupt)).toMatchObject({ state: "corrupt", code: "STATE_CORRUPT" });
});

test.each([
  ["https://github.com/example/repo.git", true],
  ["git@github.com:example/repo.git", true],
  ["ssh://git@github.com/example/repo.git", true],
  ["https://user:pass@github.com/example/repo.git", false],
  ["https://github.com/example/repo.git?token=sentinel", false],
])("repository URL %s is accepted: %s", (url, accepted) => {
  const f = fixture({ repoUrl: url });
  if (accepted) expect(ok(f.run()).plan.repo).toBeTruthy();
  else error(f.run(), "PLAN_INVALID");
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
