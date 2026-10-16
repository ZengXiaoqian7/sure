# Current unit: build_env

- **build_env**: Output = `build_env_result.json` {env_ready, backend, python_executable, lockfile_path|docker_image, log_path, runtime_checks, runtime_probe, repairs, ...}. env_ready=true. Declared `lockfile_path` and `log_path` must resolve under `model_dir` or run artifacts; Docker backend must declare `docker_image`. For `uv`, create/use the model-local `.venv` under `sure/models/<model_name>/` and ensure its interpreter exists (`.venv/bin/python` on POSIX, `.venv/Scripts/python.exe` on Windows). For local `package=none`, first write a draft with backend=`uv` and a hash-locked file inside `model_dir`, then run `materialize_model_runtime.py --input <draft> --produces <run_dir>/artifacts/build_env_result.json`. The helper resolves a content-addressed runtime under `<site runtime_root>/models/<runtime_id>` and emits portable `model_runtime_manifest.json`; do not hand-author either binding. For `conda`/`pixi`, record the selected env and its model-local evidence instead of opportunistically treating base Python as the runtime. If `model.py` already exists, the gate imports it with the selected runtime. If `runtime_checks.required_imports` is set, every declared import must pass. If the resolved request is `device=cuda`, the build env gate must also prove CUDA is visible in that runtime; do not write `env_ready=true` while the selected Python cannot import required packages or has an incompatible torch/transformers stack. If CUDA/dependency repair was needed, preserve it in `repairs` instead of deleting that evidence.

For explicit local `package=none`, write the normal build result first as `<run_dir>/artifacts/build_env_draft.json`, then seal it with:

```bash
"$HARNESS_PYTHON_BIN" scripts/materialize_model_runtime.py \
  --run-dir <run_dir> \
  --input <run_dir>/artifacts/build_env_draft.json \
  --produces <run_dir>/artifacts/build_env_result.json
```

The draft must use backend=`uv`, point to an executable validation Python, and name a `--generate-hashes` lock inside `model_dir`. The generated result replaces its Python path with the active site's content-addressed Model Python. Do not copy that absolute path into portable bundle files.

Required output: <run_dir>/artifacts/build_env_result.json.

The harness owns the semantic gate: scripts/check_env.py. Its checks must pass unchanged.

Use the schema and reference entry points when needed for the current work. Prior stage evidence and decisions remain available; verify stale facts before relying on them.
