# Current unit: package_container

- **package_container**: For `docker-local` or `docker-registry`, first run `"$HARNESS_PYTHON_BIN" scripts/describe_harness_runtime.py`. Add its exact named build context and `COPY --from=sure_harness_runtime` line to the model Docker build. It names a digest-pinned Harness Runtime image, never a host directory, because the runtime is a uv virtual environment that cannot be copied out of the host tree; if it reports no such image, build one with `sure/runtime/harness/build_image.py` and set `SURE_HARNESS_RUNTIME_IMAGE` before retrying. Output `docker_registry_result.json` plus `docker_build_result.json` and `docker_validation.json`. Container evidence must bind the image digest and distinct model/harness runtimes; registry delivery also requires passing push/pull verification. For `package=none`, emit `status=skipped` with a reason and do not create Docker evidence.

Required output: <run_dir>/artifacts/docker_registry_result.json.

The harness owns the semantic gate: scripts/check_container_package.py. Its checks must pass unchanged.

Use the schema and reference entry points when needed for the current work. Prior stage evidence and decisions remain available; verify stale facts before relying on them.
