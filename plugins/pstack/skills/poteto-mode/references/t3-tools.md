# T3 tool mapping for pstack

t3-pstack runs inside T3 Code, on a Claude Code or a Codex thread. Every subagent, panel, fan-out, schedule, and PR watch goes through the `t3-code` MCP tools, so a panel can mix Claude, GPT, and Grok children. Read this before following a skill that dispatches work, names a model, schedules, watches a PR, or proves UI behavior.

## Precedence

This file wins for dispatch, models, schedules, pull requests, transcripts, and UI evidence, including over poteto-mode's Platform Adaptation section and each skill's Models and Reasoning effort sections. Everything else follows the host. On Claude Code the skills' tool names work as written. On a Codex host, read [codex-tools.md](codex-tools.md) for everything else, such as files, shell, web search, skills, the todolist, `AskUserQuestion`, and the `run` driver. Its dispatch and model rows, and its per-skill notes on dispatch, do not apply.

Hosts prefix MCP tool names, as in `mcp__t3-code__delegate_task` or `mcp__t3_code__delegate_task`. This file uses the bare names.

This plugin is `t3-pstack`, so its skills and agents register as `t3-pstack:<name>`. The skills keep upstream's `pstack:<name>` spelling. Read every `pstack:<name>` in them as `t3-pstack:<name>`, and never invoke a `pstack:` skill or agent, because that namespace belongs to the separate pstack-claude plugin.

## Tool actions

| pstack / Claude action | On T3 |
|------------------------|-------|
| Dispatch a subagent (the `Agent` tool) | `delegate_task` with `mode: "async"`, the role's target from [the sheet](#the-sheet), and a `role` (`implementation`, `research`, `review`, `design`, `test`, or `general`). Keep the returned `taskId`. |
| Dispatch N parallel subagents | N `delegate_task` calls in one response. |
| Wait for a subagent result | The child's completion wakes this thread, so end the turn instead of polling. Call `task_status` only when a result is needed mid-turn. Reading a terminal result acknowledges its delivery. |
| Continue a subagent, or the next review round (`SendMessage`) | A new `delegate_task` with the consolidated scope: the original brief, every later directive, the prior report, and unresolved objections. Give each round its own `clientRequestId`, stable across retries of that round. Never `t3_thread_send` to a `childThreadId`. |
| Stop a subagent | `task_cancel`, then confirm with `task_status`. |
| List subagents | `t3_thread_list` with `includeSubagents: true`. |
| Read what a child did | `t3_thread_read` on its `childThreadId`. Its provider, model, and transcript are the evidence of which family ran. |
| Schedule a self-paced re-invocation (`ScheduleWakeup`, `/loop`) | `schedule_task` with a structured `schedule`, bound to this thread, and a `title` that names the loop. `delete_scheduled_task` when the loop ends. The project holds other scheduled tasks, so find yours in `list_scheduled_tasks` by its title and this thread's `boundThreadId`, and never delete one that does not match both. Report the returned cadence and `nextRunAt`. |
| Recurring automation | `schedule_task` with `bindToCurrentThread: false`, so each run gets a fresh thread. `list_scheduled_tasks`, `update_scheduled_task` (`enabled: false` pauses), `delete_scheduled_task`. `run_scheduled_task_now` triggers one run to prove the schedule works. |
| Watch a PR until something changes | `watch_pull_request`, then end the turn. T3 wakes the thread on a failed check, passing required checks (all checks when none are required), a new comment or review from another account, a conflict, or a close. The watch survives pushes and ends on merge without a wake. `unwatch_pull_request` stops it. Only a top-level thread can watch. A `delegate_task` child that opens a PR returns its URL so the parent links and watches it, and waits on CI with `gh pr checks <pr> --watch` only when its own work needs the result. |
| Open a PR | After `gh pr create`, call `link_pull_request` with its URL. For a stack, link every layer. Before finishing, `list_thread_pull_requests` returns the linked PRs bottom to top; link any that is missing. `unlink_pull_request` removes one opened by mistake. |
| A separate top-level conversation | `t3_thread_launch` with an explicit `workspaceStrategy`, only where a playbook below or the user asks for one. Follow it with `t3_thread_read` and `t3_thread_wait`. |
| Find an earlier conversation | `t3_thread_search`, which covers one project, the calling thread's or the `projectId` you pass. When the work spans projects, search once per project from `t3_project_list`. Read with `t3_thread_read` bounded by `maxCharsPerItem`, page with `afterPosition`, and expand one item with `itemId` and `textOffset` only when it matters. |
| Queued input on a thread | `t3_queue_list`, `t3_queue_read`, `t3_queue_edit`, `t3_queue_reorder`, `t3_queue_cancel`, `t3_queue_promote_to_steer`. |
| A question another thread is waiting on | `t3_pending_request_list`, `t3_pending_request_read`, `t3_pending_request_respond`. Approvals are not included. |

