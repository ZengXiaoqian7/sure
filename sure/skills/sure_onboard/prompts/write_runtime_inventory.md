# Current unit: write_runtime_inventory

- **write_runtime_inventory**: Output schema v2 = `runtime_inventory.json`. Container delivery records the digest-pinned image and read-only model mount. Local Python records only the portable Model Runtime ID, manifest/lock hashes, server command, tools, and model-core hashes; `/sure_infer` resolves the current site's absolute runtime root by ID. In both cases Model Python and Harness Python remain separate roles, and the inventory timestamp is later than package evidence.

Required output: <run_dir>/artifacts/runtime_inventory.json.

The harness owns the semantic gate: scripts/check_runtime_inventory.py. Its checks must pass unchanged.

Use the schema and reference entry points when needed for the current work. Prior stage evidence and decisions remain available; verify stale facts before relying on them.
