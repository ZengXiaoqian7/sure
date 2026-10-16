# Current unit: context_selection

- **context_selection**: Output = `context_selection.json` {task_type, selected_references, skipped_references, rationale}. Read only the task/env/contracts actually needed; record what was read. Also read `artifacts/memory_context.json` when it exists: the `pre_start` hook writes it with the memory facts that match this cluster, model family and datasets, shape `{schema: "sure.memory.context.v1", skill, target_id, facts: [{entry_id, title, path, scope, checked_at, stale, status}], omitted_provisional}`; the file is written even when nothing matched (`facts: []`); it is advisory, verify before relying, and `stale: true` means the fact is older than its scope's re-check limit. List the memory files you actually read under `selected_references.memory` (the schema already allows that key). Routing for the rest of the memory tree: `references/memory/ROUTING.md`.

Required output: <run_dir>/artifacts/context_selection.json.

The harness validates the output's structural contract.

Use the schema and reference entry points when needed for the current work. Prior stage evidence and decisions remain available; verify stale facts before relying on them.
