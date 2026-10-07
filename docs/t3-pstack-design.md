# t3-pstack design

Status: implemented in 1.0.0 (uncommitted). Sections 2 and 4 record the shipped shape; the design review's open questions are resolved in section 7.

t3-pstack is the pstack-claude port with one change: every subagent, panel, fan-out, schedule and PR watch dispatches through T3 Code's `t3-code` MCP tools. It targets T3 only. It has no detection step and no native fallback. Outside T3, use the regular pstack-claude plugin.

## 1. Usage first

The user runs `/pstack:setup-pstack` once per machine. It reads `orchestrator_capabilities`, writes the sheet, and validates the sheet against the live catalog:

```markdown
arena runners: claudeAgent/claude-opus-5-5 effort=high, codex/gpt-6.1-sol reasoningEffort=xhigh, grok/grok-4.7 reasoningEffort=high
interrogate reviewers: claudeAgent/claude-opus-5-5 effort=high, codex/gpt-6.1-sol reasoningEffort=xhigh, grok/grok-4.7 reasoningEffort=high
swarm workers: claudeAgent/claude-sonnet-5-5 effort=high
bug-fix: claudeAgent/claude-fable-5-1 effort=xhigh
session hook: on
```

When `/pstack:interrogate` runs, each panel entry becomes one call:

```json
{
  "task": "Read <plugin>/skills/interrogate/SKILL.md ... You are Reviewer B. Do not edit files. ...",
  "target": { "providerInstanceId": "codex", "model": "gpt-6.1-sol", "options": { "reasoningEffort": "xhigh" } },
  "mode": "async",
  "role": "review",
  "clientRequestId": "interrogate-<run>-r1-B"
}
```

The parent keeps each `taskId`. The children's completions wake it. It merges the verdicts the way the skill already says.

## 2. Fork strategy

**Chosen: track pstack-claude as upstream and keep the T3 overlay mostly in new files.** Syncing is `git fetch upstream && git merge upstream/main && bun tools/generate.mjs && bun test tests/`. pstack-claude keeps running `tools/sync.mjs` against cursor/plugins. We never run it, so `forks.json` and `upstream.json` stay upstream-owned and untouched.

The overlay adds a T3 row to the port's existing `RUNTIMES` table, next to Codex and Pi. That one row brings three things the generator already does for other runtimes:

- A preamble line, stamped under the first heading of every skill listed in `t3-tools.md`'s Per-skill notes table. So `arena/SKILL.md` itself says to dispatch through T3, and no SKILL.md is hand-edited.
- A generated Model names section in `t3-tools.md`, rendered from a new `t3` block in `models.json`.
- A `checkT3Models` check on that block.

Overlay ledger. These are the only upstream files we change:

| File | Change | Merge cost |
| --- | --- | --- |
| `tools/runtimes.mjs` | T3 row, last, with `displaces: "Codex"`, plus `checkT3Models` and `t3ModelNamesSection` (about 40 lines, appended) | Low, since it is appended |
| `tools/generate.mjs` | Let a row have no `manifest`, because T3 ships inside the Claude and Codex manifests. A row's preamble drops the one of the runtime it `displaces`, so a T3-listed skill carries the Copilot and T3 preambles but not Codex's. `stampLeadLine` drops any generator-owned lead line the file no longer owns. A Codex stub omits its pointer when the skill carries the T3 preamble (about 8 lines) | Low |
| `tools/substitutions.json` | The sync denylist's `grok-` token becomes `(?<!/)grok-`, so the T3 target `grok/grok-4.7` passes the sync test that runs the denylist over the installed plugin | Low |
| `tests/generate.test.mjs`, `tests/sync.test.mjs`, `tests/session-hook.test.mjs`, `tests/session-hook-windows.test.mjs` | Upstream tests learn the T3 row, the `t3-pstack` manifest name, and the `t3-pstack-models.md` sheet name, and the sync fixture copies the sheet script that `runtimes.mjs` imports (about 12 lines) | Low |
| `plugins/pstack/models.json` | A `t3` block: default, strongest and panel as T3 targets | Low, since it is one new key |
| Manifests, marketplaces, `README.md` | `t3-pstack` plugin and marketplace names, author, and install text, in every manifest including Copilot's, which the generator requires to share the Claude Code manifest's name | Low |
| `hooks/session-start.sh`, `hooks/session-start.ps1`, `hooks/session-start-context.md` | The `claude` and `codex` arms read `t3-pstack-models.md`, and the context tells each session to read `t3-tools.md` and the sheet. The `copilot` arm stays upstream's | Low |
| `VERSION`, `CHANGES.md` | Own version line (see open question 4) | One mechanical conflict per merge |
| Generated preambles in about 15 SKILL.md files | Stamped by the generator | On a conflict, take upstream's version and regenerate |

