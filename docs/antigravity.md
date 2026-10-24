# Antigravity: agystack under T3

`tools/antigravity.mjs` projects the agystack Antigravity plugin into a Gemini config skills directory so an Antigravity root inside T3 runs agystack playbooks under T3 orchestration, while standalone Antigravity keeps its native behavior unchanged. One flat projection, one manifest, one verb pair. The general installer in `tools/install.mjs` is untouched; this is a dedicated CLI and may be wired into it later, after that orchestration is tested.

## Usage

Install the projection (defaults: `~/.gemini/config` as the Gemini home, `plugins/agystack` inside it as the source):

```sh
node tools/antigravity.mjs install
```

Both verbs accept:

| Flag | Meaning |
| --- | --- |
| `--gemini-home DIR` | Gemini config home, default `~/.gemini/config` |
| `--agystack-source DIR` | agystack plugin directory, default `<gemini-home>/plugins/agystack` |
| `--json` | machine-readable report on stdout |

Exit codes are 0 for success, 1 for a blocked install or a degraded doctor, 2 for a usage error.

Inspect without touching anything:

```sh
node tools/antigravity.mjs doctor
node tools/antigravity.mjs doctor --json
```

Reinstall from a different source to move or upgrade the agystack plugin the projection reads from. Everything idempotent: an unchanged source writes nothing.

## What an install writes

The destination is `<gemini-home>/skills`, and nothing else.

- One real skill directory per agystack source skill. Its `SKILL.md` is the native bytes with a T3-only routing note inserted after the frontmatter, and a `t3-agystack generated` comment bound to the native source hash. The native text is byte-for-byte preserved; the note is the only insertion.
- One relative symlink per other native file, so every relative pointer inside a projected skill, including nested `scripts/...` and `references/...`, reads native content from the plugin source. Links point through `../../../plugins/agystack/...` style relative paths, so a moved home keeps resolving as long as it moves together. Directory symlinks are deliberately not used, because a directory symlink lets `../` paths escape into the source tree and bypass projected overrides.
- The adapter skill `t3-agystack`, copied byte-for-byte from the installed t3-pstack package. Its bridge scripts (`scripts/cloud-run.mjs` and the sibling modules) are copied as a set when the package ships them, keeping the skill's relative references working.
- A manifest at `<gemini-home>/skills/.t3-agystack-manifest.json` (schema 1). It records exactly the projection's own entries: path, kind, content hash, the native anchor hash, and link targets. Nothing else is listed there, and user-owned files are never adopted into it.

## Safety behavior

- Validate, then write. A collision (any pre-existing, unowned path the projection would write) or drift (an owned generated file whose bytes changed since the last install) fails the whole install before the first write. Restore or remove the file by hand, then install again.
- A missing or unreadable manifest is refused, not adopted. After a crash between writes the projection exists without a manifest, and the next install fails loudly instead of claiming those paths.
- Owned entries the source no longer ships are retired by the next install, because the projection owns them. User-owned entries are never modified, moved, or removed, even when byte-identical to what the projection would write.
- Same-dir atomic writes; the manifest lands last, so a crash can never leave a manifest promising files that were never written.

## The T3 adapter behavior

Every projected `SKILL.md` carries the routing note. It activates only when a `delegate_task` tool is callable in the session or the environment sets `T3_ACP_MCP_NODE`, the ACP fallback; both predicates appear in every conditional entry, in that order. When active, the note takes precedence over native orchestration references in the loaded agystack skill and hands control to the `t3-agystack` skill: explicit coordinator, T3 child lifecycles, the structured delegate envelope, and exactly one `cloud-controller` child for one Cloud Run run. When neither check passes, the note is dead text and native agystack wins, which is the standalone boundary.

The full contract lives in `plugins/pstack/skills/t3-agystack/SKILL.md`. The envelope is an explicit role and ownership block that opens every child brief; a delegate's identity comes from that envelope, never from an adapter filename.

## Limits

- The delegate envelope is a prompt convention. Live T3 task identity is not verifiable from inside a session, so delegation discipline is disclosed, not enforced at runtime.
- The cloud bridge ships when the cloud unit's artifact is installed in the package, and the projection copies it with its siblings; `doctor` reports `bundled`/`projected` state either way.
- Duplicate skill-name resolution inside standalone Antigravity's scanner and a cold ACP-fallback session are runtime behaviors this tooling cannot prove; verify them on the machine before trusting the projection in anger.
