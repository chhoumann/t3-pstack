// Stack discovery must end. A PR from a fork's main into main has the head
// branch name main, which is also the base of every PR stacked on main, and
// two PRs whose branches point at each other form a cycle.
import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orderStack } from "./github.ts";
import { parsePrNumber } from "./types.ts";

const context = (number: number) => ({
  owner: "owner",
  repo: "repo",
  number: parsePrNumber(number),
});
const pr = (
  number: number,
  headRefName: string,
  baseRefName: string,
  isCrossRepository = false
) => ({
  number: parsePrNumber(number),
  headRefName,
  baseRefName,
  isCrossRepository,
});
const numbers = (stack: readonly { readonly number: number }[]) =>
  stack.map((item) => Number(item.number));

describe("stack discovery", () => {
  const forkMain = pr(7, "main", "main", true);

  it("does not take a fork PR from main as the parent of a PR on main", () => {
    expect(
      numbers(
        orderStack(context(42), [
          forkMain,
          pr(42, "feature", "main"),
          pr(43, "upstack", "feature"),
        ])
      )
    ).toEqual([42, 43]);
  });

  it("does not stack the PRs on main above a fork PR from main", () => {
    expect(
      numbers(orderStack(context(7), [forkMain, pr(42, "feature", "main")]))
    ).toEqual([7]);
  });

  it("stops at a cycle of branches", () => {
    expect(
      numbers(orderStack(context(42), [pr(41, "a", "b"), pr(42, "b", "a")]))
    ).toEqual([41, 42]);
  });
});

describe("the gh reader on a repository with an open PR from a fork's main", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const dir of directories.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  it("watches the stack without the fork PR", () => {
    const dir = mkdtempSync(join(tmpdir(), "watch-fork-main-"));
    directories.push(dir);
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const gh = join(bin, "gh");
    writeFileSync(
      gh,
      `#!${process.execPath}
const args = process.argv.slice(2);
const fail = (stderr) => { console.error(stderr); process.exit(1); };
const graphql = (name) => args.some((a) => a.includes('query ' + name));
const commits = (commit) => ({ data: { repository: { pullRequest: { commits: { nodes: [{ commit }] } } } } });
let value;
if (args[0] === 'pr' && args[1] === 'list') {
  value = [
    { number: 7, headRefName: 'main', baseRefName: 'main', isCrossRepository: true },
    { number: 1, headRefName: 'feature', baseRefName: 'main', isCrossRepository: false },
  ];
} else if (args[0] === 'pr' && args[1] === 'view') {
  value = { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: '', headRefOid: 'head', headRefName: 'feature', baseRefName: 'main', state: 'OPEN', mergedAt: null, isDraft: false };
} else if (args[0] === 'pr' && args[1] === 'checks') {
  fail("no checks reported on the 'feature' branch");
} else if (graphql('PrCheckRollup')) {
  value = commits({ statusCheckRollup: null });
} else if (graphql('PrCommitStatuses')) {
  value = commits({ oid: 'head', statusCheckRollup: null });
} else if (graphql('ReviewThreads')) {
  value = { data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } };
} else {
  fail('unexpected fixture command: ' + JSON.stringify(args));
}
console.log(JSON.stringify(value));
`
    );
    chmodSync(gh, 0o755);
    const entry = join(dir, "entry.ts");
    writeFileSync(
      entry,
      `import { main } from ${JSON.stringify(join(import.meta.dir, "cli.ts"))}; process.exitCode = await main(process.argv.slice(2));\n`
    );
    const result = spawnSync(
      process.execPath,
      [
        entry,
        ...["--owner", "owner", "--repo", "repo", "--pr", "1"],
        ...["--stack", "--status-only", "--settle", "0"],
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: { PATH: `${bin}:${process.env.PATH}` },
      }
    );
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind: "STATUS",
      rows: [{ kind: "open", context: context(1) }],
    });
  });
});
