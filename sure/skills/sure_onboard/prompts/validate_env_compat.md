# Current unit: validate_env_compat

- **validate_env_compat**: Output = `env_compat_result.json` {compat_ok, device, requested_device, python_executable, python_version_match, adapter_protocol_supported, weights_loadable, runtime, weights, adapter, ...}. compat_ok=true must not contradict explicit false checks for python version, adapter protocol, or weights loadability. For local `device=auto`, visible host CUDA forces CUDA-first; CPU fallback must record `cuda_available`, `cuda_attempts`, `cuda_failures`, `cuda_repair_attempts`, and `fallback_reason`.

Required output: <run_dir>/artifacts/env_compat_result.json.

The harness owns the semantic gate: scripts/check_env_compat.py. Its checks must pass unchanged.

Use the schema and reference entry points when needed for the current work. Prior stage evidence and decisions remain available; verify stale facts before relying on them.