New files have no merge cost: `plugins/pstack/skills/poteto-mode/references/t3-tools.md`, `plugins/pstack/skills/setup-pstack/scripts/t3-sheet.mjs`, and `tests/t3-sheet.test.mjs`.

**Rejected: fork cursor/plugins directly.** That means rebuilding the port's Claude and Codex translation, effort agents, hooks and generator. That is the work pstack-claude already maintains.

**Rejected, but viable: a companion plugin installed beside an unmodified pstack-claude.** This means zero merge cost. Its SessionStart hook would point every session at `t3-tools.md`, which is how the Pi build works. I rejected it for three reasons. You asked for one plugin. Skill files would still say "Agent tool" with no in-file pointer. A renamed upstream role or skill would misroute silently until someone noticed, while the fork route's generator fails on it. If two installs per machine is acceptable, this option is smaller.

## 3. The dispatch contract (`t3-tools.md`)

This is one reference file in the shape of `codex-tools.md` and `pi-tools.md`. Its rows override the host mapping (Claude Code native, or `codex-tools.md` on a Codex host) for dispatch, models, scheduling and PRs. Everything else, like files, shell and the todolist, follows the host.

| pstack action | On T3 |
| --- | --- |
| Dispatch a subagent (`Agent`) | `delegate_task`, `mode: "async"`, with the target from the sheet |
| N parallel subagents | N `delegate_task` calls in one response |
| Wait for a result | Completion arrives as a notification, so end the turn instead of polling. Call `task_status` only when the result is needed mid-turn |
| Follow up or fix round (`SendMessage`) | A new `delegate_task` with consolidated scope and a new `clientRequestId`. This is already poteto-mode's "fresh subagents by default" rule. Never use `t3_thread_send` on a `childThreadId` |
| Stop a subagent | `task_cancel`, then check `task_status` |
| `subagent_type: pstack:poteto-agent` | The prompt opens with "Read `<plugin>/skills/poteto-mode/SKILL.md` in full first", using the absolute path the parent read it from. This is the Codex mapping's approach |
| `pstack:comment-sicko` | Same idea, using `poteto-mode/references/agents/comment-sicko.md` |
| `readonly: true` | Stated in the prompt. The child may run `git diff` and must not write |
| `isolation: "worktree"` | The parent runs `git worktree add` under `.claude/worktrees/` and passes the path. The child works only there |
| `@level` and effort agents | Not used. The sheet entry carries the provider's own option keys |
| `/loop` or `ScheduleWakeup` | `schedule_task` bound to this thread. Delete it when the loop ends |
| Babysit polling (watch-pr in drive mode) | `watch_pull_request`, then end the turn. `watch-pr --status-only` stays for status reads. Ship-pr and merge mechanics stay unchanged |
| Opening a PR | `link_pull_request` right after `gh pr create`, for every layer of a stack |

**Model family.** Diversity rules ("a different model family", panel diversity) use the model ID's first segment, such as `claude`, `gpt` or `grok`, not the provider instance. `codex_pool/claude-opus-5-5` is the Claude family.

**A target that fails to dispatch.** It runs on another target of the same family from the catalog, and the run says so. The skills' own fallback rules name Claude aliases, so T3 replaces them. A required review with no reviewer of another family stays `BLOCKED: independent review`, per poteto-mode. I add no new fallback.

## 4. The model sheet

