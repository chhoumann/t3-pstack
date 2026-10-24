// POSIX-only. Run state relies on POSIX file modes (0600), directory fsync,
// and loopback listener locks. There is no win32 fallback by design.
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export class CloudError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const terminal = (state) => ["succeeded", "failed", "cancelled"].includes(state);
export const runId = (requestId) => `run-${hash(requestId)}`;
export const sessionId = (id) => `t3-${id.slice(4)}`;
export function validateId(id) {
  if (!/^run-[a-f0-9]{64}$/.test(id ?? "")) throw new CloudError("INVALID_ARGUMENT", "Use a run ID returned by dispatch or list.");
  return id;
}

const secretName = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|API_KEY|APIKEY|CREDENTIAL)/i;
function knownSecrets() {
  return Object.entries(process.env)
    .filter(([name, value]) => value && value.length >= 8 && secretName.test(name))
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
}
// Provider output can quote credential-bearing commands. Strip values we know
// came from this process' environment, then the common literal shapes.
export function redact(text) {
  let out = String(text ?? "");
  for (const value of knownSecrets()) out = out.split(value).join("REDACTED");
  return out
    .replace(/(--?(?:token|api[-_]?key|secret|password)[=\s:]+)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1REDACTED")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,})\b/g, "REDACTED")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1REDACTED");
}

function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function durableDirectory(path) {
  if (existsSync(path)) return;
  durableDirectory(dirname(path));
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  syncDirectory(dirname(path));
}
function checkPrivate(path, directory) {
  const stat = lstatSync(path);
  if ((directory ? !stat.isDirectory() : !stat.isFile())
    || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) {
    throw new CloudError("STATE_PERMISSIONS", "Run state must be owned by this user and inaccessible to other users.");
  }
}

function busy(store, id, scope) {
  // Another process owns the listener. Report the winning run so the caller can
  // retry with the same client request ID instead of minting a new one.
  let record = null;
  try { record = store.read(id); } catch { /* Unreadable or absent state still does not hand over the lock. */ }
  return new CloudError("BUSY", `Another local operation owns this run's ${scope} lock. Retry with the same client request ID; that attaches to this run instead of launching a duplicate.`, {
    runId: id,
    clientRequestId: record?.requestId ?? null,
    state: record?.state ?? "unknown",
    execution: record?.execution ?? null,
    lock: scope,
    retryWithSameRequestId: true,
  });
}

export class RunStore {
  constructor() {
    const base = process.env.XDG_STATE_HOME || join(homedir(), ".local/state");
    if (!base.startsWith("/")) throw new CloudError("INVALID_ARGUMENT", "XDG_STATE_HOME must be absolute.");
    const root = join(base, "t3-pstack/agystack/runs");
    durableDirectory(root);
    checkPrivate(root, true);
    this.root = realpathSync(root);
  }
  path(id) { return join(this.root, `${validateId(id)}.json`); }
  read(id) {
    const path = this.path(id);
    if (!existsSync(path)) return null;
    checkPrivate(path, false);
    let record;
    try { record = JSON.parse(readFileSync(path, "utf8")); } catch { throw new CloudError("STATE_CORRUPT", "The run record cannot be read. Preserve it for manual recovery."); }
    if (record.schemaVersion !== 1 || record.id !== id || runId(record.requestId ?? "") !== id
      || record.sessionId !== sessionId(id) || !["prepared", "launching", "unknown", "running", "cancelling", "succeeded", "failed", "cancelled"].includes(record.state)) {
      throw new CloudError("STATE_CORRUPT", "The run record has an unsupported shape. Preserve it for manual recovery.");
    }
    return record;
  }
  require(id) {
    const record = this.read(id);
    if (!record) throw new CloudError("RUN_MISSING", "No local record exists for this run ID.");
    return record;
  }
  save(record) {
    const path = this.path(record.id);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    try {
      renameSync(temporary, path);
      syncDirectory(this.root);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    return record;
  }
  // One unreadable record must not hide the rest. Permission failures still fail
  // closed: a record owned by someone else is a security problem, not damage.
  list() {
    return readdirSync(this.root).filter((name) => /^run-[a-f0-9]{64}\.json$/.test(name))
      .sort().map((name) => {
        const id = name.slice(0, -5);
        try { return this.require(id); }
        catch (error) {
          if (error instanceof CloudError && ["STATE_CORRUPT", "RUN_MISSING"].includes(error.code)) {
            return { id, state: "corrupt", code: error.code, message: error.message };
          }
          throw error;
        }
      });
  }
  // Keep the last provider lines for diagnosis. Redacted, owner-only, never on stdout.
  diagnostics(id, verb, text) {
    const path = join(this.root, `${validateId(id)}.${verb.replace(/[^a-z0-9-]/gi, "-")}.log`);
    const tail = redact(text).replace(/\s+$/, "").split("\n").slice(-50).join("\n");
    writeFileSync(path, `# ${verb} failure at ${new Date().toISOString()}\n${tail}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  }
  async locked(id, action, scope = "state") {
    validateId(id);
    // A loopback listener is a kernel-owned process-lifetime lock. Port collisions
    // fail closed as BUSY. No stale-file deletion can race a replacement owner.
    const port = 20000 + (parseInt(hash(`${this.root}/${id}:${scope}`).slice(0, 8), 16) % 40000);
    const server = createServer((socket) => socket.destroy());
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
      });
    } catch {
      throw busy(this, id, scope);
    }
    try { return await action(); }
    finally { await new Promise((resolve) => server.close(resolve)); }
  }
  snapshot(id, contents) {
    const path = join(this.root, `.${validateId(id)}.${randomUUID()}.manifest.json`);
    writeFileSync(path, contents, { flag: "wx", mode: 0o600 });
    return path;
  }
}
