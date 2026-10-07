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

// A command is a backticked span that runs watch-pr with arguments, after any path
// or shell prefix. A bare `watch-pr` names the tool and runs nothing.
const commands = (markdown) =>
  [...markdown.matchAll(/`([^`]*)`/g)].flatMap((m) => m[1].match(/(?<=^|[\s/])watch-pr\s.*/) ?? []);

const namedFlags = (markdown) => new Set(commands(markdown).flatMap((command) => command.match(/--[a-z-]+/g) ?? []));

describe("the T3 mapping's watch-pr commands", () => {
  test("use only flags the watcher declares", () => {
    const declared = declaredFlags(cli);
    expect([...namedFlags(mapping)].filter((flag) => !declared.has(flag))).toEqual([]);
  });

  test("include a --timeout, so the checks here cannot pass on zero commands", () => {
    expect(namedFlags(mapping)).toContain("--timeout");
  });

  // A tool call is capped at 600 seconds, and the watcher's own default is no deadline.
  // --status-only is bounded too: a head with no checks yet retries for 12 minutes.
  test("bound every run under the tool cap", () => {
    const unbounded = commands(mapping).filter((command) => {
      const seconds = Number(command.match(/--timeout[ =](\d+)(?=[\s`]|$)/)?.[1]);
      return !(seconds > 0 && seconds < 600);
    });
    expect(unbounded).toEqual([]);
  });
});
