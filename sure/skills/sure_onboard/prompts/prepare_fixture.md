# Current unit: prepare_fixture

- **prepare_fixture**: Output = `fixture_manifest.json` {model_id, model_name, model_dir, task_type, source_dir, staged_dir, gt_jsonl, samples, sample_count, link_policy, fixture_source, official, provenance}. Reuse the fixture resolution carried by the feed handoff/model input; when it is `needs_input`, obtain either `--source-dir` for a model-specific fixture or a bounded temporary sample with URL, license, and checksum before running this gate. The helper copies the resolved source under `sure/models/<model_name>/fixture/<task>/<fixture_name>/` (`link_policy=copy`) and never silently changes the selected source. `gt.jsonl` rows must reference relative audio paths inside the fixture directory and carry task annotations; `sa_asr` requires speaker-attributed `segments`; sample_count must be 1-5. This gate exists because `validate.py` discovers payloads from `model_dir/fixture/**/gt.jsonl` or `SURE_VALIDATE_INPUT_JSON`.

Required output: <run_dir>/artifacts/fixture_manifest.json.

The harness owns the semantic gate: scripts/check_fixture.py. Its checks must pass unchanged.

Use the schema and reference entry points when needed for the current work. Prior stage evidence and decisions remain available; verify stale facts before relying on them.
