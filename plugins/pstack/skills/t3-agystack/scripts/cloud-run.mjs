#!/usr/bin/env node
// POSIX-only. Lock ports, process groups and 0600 diagnostics require POSIX.
import { parseArgs } from "node:util";
import { CloudController, dispatchOptions } from "./cloud-controller.mjs";
import { CloudError, RunStore, validateId } from "./cloud-state.mjs";

const help = `Usage: cloud-run.mjs dispatch --client-request-id ID --manifest FILE [options]
       cloud-run.mjs status|resume|cancel|harvest|attach RUN_ID [--json]
       cloud-run.mjs list [--json]

Dispatch options:
  --agystack-source DIR       Installed agystack plugin directory.
  --controller-task-id ID     Optional T3 provenance, not authenticated identity.
                              First write wins: a retry from another task keeps the
                              recorded ID and returns controllerTaskIdNotice.
  --repo URL --job-name NAME --project ID --region REGION --gcs-bucket NAME
  --model MODEL --parent-model MODEL --vertex --vertex-location REGION
  --base-branch BRANCH --tasks N --parallelism N --max-retries N
  --orchestrator-timeout SECONDS

The engine also resolves its runtime configuration and credentials.
AGYSTACK_DISPATCH_SCRIPT overrides default engine discovery. Job and execution
names follow the Cloud Run limit of 63 characters.
State lives under XDG_STATE_HOME or ~/.local/state, in t3-pstack/agystack/runs.
Keep one state directory on a local filesystem. Locks use exclusive loopback
ports for the process lifetime. A port collision returns BUSY with the winning
run id, state and execution when known; retry with the same request ID.
Do not share the directory across hosts or network namespaces.

dispatch plans with the engine's preflight, then records a launch intent before
it calls the engine. A failure before the engine's "Launching Cloud Run Job"
line is a pre-launch failure: the record stays prepared and the same request ID
may retry. A failure after that line stays uncertain and is never relaunched.
Reuse a request ID to read its handle. Use a new request ID only when you
explicitly intend another paid run.
status and resume reconcile remote state without launching. Recovery filters
executions by creation time server-side and pages until the list is complete
within its scan cap; an incomplete scan stays unresolved.
cancel requests remote cancellation, then checks its outcome. Killing this
controller or interrupting attach does not cancel the remote execution.
attach streams safe progress counters to stderr and a final record to stdout.
It omits raw worker logs and can harvest through the engine when it finishes.
harvest does not hold the run's mutation lock while it downloads, so cancel
stays available; it records download metadata separately from the remote outcome.
Any failing verb writes the last 50 redacted stderr lines to a 0600 file beside
the run records and reports its path as details.diagnostics. Output is never
forwarded, and known credential values are scrubbed.
list marks an unreadable record as state "corrupt" with its error code instead
of failing the whole listing.
--json emits records on stdout and structured errors on stderr.
`;

let json = process.argv.includes("--json");
try {
  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, options: {
      ...Object.fromEntries([...dispatchOptions.filter((name) => name !== "vertex"), "client-request-id", "manifest", "agystack-source", "controller-task-id"].map((name) => [name, { type: "string" }])),
      vertex: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" },
    } });
  } catch { throw new CloudError("INVALID_ARGUMENT", "Unknown or malformed arguments. Use --help."); }
  const { values, positionals } = parsed;
  json = values.json ?? false;
  if (values.help) process.stdout.write(help);
  else {
    const [verb, id] = positionals;
    if (!["dispatch", "status", "resume", "cancel", "harvest", "list", "attach"].includes(verb)
      || positionals.length !== (["dispatch", "list"].includes(verb) ? 1 : 2)
      || (verb !== "dispatch" && Object.keys(values).some((key) => key !== "json"))) throw new CloudError("INVALID_ARGUMENT", "Use dispatch, status, resume, cancel, harvest, list or attach with the arguments shown in --help.");
    if (id) validateId(id);
    const store = new RunStore();
    const controller = new CloudController(store);
    const result = verb === "list" ? store.list() : verb === "dispatch" ? await controller.dispatch(values) : await controller[verb === "resume" ? "status" : verb](id);
    if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else for (const record of Array.isArray(result) ? result : [result]) {
      process.stdout.write(`${record.id} ${record.state}\n`);
      if (record.state === "corrupt") process.stdout.write(`Code: ${record.code}\n`);
      else process.stdout.write(`Session: ${record.sessionId}\nExecution: ${record.execution ?? "unresolved"}\n`);
      if (record.controllerTaskIdNotice) process.stdout.write(`Notice: ${record.controllerTaskIdNotice}\n`);
    }
  }
} catch (error) {
  const safe = error instanceof CloudError ? error : new CloudError("LOCAL_FAILURE", "A local prerequisite or state operation failed. Check file paths and permissions. Details were withheld.");
  process.stderr.write(json ? `${JSON.stringify({ error: safe.code, message: safe.message, ...(safe.details ? { details: safe.details } : {}) })}\n` : `${safe.code}: ${safe.message}\n`);
  process.exitCode = safe.code === "INTERRUPTED" ? 130 : 1;
}
