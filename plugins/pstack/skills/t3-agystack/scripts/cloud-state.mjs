import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export class CloudError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const terminal = (state) => ["succeeded", "failed", "cancelled"].includes(state);
export const runId = (requestId) => `run-${hash(requestId)}`;
export const sessionId = (id) => `t3-${id.slice(4)}`;
export function validateId(id) {
  if (!/^run-[a-f0-9]{64}$/.test(id ?? "")) throw new CloudError("INVALID_ARGUMENT", "Use a run ID returned by dispatch or list.");
  return id;
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
  list() {
    return readdirSync(this.root).filter((name) => /^run-[a-f0-9]{64}\.json$/.test(name))
      .sort().map((name) => this.require(name.slice(0, -5)));
  }
  async locked(id, action) {
    validateId(id);
    // A loopback listener is a kernel-owned process-lifetime lock. Port collisions
    // fail closed as BUSY. No stale-file deletion can race a replacement owner.
    const port = 20000 + (parseInt(hash(`${this.root}/${id}`).slice(0, 8), 16) % 40000);
    const server = createServer((socket) => socket.destroy());
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
      });
    } catch {
      throw new CloudError("BUSY", "Another local operation owns this run's lock, or its lock port is unavailable. Retry later.");
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
