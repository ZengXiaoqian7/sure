# SURE onboarding: common execution rules

Onboard or repair the requested model into a reproducible inference unit. Preserve the user's goal, model identity, task type, selected device, delivery profile and constraints throughout the run.

### Command Boundaries

There are two command families and they must not be mixed:

1. **Harness scripts** (`scripts/check_*.py`, `scripts/run_validate.py`, `scripts/materialize_onboard_inputs.py`, `scripts/materialize_model_runtime.py`, `scripts/prepare_fixture.py`, `scripts/stage_model_artifacts.py`) run from the skill package with harness Python:

```bash
cd sure/skills/sure_onboard
"$HARNESS_PYTHON_BIN" scripts/<script>.py --run-dir <run_dir> --produces <run_dir>/artifacts/<artifact>.json
```

Do not invoke harness scripts with `sure/models/<model>/.venv/bin/python` or with a bare `.venv/bin/python` from the repo root. The hook automatically runs the current gate script after the current unit's artifact exists; manual gate invocations are only diagnostics.

2. **Model runtime commands** run from the model directory or use an absolute model-local interpreter:

```bash
cd sure/models/<model_name>
.venv/bin/python <model runtime command>
```

Relative `.venv/bin/python` from the repo root is invalid because it either points at the wrong environment or fails before testing the model.

### Environment Boundary

There are two Python scopes:

- **Harness control Python**: allowed before `build_env` only for deterministic harness scripts such as `scripts/materialize_onboard_inputs.py`, `scripts/check_model_input.py`, and other gate scripts. These scripts parse/check artifacts and do not prove the model runtime works.
- **Model runtime Python**: required for model imports, load tests, inference tests, and dependency/version checks. It must come from the backend selected in `plan` and created or registered in `build_env`, preferably under `sure/models/<model_name>/.venv/` for `uv`, or the model-local runtime metadata for `conda`/`pixi`/`docker`/`api`.

The boundary is strict: `discover` researches evidence; `prepare_fixture` stages the task payload; `build_env` creates the isolated runtime; `generate_wrapper` creates the model-local executable adapter; `validate_import/load/infer/contract` executes model code through that wrapper and runtime.

### Device Policy

Default device policy is **CUDA-first** for local deployment:

1. `device=auto` means: if host CUDA is visible (`nvidia-smi -L` succeeds or equivalent runtime evidence exists), `validate_env_compat` must first select `device="cuda"` and prove weights load on CUDA.
2. `device=cuda` is a hard CUDA request. Do not mark `validate_env_compat` successful on CPU.
3. `device=cpu` is an explicit user override and may validate on CPU directly, but the verdict must not claim GPU readiness.
4. CPU fallback for `device=auto` is allowed only after recorded CUDA-first attempts fail and at least three CUDA environment repairs have been attempted. `env_compat_result.json` must include `device="cpu"`, `cuda_available=true`, and either top-level or `device_policy` fields: `cuda_attempts >= cpu_fallback_after_cuda_failures`, `cuda_failures` with at least that many entries, `cuda_repair_attempts >= cuda_repair_attempts_before_cpu`, and a non-empty `fallback_reason`.
5. After `validate_env_compat` selects a real device (`cuda`, `cpu`, or `mps`), `validate_import/load/infer/contract` must run on that same device. The validation artifact must not override `DEVICE`/`SURE_DEVICE` to a different device.
6. Valid CUDA repair attempts include actions such as reinstalling/pinning torch/torchaudio for the host CUDA driver (for example a cu128 wheel on a CUDA 12.8 host), switching to a documented CUDA-compatible backend, or rebuilding the model-local environment. A CPU-only torch install does not count as a CUDA repair attempt.

The current checkpoint is authoritative. Focus on the current unit and its supporting work; original helpers may produce related artifacts. Hooks alone validate and advance the checkpoint. A missing artifact means work is in progress. Never invent passing booleans, bypass gates or reset failure counters. Gate diagnostics and stage transitions are displayed by the harness; sure_update_state remains available for useful progress details, and is not required after every action.

