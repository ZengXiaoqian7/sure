# SURE executor and supervisor coordination

`/sure_onboard` enables serial collaboration between an executor and an autonomous read-only supervisor (debugger). Existing skill hooks own business gates, retries, checkpoints and finish. The executor retains its ordinary tools and is the only writer of business files. Both roles use the selected model, provider runtime and thinking level.

This describes the current implementation. Earlier plans/run records are historical evidence, not additional execution requirements. Offline fixtures establish control behavior; live diagnostic quality, latency and cost require separately authorized real runs.

## Skill contract

The optional manifest policy remains version 1; active persisted coordination state is version 2.

```json
{
  "coordination": {
    "version": 1,
    "commonPrompt": "prompts/common.md",
    "stages": [{
      "id": "build_env",
      "prompt": "prompts/build_env.md",
      "references": ["references/specs/wrapper_contract.md"],
      "snapshotPaths": ["run:artifacts"],
      "diagnosticPaths": ["project:config/site.default.yaml"]
    }]
  }
}
```

Prompt/reference paths must exist inside the skill package. Onboard declares all 23 units. Other skills retain their original behavior until they opt in. `snapshotPaths` describes historical capture; `diagnosticPaths` supplies preferred read-only evidence. Neither grants or narrows executor write permissions.

Hooks return `check` independently of hook `ok`. Outcomes are `pending`, `passed`, `blocked`, `unchanged`, `exhausted` and `skipped`. Tool success, pending checks and optional extraction skips are not business passes. Each producing hook receives source/invocation identity; executed tools retain request unit/batch/order/cwd, actual input/result, execution status and check links. Passing sibling checks cannot erase another blocker.

A permitted preflight check does not replace `post_tool_result`: the original post hook still applies its gate, checkpoint and feedback after actual execution. Existing action records suppress duplicate actual results; check deduplication distinguishes hook sources, including pre/post hook points. Hook indexes read only published `.json` records, ignoring atomic-write temporary files while retaining errors for corrupt published records.

## When diagnosis starts

The executor handles a first clear local failure directly. A later meaningful failed attempt after feedback triggers diagnosis while the unit is still blocked, including changed commands or error wording. Original-batch siblings, duplicate results, diagnostic reads and pending/unchanged checks do not count as repeated corrections. Calls skipped because of hold/cancellation or truncated arguments are excluded; actual preparation/validation/preflight rejections are observed separately. There is no workload/40-call takeover and no per-error quota or relation tree.

A skill may optionally supply `condition: {id, target?, localRepair?}` and `localProgress`. Continuing locally after another failure requires a clear local repair and verified resolution of the preceding blocker. Missing metadata remains unknown; the executor receives one local correction opportunity before a later unresolved attempt requests investigation. Onboard supplies observations only for concrete cases: successive missing required fields, and finalizer directory symlinks where the previous path was actually materialized. Changed text, filenames or arbitrary shell commands do not establish causal progress. These observations never pass a gate or alter retries.

Only the harness schedules investigation. `sure_update_state` has no active-help or evidence-return control, and retired fields are rejected. The reviewed failure position survives reload/compaction so the same evidence is not assessed repeatedly. New actual failed/rejected attempts or new user instructions permit reconsideration; ordinary reads and global evidence-version increments alone do not.

Projected sessions observe preparation, argument validation, preflight and unknown-tool rejection through the actual session/tool seam, including the tool snapshot used for that turn. The original preparation runs once; there is no repeated validation/execution or error-text classifier, and frozen agent-core is unchanged. SURE control `accepted=false` is observed separately from a business gate; a pre-finish check and its returned control rejection count once. Normal holds, cancellation, truncated tool arguments and internal provider retry are excluded. Successful execution of the exact blocked operation (same tool and input) clears that invocation blocker without pretending the business gate passed; an unrelated supporting success does not. Manifest path → JSON → envelope validation can prove clear local progression; repeated failure at one phase does not. Third-party blocks retain their original authority: recording a rejection never grants permission to bypass it.

The original skill retry limit remains authoritative. `exhausted` records that gate result; it is neither the main diagnosis trigger nor a new coordination stop/resume prohibition. A very small user-selected retry limit cannot guarantee automatic intervention before exhaustion. Coordination does not reset retries, reserve the final attempt or impose another business budget. Optional memory extraction and baseline headless finish continuations retain their original behavior.

## Autonomous investigation and handoff

