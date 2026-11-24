# t3-pstack

pstack for [T3 Code](https://github.com/pingdotgg/t3code). It is Lauren Tan's (poteto's) [pstack](https://github.com/cursor/plugins/tree/main/pstack), with its Cursor mechanics rewritten in place for T3. Every subagent, panel, fan-out, schedule, and PR watch dispatches through T3's `t3-code` MCP tools, so an `interrogate` or `arena` panel can run Claude, Gemini, GPT, and Grok reviewers side by side, from a Claude Code, Codex, Antigravity, or Kiro thread.

The skill text is Lauren's. A generated set of substitutions rewrites only what names Cursor (its `Task` tool, its model slugs, its `.mdc` rule, its cloud agents, `/loop`), and a few declared forks carry what a substitution cannot. Nothing else needs loading: the T3 rules sit where Lauren's dispatch rules sit.

t3-pstack works only inside T3.

## Install, update, and check

```shell
npx -y github:chhoumann/t3-pstack install
npx -y github:chhoumann/t3-pstack update
npx -y github:chhoumann/t3-pstack doctor
```

`npx -y github:chhoumann/t3-pstack` runs the installer from the latest commit on `main`. Each Claude Code home's marketplace auto-updates from `main` too, each Codex home's marketplace stays on the release tag the installer pinned, and each Antigravity profile and Kiro home keeps the copy the installer last made. To run one release's installer, name its tag, as in `npx -y github:chhoumann/t3-pstack#v2.7.2 doctor`.

`install` and `update` are the same command, and a second run changes nothing. With Node 20 or later, it installs or updates the `t3-pstack@t3-pstack` plugin in every Claude Code and Codex config home T3 can run: `~/.claude` and `~/.codex`, `$CLAUDE_CONFIG_DIR` and `$CODEX_HOME`, and the home of each `claudeAgent` and `codex` instance in T3's settings, disabled ones included. Name any other home with `--claude-home <dir>` or `--codex-home <dir>`. Each home's `t3-pstack` marketplace must come from `chhoumann/t3-pstack` or from `--source <owner/repo|git URL|dir>` on the same run, and a home whose marketplace has another source is left as it is. `--source` defaults to the repository `npx` fetched the installer from, so a fork's `npx -y github:<owner>/t3-pstack update` installs from that fork, and a run that names another `--source` trusts nothing from the fork. A run never switches a home's source, so a home already on `chhoumann/t3-pstack` stays on it under another `--source`, and `doctor` warns and prints the commands that move it. A local directory needs a path such as `./t3-pstack`, since `owner/repo` always means GitHub. On Codex it also trusts t3-pstack's session-start hook, once its hooks file is the one this release pins. Codex runs a plugin's hook only once it is trusted, and T3's Codex sessions never ask, so without this step the hook never runs. Codex 0.164 and later tie that trust to every file in the installed plugin, so each release turns the hook off until the installer trusts it again. So the installer pins each Codex home's `t3-pstack` marketplace to the release's tag, such as `v2.7.2`, and Codex's own auto-upgrade leaves that tag where it is. A release reaches a Codex home only when `update` runs, and that run trusts the hook again. A local directory has no tag, so a marketplace from one stays unpinned. Run `update` after each release.

For each `antigravity` instance in T3's settings, disabled ones included, it copies the plugin it runs from into the profile T3 keeps for that instance: `~/.t3/userdata/providers/antigravity/<SHA-256 of the instance ID>/config/plugins/t3-pstack`. T3 starts Antigravity with that private profile instead of `~/.gemini`, and `agy plugin install` writes only `~/.gemini`, so the installer makes the copy itself. Antigravity loads the plugin's skills and agents from there, and its session-start hook from the plugin's root `hooks.json`. That hook runs under `sh`, so on Windows an Antigravity thread gets the skills without the session-start routing. A copy changes only when `update` runs, like a Codex home. Antigravity loads plugins from version 1.5.0 on, so a T3 still on the older 1.4 runtime it installed before needs Antigravity updated in its provider settings.

For each `kiro` instance in T3's settings, disabled ones included, it installs into that instance's Kiro home. That home is the instance's `KIRO_HOME` when it is an absolute path that does not hold your home folder, else `~/.kiro`, since T3 passes the value as written and Kiro ignores any other. An instance with no `KIRO_HOME` of its own inherits the one the installer runs with, since T3 starts the instance with the instance's environment over T3's own. T3's desktop app takes only a fixed list of variables from your login shell, and `KIRO_HOME` is not on it, so a T3 you open from the desktop can run such an instance at `~/.kiro` while the shell you run the installer from sets `KIRO_HOME`. In that case, add `--kiro-home ~/.kiro`. `doctor` warns of each value Kiro ignores, such as `~/.kiro-work`. An instance whose `KIRO_HOME` is a T3 secret gets no home, since T3's settings file does not hold the value, and `doctor` says to name its home with `--kiro-home <dir>`. When a project turns on T3's built-in `kiro` instance without a settings entry, it also installs into that instance's home, found the same way. It installs into `$KIRO_HOME` too, and into each home named with `--kiro-home <dir>`. A machine where nothing names a Kiro home gets none. Kiro loads plain skills from its home, so the installer copies the plugin it runs from to `<home>/t3-pstack` and links each skill from `<home>/skills/<name>` into that copy. The copy holds `.t3-pstack-install.json`, which lists every file the installer put there. It also writes `<home>/hooks/t3-pstack.json`, which runs the session-start hook when a session starts and after it compacts. Kiro has no skill namespace, so an entry in `<home>/skills` with a plugin skill's name keeps that skill from loading. The installer leaves such an entry as it is and links the other skills, and `doctor` names it. It also leaves a tree at `<home>/t3-pstack` that has no record from the installer, such as a clone, or that holds a file the record does not list, and installs nothing in that home until it moves. It leaves a hooks file it did not write, and `doctor` names it. `update` repairs a copy of its own that lost its manifest. The hooks file runs `sh`, so a Kiro home on Windows gets no session-start routing. A copy changes only when `update` runs, like a Codex home.

`doctor` reports on the same homes and changes nothing itself: each marketplace's source, each Codex marketplace's pin, the installed version, whether its files are all there, whether it is enabled, the Codex hook's trust, whether an Antigravity profile's config turns the plugin off, a Kiro home's skill links and hooks file, an entry in a Kiro home that keeps a plugin skill from loading, Claude Code records that pin an old version, plain copies of the plugin's skills, and the model sheet. It exits 1 on any problem and prints a fix for each.

Then run `/t3-pstack:setup-pstack` in a T3 thread on each machine. It writes the model sheet, `~/.config/t3-pstack/models.md`, with one T3 target per role (`<providerInstanceId>/<modelId>` plus that provider's options), and checks it against the machine's `orchestrator_capabilities`. Without a sheet, every role runs on the defaults in its skill's Models section.

## Use

```text
Use poteto-mode to fix the search filter resetting when I change pages.
```

The session-start hook tells each new chat when to enter `poteto-mode` on its own: work that touches more than one file, a design choice, or a bug whose cause is unknown. `poteto-mode` matches the task to a playbook and opens the other skills from there. They ship as upstream ships them, invoked by `poteto-mode` or typed by you (`/t3-pstack:<name>` on Claude Code and Antigravity, `$t3-pstack:<name>` on Codex, `/<name>` on Kiro).

The plugin carries 67 skill directories, 24 of them `principle-*` leaves, and 4 agents.

## Staying current

This repository syncs from Lauren's tree directly, synced against upstream `9e278fe`. `tools/upstream.json` pins each component, `tools/substitutions.json` holds the rewrite rules and a denylist of Cursor terms, and `tools/forks.json` declares every file the port keeps in its own form and why. `bun tools/sync.mjs <component> <sha>` derives each upstream file through the rules, merges it three ways with the port's copy, and fails on an undeclared fork, a denylist hit, or a rule that no longer matches upstream. [CONTRIBUTING.md](CONTRIBUTING.md#the-sync-boundary) has the details.

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