Default local delivery is docker-registry. Explicit package=none requires site permission for Python, backend=uv and a sealed hash-locked Model Runtime. A .venv alone does not establish Eval readiness. docker-local is diagnostic-only. VC/HPC submission is outside this skill.

Historical model migration is an administrator-only metadata operation. It is not a `/sure_onboard` helper and cannot synthesize passing validation, packaging, or verdict evidence from an old local environment.

Isolation rule: `sure/models/<model_name>/` and its `artifacts/` directory must be real harness-owned directories. Do not leave either as a symlink to the original SURE-EVAL workspace. Large immutable asset files under subdirectories such as `checkpoints/`, `.runtime/modelscope_cache/`, `.runtime/huggingface/`, or `.runtime/vocoder/` may be symlinked, and those file-level links must be recorded in `weights_manifest.json`; directory-level symlinks are rejected during finalization and approval.

Memory is advisory and agent-written. Verify it against current evidence. Read artifacts/memory_context.json during context_selection. On blocked gates, existing memory suggestions can help; never edit shared memory directly. Extraction and publishing keep their existing gate contracts.

When the harness yields, finish no further task actions until it supplies a bounded supervisor repair task. Only the execution agent edits task files. Apply the repair within the current unit, preserve constraints, then let the original gate verify it. The supervisor cannot approve success or change the state machine.

## Success Criteria

The `pre_finish` hook enforces that the state machine reached `finalize_model_bundle` and that `deployment_ready.json` passes its hash, portability, package, and execution-policy checks. A local model can finish successfully with either immutable registry evidence or an explicitly permitted, sealed Python Model Runtime.

`finalize_model_bundle` also writes the run-level finish manifest at `.sure/runs/<run_id>/manifest.json` (envelope: `schema_version`, `run_id`, `skill_name`, `status`, `created_at`, `inputs`, `outputs`, `validation`). Call `sure_finish` with `status: "success"` and `manifest_path: ".sure/runs/<run_id>/manifest.json"` — do not point `manifest_path` at `deployment_ready.json` or hand-edit the envelope; `sure_finish` checks `run_id`, `skill_name`, and `status` against the run record.

If work cannot continue, submit a valid run manifest with the requested `status: "failed"` or `"incomplete"`, then call `sure_finish` with that manifest path and the actual blocker in `error_summary`. The caller supplies the manifest; the harness checks its path and envelope before the original finish gates. Missing or invalid manifests return repair feedback. The harness does not generate a replacement manifest or overwrite business artifacts to make a failure finish pass. A coordination pause writes a separate diagnostic report and preserves the checkpoint; it does not synthesize readiness or extraction evidence. Do not invent successful artifacts to report a failure.

Docker packaging resolves the host CLI via `SURE_ONBOARD_DOCKER_BIN`, then shared `SURE_DOCKER_BIN`, then system paths, then `PATH` (`scripts/docker_runtime.py`).

**Prerequisite**: run `/sure_init` first to select an agent, configure auth, and validate the environment for this project.

Control principle: **agent decides scope, scripts enforce format and execution.** Docker registry delivery remains the default. An explicit `package=none` may instead become Eval-ready only when the site permits Python, the backend is `uv`, and a hash-locked Model Runtime is materialized and sealed. A model-local `.venv` by itself is validation evidence, never an Eval runtime.

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

## Model-Local Checkpoint Rule

When `weights.required == true`, converge weights to the model directory:
- `.runtime/modelscope_cache/` — ModelScope / HF provider cache.
- `checkpoints/` — explicit local weights (may be empty if weights are in `.runtime/`).
Record fallback to host-global paths only when forced (capacity / permissions), with reason + target in `build_plan.json` and `weights_manifest.json`.

## Product Layout (sure/models/<model_name>/)