Each run owns an independent native supervisor transcript under `supervisor/session/`. Each invocation opens that exact session with current tools/stage context; it does not replay calls or select a recent unrelated transcript. Native compaction, provider retry and request timeouts remain available. Investigation reads, turns and elapsed time are recorded without additional investigation quotas.

Initial context supplies the complete manual/common rules, user constraints, current stage, failure and compact whole-run navigation/actions. This is a starting point for autonomous investigation. There is no mandatory timeline/user-context reread, delivery-offset gate or binary-search procedure.

The initial navigation and the existing `timeline` read share a `checkpointTimeline` derived from recorded applied states in `events.jsonl`. Only actual checkpoint changes appear; display-only updates and unchanged checkpoints do not create transitions. Checkpoint metadata and shallow `data` fields have before/after previews (160 characters per value), without interpreting a skill's state machine. Complete states remain in the original log: use `log` with `logOffset` or `previousLogOffset`, in the same character units as ordinary diagnostic pagination.

Coordinated hook results carry the existing execution ID of the finally selected state patch into the applied state event's optional `data.hookExecutionId`. Original patch selection, normalization, merge and write ordering are unchanged; an invalid patch produces no applied state event. `hooks` with `hookId` reads that source, and an exact matching check ID may supply `checkVersion`/`snapshotId`. Missing links remain null, never inferred from timestamps or a nearby check. Older records remain readable without rewriting them; unreadable JSONL offsets are explicit and cut the before/after comparison. A check-linked snapshot is a scoped observation, not an atomic archive of the checkpoint and every artifact. Uncaptured historical text remains unavailable; a current file is not a substitute historical version.

This view is assembled only for supervisor investigation, with no new tool, ledger, recovery cursor, state-machine authority or executor duty. Existing snapshot limits, original gate/retry/finish and context/compaction behavior remain unchanged.

The supervisor has four tools:

- `sure_diagnostic_read`: timeline, actions/checks/hooks/tasks, snapshots, diffs, logs, file/search and one-level listing. Text pages use ordinary 2,000-line/50-KiB limits with continuation. Task-related absolute paths and dependency sources can be read subject to OS permissions, sensitive-path and binary/weight exclusions. Live reading is separate from snapshot capture and repair scope. Live evidence is labelled/hashed; changed sources invalidate advice. Explicit historical snapshot requests never substitute current files.
- `sure_handoff_repair({task, focusPaths?})`: one complete natural-language corrective goal, including any necessary probe, correction and validation. Focus paths are optional hints within original task scope, not a write allowlist. No mandatory structured diagnosis or executor report is required.
- `sure_continue_execution({reason})`: give concrete guidance to continue the existing route when evidence does not justify a correction. The actual reason reaches the executor and is retained after compaction/reload; the reviewed position prevents repeated diagnosis of the same evidence.
- `sure_pause_diagnosis({reason})`: preserve an investigation that cannot continue for user recovery. It dispatches no executor work, requests no later return/approval, neither finishes the business run nor manufactures readiness/extraction artifacts.

The supervisor has no shell/process, edit/write, business finish or business-stop capability. Actual probes/tests/changes are executor tasks. Repair passes the original gate, then execution continues without routine supervisor approval. There is no standalone evidence task or mandatory result-return protocol. One investigation gives complete corrective/continue guidance; the executor performs its necessary steps without a later supervisor approval round. Continued new failures can automatically trigger another investigation in the persistent session. Probe success is not business success. `gateOutcome` is an original gate observation, not proof that every task action occurred.

Control candidates settle at the complete tool-batch boundary. Conflicts receive feedback. After initial protocol feedback, three consecutive unsuccessful corrective turns without valid control/newly delivered evidence pause diagnosis; this fault rule does not cap ordinary investigation. Cancellation, provider failures, legal missing files and stale evidence remain distinct. Explicit resume resets the protocol streak, retaining history.

## Ownership, settlement and recovery

The extension holds future executor work, waits for all requested calls (including skipped calls), drains serialized results, synchronizes user constraints and captures a barrier before diagnosis. Actual results are saved before consulting hold state. Late held results remain evidence without business hooks/patches. Ownership/cancellation checks protect writes, acceptance and delivery; stale callbacks cannot restart either role.

Tasks have run-specific IDs and an outbox. A receipt is an actual executor user message with the exact task/run/unit tag on the receiving session's current branch after its saved parent. Receiver session ID/file, branch parent and actual message ID are retained. A sender flag alone is insufficient. Confirmed receipts prevent duplicates; started delivery that cannot be confirmed pauses without blind replay. Other runs, sessions and sibling branches cannot acknowledge the task.

