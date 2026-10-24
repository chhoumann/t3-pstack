---
name: t3-agystack
description: "T3 adapter for the agystack Antigravity plugin: active only in T3 sessions, it routes agystack playbooks through T3 child lifecycles (delegate_task or the ACP fallback), defines the explicit delegate envelope, and scopes one cloud-controller to one Cloud Run run. Standalone Antigravity ignores it and keeps native behavior."
---

# t3-agystack

agystack playbooks run the same in both worlds. What changes under T3 is who owns orchestration and what a child is allowed to do. This skill states that contract. It is installed by the t3-pstack projection beside the agystack skills, and the routing note at the top of every projected SKILL.md points here.

## Activation

This file is active only in a T3 session. Check these, in order; either passing activates this file:

1. A `delegate_task` MCP tool is actually callable in this session (a T3 provider child exists).
2. `T3_ACP_MCP_NODE` is set **and** names an existing, runnable file (the ACP transport fallback). Bare presence of the variable does not activate this file: a standalone Antigravity spawned from a T3 terminal inherits the variable without inheriting the transport, and keeps native behavior. A terminal that wants standalone behavior can `unset T3_ACP_MCP_NODE`.

Neither check passes: ignore this file and the routing note. Native agystack instructions win, including native `invoke_subagent`, watchdog timers, and the native tier config. Standalone Antigravity never reads an adapter. Either check passes: this file and the note take precedence over every native orchestration reference in the loaded agystack skills. Native orchestration is overridden, never offered as an alternative: do not fall back to native `invoke_subagent` descendants because `delegate_task` feels slower. Every conditional entry carries both checks; no session is half-adapter, and no terminal is forced into the adapter by an inherited variable alone.

## Ownership

Two roles, and the boundary is explicit.

**Coordinator.** The session whose task owns the agenda. It runs the agystack playbooks itself, owns the todolist and every lifecycle decision, and creates child work. On T3, coordination is the coordinator's own work. It never re-runs a playbook inside a delegate.

**Explicit delegate.** A child created through `delegate_task` or the ACP fallback. It executes its brief directly and owns its diff. It does not open new playbooks, does not spawn children, and does not route through native tools. Its identity comes from an envelope in the brief, never from a filename or a copied phrase. Mentioning an adapter path grants nothing.

A child may coordinate further only when its envelope names a subcoordinator role and says so in `ownership`. Anything else is a leaf.

## Delegate envelope

The coordinator opens every child brief with this block, then the task itself:

```
---
t3-agystack delegate envelope
role: <poteto-agent | reviewer | explorer | consumer | cloud-controller>
ownership: <"leaf: execute directly, spawn nothing" | "subcoordinator: may delegate within <scope>">
task: <one line describing the task>
paths: <exhaustive write paths; "none" for read-only work>
forbidden: <paths and policies off limits, e.g. user config, other skills' files>
workdir: <absolute session workdir for every command>
deliverable: <artifact, report, or SHA to return>
provenance: <absolute path of the resolved t3-agystack SKILL.md>
---
```

The envelope is a prompt convention until the T3 runtime supplies authenticated role metadata. That is its strength and its limit, stated plainly: nothing enforces it at runtime, only discipline. An envelope with stolen or vague fields is a bad brief, and the coordinator owns that.

## Cloud Run

Cloud swarms are an external backend, never one `delegate_task` per container. Workers are SDK agents the engine clones and runs; they are not T3 tasks and do not wake the coordinator.

A coordinator that wants a cloud run creates exactly one explicitly authorized child:

```
---
t3-agystack delegate envelope
role: cloud-controller
ownership: own exactly one Cloud Run run: one request id, one execution handle
task: dispatch the swarm plan and return the run handle
paths: <the state root the cloud run CLI writes>
forbidden: no new runs, no engine rewrites, no credential echoes
workdir: <repo checkout for the engine>
deliverable: <run handle, execution id, and state, as JSON>
provenance: <absolute path of the resolved t3-agystack SKILL.md>
---
```

That child invokes the cloud bridge at `scripts/cloud-run.mjs` next to this file, with its sibling modules beside it. The verbs are `dispatch/status/resume/cancel/harvest/list/attach`; `dispatch` requires a fresh `--client-request-id` and may carry `--controller-task-id` as provenance. The bridge fronts the agystack engine with durable run records, never repeats an attempted launch, and treats cancellation as explicit until remote terminal evidence. Cloud models, auth, and config stay independent of the composer model and of the projection. Killing the controller does not cancel the remote job. One controller per run; a second run wants a second brief or a widened envelope from the coordinator in writing.

## Model routing

The model sheet is authoritative for role assignments; the live T3 catalog resolves any specifically requested Antigravity instance and model. Do not invent options a catalog does not list and do not fake an option by prompt language. Native tier config (`pro`/`flash`/`flash_lite`) remains meaningful only in standalone use, so an envelope must name a concrete T3 provider instance and model, or name the sheet role for the coordinator to resolve.

## Limits

Live T3 task identity is not verifiable from inside a session today, so this adapter discloses rather than guarantees: delegation discipline is real, runtime enforcement is not. Idempotence, ownership, and drift protection for the projection itself are enforced by the manifest and by `tools/antigravity.mjs`, which is the narrower, provable guarantee.
