# Current unit: fetch_weights

- **fetch_weights**: Output = `weights_manifest.json` {weights_ready|status=fetched, source, resolved_local_model_path, ...}. If `weights.required=true`, non-API/non-PyPI sources must resolve to an existing local checkpoint path. Prefer model-local `.runtime/` or `checkpoints/`; if the declared load path is outside `model_dir`, record `fallback_to_host_global=true` and a non-empty `fallback_reason`. For HuggingFace in restricted networks, first try direct metadata with timeout, then retry with `HF_ENDPOINT=https://hf-mirror.com`; if large files redirect to Xet/CAS (`cas-bridge.xethub.hf.co`) and that host times out, record the CAS/Xet failure in `source_attempts` and fail this unit with a user-actionable repair instead of looping. Rich upstream-style fields such as `required`, `repo_id`, `dependencies`, `checkpoint_root`, and `source_attempts` are accepted but must point to existing paths. See `references/contracts/model_local_checkpoint_rule.md`.

Required output: <run_dir>/artifacts/weights_manifest.json.

The harness owns the semantic gate: scripts/check_weights.py. Its checks must pass unchanged.

Use the schema and reference entry points when needed for the current work. Prior stage evidence and decisions remain available; verify stale facts before relying on them.