## Subagent policy

poteto-mode's [Subagents](../SKILL.md#subagents) section applies through `delegate_task`, with these mappings:

- Every pstack role dispatches through `delegate_task`, same family included, so every child shows up in T3 and reads its options from one place.
- A child gets only its brief, never the parent's context. Pass file pointers and absolute paths.
- `subagent_type: "pstack:poteto-agent"` becomes a brief that opens with "Read `<plugin>/skills/poteto-mode/SKILL.md` in full before any work." Use the absolute path you read this file from. `pstack:comment-sicko` becomes the same with `<plugin>/skills/poteto-mode/references/agents/comment-sicko.md`. Any other `subagent_type`, and the effort agents, need no brief line.
- `readonly: true` becomes a sentence in the brief: inspect only, `git diff` is fine, change no file.
- `isolation: "worktree"` becomes a worktree you create first with `git worktree add .claude/worktrees/<slug> -b <branch>`, named in the brief by absolute path as the only place the child writes. `delegate_task` has no workspace of its own, so the child starts in your checkout. The brief tells it to run every command with that path as its working directory (`workdir` on Codex) and to edit by absolute path. Record `git status --porcelain` in your checkout before you dispatch. After you take the result, check that it is unchanged, then remove the worktree and delete its branch.
- A step a playbook or skill says to delegate goes to `delegate_task` on that role's sheet entry, not into your own tool calls. Doing one yourself needs a stated reason, such as a step too small to brief.
- End every poteto-mode reply that ran a playbook with a dispatch ledger: one line per delegated step, naming the role and the `providerInstanceId/model` it ran on, or `in-thread: <reason>`. A playbook run with no dispatches says so in one line.
- A role value's effort lives in its sheet entry. Ignore the `@<level>` syntax and the Reasoning effort section in the skills.
- A rejected target runs on another target of the same family from `orchestrator_capabilities`, and you say so. The skills' own fallback rules name Claude aliases and do not apply. When the catalog has no other target of that family, the seat stays empty. A required review with no reviewer from another family stays `BLOCKED: independent review`, per poteto-mode.

## The sheet

The override sheet is `t3-pstack-models.md` in the host's config directory, which is `$CLAUDE_CONFIG_DIR` or `~/.claude` on Claude Code, `$CODEX_HOME` or `~/.codex` on Codex. Its name differs from pstack-claude's `pstack-models.md`, so the two plugins never read each other's sheet, and every `pstack-models.md` path in setup-pstack means this file. Read it before the first dispatch in a session, on either host. It needs no include line and no paste into `AGENTS.md`.

Each role line holds one entry. A panel role (`arena runners`, `arena cross-judge pool`, `architect runners`, `interrogate reviewers`) holds a comma-separated list. An entry is `<providerInstanceId>/<modelId>` followed by any `<optionId>=<value>` pairs, or `inherit-parent` (alias `auto`). It maps one to one onto `delegate_task`'s `target`. The provider instance becomes `providerInstanceId`, the model becomes `model`, and the pairs become `options`. `inherit-parent` omits `target`. It does not count toward a panel's two families, because one sheet serves every thread on the machine. Option IDs differ per provider (Claude names the reasoning option `effort`, Codex and Grok name it `reasoningEffort`), so copy them from `orchestrator_capabilities`, never from another provider's line.

