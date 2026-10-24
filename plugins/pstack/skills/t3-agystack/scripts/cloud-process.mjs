// POSIX-only. Process-group signalling, detached process groups and file modes
// have no win32 equivalent; the bridge refuses to pretend otherwise.
import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { CloudError } from "./cloud-state.mjs";

const OUTPUT_LIMIT = 8 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;

export function executable(name) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const path = resolve(dir, name);
    try { accessSync(path, constants.X_OK); if (statSync(path).isFile()) return path; } catch {}
  }
  throw new CloudError("PREREQUISITE_MISSING", `Install ${name} and make it available on PATH.`);
}
export function enginePath(source, cwd) {
  const relative = "skills/swarm/scripts/cloud_dispatch.py";
  const paths = source ? [join(resolve(source), relative)]
    : process.env.AGYSTACK_DISPATCH_SCRIPT ? [resolve(process.env.AGYSTACK_DISPATCH_SCRIPT)]
      : [join(homedir(), ".gemini/config/plugins/agystack", relative), join(cwd, ".agents/plugins/agystack", relative)];
  for (const path of paths) {
    try { accessSync(path, constants.R_OK); if (statSync(path).isFile()) return realpathSync(path); } catch {}
  }
  throw new CloudError("ENGINE_MISSING", "Install agystack or pass --agystack-source pointing to its plugin directory.");
}

function progressLine(line) {
  const progress = line.match(/^\[Cloud Swarm\] Progress: \d+\/\d+ succeeded, \d+ running, \d+ failed\./);
  if (progress) process.stderr.write(`${progress[0]}\n`);
}

// stderr is captured in a bounded tail for redacted diagnostics. It is never
// forwarded: provider output can quote credential-bearing commands.
export async function runProcess(command, args, { cwd, timeout = 120000, stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PYTHONUNBUFFERED: "1", CLOUDSDK_CORE_DISABLE_PROMPTS: "1" } });
    let stdout = "", stderr = "", line = "", size = 0, failure, escalation;
    function kill(signal) {
      try { process.kill(-child.pid, signal); } catch { /* The process has already exited. */ }
    }
    function stop(code) {
      failure ??= code;
      kill("SIGTERM");
      escalation ??= setTimeout(() => kill("SIGKILL"), 1000);
    }
    const interrupt = () => stop("INTERRUPTED");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    const timer = timeout ? setTimeout(() => stop("PROCESS_TIMEOUT"), timeout) : null;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stream) {
        line += chunk;
        for (let newline; (newline = line.indexOf("\n")) !== -1;) {
          progressLine(line.slice(0, newline)); line = line.slice(newline + 1);
        }
        if (line.length > 8192) line = "";
      } else {
        size += Buffer.byteLength(chunk);
        if (size > OUTPUT_LIMIT) stop("PROCESS_OUTPUT_LIMIT");
        else stdout += chunk;
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-STDERR_LIMIT); });
    child.on("error", () => { failure = "PROCESS_START_FAILED"; });
    child.on("close", (code, signal) => {
      clearTimeout(timer); clearTimeout(escalation);
      process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
      // The bounded tail rides on the error so callers can persist a redacted
      // copy. It is never part of the error payload shown to the user.
      if (failure) {
        const error = new CloudError(failure, "The external process did not finish. Its output was withheld. Use status or resume to reconcile the run.");
        error.stderr = stderr;
        reject(error);
      // A signalled child was cut off, so its stdout cannot prove what happened.
      } else if (signal) {
        const error = new CloudError("PROCESS_SIGNALLED", "The external process was terminated by a signal before it finished. Use status or resume to reconcile the run.");
        error.stderr = stderr;
        reject(error);
      } else resolve({ code, stdout, stderr });
    });
  });
}

export function parseJson(text) {
  try { return JSON.parse(text); } catch { throw new CloudError("REMOTE_INVALID", "The external process returned an unrecognized response. Output was withheld."); }
}
export function parseDryRun(text) {
  // cloud_dispatch prints preflight text before a final pretty-printed object.
  for (const match of text.matchAll(/^\{/gm)) {
    try {
      const payload = JSON.parse(text.slice(match.index));
      if (payload.job_name && payload.env_vars) return payload;
    } catch { /* This line was human output rather than the final JSON object. */ }
  }
  throw new CloudError("PLAN_INVALID", "The dispatcher did not return its dry-run plan. Output was withheld.");
}
