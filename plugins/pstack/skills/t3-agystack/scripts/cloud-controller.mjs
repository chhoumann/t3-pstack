// POSIX-only. The controller depends on loopback lock ports, process groups and
// 0600 diagnostics files. There is no win32 fallback by design.
import { readFileSync, realpathSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CloudError, hash, runId, sessionId, terminal } from "./cloud-state.mjs";
import { enginePath, executable, parseDryRun, parseJson, runProcess } from "./cloud-process.mjs";

const now = () => new Date().toISOString();
// Cloud Run caps job and execution resource names at 63 characters (job names are
// further constrained in practice because revisions and executions append suffixes).
// Accept the API maximum and reject anything longer rather than silently truncating.
const resource = /^[a-z][a-z0-9-]{0,62}$/;
const token = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
// The engine prints this line immediately before invoking `gcloud run jobs execute`
// (cloud_dispatch.py: "Launching Cloud Run Job ..."). Its presence is the only
// positive evidence that an attempt could have reached Cloud Run.
const LAUNCH_MARKER = /^Launching Cloud Run Job\b/m;
const RECOVERY_PAGE = 100;
const RECOVERY_MAX = 2000;
const RECOVERY_BUDGET = 60000;
// Local clocks can trail the API's creationTimestamp, so widen the server-side
// lower bound instead of assuming perfect ordering.
const RECOVERY_SKEW = 10 * 60 * 1000;
const RECOVERY_CONCURRENCY = 8;

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
  try { url = new URL(value); } catch { throw new CloudError("PLAN_INVALID", "Use an HTTPS, ssh:// or scp-style Git repository URL without a password, query or fragment."); }
  if (url.password || url.search || url.hash) throw new CloudError("PLAN_INVALID", "Repository URLs must not contain passwords, queries or fragments.");
  if (url.protocol === "ssh:") return url.href;
  if (url.protocol !== "https:" || url.username) throw new CloudError("PLAN_INVALID", "Use an HTTPS URL without credentials, an ssh:// URL with an optional username, or a scp-style git@host:path URL.");
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
function taskIdNotice(record, requested) {
  if (!requested || record.controllerTaskId === requested) return null;
  return `First controller task ID ${record.controllerTaskId ?? "(none)"} is kept for this request; ${requested} was ignored.`;
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
// The engine identifies an execution by recursively finding the SWARM_SESSION_ID
// (or SESSION_ID) env value; it never relies on a job label. Mirror that, and
// only use job/region metadata as corroboration when the API supplies it.
function sessionValues(data) {
  const values = [];
  const walk = (node) => {
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (!node || typeof node !== "object") return;
    if (["SWARM_SESSION_ID", "SESSION_ID"].includes(node.name) && typeof node.value === "string") values.push(node.value.trim());
    for (const value of Object.values(node)) walk(value);
  };
  walk(data);
  return values;
}
function matchesExecution(data, record, name) {
  if (!data || typeof data !== "object") return false;
  if (executionName(data.metadata?.name ?? data.name, record.plan) !== name) return false;
  const sessions = sessionValues(data);
  if (!sessions.length || !sessions.every((value) => value === record.sessionId)) return false;
  const labels = data.metadata?.labels ?? data.labels ?? {};
  const full = `projects/${record.plan.project}/locations/${record.plan.region}/jobs/${record.plan.jobName}`;
  const job = data.job ?? labels["run.googleapis.com/job"];
  if (job && job !== record.plan.jobName && job !== full) return false;
  if (labels["cloud.googleapis.com/location"] && labels["cloud.googleapis.com/location"] !== record.plan.region) return false;
  return true;
}
function launched(stdout) {
  return typeof stdout === "string" && LAUNCH_MARKER.test(stdout);
}
async function mapLimit(items, limit, worker) {
  let next = 0;
  const run = async () => {
    while (next < items.length) await worker(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}
function incomplete(message) {
  return new CloudError("RECOVERY_INCOMPLETE", `${message} The launch remains unresolved and cannot be repeated.`);
}

export class CloudController {
  constructor(store) { this.store = store; }
  save(record) { record.updatedAt = now(); return this.store.save(record); }
  diagnostics(record, verb, stderr) { return this.store.diagnostics(record.id, verb, stderr); }
  // Bounded process execution that always leaves a redacted diagnostics file when
  // the provider could not finish (timeout, signal, interruption, start failure).
  async external(id, verb, command, args, options) {
    try { return await runProcess(command, args, options); }
    catch (error) {
      if (error instanceof CloudError && typeof error.stderr === "string" && error.stderr) {
        const diagnostics = this.store.diagnostics(id, verb, error.stderr);
        error.details = { ...(error.details ?? {}), runId: id, diagnostics };
      }
      throw error;
    }
  }
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
      let notice = null;
      if (record) {
        if (record.inputFingerprint !== inputFingerprint) throw new CloudError("REQUEST_COLLISION", "This request ID already belongs to different inputs. Choose a new request ID for a new launch.");
        // Provenance is first-write-wins: a retry from a different controller task
        // keeps the recorded owner and says so rather than rewriting history.
        notice = taskIdNotice(record, options["controller-task-id"]);
        if (record.state !== "prepared") return notice ? { ...record, controllerTaskIdNotice: notice } : record;
      }
      const python = executable("python3");
      executable("gcloud");
      const snapshot = this.store.snapshot(id, manifest);
      const session = sessionId(id);
      const args = ["--manifest", snapshot, "--session-id", session, "--gcs-prefix", `swarms/${session}`, "--no-wait"];
      try {
        if (!record) {
          // --preflight makes quota, auth, git and bucket failures surface while
          // nothing has been staged or launched, so a retry is always safe.
          const planned = await this.external(id, "plan", python, ["-u", engine, ...flags(options), ...args, "--preflight", "--dry-run"], { cwd });
          if (planned.code !== 0) {
            const diagnostics = this.store.diagnostics(id, "plan", planned.stderr);
            throw new CloudError("PLAN_FAILED", "The dispatcher could not resolve a pre-launch plan. Nothing was launched; fix credentials, quota, repository access or the bucket, then retry with the same client request ID. A redacted copy of the engine output is in the diagnostics file.", { runId: id, diagnostics });
          }
          const payload = parseDryRun(planned.stdout);
          if (payload.env_vars.SWARM_SESSION_ID !== session) throw new CloudError("PLAN_INVALID", "The dispatcher did not preserve the requested session ID.");
          record = {
            schemaVersion: 1, id, requestId, inputFingerprint, manifestFingerprint,
            sessionId: session, cwd, engine,
            controllerTaskId: options["controller-task-id"] ?? null,
            plan: safePlan(payload), state: "prepared", execution: null,
            harvest: null, cancellation: null, lastFailure: null, createdAt: now(),
          };
          this.save(record);
        }
        record.state = "launching";
        record.launchIntentAt = now();
        record.lastFailure = null;
        this.save(record);
        let result;
        try {
          result = await this.external(id, "launch", python, ["-u", engine, ...planFlags(record.plan), ...(options["orchestrator-timeout"] ? ["--orchestrator-timeout", options["orchestrator-timeout"]] : []), ...args], { cwd });
        } catch (error) {
          // The engine was killed or exceeded a bound: stdout cannot prove whether
          // gcloud was invoked, so the record stays ambiguous. Never relaunch it.
          record.state = "unknown";
          this.save(record);
          if (error.code === "INTERRUPTED") throw error;
          throw new CloudError("LAUNCH_UNCERTAIN", "The launch may have reached Cloud Run. Use resume. This request will never be launched again.", { runId: id, diagnostics: error.details?.diagnostics ?? null });
        }
        const handle = result.stdout.match(/^Execution: (\S+)\s*$/m)?.[1];
        record.execution = executionName(handle, record.plan);
        if (result.code !== 0 && !launched(result.stdout)) {
          // No launch marker on a completed run means the engine stopped before
          // `gcloud run jobs execute` (preflight, credentials, quota, git, bucket,
          // staging). That is a deterministic pre-launch failure, so the request
          // stays retryable instead of being stranded forever.
          record.state = "prepared";
          record.execution = null;
          const diagnostics = this.store.diagnostics(id, "launch", result.stderr);
          record.lastFailure = { code: "PRELAUNCH_FAILED", at: now(), retryable: true, evidence: "launch-marker-absent", diagnostics };
          this.save(record);
          throw new CloudError("PRELAUNCH_FAILED", "The engine stopped before starting the Cloud Run launch. Nothing was launched; retry with the same client request ID. A redacted copy of the engine output is in the diagnostics file.", { runId: id, diagnostics, retryable: true });
        }
        record.state = record.execution ? "running" : "unknown";
        this.save(record);
        if (result.code !== 0) {
          const diagnostics = this.store.diagnostics(id, "launch", result.stderr);
          record.lastFailure = { code: "LAUNCH_UNCERTAIN", at: now(), retryable: false, evidence: "launch-marker-present", diagnostics };
          this.save(record);
          throw new CloudError("LAUNCH_UNCERTAIN", "The launch may have reached Cloud Run. Use resume. This request will never be launched again.", { runId: id, diagnostics });
        }
        return notice ? { ...record, controllerTaskIdNotice: notice } : record;
      } finally { unlinkSync(snapshot); }
    });
  }
  async gcloud(record, operation, name, extra = [], timeout = 30000, verb = operation) {
    const args = ["run", "jobs", "executions", operation, ...(name ? [name] : []), `--project=${record.plan.project}`, `--region=${record.plan.region}`, "--format=json", "--quiet", ...extra];
    const result = await this.external(record.id, verb, executable("gcloud"), args, { cwd: record.cwd, timeout });
    if (result.code !== 0) {
      const diagnostics = this.diagnostics(record, verb, result.stderr);
      throw new CloudError("REMOTE_FAILED", "Cloud Run could not complete the request. Check gcloud credentials, project permissions and connectivity. A redacted copy of the provider output is in the diagnostics file.", { runId: record.id, operation, diagnostics });
    }
    return operation === "cancel" ? null : parseJson(result.stdout);
  }
  // gcloud walks list pages internally and prints one JSON array, so a short array
  // proves the walk ended. Grow --limit until it is short: that covers every page
  // without turning a large job history into a fatal error. Only executions newer
  // than this record's launch intent can belong to it, so ask the server to filter.
  async executions(record, deadline) {
    const started = Date.parse(record.launchIntentAt ?? record.createdAt);
    const extra = [`--job=${record.plan.jobName}`];
    if (Number.isFinite(started)) extra.push(`--filter=creationTimestamp>=${new Date(started - RECOVERY_SKEW).toISOString()}`);
    for (let limit = RECOVERY_PAGE; ; limit = Math.min(limit * 2, RECOVERY_MAX)) {
      if (Date.now() >= deadline) throw incomplete("Recovery reached its time budget.");
      const items = await this.gcloud(record, "list", null, [...extra, `--page-size=${RECOVERY_PAGE}`, `--limit=${limit}`], Math.max(1, deadline - Date.now()), "recovery-list");
      if (!Array.isArray(items)) throw incomplete("Recovery did not receive a complete execution array.");
      if (items.length < limit) return items;
      if (limit >= RECOVERY_MAX) throw incomplete(`Recovery reached its ${RECOVERY_MAX}-execution scan cap.`);
    }
  }
  async refresh(record) {
    if (terminal(record.state) || record.state === "prepared") return record;
    let data;
    if (!record.execution) {
      record.state = "unknown";
      this.save(record);
      const deadline = Date.now() + RECOVERY_BUDGET;
      const items = await this.executions(record, deadline);
      const candidates = items.map((item) => {
        const name = executionName(item.metadata?.name ?? item.name, record.plan);
        if (!name) throw incomplete("An execution in the list could not be identified.");
        return name;
      });
      const matches = new Map();
      await mapLimit([...new Set(candidates)], RECOVERY_CONCURRENCY, async (name) => {
        if (Date.now() >= deadline) throw incomplete("Recovery reached its time budget.");
        const candidate = await this.gcloud(record, "describe", name, [], Math.max(1, deadline - Date.now()), "recovery-describe");
        if (matchesExecution(candidate, record, name)) matches.set(name, candidate);
      });
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
        record.cancellation.diagnostics = error.details?.diagnostics ?? null;
        this.save(record);
        if (error.code === "INTERRUPTED") throw error;
        throw new CloudError("CANCEL_UNCONFIRMED", "Cloud Run did not confirm the cancellation request. Use status, then cancel again if necessary. A redacted copy of the provider output is in the diagnostics file.", { runId: id, diagnostics: record.cancellation.diagnostics });
      }
      return this.refresh(record);
    });
  }
  async harvest(id) {
    // The download runs without the state lock so cancellation stays available,
    // but a per-run harvest lock keeps two downloads from writing the same tree.
    return this.store.locked(id, async () => {
      const record = await this.store.locked(id, () => {
        const current = this.store.require(id);
        current.harvest = { status: "fetching", startedAt: now(), directory: join(current.cwd, ".slices", current.sessionId) };
        return this.save(current);
      });
      const args = ["-u", record.engine, ...planFlags(record.plan), "--harvest-session", record.sessionId, "--gcs-prefix", `swarms/${record.sessionId}`];
      let result;
      try {
        // Downloads can outlive any fixed timeout; attach uses the same policy.
        result = await this.external(id, "harvest", executable("python3"), args, { cwd: record.cwd, timeout: 0 });
      } catch (error) {
        await this.store.locked(id, () => {
          const current = this.store.require(id);
          current.harvest.status = "interrupted";
          current.harvest.finishedAt = now();
          this.save(current);
        });
        throw error;
      }
      return this.store.locked(id, async () => {
        const current = this.store.require(id);
        current.harvest.status = result.code === 0 ? "downloaded" : "failed";
        current.harvest.finishedAt = now();
        if (result.code !== 0) {
          current.harvest.diagnostics = this.diagnostics(current, "harvest", result.stderr);
          this.save(current);
          throw new CloudError("HARVEST_FAILED", "The dispatcher could not harvest artifacts. Remote state is independent of harvest. A redacted copy of the engine output is in the diagnostics file.", { runId: id, diagnostics: current.harvest.diagnostics });
        }
        this.save(current);
        await this.refresh(current);
        return current;
      });
    }, "harvest");
  }
  async attach(id) {
    const record = await this.status(id);
    if (!record.execution) throw new CloudError("EXECUTION_UNRESOLVED", "Use resume to recover an execution handle before attaching.");
    // Observation holds no mutation lock, so a separate cancel command can run.
    const result = await this.external(id, "attach", executable("python3"), ["-u", record.engine, ...planFlags(record.plan), "--wait-execution", record.execution, "--session-id", record.sessionId, "--gcs-prefix", `swarms/${record.sessionId}`], { cwd: record.cwd, timeout: 0, stream: true });
    const refreshed = await this.status(id);
    if (result.code !== 0) {
      const diagnostics = this.diagnostics(record, "attach", result.stderr);
      throw new CloudError("ATTACH_FAILED", "The observer exited unsuccessfully. Remote state was refreshed. A redacted copy of the engine output is in the diagnostics file. Use status for the outcome.", { runId: id, diagnostics });
    }
    return refreshed;
  }
}