A model's family is the first segment of its ID, such as `claude`, `gpt`, or `grok`, whatever provider instance serves it. "A different model family" and panel diversity mean different families, not different providers. Your own family is the one in `orchestrator_capabilities`' `inheritedModel`.

`session hook: on` or `off` keeps its usual meaning. A T3 sheet has no `default effort` line, and the checker rejects one. An entry without options runs at the provider's default.

## Model names

On T3 the sheet names T3 targets, not the Claude aliases in each skill's Models section. Resolve every role from the sheet (see [The sheet](#the-sheet)). A role with no line runs on its tier's default below, and the aliases in the skills' Models sections do not apply. The defaults, as a complete sheet:

```markdown
# pstack model configuration (T3)

feature, refactoring: claudeAgent/claude-opus-5-5 effort=high
bug-fix: claudeAgent/claude-fable-5-1 effort=xhigh
perf-issue: claudeAgent/claude-fable-5-1 effort=xhigh
hillclimb: claudeAgent/claude-fable-5-1 effort=xhigh
judgment and prose: claudeAgent/claude-opus-5-5 effort=high
strongest judgment: claudeAgent/claude-fable-5-1 effort=xhigh
how explorer: claudeAgent/claude-opus-5-5 effort=high
how explainer: claudeAgent/claude-opus-5-5 effort=high
why investigators: claudeAgent/claude-opus-5-5 effort=high
why synthesizer: claudeAgent/claude-opus-5-5 effort=high
reflect tooling: claudeAgent/claude-opus-5-5 effort=high
reflect judgment, divergent, synthesizer: claudeAgent/claude-opus-5-5 effort=high
arena runners: claudeAgent/claude-opus-5-5 effort=high, codex/gpt-6.1-sol reasoningEffort=xhigh, grok/grok-4.7 reasoningEffort=high
arena cross-judge pool: claudeAgent/claude-opus-5-5 effort=high, codex/gpt-6.1-sol reasoningEffort=xhigh, grok/grok-4.7 reasoningEffort=high
swarm workers: claudeAgent/claude-opus-5-5 effort=high
architect runners: claudeAgent/claude-opus-5-5 effort=high, codex/gpt-6.1-sol reasoningEffort=xhigh, grok/grok-4.7 reasoningEffort=high
interrogate reviewers: claudeAgent/claude-opus-5-5 effort=high, codex/gpt-6.1-sol reasoningEffort=xhigh, grok/grok-4.7 reasoningEffort=high

session hook: on
```

## UI evidence

Prove UI behavior on the real surface and put the proof in the thread.

- **The project's verify skill comes first** (`.claude/skills/verify/`, or the repo's own driver skill). It is the only path for surfaces T3's browser cannot drive: Electron and desktop apps, Obsidian, CLIs, and TUIs.
- **Web apps** use the `preview_*` tools. `preview_open`, then `preview_navigate` with `{target: {kind: "environment-port", port}}` for a dev server, or `url`. `preview_snapshot` before acting, then act with `locator: "aria-ref=<ref>"` from the latest snapshot, or a role or text locator: `preview_click`, `preview_type`, `preview_press`, `preview_scroll`, `preview_hover`, `preview_select`, `preview_drag`, `preview_upload`, and `preview_wait_for`. `preview_dialog` answers a dialog that `preview_status` reports. Refs expire on navigation and on the next snapshot. `preview_resize` and `preview_set_appearance` cover breakpoints and dark mode. `preview_evaluate` reads page state.
- **Web evidence** is `preview_snapshot` with `save: true`, embedded in the reply as a Markdown image whose target is the returned `screenshotPath`, and a `preview_recording_start` / `preview_recording_stop` pair around an interaction, linked by the path the stop returns. `t3_preview_list` and `t3_preview_close` clean up tabs.
- **iOS Simulator and Android Emulator** use the `device_*` tools. `device_list`, then `device_open`, which boots the device, shows it in the user's Device panel, and returns the `agent-device` CLI invocation that drives it. `device_screenshot` captures what the user sees. `device_close` with `shutdown: true` powers off a device you booted.

