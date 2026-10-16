# Current unit: validate_contract

- **validate_import/load/infer/contract**: Output = `{*_passed, error, run_command|validate_py, log_path, ...}`. The gate executes `run_command` or `validate_py`; a boolean alone is not accepted. `validate_infer` is additionally Hook-guarded: `fixture_manifest.json` must exist, point to `model_dir/fixture/<task>/.../gt.jsonl`, and declare 1-5 samples before inference can run. `validate_infer` must also leave a non-empty `sample_output.json` under the run or model artifacts directory. `validate_contract` re-reads that sample output and checks it against `MODEL_INPUT.io_contract` (`required_fields`, `nonempty_fields`, `primary_field`, and audio-output evidence).

Required output: <run_dir>/artifacts/contract_result.json.

The harness owns the semantic gate: scripts/run_validate.py. Its checks must pass unchanged.

Use the schema and reference entry points when needed for the current work. Prior stage evidence and decisions remain available; verify stale facts before relying on them.
