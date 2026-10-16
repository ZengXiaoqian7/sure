# Current unit: generate_wrapper

- **generate_wrapper**: Output = `wrapper_manifest.json` {wrapper_path, model_py, server_py, ...}. The wrapper set lands in `sure/models/<model_name>/` (model.py, server.py, __init__.py, validate.py). Generated `validate.py` must preserve the template CLI: `--stage import|load|infer|contract|all`, write `artifacts/<stage>_result.json`, write `artifacts/sample_output.json` during infer, and validate contract from `io_contract`. Templates live in `scripts/templates/`. `config.yaml` may enable `protocols.strict_core` only when every conservative parameter (`temperature`, `do_sample`, `num_beams`, `num_return_sequences`, `seed`) maps to a property declared by the selected MCP tool `input_schema`, or is explicitly marked `model_param: null`, `status: not_applicable` with an architecture-specific reason. Omit/disable `strict_core` when that proof is unavailable; `/sure_infer` will still use `standard_system` by default.

Required output: <run_dir>/artifacts/wrapper_manifest.json.

The harness validates the output's structural contract.

Use the schema and reference entry points when needed for the current work. Prior stage evidence and decisions remain available; verify stale facts before relying on them.
