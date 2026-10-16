# Current unit: build_plan

- **build_plan**: Output = `build_plan.json` {model_id, model_dir, backend, package_profile, steps, ...}. It must be executable and must not include required VC/HPC submission steps. For `docker-registry`, copy `container_delivery.target_image` exactly from `model_input_resolved.json`; do not infer or rewrite its registry namespace. Local `package=none` must select backend=`uv` and include `materialize_model_runtime.py` after producing a hash-locked dependency file.

Required output: <run_dir>/artifacts/build_plan.json.

The harness owns the semantic gate: scripts/check_build_plan.py. Its checks must pass unchanged.

Use the schema and reference entry points when needed for the current work. Prior stage evidence and decisions remain available; verify stale facts before relying on them.
