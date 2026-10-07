// t3-tools.md is port-only, but the watch-pr it hands agents is synced from
// upstream, so a merge can rename a flag the mapping still names.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const mapping = readFileSync(join(root, "plugins/pstack/skills/poteto-mode/references/t3-tools.md"), "utf8");
const cli = readFileSync(join(root, "plugins/pstack/skills/poteto-mode/scripts/watch-pr/cli.ts"), "utf8");

// The flags the Commander chain in parseArgs declares, from `new Command` to `program.parse`.
function declaredFlags(source) {
  const table = source.match(/new Command\("watch-pr"\)([\s\S]*?)program\.parse\(/);
  if (table === null) throw new Error("cli.ts has no watch-pr Commander option table");
  return new Set([...table[1].matchAll(/(?:\.option\(|new Option\()\s*"(--[a-z-]+)/g)].map((m) => m[1]));
}

function namedFlags(markdown) {
  const commands = [...markdown.matchAll(/`(watch-pr [^`]*)`/g)].map((m) => m[1]);
  return new Set(commands.flatMap((command) => command.match(/--[a-z-]+/g) ?? []));
}

describe("the T3 mapping's watch-pr commands", () => {
  test("name exactly the flags the mapping relies on", () => {
    expect([...namedFlags(mapping)].sort()).toEqual(["--pr", "--queued-stack", "--stack", "--stack-prs", "--timeout"]);
  });

  test("use only flags the watcher declares", () => {
    const declared = declaredFlags(cli);
    expect([...namedFlags(mapping)].filter((flag) => !declared.has(flag))).toEqual([]);
  });
});
