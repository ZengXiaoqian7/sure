# Current unit: validate_spec

- **validate_spec**: Output = `spec_validation.json` {checks, status}. All seven checks (spec_completeness/evidence_sufficiency/conflict_resolution/build_plan_executable/fixture_availability/io_contract_sufficient/preflight_compatible) must pass; status=passed. This unit proves that a task fixture source has been identified; it does not stage the model-local fixture. See `references/contracts/spec_validation.md`.

Required output: <run_dir>/artifacts/spec_validation.json.

The harness owns the semantic gate: scripts/check_spec.py. Its checks must pass unchanged.

Use the schema and reference entry points when needed for the current work. Prior stage evidence and decisions remain available; verify stale facts before relying on them.
