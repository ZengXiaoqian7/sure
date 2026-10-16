# Current unit: plan

- **plan**: Output = `backend_choice.json` {backend, choice_reason, ...}. Allowed: backend ∈ {uv,pip,conda,pixi,docker,api}. See `references/policies/backend_selection.md` + `references/playbooks/env_ROUTING.md`.

## Backend Routing Rules (Phase 1)

Rule-based backend selection (record the reason in `backend_choice.json`):

1. API-only model → `api`.
2. Repo has Dockerfile + complex deps → `docker`.
3. Repo has `environment.yml` / conda signals → `pixi` (or `conda`).
4. Repo has only `pyproject.toml` / `requirements.txt`, pure Python → `uv`.
5. CUDA compilation / custom C++ / k2 / complex submodules → `docker` first.
6. High host-pollution risk → `docker` first.

Required output: <run_dir>/artifacts/backend_choice.json.

The harness validates the output's structural contract.

Use the schema and reference entry points when needed for the current work. Prior stage evidence and decisions remain available; verify stale facts before relying on them.