The evidence is the artifact these tools return, never your description of it. A live verifier lane that a child runs opens its own tab with `preview_open`, `reuseExistingTab: false`, and `open: false` unless the user should watch, and passes the returned `tabId` on every call.

## Playbooks

- **Babysit.** *The watch* is T3's `watch_pull_request`. *The watcher* is the bare `watch-pr`, which gives every verdict. *The backstop* is a `schedule_task` bound to this thread, titled `babysit backstop: <owner>/<repo>#<n>` (the bottom PR for a stack). The project holds other scheduled tasks, so find the backstop only by that title and this thread's `boundThreadId` in `list_scheduled_tasks`, and never delete a task that does not match both. The watch wakes the thread only on a failed check, passing required checks, a new comment or review from another account, a conflict, or a close. The backstop wakes it every ten minutes, which covers every state the watch never wakes on: no checks, optional checks finishing after the required ones, a GitHub read recovering, mergeability becoming known, `behind-base`, and a merge, which ends the watch without a wake. The two replace step 6's `/loop`; where step 6 says to rearm the watcher, run it again on the next wake. *Stop* means `unwatch_pull_request` on every watched PR and `delete_scheduled_task` on the backstop, then hand back.
  - **`drive`.**
    1. Before ending any turn, handle the review threads already on the PR, because the watch wakes only on comments posted after it is armed. Then run the watcher: `watch-pr --pr <n> --timeout 300`, or `watch-pr --stack --pr <bottom> --timeout 300` for a stack, with the shell's own timeout above 300 seconds, because a tool call is capped at 600.
    2. `READY`, except as in step 3: stop per steps 6 and 9.
    3. `READY` with `ci-none` in a repository that has files in `.github/workflows` is not final yet, because checks can register after the watcher's 60-second confirm. Treat it as waiting. Once two consecutive backstop ticks still report it, it is final.
    4. `BLOCKER` on a conflict, the `behind-base` gate, failing checks, or review threads: work it per step 5. The `review-required` gate, or `changes-requested` once its comments are handled: report the wait and keep waiting, since the watch wakes on another account's review. `draft-pr`, `closed-without-merge`, `merge-blocked`, and `status-query` (exit 7): report the gate or `failure.detail`, and stop.
    5. Anything else is waiting: every `TIMEOUT` reason, and step 3. Arm the watch if it is not armed, on every unmerged layer of a stack. Create the backstop if `list_scheduled_tasks` shows no task with its title bound to this thread: `schedule_task` with that `title`, `schedule: {type: "interval", everyMs: 600000}`, `bindToCurrentThread: true`, and a prompt to rerun the babysit verdict step for PR <n>. Then end the turn.
    6. On any wake, from the watch or the backstop, run the watcher again and apply the same steps. A tick that arrives while a turn is running does nothing beyond that turn's own watcher run. When the verdict has not changed across two hours of backstop ticks, report it to the user and stop.
  - **`background`.** Arm the watch and keep working on the plan. A wake arrives as a queued message. At each natural pause, take the verdict with `watch-pr --pr <n> --timeout 180`, which fits two reads and the 60-second interval between them with slack. Act on a `READY` or a `BLOCKER` as in `drive`, and on a `TIMEOUT` keep working. No backstop while the plan runs. If the plan finishes with the PR still waiting, switch to `drive`.
  - **`check`.** One `watch-pr --pr <n> --status-only`, which prints one table at once, as step 6 and the Reply expect. No watch and no backstop. It reads once, so a head with no checks shows `ci-unreported`. When that head was pushed more than a minute ago, report "no checks have registered on this head".
  - T3 ignores comments from the GitHub account it reads with, so an operator who reviews under that account messages the thread afterward.
