# Current unit: load_model_input

- **load_model_input**: Output = `model_input_resolved.json` {model_id, model_name, model_dir, task_type, deployment_type, package_profile, path_policy, ...}. `model_name` must be a single directory segment; `model_dir` must point to `sure/models/<model_name>/`; `path_policy` records the harness-owned model-dir rule and asset-level symlink policy.

## Parameters

| Parameter | Required | Meaning |
|-----------|----------|---------|
| `model` | ✅ preferred after `/sure_feed` | Handoff folder name under `sure/handoffs/<model>/`, for example `OpenMOSS-Team__MOSS-Transcribe-Diarize`. This resolves to `sure/handoffs/<model>/model_input.yaml`. |
| `model_input_path` | ✅ preferred for explicit paths | Path to the `MODEL_INPUT` YAML emitted by `/sure_feed`. This auto-fills `model_id`, `repo`, `task_type`, `deployment_type`, `preferred_backend`, `python_version`, and `weights_source`. |
| `model_id` | Required without `model_input_path` | Provider model id such as `Qwen/Qwen3-ASR-1.7B`. |
| `model_name` | Auto-filled from MODEL_INPUT or `model_id` | Single-segment directory name such as `Qwen__Qwen3-ASR-1.7B`; becomes `sure/models/<model_name>/`. |
| `repo` | Required without `model_input_path` | Repo URL or local path (DISCOVER input). |
| `task_type` | Required without `model_input_path` | Any task or alias in `sure/runtime/evaluation/engine-capabilities.generated.json`, or its `speech_understanding` suite. |
| `deployment_type` | Required without `model_input_path` | `local \| api`. |
| `preferred_backend` | — | `uv \| pip \| conda \| pixi \| docker \| api` (overrides auto-selection). |
| `python_version` | — | Pin a Python version. |
| `weights_source` | — | Weights URL / local path. |
| `package` | — | Local models default to `docker-registry`. Explicit `none` selects a sealed local Python runtime when site policy permits `python` and backend=`uv`; API also uses `none`. `docker-local` is diagnostic-only. |
| `package_profile` | — | Alias for `package`; use only one. |
| `weights_link_policy` | — | `auto` (default), `copy`, `symlink`, `reuse-existing`, or `no-reuse`. |
| `skip_download` | — | bool — use existing local weights only. |
| `device` | — | `auto` (default), `cuda`, `cpu`, or `mps`. |
| `cpu_fallback_after_cuda_failures` | — | Default 3. When `device=auto` and host CUDA is visible, CPU fallback is accepted only after this many recorded CUDA failures. |
| `cuda_repair_attempts_before_cpu` | — | Default 3. When CUDA is visible and the first CUDA path fails, the agent must try at least this many CUDA environment repairs before CPU fallback can pass. |
| `force_repair` | — | bool — force a repair of an already-onboarded model. |
| `existing_model_dir` | — | For repair: point at the existing model artifacts dir. |
| `max_retries` | — | Default 3. |

The run directory (`<run_dir>`) holds structured run outputs under `<run_dir>/artifacts/<unit.produces>`. **Model entity products** (wrapper/spec/fixture/verdict) land in the repo-level global dir `sure/models/<model_name>/`, where `model_name` is the single-segment normalized name such as `Qwen__Qwen3-ASR-1.7B`. Do not use raw `owner/model` as a directory path.

Preferred handoff:

```bash
/sure_onboard model=OpenMOSS-Team__MOSS-Transcribe-Diarize
```

Explicit path handoff:

```bash
/sure_onboard model_input_path=sure/handoffs/OpenMOSS-Team__MOSS-Transcribe-Diarize/model_input.yaml
```

For a quick local check, a positional YAML path is also accepted:

```bash
/sure_onboard sure/handoffs/OpenMOSS-Team__MOSS-Transcribe-Diarize/model_input.yaml
```

The `sure/handoffs/<model>/` folder is not deleted after onboard. It remains a stable cache of the feed research result and lets users re-run or compare onboarding attempts without repeating discovery.

Recommended first command after start, when a `MODEL_INPUT` path is available:

```bash
"$HARNESS_PYTHON_BIN" scripts/materialize_onboard_inputs.py \
  --model-input-path sure/handoffs/<model>/model_input.yaml \
  --run-dir <run_dir> \
  --repo-root <repo_root> \
  [--image-version <version>]
```

This helper emits only `model_input_resolved.json` and `context_selection.json`. For `docker-registry`, it resolves `container_delivery.target_image` from the active site policy before any model download or build; omit `--image-version` to select the next unused patch tag. It deliberately does **not** emit `backend_choice.json` or `build_plan.json`; those must remain agent-research-first outputs based on repository evidence and documented import/load/inference paths.

The helper reads explicit `package`/`package_profile`, `device`, `force_repair`, and `skip_download` options from `<run_dir>/run.json`. Omit the corresponding helper flags to inherit them. If you supply a helper flag, it must agree with the run's explicit option. Without an explicit option, the existing helper defaults apply.

`MODEL_INPUT` should be strict YAML. The helper includes a scalar-only fallback for legacy handoffs with unquoted multiline code snippets, but fallback output is partial and must be treated as a repair signal for `/sure_feed`, not as the preferred format.

Required output: <run_dir>/artifacts/model_input_resolved.json.

The harness owns the semantic gate: scripts/check_model_input.py. Its checks must pass unchanged.

Use the schema and reference entry points when needed for the current work. Prior stage evidence and decisions remain available; verify stale facts before relying on them.
