# Current unit: package_gate

- **package_gate**: Run `scripts/write_package_gate.py --run-dir <run_dir> --produces <run_dir>/artifacts/package_gate.json`. It derives schema v2 evidence from the staged manifest and validated inputs instead of trusting an older sidecar. `docker-registry` requires exact Docker tag/digest/ref agreement. Local `none` requires all local validations, `bundle_ready=true`, all Docker readiness flags false, a byte-identical staged Model Runtime manifest, and a live site-runtime verification. Its timestamp must be later than the artifact manifest; `docker-local` remains non-Eval-ready.

Required output: <run_dir>/artifacts/package_gate.json.

The harness owns the semantic gate: scripts/check_package_gate.py. Its checks must pass unchanged.

Use the schema and reference entry points when needed for the current work. Prior stage evidence and decisions remain available; verify stale facts before relying on them.