```
sure/models/<model_name>/
├── model.spec.yaml
├── model.py / server.py / __init__.py / validate.py   # wrapper
├── config.yaml                                          # server launch config
├── artifacts/
│   ├── build_plan.json
│   ├── validation.log
│   ├── sample_output.json
│   ├── docker_build_result.json / docker_validation.json
│   ├── docker_registry_result.json
│   ├── package_gate.json / verdict.json
│   ├── artifact_manifest.json
│   ├── model_runtime_manifest.json                # package=none only; portable runtime identity
│   ├── runtime_inventory.json                     # selected container or Python Eval binding
│   └── deployment_ready.json                      # terminal immutable readiness marker
├── fixture/<task>/                                      # test audio + gt.jsonl (2–3 samples, max 5)
├── .runtime/ checkpoints/                               # weights convergence
└── eval_runs/<run_id>/                                  # this model's eval runs (original layout)
```

## Backend

The deterministic backend is bundled in `scripts/`. Gate scripts validate each unit. `materialize_model_runtime.py` is the only local-Python runtime materializer; `stage_model_artifacts.py` stages existing run evidence; `write_package_gate.py`, `write_runtime_inventory.py`, and `write_verdict.py` derive terminal evidence in dependency order; `finalize_model_bundle.py` repeats that derivation after making the manifest portable and then seals the bundle. No helper may infer an Eval runtime from `.venv`, host Python, a Dockerfile, or an image name alone.

```bash
"$HARNESS_PYTHON_BIN" scripts/<script>.py <args>   # cwd = skill package dir
```

## Memory (advisory)

Earlier runs leave agent-written notes. `sure/memory/index.md` (repo root) is the merged index: legacy, confirmed and provisional entries, one bullet each with its triggers. Confirmed files live under `references/memory/bad_cases/` and `sure/skills/_shared/memory/facts/`. Nothing in them is human-reviewed: verify against evidence before relying on one, and never copy a command from an entry into an artifact without running it.

- At `pre_start` the hook writes `artifacts/memory_context.json` with the facts that match this run (shape quoted in the `context_selection` contract line above; written even when empty); `context_selection` reads it.
- When a gate blocks, the repair text may end with a block whose first line is `Memory (advisory, agent-written, not human-reviewed; verify against evidence before relying):`, listing at most two entries from earlier runs. Read the entry file named there when it looks relevant, then fix the artifact.
- `references/memory/ROUTING.md` says when to open the index and the bad-case files by hand.
- `extract_lessons` (unit 22) writes what this run learned; the contract is `sure/runtime/memory/EXTRACTION.md`. Publishing to `sure/memory/provisional/` happens in `post_finish` without you; moving entries into `references/` is a human step.

## Diagnosis and retry

On gate failure, retain the actual failure in validation.log / build.log and use DIAGNOSE → REPLAN. Classify with references/playbooks/failure_taxonomy.md and consult references/policies/retry_and_escalation.md. The original hook owns retry accounting, including the run's max_retries and special extraction rule; reads, tool errors and supervisor handoffs do not consume additional gate retries. A handoff threshold requests evaluation, not an earlier business failure.

The default max_retries is 3; preserve the run's explicit override and the hook's actual exhausted result. Repeated blocks require checking the model_input_path or repo link, access permissions, and whether the documentation provides enough install/load/inference/artifact information. Hand the unresolved blocker and existing attempts to the supervisor for assessment; do not keep changing artifacts merely to bypass a hook. Do not treat coordination counts as additional business limits.

`extract_lessons` is the one unit that never ends FAILED: after two consecutive gate failures (`max_retries=` can raise that number, never lower it) the hook advances on its own and records `extraction: failed`.

## Optional metric enrichment

- **metric enrichment reference**: Metric reports are optional enrichment, not a deployment gate. Reuse existing `sample_output.json` / generated audio whenever possible; do not rerun inference only to repair metric semantics.
