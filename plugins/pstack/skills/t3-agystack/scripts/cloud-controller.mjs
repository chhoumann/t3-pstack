import { readFileSync, realpathSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CloudError, hash, runId, sessionId, terminal } from "./cloud-state.mjs";
import { enginePath, executable, parseDryRun, parseJson, runProcess } from "./cloud-process.mjs";

const now = () => new Date().toISOString();
const resource = /^[a-z][a-z0-9-]{0,62}$/;
const token = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
export const dispatchOptions = ["repo", "job-name", "region", "project", "gcs-bucket", "model", "parent-model", "vertex-location", "base-branch", "tasks", "parallelism", "max-retries", "orchestrator-timeout", "vertex"];

function checked(value, pattern = token) {
  if (typeof value !== "string" || !pattern.test(value)) throw new CloudError("PLAN_INVALID", "A plan field is missing or unsafe. Supply an explicit project, region, job, repository and bucket.");
  return value;
}
function integer(value, min = 1) {
  if (!Number.isSafeInteger(value) || value < min || value > 1000000) throw new CloudError("PLAN_INVALID", "The dispatcher returned an invalid task or retry count.");
  return value;
}
function repository(value) {
  if (typeof value !== "string") throw new CloudError("PLAN_INVALID", "A repository URL is required.");
  if (/^git@[a-zA-Z0-9.-]+:[A-Za-z0-9_./-]+$/.test(value)) return value;
  let url;
  try { url = new URL(value); } catch { throw new CloudError("PLAN_INVALID", "Use a credential-free HTTPS or SSH repository URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new CloudError("PLAN_INVALID", "Repository URLs must not contain credentials, queries or fragments.");
  return url.href;
}
function safePlan(payload) {
  const env = payload.env_vars;
  return {
    jobName: checked(payload.job_name, resource),
    region: checked(payload.region, resource),
    project: checked(payload.project, /^[a-z0-9][a-z0-9-]{0,62}$/),
    tasksCount: integer(payload.tasks_count),
    parallelism: integer(payload.parallelism),
    maxRetries: integer(payload.max_retries, 0),
    repo: repository(env.REPO_URL),
    gcsBucket: checked(env.GCS_BUCKET, /^[a-z0-9][a-z0-9._-]{1,221}$/),
    model: env.MODEL_OVERRIDE ? checked(env.MODEL_OVERRIDE) : null,
    vertex: env.USE_VERTEX_AI === "1",
    vertexLocation: env.VERTEXAI_LOCATION ? checked(env.VERTEXAI_LOCATION) : null,
    baseBranch: env.BASE_BRANCH ? checked(env.BASE_BRANCH) : null,
  };
}
function flags(options) {
  return dispatchOptions.flatMap((name) => {
    const value = options[name];
    if (value === undefined || value === null || value === false) return [];
    return value === true ? [`--${name}`] : [`--${name}`, String(value)];
  });
}
function planFlags(plan) {
  return flags({
    "job-name": plan.jobName,
    region: plan.region,
    project: plan.project,
    repo: plan.repo,
    "gcs-bucket": plan.gcsBucket,
    tasks: plan.tasksCount,
    parallelism: plan.parallelism,
    "max-retries": plan.maxRetries,
    model: plan.model,
    vertex: plan.vertex,
    "vertex-location": plan.vertexLocation,
    "base-branch": plan.baseBranch,
  });
}

function remoteState(data) {
  const conditions = data.status?.conditions ?? data.conditions;
  if (!Array.isArray(conditions)) return "unknown";
  const completed = conditions.find((condition) => condition.type === "Completed");
  if (!completed) return "unknown";
  if (completed.status === "True" || completed.state === "CONDITION_SUCCEEDED") return "succeeded";
  const reason = completed.executionReason ?? completed.reason;
  if (["CANCELLING", "Cancelling"].includes(reason)) return "cancelling";
  if (completed.status === "False" || completed.state === "CONDITION_FAILED") {
    return ["CANCELLED", "Cancelled", "Canceled"].includes(reason) ? "cancelled" : "failed";
  }
  if (completed.status === "Unknown" || ["CONDITION_PENDING", "CONDITION_RECONCILING"].includes(completed.state)) return "running";
  return "unknown";
}
function executionName(value, plan) {
  if (typeof value !== "string") return null;
  if (resource.test(value)) return value;
  const prefix = `projects/${plan.project}/locations/${plan.region}/jobs/${plan.jobName}/executions/`;
  return value.startsWith(prefix) && resource.test(value.slice(prefix.length)) ? value.slice(prefix.length) : null;
}
function matchesExecution(data, record, name) {
  if (executionName(data.metadata?.name ?? data.name, record.plan) !== name) return false;
  const labels = data.metadata?.labels ?? data.labels ?? {};
  const job = data.job ?? labels["run.googleapis.com/job"];
  if (job !== record.plan.jobName && job !== `projects/${record.plan.project}/locations/${record.plan.region}/jobs/${record.plan.jobName}`) return false;
  if (labels["cloud.googleapis.com/location"] && labels["cloud.googleapis.com/location"] !== record.plan.region) return false;
  const containers = data.spec?.template?.spec?.containers ?? data.template?.containers;
  if (!Array.isArray(containers)) return false;
  const sessions = containers.flatMap((container) => (container.env ?? []).filter((item) => item.name === "SWARM_SESSION_ID").map((item) => item.value));
  return sessions.length > 0 && sessions.every((value) => value === record.sessionId);
}

export class CloudController {
  constructor(store) { this.store = store; }
  save(record) { record.updatedAt = now(); return this.store.save(record); }
  async dispatch(options) {
    const requestId = options["client-request-id"];
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(requestId ?? "") || !options.manifest) throw new CloudError("INVALID_ARGUMENT", "dispatch requires --client-request-id and --manifest.");
    if (options["controller-task-id"] && !token.test(options["controller-task-id"])) throw new CloudError("INVALID_ARGUMENT", "The controller task ID must be a plain identifier.");
    const id = runId(requestId);
    return this.store.locked(id, async () => {
      const cwd = realpathSync(process.cwd());
      const engine = enginePath(options["agystack-source"], cwd);
      const manifest = readFileSync(options.manifest);
      try { JSON.parse(manifest.toString("utf8")); } catch { throw new CloudError("INVALID_ARGUMENT", "The manifest must contain valid JSON."); }
      const manifestFingerprint = hash(manifest);
      const inputFingerprint = hash(JSON.stringify({ cwd, engine, manifestFingerprint, flags: flags(options) }));
      let record = this.store.read(id);
      if (record) {
        if (record.inputFingerprint !== inputFingerprint) throw new CloudError("REQUEST_COLLISION", "This request ID already belongs to different inputs. Choose a new request ID for a new launch.");
        if (record.state !== "prepared") return record;
      }
      const python = executable("python3");
      executable("gcloud");
      const snapshot = this.store.snapshot(id, manifest);
      const session = sessionId(id);
      const args = ["--manifest", snapshot, "--session-id", session, "--gcs-prefix", `swarms/${session}`, "--no-wait"];
      try {
        if (!record) {
          const planned = await runProcess(python, ["-u", engine, ...flags(options), ...args, "--dry-run"], { cwd });
          if (planned.code !== 0) throw new CloudError("PLAN_FAILED", "The dispatcher could not resolve the plan. Check cloud and Git credentials, runtime configuration and manifest. Output was withheld.");
          const payload = parseDryRun(planned.stdout);
          if (payload.env_vars.SWARM_SESSION_ID !== session) throw new CloudError("PLAN_INVALID", "The dispatcher did not preserve the requested session ID.");
          record = {
            schemaVersion: 1, id, requestId, inputFingerprint, manifestFingerprint,
            sessionId: session, cwd, engine,
            controllerTaskId: options["controller-task-id"] ?? null,
            plan: safePlan(payload), state: "prepared", execution: null,
            harvest: null, cancellation: null, createdAt: now(),
          };
          this.save(record);
        }
        record.state = "launching";
        record.launchIntentAt = now();
        this.save(record);
        let result;
        try {
          result = await runProcess(python, ["-u", engine, ...planFlags(record.plan), ...(options["orchestrator-timeout"] ? ["--orchestrator-timeout", options["orchestrator-timeout"]] : []), ...args], { cwd });
        } catch (error) {
          record.state = "unknown";
          this.save(record);
          if (error.code === "INTERRUPTED") throw error;
          throw new CloudError("LAUNCH_UNCERTAIN", "The launch may have reached Cloud Run. Use resume. This request will never be launched again.");
        }
        const handle = result.stdout.match(/^Execution: (\S+)\s*$/m)?.[1];
        record.execution = executionName(handle, record.plan);
        record.state = record.execution ? "running" : "unknown";
        this.save(record);
        if (result.code !== 0) throw new CloudError("LAUNCH_UNCERTAIN", "The launch may have reached Cloud Run. Use resume. This request will never be launched again.");
        return record;
      } finally { unlinkSync(snapshot); }
    });
  }
  async gcloud(record, operation, name, extra = [], timeout = 30000) {
    const args = ["run", "jobs", "executions", operation, ...(name ? [name] : []), `--project=${record.plan.project}`, `--region=${record.plan.region}`, "--format=json", "--quiet", ...extra];
    const result = await runProcess(executable("gcloud"), args, { cwd: record.cwd, timeout });
    if (result.code !== 0) throw new CloudError("REMOTE_FAILED", "Cloud Run could not complete the request. Check gcloud credentials, project permissions and connectivity. Output was withheld.");
    return operation === "cancel" ? null : parseJson(result.stdout);
  }
  async refresh(record) {
    if (terminal(record.state) || record.state === "prepared") return record;
    let data;
    if (!record.execution) {
      record.state = "unknown";
      this.save(record);
      const deadline = Date.now() + 60000;
      // gcloud follows pages up to --limit. Hitting the cap cannot prove uniqueness.
      const items = await this.gcloud(record, "list", null, [`--job=${record.plan.jobName}`, "--page-size=100", "--limit=1001"]);
      if (!Array.isArray(items) || items.length > 1000) throw new CloudError("RECOVERY_INCOMPLETE", "Recovery did not scan a complete execution list. The launch remains unresolved and cannot be repeated.");
      const matches = new Map();
      for (const item of items) {
        if (Date.now() >= deadline) throw new CloudError("RECOVERY_INCOMPLETE", "Recovery reached its time budget. The launch remains unresolved and cannot be repeated.");
        const name = executionName(item.metadata?.name ?? item.name, record.plan);
        if (!name) throw new CloudError("RECOVERY_INCOMPLETE", "An execution could not be identified. The launch remains unresolved.");
        const candidate = await this.gcloud(record, "describe", name, [], Math.max(1, deadline - Date.now()));
        if (matchesExecution(candidate, record, name)) matches.set(name, candidate);
      }
      if (matches.size > 1) throw new CloudError("AMBIGUOUS_EXECUTION", "Multiple executions match the session. Resolve them manually before any cancellation or attachment.");
      if (!matches.size) return record;
      [record.execution, data] = matches.entries().next().value;
    } else {
      data = await this.gcloud(record, "describe", record.execution);
      if (!matchesExecution(data, record, record.execution)) throw new CloudError("EXECUTION_MISMATCH", "Cloud Run did not confirm this execution's job and session. No action was taken.");
    }
    const observed = remoteState(data);
    record.state = record.state === "cancelling" && ["running", "unknown"].includes(observed) ? "cancelling" : observed;
    record.observedAt = now();
    return this.save(record);
  }
  async status(id) { return this.store.locked(id, () => this.refresh(this.store.require(id))); }
  async cancel(id) {
    return this.store.locked(id, async () => {
      const record = await this.refresh(this.store.require(id));
      if (terminal(record.state)) return record;
      if (!record.execution) throw new CloudError("EXECUTION_UNRESOLVED", "No verified execution handle is available. Use resume before cancellation.");
      if (record.cancellation?.status === "accepted") return record;
      record.cancellation = { requestedAt: now(), status: "requested" };
      record.state = "cancelling";
      this.save(record);
      try {
        await this.gcloud(record, "cancel", record.execution);
        record.cancellation.status = "accepted";
        this.save(record);
      } catch (error) {
        record.cancellation.status = "unconfirmed";
        this.save(record);
        if (error.code === "INTERRUPTED") throw error;
        throw new CloudError("CANCEL_UNCONFIRMED", "Cloud Run did not confirm the cancellation request. Use status, then cancel again if necessary. Output was withheld.");
      }
      return this.refresh(record);
    });
  }
  async harvest(id) {
    return this.store.locked(id, async () => {
      const record = this.store.require(id);
      const args = ["-u", record.engine, ...planFlags(record.plan), "--harvest-session", record.sessionId, "--gcs-prefix", `swarms/${record.sessionId}`];
      record.harvest = { status: "fetching", startedAt: now(), directory: join(record.cwd, ".slices", record.sessionId) };
      this.save(record);
      try {
        const result = await runProcess(executable("python3"), args, { cwd: record.cwd });
        record.harvest.status = result.code === 0 ? "downloaded" : "failed";
      } catch (error) {
        record.harvest.status = "interrupted";
        this.save(record);
        throw error;
      }
      record.harvest.finishedAt = now();
      this.save(record);
      await this.refresh(record);
      if (record.harvest.status === "failed") throw new CloudError("HARVEST_FAILED", "The dispatcher could not harvest artifacts. Output was withheld. Remote state is independent of harvest.");
      return record;
    });
  }
  async attach(id) {
    const record = await this.status(id);
    if (!record.execution) throw new CloudError("EXECUTION_UNRESOLVED", "Use resume to recover an execution handle before attaching.");
    // Observation holds no mutation lock, so a separate cancel command can run.
    const result = await runProcess(executable("python3"), ["-u", record.engine, ...planFlags(record.plan), "--wait-execution", record.execution, "--session-id", record.sessionId, "--gcs-prefix", `swarms/${record.sessionId}`], { cwd: record.cwd, timeout: 0, stream: true });
    const refreshed = await this.status(id);
    if (result.code !== 0) throw new CloudError("ATTACH_FAILED", "The observer exited unsuccessfully. Remote state was refreshed. Use status for the outcome.");
    return refreshed;
  }
}
