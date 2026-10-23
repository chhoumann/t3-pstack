# Contributing

Thanks for helping out. This repo is a **port**, not an original work: the skills tree tracks [Lauren Tan's pstack](https://github.com/cursor/plugins/tree/main/pstack) and is synced forward from it. That one fact shapes most of what follows.

[CONTEXT.md](CONTEXT.md) is the glossary for the terms below.

## The sync boundary

Upstream owns the skill text. This port owns the rewrite of upstream's Cursor mechanics into their T3 form, and nothing else. The rewrite has two parts:

- **Substitutions.** [`tools/substitutions.json`](tools/substitutions.json) rewrites each upstream sentence that names a Cursor mechanism: the `Task` tool, `subagent_type`, model slugs, the `pstack-models.mdc` rule, cloud agents, `/loop`, Cursor paths. Most T3 behavior the port adds, such as the dispatch ledger or the review loop, is an anchored insert: a rule whose pattern is an upstream sentence and whose replacement keeps that sentence and appends the T3 text. A substitution leaves upstream's later edits elsewhere in the file mechanical, so the port prefers it to a fork. Each rule's `rationale` names why it exists, and most cite the section of t3-pstack 1.0.14's `t3-tools.md` it replaces.
- **Forks.** [`tools/forks.json`](tools/forks.json) declares each file the port keeps in its own form, with a `kind`, a one-sentence `why`, the `since` release, and an `upstream` status. Today that is setup-pstack, which writes the T3 model sheet, the hook points of the watch-pr settle overlay, the files that carry the rules and watch-pr fixes restored from Michael Denyer's pstack-claude, the worktree audit and cleanup playbook, which fix [cursor/plugins#449](https://github.com/cursor/plugins/issues/449), and the orchestrate store, whose lock takeover and reused-branch lookup carry fixes. Every upstream change to a forked file needs a person to merge it, so a fork is the last resort.

The port also owns files upstream does not have: the plugin manifests, the session-start hooks and their routing text, `models.json`, the sheet checker `t3-sheet.mjs`, the watch-pr settle overlay (`settle.ts`), and the transcript lookups reflect uses. The sync lists them as port-only.

Before changing a file under `plugins/pstack/skills` or `plugins/pstack/agents`, work out which kind of change it is:

- **Fixing the T3 form.** A rewritten sentence that resolves wrong on T3, or a Cursor mechanism a rule missed. Change or add the rule in `tools/substitutions.json`, then regenerate (below). Never edit a derived file by hand, because the sync check fails on it.
- **Changing what a skill does.** New steps, a different workflow, reworded guidance. That belongs upstream. The port adds behavior only where T3 needs it, as an anchored insert with a reason, or as a declared fork when no insert can carry it.

### Running a sync

```shell
bun tools/sync.mjs <component> <upstream-sha> [--dry-run] [--bootstrap] [--clone <dir>]
```

`tools/upstream.json` pins the upstream SHA per component (`pstack`, the six carried `cursor-team-kit` skills, and `thermos`) and lists the upstream paths the port excludes. The tool derives each upstream file into its port form: the substitutions in order, then `deriveT3` in `tools/derive-t3.mjs`, which sets a skill's or agent's `name` to its directory or file name, drops Cursor-only frontmatter keys, drops `disable-model-invocation` from `poteto-mode` alone, and stamps the regions rendered from `models.json`. Then it compares old upstream, new upstream, and the port's copy: a file only upstream changed is written, a file only the port changed is a fork, and a file both changed is merged with `git merge-file`, with a conflict written as git's markers.

A rule matches a literal `pattern` or a `regex`, optionally only in files whose upstream-relative path matches `files`, and carries a literal `replacement` and a `rationale`. Rules run in order, each on the output of the ones before it, so a pattern goes above any shorter pattern it contains, and the tool fails on a rule in the reverse order. A run fails, and writes nothing, on any of these:

- a denylist term in a derived file, which needs a new rule or a rewritten sentence;
- a fork, a merge, or a conflict on a path `tools/forks.json` does not declare;
- a rule that matches nothing in the derived trees, because upstream reworded the sentence it anchored on and the T3 text it carried would silently disappear;
- a binary file that differs three ways, or a port path that collides with an upstream one.

`--dry-run` reports without writing. At the pinned SHA it prints the ownership map: each fork with its changed lines, and the port-only files. CI runs it for every component, so a hand edit to a derived file or an undeclared fork fails the pull request. `--bootstrap` regenerates a component from upstream at a SHA without a merge, keeping each declared fork, which is how 2.0 rebuilt the tree and how a damaged tree recovers. `--clone` reads upstream from a local clone.

After a sync, write the `CHANGES.md` entry from the printed report, then run the generator and the tests.

## Before you open a PR

Install the root dependencies, then run the generator and the tests:

```shell
bun install --frozen-lockfile
bun tools/generate.mjs
GIT_CONFIG_GLOBAL=/dev/null bun test tests/ --timeout 30000
```

The generator stamps `VERSION` into the Claude Code and Codex manifests, the marketplace entry, and `package.json`. It renders each model-consuming skill's Models section, interrogate's reviewer table, and setup-pstack's sheet block from `plugins/pstack/models.json`, lists the plugin's agents in the Claude Code manifest, and copies the license and notice files into the installed plugin. It checks each skill's frontmatter, every local Markdown link, the plugin layout, agent frontmatter, the Codex marketplace, and both hooks files against their pins in `tools/frozen-hooks.json`. CI runs `bun tools/generate.mjs --check`, which writes nothing and fails naming each generated file that is stale or orphaned, so commit the generator's output. `.pre-commit-config.yaml` runs the same check before each commit once you run `prek install` (or `pre-commit install`).

Change model defaults in `models.json`, never in a skill body. A role names a tier (`default`, `strongest`, or `panel`), and each tier holds T3 entries in the grammar `t3-sheet.mjs` checks. The panel must span two model families. A role may carry an `alias`, the label a sheet written before upstream renamed the role still uses.

If you touched `skills/poteto-mode/scripts/`:

```shell
cd plugins/pstack/skills/poteto-mode/scripts
bun install --frozen-lockfile
bun run typecheck
GIT_CONFIG_GLOBAL=/dev/null bun test orch watch-pr check-plan.test.ts
bunx prettier@3.6.2 --check watch-pr/settle.ts watch-pr/settle.test.ts resolve-codex-transcript.ts
```

Upstream's scripts are not Prettier output, so the format check covers the port's own TypeScript only.

If you touched the installer (`tools/install.mjs` or `tools/install/`), also run its end-to-end test. It needs the `claude` and `codex` CLIs, runs in a throwaway `HOME`, and takes a few minutes:

```shell
T3_PSTACK_E2E=1 GIT_CONFIG_GLOBAL=/dev/null bun test tests/install-e2e.test.mjs --timeout 300000
```

If you touched a workflow, audit it before pushing:

```shell
uvx zizmor@1.29.0 --persona pedantic --min-severity low --collect all -- .
```

## Things that will fail CI

- **A hand edit to a derived file.** The fork check runs `tools/sync.mjs --dry-run` at each pin. Change the rule that produced the text instead, or declare a fork.
- **A substitution that no longer matches upstream.** Update it to upstream's current sentence or delete it.
- **`disable-model-invocation` on `poteto-mode`.** The session-start hook invokes it by name, and the flag makes the Skill tool refuse that.
- **A root `plugins/pstack/plugin.json`.** Codex reads a plugin with upstream's Agent Plugins manifest as an Agent Plugin and truncates each injected SKILL.md to 8,000 bytes, which cuts `poteto-mode` off mid-file. `tools/upstream.json` excludes the file.
- **A changed hooks file.** Codex trusts a plugin hook by a hash of its entry, and a Git marketplace delivers a new entry at the next app-server start, so any change to `hooks/hooks.json` or `hooks/codex-hooks.json` stops routing in every Codex home until the installer reruns. `tools/frozen-hooks.json` pins both. Change `session-start.sh` or the routing text instead. When an entry must change, pin its new digest with `changedIn` set to the release, and tell users to rerun the installer in that release's `CHANGES.md` entry. The check fetches `origin/main`, which the marketplaces deliver, and compares each hooks file with it, so a file that differs from main's needs a `VERSION` newer than main's and a `changedIn` that names it, and the installer trusts only the entry its own release pins. The fetch means the check needs the network.
- **Stale generated output, or a missing `CHANGES.md` heading for `VERSION`.**
- **An unresolved sync conflict marker** anywhere under `plugins/pstack`.
- **A missing or escaping local Markdown link.**
- **A shell script that fails shellcheck**, **an action pinned to a tag**, **a workflow that fails `actionlint`**, **a Markdown correctness error**, or **a broken relative link** in any Markdown file.

## Dependency updates

Dependabot keeps the pinned action SHAs current. The vendored scripts' one runtime dependency (`commander`) follows upstream's pin and moves with `tools/sync.mjs`. `osv-scanner` scans every `bun.lock` weekly. The root `bun.lock` pins `typebox`, which the generator uses to check the hooks files.

## Releasing

Plugin auto-update installs **by version number**, not by tracking `main`. A skill fix merged without a version bump is inert on every installed copy. The bump is three steps: edit the root `VERSION` file, add a `CHANGES.md` entry under a `## <version> - <title>` heading, and run `bun tools/generate.mjs` to stamp the manifests. Forgetting any of the three fails CI.

## Commit and PR style

- Explain what changed and why. The diff already shows how.
- One concern per PR.
- Claim only what you verified, and name the check.

## Reporting bugs

Include the t3-pstack version, the T3 Code version, the host (Claude Code or Codex) and its version, and the reproduction steps.
