# Current unit: finalize_model_bundle

- **finalize_model_bundle**: Rewrites the manifest into portable finalized form, deterministically regenerates package, runtime, and verdict, verifies complete required-file hashes, and atomically writes `deployment_ready.json` last. Docker and API deliveries retain `sure.onboard.deployment_ready.v1`; an approved `package=none` Python delivery uses `sure.onboard.deployment_ready.v2`. The marker must be later than manifest/package/runtime/verdict and is the only terminal readiness marker consumed by `/sure_infer`.

Required output: <run_dir>/artifacts/deployment_ready.json.

The harness owns the semantic gate: scripts/check_finalized_bundle.py. Its checks must pass unchanged.

Use the schema and reference entry points when needed for the current work. Prior stage evidence and decisions remain available; verify stale facts before relying on them.
