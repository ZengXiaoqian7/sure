# Current unit: discover

- **discover**: Inputs = resolved `repo_url`, `model_dir`, and optional handoff artifacts. Output = `repo_summary.json` with only these top-level fields: `repo_url` (string, required), `timestamp` (string), `model_id` (string), `model_name` (string), `task_type` (string), `deployment_type` (string), `commit` (string|null), `repo_commit` (string|null), `discovery_strategy` (string), `model_dir` (string|null), `model_dir_exists` (boolean), `handoff_artifacts_dir` (string|null), `local_path` (string|null), `evidence_sources` (array of string or object), `file_inventory` (array of strings, or object), `model_card_info` (object), `entrypoints` (object), `dependency_hints` (object), `fixture_hints` (object), `language` (string), `notes` (string); the schema has `additionalProperties:false`. Prefer existing `model_dir` and handoff artifacts before network clone/search. Must Not Do: unbounded filesystem search, full checkpoint download, safetensors/bin transfer, long sleep polling, current-shell/base-Python runtime dependency probes, model load/infer probes, `verdict_status`, `wrapper_path` (later units).

### Local-first discovery

`discover` is agent-research-first, but it must be bounded and model-local-first:

1. Read `<run_dir>/artifacts/model_input_resolved.json`.
2. Inspect `model_input_resolved.model_dir` if it already exists. This is the highest-priority evidence because `/sure_onboard model=<name>` may be repairing or validating an already adapted local model from the original SURE workspace.
3. Inspect `model_input_resolved.source.handoff_artifacts_dir` when present; `/sure_feed` research artifacts are the second-priority evidence.
4. Inspect only the declared `repo_url` or a bounded clone/cache under `model_dir/.runtime/` when local evidence is insufficient.
5. Do not run unbounded filesystem searches such as `find /`, `find /mnt`, or site-specific shared roots. If a local path is needed, derive it from `model_dir`, `handoff_artifacts_dir`, `weights.local_path`, or the declared model-local checkpoint paths.
6. Do not download full checkpoints in `discover`: no `snapshot_download`, no `huggingface-cli download`, no safetensors/bin `hf_hub_download`, no long `sleep` polling. Use short metadata probes only (for example README/config/listing with timeout and `HF_ENDPOINT=https://hf-mirror.com` fallback when direct HuggingFace is unreachable). Full checkpoint transfer and retry policy belong to `fetch_weights`.
7. Do not validate model runtime dependencies with the current shell or base Python in `discover`: no `python -c "import torch/transformers/torchaudio/..."`, no load/infer probes, and no `from_pretrained`. Record dependency evidence from README/config/requirements in `repo_summary.json`; backend selection and environment creation happen later.

`repo_summary.json` should record the chosen strategy in `discovery_strategy`, plus `model_dir`, `handoff_artifacts_dir`, `local_path`, and `evidence_sources` when available. Remote GitHub/HuggingFace/ModelScope evidence is supporting evidence; it must not replace an existing, validated model-local implementation.

Required output: <run_dir>/artifacts/repo_summary.json.

The harness validates the output's structural contract.

Use the schema and reference entry points when needed for the current work. Prior stage evidence and decisions remain available; verify stale facts before relying on them.
