import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

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
const event = (value) => appendFileSync(join(root, "events.jsonl"), `${JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function hold(name) {
  writeFileSync(join(root, name), String(process.pid));
  while (!existsSync(join(root, `${name}.release`))) await sleep(20);
}
function execution(name, session, state = cfg.remote ?? "running") {
  const condition = state === "running" ? { type: "Completed", status: "Unknown" }
    : state === "succeeded" ? { type: "Completed", status: "True" }
      : { type: "Completed", status: "False", reason: state === "cancelled" ? "Cancelled" : "NonZeroExitCode" };
  return {
    metadata: { name, labels: { "run.googleapis.com/job": "swarm", "cloud.googleapis.com/location": "us-central1" } },
    spec: { template: { spec: { containers: [{ env: [{ name: "SWARM_SESSION_ID", value: session }, { name: "GH_TOKEN", value: secret }] }] } } },
    status: { conditions: [condition] },
  };
}

if (engine) {
  const booleanFlags = new Set(["--dry-run", "--no-wait", "--vertex"]);
  const valueFlags = new Set(["--manifest", "--session-id", "--gcs-prefix", "--repo", "--job-name", "--region", "--project", "--gcs-bucket", "--model", "--parent-model", "--vertex-location", "--base-branch", "--tasks", "--parallelism", "--max-retries", "--orchestrator-timeout", "--harvest-session", "--wait-execution"]);
  if (args[0] !== "-u" || !args[1]?.endsWith("cloud_dispatch.py")) throw Error("unexpected Python invocation");
  for (let i = 2; i < args.length; i++) {
    if (booleanFlags.has(args[i])) continue;
    if (!valueFlags.has(args[i]) || args[i + 1] === undefined) throw Error("unsupported engine flag");
    i++;
  }
  if (args.includes("--dry-run")) {
    event({ kind: "plan", args, cwd: process.cwd() });
    if (cfg.dryFailure) { console.error(secret); process.exit(1); }
    const session = option("--session-id");
    console.log("[DRY-RUN] Quota preflight skipped.");
    console.log(JSON.stringify({
      job_name: "swarm", region: "us-central1", project: "test-project", tasks_count: 2,
      parallelism: 16, max_retries: 0,
      env_vars: { SWARM_SESSION_ID: session, SESSION_ID: session, REPO_URL: "https://github.com/example/repo.git", GCS_BUCKET: "test-bucket", MODEL_OVERRIDE: "gemini-test", GH_TOKEN: secret },
      gcloud_command: `gcloud --token=${secret}`, secrets_mapping: { secret },
    }, null, 2));
    process.exit(0);
  }
  if (args.includes("--harvest-session")) {
    event({ kind: "harvest", args, cwd: process.cwd() });
    if (cfg.holdHarvest) await hold("harvesting");
    const dest = join(process.cwd(), ".slices", option("--harvest-session"));
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "patch.diff"), "example patch\n");
    console.log(`Harvested patch. ${secret}`);
    process.exit(cfg.harvestFailure ? 1 : 0);
  }
  if (args.includes("--wait-execution")) {
    event({ kind: "attach", args, cwd: process.cwd() });
    console.log(`[Cloud Swarm] Progress: 1/2 succeeded, 1 running, 0 failed. ${secret}`);
    await hold("attached");
    process.exit(cfg.attachFailure ? 1 : 0);
  }
  if (!args.includes("--no-wait")) throw Error("launch must be asynchronous");
  const session = option("--session-id");
  event({ kind: "launch", args, cwd: process.cwd() });
  const remote = execution("swarm-abcde", session);
  writeFileSync(join(root, "execution.json"), JSON.stringify(remote));
  if (cfg.holdLaunch) await hold("launching");
  if (cfg.launchFailure) { console.error(secret); process.exit(1); }
  if (!cfg.hideHandle) console.log("Execution: swarm-abcde");
  console.log(`Session: ${session}`);
} else {
  event({ kind: args[3], args });
  if (cfg.gcloudFailure) { console.error(secret); process.exit(1); }
  const saved = existsSync(join(root, "execution.json")) ? JSON.parse(readFileSync(join(root, "execution.json"), "utf8")) : null;
  if (args.includes("list")) {
    if (!args.includes("--job=swarm") || !args.includes("--project=test-project") || !args.includes("--region=us-central1")) throw Error("missing context");
    const others = Array.from({ length: cfg.others ?? 0 }, (_, i) => ({ metadata: { name: `swarm-other-${i}` } }));
    let items = cfg.emptyList ? [] : [...others, ...(saved ? [saved] : [])];
    if (cfg.ambiguous && saved) items.push({ metadata: { name: "swarm-second" } });
    const limit = args.find((arg) => arg.startsWith("--limit="));
    if (limit) items = items.slice(0, Number(limit.split("=")[1]));
    console.log(JSON.stringify(cfg.pageToken ? { items, nextPageToken: "more" } : items));
  } else if (args.includes("describe")) {
    const name = args[4];
    if (cfg.describeFailure) { console.error(secret); process.exit(1); }
    let session = saved?.spec.template.spec.containers[0].env[0].value;
    if (name.includes("other")) session = "not-this-session";
    const data = execution(name, session);
    if (cfg.wrongJob) data.metadata.labels["run.googleapis.com/job"] = "unrelated";
    if (cfg.wrongSession) data.spec.template.spec.containers[0].env[0].value = "unrelated";
    if (cfg.v2) {
      console.log(JSON.stringify({ name: `projects/test-project/locations/us-central1/jobs/swarm/executions/${name}`, job: "projects/test-project/locations/us-central1/jobs/swarm", template: { containers: data.spec.template.spec.containers }, conditions: [{ type: "Completed", state: cfg.remote === "running" ? "CONDITION_PENDING" : cfg.remote === "succeeded" ? "CONDITION_SUCCEEDED" : "CONDITION_FAILED", executionReason: cfg.remote === "cancelled" ? "CANCELLED" : "NON_ZERO_EXIT_CODE" }] }));
    } else console.log(JSON.stringify(data));
  } else if (args.includes("cancel")) {
    if (cfg.cancelDenied) { console.error(secret); process.exit(1); }
    if (cfg.cancelTerminal) writeFileSync(join(root, "config.json"), JSON.stringify({ ...cfg, remote: cfg.cancelTerminal }));
    console.log(`Cancellation accepted. ${secret}`);
  } else throw Error("unexpected gcloud operation");
}
