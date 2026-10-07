# t3-pstack

pstack for [T3 Code](https://github.com/pingdotgg/t3code). It is [pstack-claude](https://github.com/michael-denyer/pstack-claude), Michael Denyer's Claude Code and Codex port of Lauren Tan's (poteto's) [pstack](https://github.com/cursor/plugins/tree/main/pstack), with one change: every subagent, panel, fan-out, schedule, and PR watch dispatches through T3's `t3-code` MCP tools. An `interrogate`, `arena`, or `architect` panel can then run Claude, GPT, and Grok reviewers side by side, from a Claude Code thread or a Codex thread. The mapping lives in [`t3-tools.md`](plugins/pstack/skills/poteto-mode/references/t3-tools.md).

t3-pstack works only inside T3. Outside T3, use pstack-claude.

## Install

| | Claude Code | Codex |
| --- | --- | --- |
| Plugin id | `t3-pstack@t3-pstack` | `t3-pstack@t3-pstack` |
| Marketplace repo | `chhoumann/t3-pstack` | `chhoumann/t3-pstack` |

```shell
claude plugin marketplace add chhoumann/t3-pstack && claude plugin install t3-pstack@t3-pstack
codex plugin marketplace add chhoumann/t3-pstack && codex plugin add t3-pstack@t3-pstack
```

Then run `/t3-pstack:setup-pstack` in a T3 thread on each machine. It writes `t3-pstack-models.md` in the host's config directory, with one T3 target per role (`<providerInstanceId>/<modelId>` plus that provider's options), and checks it against the machine's `orchestrator_capabilities`.

t3-pstack and pstack-claude never collide. They differ in plugin name (`t3-pstack` and `pstack`), marketplace (`t3-pstack` and `pstack-claude`), skill and agent namespace, and model sheet (`t3-pstack-models.md` and `pstack-models.md`). Both can be installed at once, though each injects its own routing instruction at session start, so enable one per runtime.

## Staying current

`upstream` is pstack-claude. Merge it with `git merge upstream/main`, then run `bun tools/generate.mjs` and `bun test tests/`. The overlay is mostly new files. The design and the list of upstream files it edits are in [`docs/t3-pstack-design.md`](docs/t3-pstack-design.md).

The sections below are pstack-claude's documentation, kept as upstream writes it. Their install commands install pstack-claude, not t3-pstack.

Tell `poteto-mode` your goal and it will invoke the correct workflow for the task. It keeps your code concise, simple and verified.

For concurrency bugs and invariants that tests cannot reach, see the separate [agent-formal-verify](https://github.com/michael-denyer/agent-formal-verify) plugin, which adds TLA+ model checking and Lean proofs.

## Install

### Claude Code

Run in Claude Code:

```text
/plugin marketplace add michael-denyer/pstack-claude
/plugin install pstack@pstack-claude
```

### Codex

Run in your terminal:

```shell
codex plugin marketplace add michael-denyer/pstack-claude
codex plugin add pstack@pstack-claude
```

### Pi

Run in your terminal:

```shell
pi install git:github.com/michael-denyer/pstack-claude
```

The package loads the skills and the pstack Pi extension, which adds the subagent, question, and wake-up tools the skills use, plus `/loop` and the routing instruction. Invoke a skill with `/skill:<name>`.

### GitHub Copilot

Run in your terminal:

```shell
copilot plugin marketplace add michael-denyer/pstack-claude
copilot plugin install pstack@pstack-claude
```

This installs pstack for the Copilot CLI and the GitHub Copilot app, which share `~/.copilot`. Start a new session afterwards. Copilot ships no default pstack models, so the first skill that needs one runs `setup-pstack` to pick from the models your account lists, and later sessions reuse that choice.

The Copilot build is tested on Copilot CLI 1.0.87 through 1.0.92. On those versions the routing hook's context reaches the session alongside other plugins' session-start context. If a later version keeps only one plugin's context, `setup-pstack` offers a [standing instruction](plugins/pstack/skills/setup-pstack/copilot.md#wire-it-in) for `~/.copilot/copilot-instructions.md` instead. On 1.0.92, once the CLI caches its computer-use experiment assignment, `copilot -p` sessions list no plugin skills and a `skill` call returns "Skill not found". Interactive sessions, the hooks, and the agents are unaffected.

Run `setup-pstack` to change model defaults, set a reasoning effort per role (for example `arena runners: opus @xhigh, fable @max`, which Claude Code dispatches through the plugin's `pstack:effort-<level>` or `pstack:poteto-agent-<level>` agents; roles without a level keep the session's effort unless the sheet's `default effort` line names one), or turn automatic routing off. The plugin installs the routing hook on Claude Code, Codex, and GitHub Copilot; Codex asks you to trust it through `/hooks` before it runs. On Pi the extension injects the same routing instruction. In Claude Code and the Copilot CLI, use `/pstack:setup-pstack`.

For Prime Agent, OpenCode, Gemini CLI, or skills-only installs for any harness, see [shared installation](docs/reference.md#shared-skills-installation).

## Getting started

```text
Use poteto-mode to fix the search filter resetting when I change pages.
```

For a bug, it reproduces the failure, uses `how` and `why` to investigate, delegates the fix, then reruns the failing case. If the fix crosses a function boundary, it brings in `architect` before implementation. You receive the fix and the failing and passing evidence.

[Other playbooks](plugins/pstack/skills/poteto-mode/SKILL.md#playbooks) cover planning, features, refactoring, performance issues, investigations, prototypes, PR maintenance, shipping, and longer projects.

![poteto-mode on Claude Code, Codex, and Pi turns a request into verified work. Choose a playbook, plan and delegate with architect, arena, or swarm, then review and verify with interrogate, tests, and measurements. Project playbooks customize the workflow, and setup-pstack configures the model and reasoning effort per role. Supporting skills include how, why, and unslop.](assets/pstack-overview.png)

## Details

- [Skills and slash commands](docs/reference.md#slash-commands)
- [Runtime setup](docs/reference.md#runtime-support)
- [Models and dependencies](docs/reference.md#configuration-and-dependencies)
- [Maintenance and port scope](docs/reference.md#maintenance)

## Data handling

pstack has no server or telemetry. Anything its skills ask your agent to read, including session transcripts, goes to your model provider. Scripts run locally, and PR tools use your GitHub CLI login.

## Contributing

Thanks for helping make this port better. Bug reports, documentation fixes, and runtime improvements are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the checks and where your change belongs. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

To support maintenance of this port, [buy the maintainer a coffee](https://buymeacoffee.com/codenyer).

## License

t3-pstack is [MIT-licensed](LICENSE). Its T3 modifications and additions are © 2026 Christian Bager Bach Houmann. It builds on:

- [pstack-claude](https://github.com/michael-denyer/pstack-claude), MIT, © 2026 Michael Denyer, the Claude Code, Codex, and Pi port this fork tracks.
- [pstack](https://github.com/cursor/plugins/tree/main/pstack) in cursor/plugins, MIT, © 2026 Lauren Tan (poteto), the original skill stack.
- The skills imported from [cursor-team-kit](https://github.com/cursor/plugins/tree/main/cursor-team-kit), MIT, © 2026 Cursor. See [LICENSE-cursor-team-kit](LICENSE-cursor-team-kit).

[NOTICE.md](NOTICE.md) lists each upstream component with its source commit and license file.
