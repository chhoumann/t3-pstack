import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

// Fake agystack engine + fake gcloud. Shapes follow the real v1/v2 Cloud Run
// Execution JSON and the engine's own stdout contract. No network, no cloud.
const root = process.env.CLOUD_FIXTURE;
const args = process.argv.slice(2);
const engine = basename(process.argv[1]) === "python3";
const config = () => JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
const option = (name) => {
  const equal = args.find((arg) => arg.startsWith(`${name}=`));
  return equal ? equal.slice(name.length + 1) : args[args.indexOf(name) + 1];
};
const cfg = config();
const secret = "CLOUD_SENTINEL_SECRET_DO_NOT_DISCLOSE";
// Executions that belong to this run are created after the local record, and the
// fixture clock is pinned far enough ahead that any server-side lower bound matches.
const executionTime = "2100-01-01T00:00:00.000Z";
// Pre-existing executions of the shared job predate every local record.
const historicalTime = "2020-01-01T00:00:00.000Z";
const event = (value) => appendFileSync(join(root, "events.jsonl"), `${JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failure = (prefix = "", fallback = secret) => {
  const message = cfg.stderrMessage ?? fallback;
  if (cfg.stderrLines) {
    for (let index = 0; index < cfg.stderrLines; index++) console.error(`${prefix}provider line ${index} ${message}`);
  } else console.error(`${prefix}${message}`);
  process.exit(1);
};
async function hold(name) {
  writeFileSync(join(root, name), String(process.pid));
  while (!existsSync(join(root, `${name}.release`))) await sleep(20);
}
function completed(state) {
  if (state === "succeeded") return { type: "Completed", status: "True", lastTransitionTime: executionTime };
  if (state === "failed") return { type: "Completed", status: "False", reason: "NonZeroExitCode", lastTransitionTime: executionTime };
  if (state === "cancelled") return { type: "Completed", status: "False", reason: "Cancelled", lastTransitionTime: executionTime };
  return { type: "Completed", status: "Unknown", lastTransitionTime: executionTime };
}
function environment(session) {
  return [
    { name: "SWARM_SESSION_ID", value: session },
    { name: "SESSION_ID", value: session },
    { name: "GCS_PREFIX", value: `swarms/${session}` },
    { name: "GH_TOKEN", value: secret },
  ];
}
// Cloud Run v1 Execution, as `gcloud run jobs executions describe --format=json`
// prints it: metadata.labels carries the job, spec.template.spec.containers holds env.
function executionV1(name, session, state) {
  return {
    apiVersion: "run.googleapis.com/v1",
    kind: "Execution",
    metadata: {
      annotations: { "run.googleapis.com/job": "swarm" },
      creationTimestamp: executionTime,
      generation: 1,
      labels: {
        "cloud.googleapis.com/location": "us-central1",
        "run.googleapis.com/job": "swarm",
        "run.googleapis.com/jobUid": "job-uid",
        "run.googleapis.com/launchStage": "GA",
      },
      name,
      namespace: "123456789",
      resourceVersion: "abc",
      selfLink: `/apis/run.googleapis.com/v1/namespaces/123456789/executions/${name}`,
      uid: `uid-${name}`,
    },
    spec: {
      parallelism: 16,
      taskCount: 2,
      template: {
        spec: {
          containers: [{
            env: environment(session),
            image: "us-docker.pkg.dev/test-project/swarm/worker:latest",
            resources: { limits: { cpu: "1", memory: "512Mi" } },
          }],
          maxRetries: 0,
          timeoutSeconds: "600",
        },
      },
    },
    status: {
      conditions: [completed(state), { type: "Started", status: "True", lastTransitionTime: executionTime }],
      startTime: executionTime,
      taskCount: 2,
      succeededCount: state === "succeeded" ? 2 : 0,
      failedCount: state === "failed" ? 2 : 0,
      runningCount: state === "running" ? 2 : 0,
    },
  };
}
// Cloud Run v2 Execution: no metadata wrapper, top-level job/template, conditions
// carrying state (and executionReason for terminal failures).
function executionV2(name, session, state) {
  const condition = state === "succeeded" ? { type: "Completed", state: "CONDITION_SUCCEEDED", lastTransitionTime: executionTime }
    : state === "running" ? { type: "Completed", state: "CONDITION_PENDING", lastTransitionTime: executionTime }
      : { type: "Completed", state: "CONDITION_FAILED", executionReason: state === "cancelled" ? "CANCELLED" : "NON_ZERO_EXIT_CODE", lastTransitionTime: executionTime };
  return {
    name: `projects/test-project/locations/us-central1/jobs/swarm/executions/${name}`,
    uid: `uid-${name}`,
    generation: "1",
    labels: { "cloud.googleapis.com/location": "us-central1", "run.googleapis.com/job": "swarm" },
    annotations: {},
    job: "projects/test-project/locations/us-central1/jobs/swarm",
    createTime: executionTime,
    startTime: executionTime,
    ...(state === "running" ? {} : { completionTime: executionTime }),
    template: {
      containers: [{
        env: environment(session),
        image: "us-docker.pkg.dev/test-project/swarm/worker:latest",
        resources: { limits: { cpu: "1", memory: "512Mi" } },
      }],
      maxRetries: 0,
      timeout: "600s",
    },
    status: {
      conditions: [condition],
      taskCount: 2,
      succeededCount: state === "succeeded" ? 2 : 0,
      failedCount: state === "failed" ? 2 : 0,
      runningCount: state === "running" ? 2 : 0,
    },
  };
}

if (engine) {
  const booleanFlags = new Set(["--dry-run", "--no-wait", "--vertex", "--preflight"]);
  const valueFlags = new Set(["--manifest", "--session-id", "--gcs-prefix", "--repo", "--job-name", "--region", "--project", "--gcs-bucket", "--model", "--parent-model", "--vertex-location", "--base-branch", "--tasks", "--parallelism", "--max-retries", "--orchestrator-timeout", "--harvest-session", "--wait-execution"]);
  if (args[0] !== "-u" || !args[1]?.endsWith("cloud_dispatch.py")) throw Error("unexpected Python invocation");
  for (let i = 2; i < args.length; i++) {
    if (booleanFlags.has(args[i])) continue;
    if (!valueFlags.has(args[i]) || args[i + 1] === undefined) throw Error("unsupported engine flag");
    i++;
  }
  const session = option("--session-id");
  if (args.includes("--dry-run")) {
    event({ kind: "plan", args, cwd: process.cwd() });
    // Preflight must run at plan time (cloud_dispatch.py supports --preflight with
    // --dry-run), so quota/auth/git/bucket failures happen before a record exists.
    if (!args.includes("--preflight")) throw Error("the controller must preflight the dry-run plan");
    console.log("[PRE-FLIGHT] Verifying cloud swarm credentials, quota tiers, repository access, and GCS bucket...");
    if (cfg.dryFailure || cfg.dryPreflightFailure) failure();
    console.log("[DRY-RUN] Quota preflight skipped.");
    console.log(JSON.stringify({
      job_name: "swarm", region: "us-central1", project: "test-project", tasks_count: 2,
      parallelism: 16, max_retries: 0,
      env_vars: {
        SWARM_SESSION_ID: session, SESSION_ID: session,
        REPO_URL: cfg.repoUrl ?? "https://github.com/example/repo.git",
        GCS_BUCKET: "test-bucket", MODEL_OVERRIDE: "gemini-test", GH_TOKEN: secret,
      },
      gcloud_command: `gcloud --token=${secret}`, secrets_mapping: { secret },
    }, null, 2));
    process.exit(0);
  }
  if (args.includes("--harvest-session")) {
    event({ kind: "harvest", args, cwd: process.cwd() });
    if (cfg.holdHarvest) await hold("harvesting");
    if (cfg.harvestFailure) failure();
    const dest = join(process.cwd(), ".slices", option("--harvest-session"));
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "patch.diff"), "example patch\n");
    console.log(`Harvested patch. ${secret}`);
    process.exit(0);
  }
  if (args.includes("--wait-execution")) {
    event({ kind: "attach", args, cwd: process.cwd() });
    console.log(`[Cloud Swarm] Progress: 1/2 succeeded, 1 running, 0 failed. ${secret}`);
    await hold("attached");
    if (cfg.attachFailure) failure();
    process.exit(0);
  }
  if (!args.includes("--no-wait")) throw Error("launch must be asynchronous");
  if (cfg.launchPreflightFailure) {
    // Pre-launch: the engine stops during preflight, before its launch marker.
    event({ kind: "prelaunch", args, cwd: process.cwd() });
    console.log("[PRE-FLIGHT] Verifying cloud swarm credentials, quota tiers, repository access, and GCS bucket...");
    failure("Error [Pre-Flight]: ", "quota exceeded for project test-project");
  }
  event({ kind: "launch", args, cwd: process.cwd() });
  // This exact line precedes `gcloud run jobs execute` in cloud_dispatch.py.
  console.log(`Launching Cloud Run Job 'swarm' with 2 tasks (parallelism: 16)...`);
  writeFileSync(join(root, "execution.json"), JSON.stringify({ name: "swarm-abcde", session }));
  if (cfg.holdLaunch) await hold("launching");
  if (cfg.launchFailure) failure();
  if (!cfg.hideHandle) console.log("Execution: swarm-abcde");
  console.log(`Session: ${session}`);
} else {
  event({ kind: args[3], args });
  if (cfg.gcloudFailure) failure();
  const saved = existsSync(join(root, "execution.json")) ? JSON.parse(readFileSync(join(root, "execution.json"), "utf8")) : null;
  if (args.includes("list")) {
    if (!args.includes("--job=swarm") || !args.includes("--project=test-project") || !args.includes("--region=us-central1")) throw Error("missing context");
    // gcloud walks pages itself and prints one array; --limit truncates it. The
    // controller must ask the server to drop executions older than the record.
    const filter = args.find((arg) => arg.startsWith("--filter=creationTimestamp>="));
    if (!filter) throw Error("recovery must filter by creation time server-side");
    const since = Date.parse(filter.slice("--filter=creationTimestamp>=".length));
    const limit = Number(args.find((arg) => arg.startsWith("--limit="))?.split("=")[1] ?? Number.MAX_SAFE_INTEGER);
    const item = (name, creationTimestamp) => ({
      apiVersion: "run.googleapis.com/v1",
      kind: "Execution",
      metadata: { creationTimestamp, name, labels: { "run.googleapis.com/job": "swarm" } },
    });
    const old = Array.from({ length: cfg.others ?? 0 }, (_, index) => item(`swarm-old-${index}`, historicalTime));
    const recent = Array.from({ length: cfg.othersRecent ?? 0 }, (_, index) => item(`swarm-recent-${index}`, executionTime));
    let items = cfg.emptyList ? [] : [...recent, ...(saved ? [item(saved.name, executionTime)] : [])];
    if (cfg.ambiguous && saved) items.push(item("swarm-second", executionTime));
    items = items.filter((entry) => Date.parse(entry.metadata.creationTimestamp) >= since);
    console.log(JSON.stringify(items.slice(0, limit)));
  } else if (args.includes("describe")) {
    const name = args[4];
    if (cfg.describeFailure) failure();
    // Only this run's execution (and the deliberate decoy) carry its session env;
    // every other execution of the shared job belongs to another session.
    const owned = name === saved?.name || name === "swarm-second";
    const session = owned ? saved.session : "not-this-session";
    const state = cfg.remote ?? "running";
    const data = cfg.v2 ? executionV2(name, session, state) : executionV1(name, session, state);
    if (cfg.omitJobLabel) {
      delete data.metadata?.labels?.["run.googleapis.com/job"];
      delete data.annotations?.["run.googleapis.com/job"];
      if ("job" in data) delete data.job;
    }
    if (cfg.wrongJob) {
      if (data.metadata) data.metadata.labels["run.googleapis.com/job"] = "unrelated";
      else data.job = "projects/test-project/locations/us-central1/jobs/unrelated";
    }
    if (cfg.wrongSession) {
      const containers = data.spec?.template?.spec?.containers ?? data.template?.containers;
      for (const container of containers) for (const entry of container.env) entry.value = "unrelated";
    }
    console.log(JSON.stringify(data));
  } else if (args.includes("cancel")) {
    if (cfg.cancelDenied) failure();
    if (cfg.cancelTerminal) writeFileSync(join(root, "config.json"), JSON.stringify({ ...cfg, remote: cfg.cancelTerminal }));
    console.log(`Cancellation accepted. ${secret}`);
  } else throw Error("unexpected gcloud operation");
}