**Grammar.** One line per role, with the role names unchanged from `models.json`. A value is a comma-separated list of entries. Each entry is `<providerInstanceId>/<modelId>` followed by any number of `<optionId>=<value>`, or `inherit-parent`, which omits `target`. Options map one to one onto `target.options`, so dispatch needs no translation table. The `default effort` line is dropped. An omitted option uses the catalog default. `session hook: on|off` stays, because the unchanged hook reads it.

**Validation.** `t3-sheet.mjs <sheet> <catalog.json>` is pure parsing and comparison, about 80 lines. It fails, naming the role and entry, when:

- the provider is missing or has `canRunChildTask: false`
- the model is not listed under that provider
- an option ID or value is not in the catalog
- a panel role (`arena runners`, `architect runners`, `interrogate reviewers`, `arena cross-judge pool`) has fewer than two families

setup-pstack saves the `orchestrator_capabilities` result to a temp file and runs the script before writing the sheet. `tests/t3-sheet.test.mjs` feeds it a trimmed real catalog and proves each rejection fires.

**Identity.** The plugin is `t3-pstack@t3-pstack` and the sheet is `t3-pstack-models.md`, so t3-pstack never shares a plugin id, namespace, or sheet with pstack-claude. Skill bodies keep upstream's `pstack:<name>` text, and `t3-tools.md` reads it as `t3-pstack:<name>`.

**Location and sync.** The canonical file lives in your dotfiles repo. It is symlinked to `~/.claude/t3-pstack-models.md` and `~/.codex/t3-pstack-models.md`, the paths the hook and setup-pstack already use. So the hook script and the setup-pstack paths need no changes, and no include line is needed. Under T3, skills read the sheet before their first dispatch, the same on both hosts, so Codex needs no paste into `AGENTS.md`. setup-pstack writes through the symlink, resolving it with `realpath` first, so the link survives. After a dotfiles pull, re-run the check script on each machine (Mac, agents-fsn1, janus). Provider instances differ across these machines (section 7), so each machine gets its own sheet in dotfiles.

**Shipped defaults** (`models.json` `t3` block, which renders into `t3-tools.md`):

- default: `claudeAgent/claude-opus-5-5 effort=high`
- strongest: `claudeAgent/claude-fable-5-1 effort=xhigh`
- panel: `claudeAgent/claude-opus-5-5 effort=high`, `codex/gpt-6.1-sol reasoningEffort=xhigh`, `grok/grok-4.7 reasoningEffort=high`

The panel effort is explicit because `gpt-6.1-sol` defaults to `low`.

## 5. Which skills change

Each of these gets one row in `t3-tools.md`'s Per-skill notes table. The generator then stamps the T3 preamble into that skill. No SKILL.md body is edited.

| Skill | On T3 |
| --- | --- |
| `setup-pstack` | Detect models with `orchestrator_capabilities` instead of the `Agent` tool. Write the T3 grammar. Run the check script. Skip step 7, the include and paste. Offer the dotfiles symlink layout |
| `poteto-mode` | The Subagents defaults map through the dispatch table. The playbooks inherit this through poteto-mode. Three of them get specific lines below |
| `arena`, `architect` | Runners are async `delegate_task` calls, one per panel entry, and writers get worktrees the parent created. The cross-judge comes from a family different from the parent's own model, which T3 reports as `inheritedModel` |
| `interrogate` | One `delegate_task` per reviewer, with read-only in the prompt and `role: "review"`. Each round is a fresh `delegate_task` with prior findings, using a distinct `clientRequestId` per round |
| `swarm` | Workers are `delegate_task` calls, and writers get parent-made worktrees. Verifier lanes in autopilot-full draw from the panel, so lanes span families |
| `show-me-your-work` | The handback reviewer is a `delegate_task` on a family other than the worker's. The trail records each child's provider, model and `taskId` as evidence |
| `how`, `why`, `reflect`, `teach`, `no-comments`, `create-verification-skill` | Fan-out and subagents go through the dispatch table |
| `maintain-verification-skill` | Per-feature readers are `delegate_task` calls. Scheduling it is a `schedule_task` with `fixed_time` daily, the repo's `projectId`, and `bindToCurrentThread: false`, so each run gets a fresh thread. The note says to report the returned `nextRunAt` |
| `babysit` | `/loop` and the watcher map to `watch_pull_request` (see the table) |
| Playbooks babysit, autopilot-full, autopilot-stack, orchestrate | Reached through poteto-mode's row. PR owners run as `t3_thread_launch` with `workspaceStrategy: worktree` (see open question 1). The hourly audit tick is a `schedule_task` bound to the coordinator. The coordinator calls `watch_pull_request` on each owner's PR |

