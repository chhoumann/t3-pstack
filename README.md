# t3-pstack

pstack for [T3 Code](https://github.com/pingdotgg/t3code). It is Lauren Tan's (poteto's) [pstack](https://github.com/cursor/plugins/tree/main/pstack), with its Cursor mechanics rewritten in place for T3. Every subagent, panel, fan-out, schedule, and PR watch dispatches through T3's `t3-code` MCP tools, so an `interrogate` or `arena` panel can run Claude, Gemini, GPT, and Grok reviewers side by side, from a Claude Code, Codex, or Antigravity thread.

The skill text is Lauren's. A generated set of substitutions rewrites only what names Cursor (its `Task` tool, its model slugs, its `.mdc` rule, its cloud agents, `/loop`), and a few declared forks carry what a substitution cannot. Nothing else needs loading: the T3 rules sit where Lauren's dispatch rules sit.

t3-pstack works only inside T3.

## Install, update, and check

```shell
npx -y github:chhoumann/t3-pstack install
npx -y github:chhoumann/t3-pstack update
npx -y github:chhoumann/t3-pstack doctor
```

`npx -y github:chhoumann/t3-pstack` runs the installer from the latest commit on `main`. Each Claude Code home's marketplace auto-updates from `main` too, each Codex home's marketplace stays on the release tag the installer pinned, and the Antigravity profiles keep the copy the installer last made. To run one release's installer, name its tag, as in `npx -y github:chhoumann/t3-pstack#v2.5.0 doctor`.

`install` and `update` are the same command, and a second run changes nothing. With Node 20 or later, it installs or updates the `t3-pstack@t3-pstack` plugin in every Claude Code and Codex config home T3 can run: `~/.claude` and `~/.codex`, `$CLAUDE_CONFIG_DIR` and `$CODEX_HOME`, and the home of each `claudeAgent` and `codex` instance in T3's settings, disabled ones included. Name any other home with `--claude-home <dir>` or `--codex-home <dir>`. Each home's `t3-pstack` marketplace must come from `chhoumann/t3-pstack`, from the repository `npx` fetched the installer from, or from `--source <owner/repo|git URL|dir>` on the same run, and a home whose marketplace has another source is left as it is. `--source` defaults to the repository `npx` fetched, so a fork's `npx -y github:<owner>/t3-pstack update` installs from that fork. A run never switches a home's source, so a home already on `chhoumann/t3-pstack` stays on it under another `--source`, and `doctor` warns and prints the commands that move it. A local directory needs a path such as `./t3-pstack`, since `owner/repo` always means GitHub. On Codex it also trusts t3-pstack's session-start hook, once its hooks file is the one this release pins. Codex runs a plugin's hook only once it is trusted, and T3's Codex sessions never ask, so without this step the hook never runs. Codex 0.164 and later tie that trust to every file in the installed plugin, so each release turns the hook off until the installer trusts it again. So the installer pins each Codex home's `t3-pstack` marketplace to the release's tag, such as `v2.5.0`, and Codex's own auto-upgrade leaves that tag where it is. A release reaches a Codex home only when `update` runs, and that run trusts the hook again. A local directory has no tag, so a marketplace from one stays unpinned. Run `update` after each release.

For each `antigravity` instance in T3's settings, disabled ones included, it sets up the profile T3 keeps for that instance, `~/.t3/userdata/providers/antigravity/<SHA-256 of the instance ID>`. T3 starts Antigravity with that private profile instead of `~/.gemini`, and `agy plugin install` writes only `~/.gemini`, so the installer does the work itself. T3 lists an Antigravity thread's skills only from `~/.gemini/config/skills`, and it links the profile's `config/skills` there. So the installer copies the plugin once, to `~/.gemini/t3-pstack`, and links each of its skills into `~/.gemini/config/skills`. In each profile it links `config/skills` to `~/.gemini/config/skills`, `config/plugins/t3-pstack` to the copy, and `config/agents` to the copy's agents. Every link resolves into the one copy, so Antigravity loads each skill once. It loads the session-start hook from the plugin's root `hooks.json`. That hook runs under `sh`, so on Windows an Antigravity thread gets the skills without the session-start routing. A skill of your own in `~/.gemini/config/skills` with a plugin skill's name stays as it is, and `doctor` names it. Turning t3-pstack off in a profile's `config.json` no longer hides its skills, because they live in `~/.gemini/config/skills`, which T3 lists and links for every profile. The copy changes only when `update` runs, like a Codex home.

`doctor` reports on the same homes and changes nothing itself: each marketplace's source, each Codex marketplace's pin, the installed version, whether its files are all there, whether it is enabled, the Codex hook's trust, whether an Antigravity profile's links resolve and its config turns the plugin off, which plugin skills T3 cannot list, Claude Code records that pin an old version, plain copies of the plugin's skills, and the model sheet. It exits 1 on any problem and prints a fix for each.

Then run `/t3-pstack:setup-pstack` in a T3 thread on each machine. It writes the model sheet, `~/.config/t3-pstack/models.md`, with one T3 target per role (`<providerInstanceId>/<modelId>` plus that provider's options), and checks it against the machine's `orchestrator_capabilities`. Without a sheet, every role runs on the defaults in its skill's Models section.

## Use

```text
Use poteto-mode to fix the search filter resetting when I change pages.
```

The session-start hook tells each new chat when to enter `poteto-mode` on its own: work that touches more than one file, a design choice, or a bug whose cause is unknown. `poteto-mode` matches the task to a playbook and opens the other skills from there. They ship as upstream ships them, invoked by `poteto-mode` or typed by you (`/t3-pstack:<name>` on Claude Code and Antigravity, `$t3-pstack:<name>` on Codex).

The plugin carries 66 skill directories, 24 of them `principle-*` leaves, and 4 agents.

## Staying current

This repository syncs from Lauren's tree directly, synced against upstream `2f87c85`. `tools/upstream.json` pins each component, `tools/substitutions.json` holds the rewrite rules and a denylist of Cursor terms, and `tools/forks.json` declares every file the port keeps in its own form and why. `bun tools/sync.mjs <component> <sha>` derives each upstream file through the rules, merges it three ways with the port's copy, and fails on an undeclared fork, a denylist hit, or a rule that no longer matches upstream. [CONTRIBUTING.md](CONTRIBUTING.md#the-sync-boundary) has the details.

## Data handling

t3-pstack has no server or telemetry. Anything its skills ask your agent to read, including session transcripts, goes to your model provider. Scripts run locally, and PR tools use your GitHub CLI login.

## Contributing

Bug reports, documentation fixes, and T3 improvements are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the checks and where your change belongs. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

t3-pstack is [MIT-licensed](LICENSE). Its T3 modifications and additions are © 2026 Christian Bager Bach Houmann. It builds on:

- [pstack](https://github.com/cursor/plugins/tree/main/pstack) in cursor/plugins, MIT, © 2026 Lauren Tan (poteto), the skill stack itself.
- [pstack-claude](https://github.com/michael-denyer/pstack-claude), MIT, © 2026 Michael Denyer, whose sync, generator, and validation tooling this port still uses.
- The skills imported from [cursor-team-kit](https://github.com/cursor/plugins/tree/main/cursor-team-kit), MIT, © 2026 Cursor. See [LICENSE-cursor-team-kit](LICENSE-cursor-team-kit).
- The skills and review agents imported from [thermos](https://github.com/cursor/plugins/tree/main/thermos), MIT, © 2026 Cursor. See [LICENSE-thermos](LICENSE-thermos).

[NOTICE.md](NOTICE.md) lists each upstream component with its source commit and license file.
