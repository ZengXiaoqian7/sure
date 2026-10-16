# Current unit: classify

- **classify**: Output exactly `classification.json` with only these top-level fields: `task_type`, `deployment_type`, `sub_task`, `input_modality`, `output_modality`, `rationale`. Do not include metadata fields such as `timestamp`, `model_id`, `model_name`, or `task_type_reason`; the schema has `additionalProperties:false`. Allowed task values come from `sure/runtime/evaluation/engine-capabilities.generated.json`; `speech_understanding` means its complete generated suite membership and cannot be narrowed by model metadata.

Required output: <run_dir>/artifacts/classification.json.

The harness validates the output's structural contract.

Use the schema and reference entry points when needed for the current work. Prior stage evidence and decisions remain available; verify stale facts before relying on them.
