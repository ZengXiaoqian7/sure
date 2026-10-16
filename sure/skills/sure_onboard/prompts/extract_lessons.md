# Current unit: extract_lessons

- **extract_lessons**: Inputs = `artifacts/run_digest.json`, written by the hook the moment `verdict` passed (read it; never rebuild it in place). Output = `extraction_declaration.json` {schema, no_new_lessons, no_lessons_reason, covered_by, candidates, infra_noise, infra_evidence} plus 0 to 5 candidate directories under `artifacts/candidates/<nn>-<slug>/` (`proposal.json` + `proposal.md`) and, for facts, evidence files under `artifacts/memory_evidence/`. The full contract (digest fields, candidate formats, the gate's ten checks, the write-tools-only rule) is `sure/runtime/memory/EXTRACTION.md`; read it before writing anything. Write candidates and evidence first and the declaration last. `no_new_lessons: true` with a one-line reason is the normal result of a clean run. Must Not Do: do not run `scripts/build_run_digest.py` onto `artifacts/run_digest.json` (a preview goes to `--out <run_dir>/artifacts/run_digest.preview.json` and the gate ignores it); do not write under `sure/memory/` or `references/memory/`; do not use bash heredocs for these files. Failure: `scripts/check_memory_extraction.py` says which check failed; after two consecutive failures the hook advances on its own with `extraction: failed`, and switching to `no_new_lessons: true` with the reason is always a valid way out.

Required output: <run_dir>/artifacts/extraction_declaration.json.

The harness owns the semantic gate: scripts/check_memory_extraction.py. Its checks must pass unchanged.

Use the schema and reference entry points when needed for the current work. Prior stage evidence and decisions remain available; verify stale facts before relying on them.