Out of scope: pattern-buffer routines. No pstack skill defines one. Once this lands, a pattern buffer is one `schedule_task` recipe.

## 6. End-to-end proof

1. `bun tools/generate.mjs --check` and `bun test tests/` pass. The check script's tests reject each malformed entry against a captured real catalog.
2. Install from the local checkout into Claude Code and Codex: `/plugin marketplace add ~/Developer/t3-pstack`, then `codex plugin marketplace add ~/Developer/t3-pstack`. Uninstall `pstack@pstack-claude` first so the `pstack:*` names don't collide. This changes your global `~/.claude` and `~/.codex`, so I'll ask before doing it.
3. In a fresh T3 Claude thread, run `/pstack:setup-pstack` and accept the cross-family panel. Check the written sheet and the check-script output.
4. Run `/pstack:interrogate` on the overlay's own diff. Pass condition: three `taskId`s whose child threads (`t3_thread_list` with `includeSubagents`, then `t3_thread_read`) ran on `claudeAgent/claude-opus-5-5`, `codex/gpt-6.1-sol` and `grok/grok-4.7`, each with review text. The merged verdict must attribute findings per family.
5. Run `/pstack:arena` on a small sketch task. Pass condition: three runners on three families, and a cross-judge from a family other than the parent's.
6. Repeat step 4 from a Codex-host T3 thread. That proves the Codex host reads the same sheet and dispatches the same way.
7. Run `schedule_task` for `maintain-verification-skill` on a test repo, trigger it once with `run_scheduled_task_now`, read the run thread, then delete the schedule.
8. `watch_pull_request` needs a real PR, which needs a GitHub repo. That stays untested until you say where.

The evidence for each step is the `t3_thread_read` output for the children: provider, model and text. A summary from the parent doesn't count.

## 7. Open questions (resolved)

Resolved 2026-10-05: 1 owners are top-level threads, 2 one dispatch path, 4 independent 1.0.0 line. 3 checked over ssh: provider instances differ (Mac: claudeAgent, codex, codex_pool, grok; agents-fsn1: claudeAgent, a Claude pool, codex_pool, grok, opencode, with codex disabled; janus: claudeAgent and codex only, no grok), so each machine needs its own sheet. 5 stays open; T3 provider instances accept per-instance environment variables, which could give T3's Claude its own `CLAUDE_CONFIG_DIR`.

The questions as first asked:

1. **PR owners as top-level threads.** T3's guidance reserves `t3_thread_launch` for explicit requests for top-level threads. I'd treat invoking autopilot or orchestrate as that request. Owners then get T3-bound worktrees and their own visible threads, and you can step into them. The alternative is `delegate_task` children working in worktrees the parent created. That is simpler, but the worktree is invisible to T3's UI.
2. **One dispatch path, even for same-family work.** T3's guidance prefers native subagents for same-provider work. I route every pstack role through `delegate_task` anyway. That gives one set of semantics, one place to read options, and every child visible in T3. The cost is that Claude-on-Claude children are full T3 threads, not lightweight `Agent` calls.
3. **Machines.** Do agents-fsn1 and janus use the same provider instance IDs as the Mac (`claudeAgent`, `codex`, `grok`)? If not, the synced sheet fails the check there. Then we either align the IDs in T3 settings or allow a per-host sheet.
4. **Versioning.** The generator requires `MAJOR.MINOR.PATCH`. I propose an independent line starting at `1.0.0`. Each upstream merge keeps our VERSION and adds a CHANGES entry naming the merged pstack-claude version.
5. **Terminal Claude Code on the same machine.** T3's Claude threads use `~/.claude`, the same as the terminal CLI. With no fallback, a terminal session gets t3-pstack, and its dispatches fail because the T3 tools are missing. Is that acceptable, or should T3's Claude provider run with its own `CLAUDE_CONFIG_DIR`?
