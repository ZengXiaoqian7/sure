# SURE two-agent reference implementation

Development reference snapshot, based on upstream commit `c7806d5e679b6a012bad95dac0df2e24995f2200`. It includes offline regressions; real provider caching and matched task outcomes remain unverified. This branch is intended for integration review while local development continues.

## Roles and authority

- `/sure_onboard` opts in through `sure.skill.json`; other skills retain their existing execution path.
- The executor performs the original business task and is the only agent allowed to write task files. Stage prompts retain the original applicable rules. Consumer inspection or service probes are failure-specific work, not a new routine checklist.
- An independent persistent supervisor uses the selected model/provider and thinking level. It can inspect authorized text through `sure_diagnostic_read`, submit one complete task with `sure_handoff_repair({task, focusPaths?})`, or pause diagnosis with `sure_pause_diagnosis({reason})`. It has no business write, shell, finish or stop tool. Path hints do not narrow or expand executor permissions.
- The harness owns original gates/retries/finish, complete-batch hold and drain, evidence versions, ownership, handoff identity/receipts and cancellation. A supervisor task or model claim cannot authorize success. Each independent first error retains a local correction; an actual unsuccessful original-condition recheck returns for assessment. Work-volume counters request review rather than impose business retry caps.
- When association is ambiguous, executor `sure_update_state` accepts `repair_verification={repair_id,check_version,relation}`, where relation is `recheck`, `independent` or `related`; the host reads the recorded outcome. `sure_finish` validates the caller's run-level manifest and existing hooks.

## Messages and evidence

Common and stage contracts enter Pi's native message queue once per effective change at complete tool-batch boundaries. Unchanged turns retain the earlier prefix. Only explicit native compaction boundaries select old successful bulk output for stable excerpts; call/result pairs, current evidence, unresolved failures and provider-native blocks remain intact. Native summary, keepRecent, overflow recovery and cancellation stay in use. Reload/compaction restores current rules, user constraints and the same supervisor body/identity/status without assigning the task again. Raw transcripts remain intact.

Run-local `coordination.json` retains attempts, repair records and the outbox. `evidence/<version>.json`, hook/tool records, user constraints, snapshots and `supervisor/session/` retain provenance. Missing/corrupt transcripts, unknown receipts and ambiguous owners pause rather than fabricate continuity. A diagnostic pause exports the original failure and recoverable report without manufacturing terminal business products.

Coordinated SDK requests add redacted provider evidence: final serialized OpenAI completions payload hashes, ordered message hashes/prefixes, cache-field presence and raw/normalized usage linkage. Chunk usage is not summed. Missing fields, explicit zero, null and malformed values must be distinguished; numeric-type validation is not guaranteed by the existing parser. No authentication, full payload or private thinking is recorded. A stable prefix does not prove server cache hits or model retention.

## Offline regression entry points

From `packages/coding-agent`, run selected files with `node ../../node_modules/vitest/dist/cli.js --run`: `test/suite/sure-{coordinator,coordination-loop,context,local-context,supervisor,supervisor-session,supervisor-recovery,provider-diagnostics,baseline-limits}.test.ts`. Additional focused tests cover entry/reporting, hook evidence, ownership, storage, original onboard recovery/finish and print-mode outcomes. Shared session queue/compaction tests remain applicable.

From `packages/ai`, run `node ../../node_modules/vitest/dist/cli.js --run test/openai-completions-usage.test.ts`. Run `npm run check` from the repository root. Use the existing locked Harness Runtime; do not invoke real provider/consumer tests for this reference review.