Supervisor recovery verifies exact file, session ID, cwd and branch leaf. Missing/damaged ready transcripts and uncertain accepted controls pause safely. Only current-branch unpaired calls receive recovery results; actual tools are never replayed. A local exclusive owner persists across both roles. Only a confirmed exited process permits reclamation; there is no TTL takeover. Unknown/foreign-host/replaced ownership fails closed with concrete recovery paths.

Version 1 active coordination records and retired evidence-return results are not automatically migrated/resumed. Historical JSON/JSONL, snapshots and audit records remain readable. Start a new run for the current protocol. Valid version 2 recovery remains supported. The retired stop schema, `prepare_stop` hook and terminal-artifact materializer are removed.

`sure_finish` preserves baseline ordering for every status: validate the caller's manifest path/envelope, then run original finish hooks. Missing/invalid manifests return feedback. Diagnosis/pause do not create replacement manifests or overwrite business artifacts. Original error hooks, cancellation and shutdown/checkpoint classification remain. Terminal reports describe settled outcomes with no stop authority or additional model call.

## Context and display

Executor common rules and authored stage contracts remain native messages appended once at whole-batch boundaries without another model turn. Complete baseline local clauses, shared constraints and full-manual entry point remain. Stage changes do not rewrite ordinary request prefixes.

Preserve native-compaction-boundary selective trimming: only old, successful, large plain-text observations without current/unresolved references become historical excerpts. Errors, current evidence and native blocks remain. Excerpts preserve real text, source references and legal tool-call/result pairing. Raw transcripts/evidence are unchanged. Cancelled compaction publishes no trim boundary. Native summaries, overflow/length recovery, retries and cancellation remain; missing current rules, user constraints and the latest same-unit accepted corrective task body are restored after compaction/restart without assigning new tasks. Concrete continue guidance is restored by the same investigation identity when absent from the effective context. Restoration creates no new assignment, investigation or gate. The retired cross-stage evidence-return path and its special recovery obligation are removed.

Restoration selects the latest same-unit repair before checking validity; an invalid latest task never falls back to an older one. New user instructions invalidate that retained task even after its original gate cleared pending delivery, and invalidate retained continue guidance through the existing review position. A normal shutdown that keeps the same pending task remains recoverable; a later original pass preserves that valid goal's body. These rules stop automatic restoration of superseded guidance without deleting native history. The existing resume/freshness ordering and scope are unchanged by this fix.

The existing TUI renders true supervisor tool start/update/end events separately from executor actions. During diagnosis its working text is exactly `Supervisor · reviewing evidence and preparing guidance…`; cleanup/delivery restores ordinary executor status. This display path does not inject supervisor activity into executor context or business hooks. There is no second TUI runtime or new terminal-summary model workflow.

## Persistence and verification

`coordination.json` retains scheduling state, failed/reviewed positions, task history/outbox and supervisor identity. Immutable checks/tools live under `evidence/`; snapshots retain historical text, identities and explicit omissions; diagnoses retain results/checkpoints; native transcripts retain conversation. Identical snapshot identities reuse existing bodies without a content-library/GC framework. Unused recent-session resume, disable-tools options and the unconsumed historical-scope aggregation are removed; exact native-session recovery remains. Capture limits remain 256 files, 256,000 bytes per text file and 2,000,000 total text bytes; these do not limit authorized live-source reading.

Extra provider payload/prefix/cache-ingress research observers and SDK wrappers are removed. Baseline payload/response/fetch/header/session affinity hooks, usage/cost parsing, retry, timeout, streaming and errors remain. Usage comes from native recorded responses.

Offline regressions cover baseline gate/finish/retry, changing failures/batches, real helper recovery, native context/compaction, persistent autonomous diagnosis, branch recovery, receipt uncertainty, cancellation/ownership, provider behavior and real role/tool display. Faux-provider tests do not establish live diagnostic quality or time/token savings.

`node scripts/sure-coordination-inspect.mjs RUN_DIR [EXECUTOR_SESSION.jsonl ...]` reads current/historical records without rerunning gates. Missing usage/transcripts keep totals unknown. `--comparison-source REPO INPUT_FILE ...` records source/input identities for separately authorized comparisons. Include failed/paused samples, selected settings, starting caches and business outputs when evaluating live runs.
