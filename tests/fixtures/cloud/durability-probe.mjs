import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const root = process.env.CLOUD_FIXTURE;
const original = { open: fs.openSync, close: fs.closeSync, sync: fs.fsyncSync, rename: fs.renameSync };
const paths = new Map();
let renamedState;
const event = (kind, state) => fs.appendFileSync(join(root, "events.jsonl"), `${JSON.stringify({ kind, state })}\n`);
fs.openSync = (...args) => {
  const fd = original.open(...args);
  paths.set(fd, String(args[0]));
  return fd;
};
fs.closeSync = (fd) => { paths.delete(fd); return original.close(fd); };
fs.fsyncSync = (fd) => {
  const path = paths.get(fd);
  const directory = fs.statSync(path).isDirectory();
  if (directory && renamedState === "launching" && process.env.CLOUD_SYNC_FAULT === "directory") throw Error("injected directory sync failure");
  original.sync(fd);
  if (directory) event("sync-directory", renamedState);
  else {
    const record = JSON.parse(fs.readFileSync(path, "utf8"));
    event("sync-file", record.state);
  }
};
fs.renameSync = (from, to) => {
  const record = JSON.parse(fs.readFileSync(from, "utf8"));
  if (record.state === "running" && process.env.CLOUD_SYNC_FAULT === "handle") process.kill(process.pid, "SIGKILL");
  if (record.state === "launching" && process.env.CLOUD_SYNC_FAULT === "before-rename") process.kill(process.pid, "SIGKILL");
  original.rename(from, to);
  renamedState = record.state;
  event("rename", renamedState);
  if (record.state === "launching" && process.env.CLOUD_SYNC_FAULT === "after-rename") process.kill(process.pid, "SIGKILL");
};
syncBuiltinESMExports();