- **Autopilot-full, autopilot-stack, orchestrate.** Invoking one of these is the request for top-level threads. Each PR owner is a `t3_thread_launch` with `workspaceStrategy: {type: "worktree", baseRef, branch, startFromOrigin: false}`, briefed with the playbook steps and this thread's ID so it reports back with `t3_thread_send`. Verifier lanes are `delegate_task` children assigned round-robin over the `interrogate reviewers` entries, so lanes span families. The hourly audit tick is a `schedule_task` bound to this thread. Watch each owner's PR with `watch_pull_request`.
- **Worktree and simulator cleanup.** A worktree is in use when a T3 thread is bound to it, whatever the transcript audit says. `t3_thread_list` does not return `worktreePath`, so page through `t3_thread_list` with `includeSubagents: true` and `t3_thread_read` each thread for its `worktreePath`.
- **Bug fix, Feature, Refactoring.** Before Opening a PR, run **interrogate** on the diff with the `interrogate reviewers` panel and settle its blocking findings. Skip it only for a mechanical change, such as a rename or a dependency bump, and say so in the reply.
- **Opening a PR, Shipping.** `link_pull_request` per PR as it opens, always with its URL. Read a stack bottom to top from `list_thread_pull_requests`. Shipping step 9 runs `watch-pr --queued-stack --stack-prs <bottom> --timeout 540` once per tick, with the shell's own timeout above 540 seconds and under the 600-second tool cap. The ticks come from a `schedule_task` bound to this thread, titled `shipping tick: <owner>/<repo>#<bottom>`, with `schedule: {type: "interval", everyMs: 660000}`, above the 540-second run plus overhead. A tick that fires while the previous tick's run is still going does nothing. A `TIMEOUT` means run it again on the next tick. `delete_scheduled_task` on that task, matched by title and `boundThreadId`, once the loop ends. Never substitute `watch_pull_request` there: it does not wake on a merge, on `behind-base`, or on merge-queue state.

## Per-skill notes

Every skill below carries a pointer to this file under its heading. Read its row before you follow it.

