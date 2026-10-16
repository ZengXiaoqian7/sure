# Current unit: verdict

- **verdict**: Run `scripts/write_verdict.py --run-dir <run_dir> --produces <run_dir>/artifacts/verdict.json`. It derives the verdict from staged build, validation, package, and runtime evidence instead of trusting an older sidecar. A local success requires `bundle_ready=true` and either verified `docker-registry` delivery or sealed `package=none` Python delivery. Its timestamp must be later than package and runtime evidence; `docker-local` must remain partial or failed.

Required output: <run_dir>/artifacts/verdict.json.

The harness owns the semantic gate: scripts/check_verdict.py. Its checks must pass unchanged.

Use the schema and reference entry points when needed for the current work. Prior stage evidence and decisions remain available; verify stale facts before relying on them.
