# Current unit: save_artifacts

- **save_artifacts**: Output = `artifact_manifest.json` {model_dir, artifacts.{required,conditional,optional}}. Gate checks model-local files exist and stages the selected delivery evidence. Local `package=none` requires the exact generated `model_runtime_manifest.json`; it does not infer one from `.venv`.

Recommended command at `save_artifacts`, after wrapper generation and validation artifacts exist:

```bash
"$HARNESS_PYTHON_BIN" scripts/stage_model_artifacts.py \
  --run-dir <run_dir> \
  --produces <run_dir>/artifacts/artifact_manifest.json
```

This helper copies already-created run artifacts into `sure/models/<model_name>/artifacts/` and writes the preferred `artifact_manifest.json` both in the run directory and in the model directory. It does not create `model.py`, `model.spec.yaml`, validation results, weights, or verdicts; missing previous state-machine outputs remain a blocking error.

Required output: <run_dir>/artifacts/artifact_manifest.json.

The harness owns the semantic gate: scripts/check_artifact_manifest.py. Its checks must pass unchanged.

Use the schema and reference entry points when needed for the current work. Prior stage evidence and decisions remain available; verify stale facts before relying on them.