| Skill | On T3 |
|-------|-------|
| `poteto-mode` | Subagents map through Subagent policy above, and the playbooks named in [Playbooks](#playbooks) change as listed there. Proof on a UI surface follows [UI evidence](#ui-evidence). |
| `setup-pstack` | The T3 sheet replaces steps 1, 2, 3, 5, 6, and 7. Detect models with `orchestrator_capabilities`, not the `Agent` tool. Start from the current sheet, or from the defaults in [Model names](#model-names) when there is none. Drop any value that is not a T3 entry (a bare family name, a `claude-` ID, `@<level>`) and the `default effort` line. Offer each role the catalog's targets and that provider's own option values in the grammar of [The sheet](#the-sheet); panel roles need at least two families among their targets. A role with no line runs on its tier default, which the checker also checks, so add a line for any role whose default this machine cannot run. Ask the `session hook` question as written. Write the candidate to a temp file. Then call `orchestrator_capabilities` again and save its result to a temp file as `{"providers": [...]}`, copying verbatim the entry of every provider instance the candidate or the defaults name. Run `node <plugin>/skills/setup-pstack/scripts/t3-sheet.mjs <candidate> <catalog.json>`, and fix every line it prints before you touch the real sheet. Then overwrite the sheet, writing through any symlink at its path (resolve it with `realpath`). It needs no include line. One sheet serves both hosts, so link the other host's sheet path to it (`ln -s`). If a different file is already there, run the checker on it and ask before you replace it. On Codex, remove any pstack model rows an earlier setup pasted into `<codex-home>/AGENTS.md`. The sheet may live in a dotfiles repo with both host paths linked to it, one sheet per machine when the machines' provider instances differ. |
| `automate-me` | The parallel history readers are `delegate_task` calls. Find and read the transcripts per Find an earlier conversation in [Tool actions](#tool-actions), with `t3_thread_list` for recent threads, not from `~/.claude/projects/`. |
| `arena` | Each runner is one `delegate_task` on an `arena runners` entry. A runner that writes code gets its own worktree (Subagent policy). The cross-judge is an `arena cross-judge pool` entry whose model ran no candidate, so no model scores its own work. Among those, prefer one whose family differs from yours. If every pool entry ran a candidate, say so in the reply and judge on the entry that wrote the fewest. |
| `architect` | The runner panel goes through the **arena** skill, so its dispatch applies, on the `architect runners` entries. |
| `interrogate` | One `delegate_task` per `interrogate reviewers` entry, with `role: "review"` and the read-only sentence. Each later round is a fresh `delegate_task` per reviewer, with the prior findings and a new `clientRequestId`. Name each reviewer's family in the merged verdict. |
| `swarm` | Each worker is a `delegate_task` on the `swarm workers` entry, or on each arm's entry in a race. Writers get worktrees (Subagent policy). |
| `show-me-your-work` | The handback reviewer is a `delegate_task` on a family other than the one that did the work. Each decision row that delegated work names the child's provider, model, and `taskId`. Check the log against `t3_thread_read` of this thread and its children. |
| `how` | Explorers and the explainer are `delegate_task` calls with the read-only sentence. |
| `why` | Investigators and the synthesizer are `delegate_task` calls. Dispatch the synthesizer after every investigator's completion has arrived. |
| `reflect` | The three reviewers and the synthesizer are `delegate_task` calls. Find and read the transcript per Find an earlier conversation in [Tool actions](#tool-actions). |
| `recall` | Search and read threads per Find an earlier conversation in [Tool actions](#tool-actions), with `t3_thread_list` for recent threads, child threads included. |
| `teach` | Running `how` and `why` in parallel is two `delegate_task` calls. Show running behavior through [UI evidence](#ui-evidence). |
| `no-comments` | `pstack:comment-sicko` is a `delegate_task` whose brief reads its agent file first (Subagent policy). Pass it the scope, and do not give it a worktree, because a worktree lacks the scope's uncommitted changes. |
| `create-verification-skill` | For a web app the generated skill drives through the `preview_*` tools, and for a simulator through the `device_*` tools (see [UI evidence](#ui-evidence)). Every other surface keeps its own harness. |
| `maintain-verification-skill` | Per-feature source readers are `delegate_task` calls. The live pass drives through the project's verify skill or [UI evidence](#ui-evidence). To run it on a schedule, `schedule_task` with `{type: "fixed_time", timeOfDay, weekdays}`, the repo's `projectId`, `bindToCurrentThread: false`, and a prompt that runs `/t3-pstack:maintain-verification-skill`. Prove it once with `run_scheduled_task_now`. |
| `babysit` | The watch (`watch_pull_request`) and the backstop (a ten-minute `schedule_task` bound to this thread) replace step 6's `/loop` and polling, and the watcher (the bare `watch-pr`) gives every verdict, per mode (see [Playbooks](#playbooks)). |
| `poteto-help` | The user types it as `/t3-pstack:poteto-help`. Every slash command it hands the user is `/t3-pstack:<name>`, whatever the linked reference spells. Its model and routing check reads the T3 sheet, `t3-pstack-models.md` (see [The sheet](#the-sheet)), not the `pstack-models.md` that setup-pstack's Other runtimes table names. Setup is `/t3-pstack:setup-pstack`. Install commands come from t3-pstack's README (`chhoumann/t3-pstack`), not pstack-claude's, and public copies link under `https://github.com/chhoumann/t3-pstack/blob/main/plugins/pstack/`. |
