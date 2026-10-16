import { cpSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SureHookContext, SureHookResult } from "@earendil-works/pi-coding-agent/hooks";
import { readArtifact, readCheckpoint } from "./checkpoints.ts";

/** Deterministic non-success materialization; never writes model-local readiness. */
export function prepareStop(ctx: SureHookContext): SureHookResult {
	const checkpoint = readCheckpoint(ctx);
	const resolved = readArtifact(ctx, "model_input_resolved.json") as Record<string, unknown> | undefined;
	const event = ctx.event as { reason?: string; finish?: { status?: string } } | undefined;
	const status = event?.finish?.status === "incomplete" ? "incomplete" : "failed";
	const reason = event?.reason ?? "Execution stopped before the onboarding gates completed.";
	const modelName = typeof resolved?.model_name === "string" ? resolved.model_name : "unresolved-model";
	const profile = ["none", "docker-local", "docker-registry"].includes(String(resolved?.package_profile))
		? String(resolved?.package_profile)
		: "docker-registry";
	const artifactsDir = join(ctx.runDir, "artifacts");
	mkdirSync(artifactsDir, { recursive: true });
	const write = (name: string, value: unknown): void => {
		const path = join(artifactsDir, name);
		if (existsSync(path)) {
			const previous = join(artifactsDir, "stop_previous", name);
			mkdirSync(join(artifactsDir, "stop_previous"), { recursive: true });
			if (!existsSync(previous)) cpSync(path, previous);
		}
		writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		renameSync(`${path}.tmp`, path);
	};
	write("package_gate.json", {
		schema: "sure.onboard.package_gate.v2",
		status: "blocked",
		package_profile: profile,
		bundle_ready: false,
		readiness: { bundle_ready: false, registry_ready: false, local_ready: false },
		reason,
	});
	write("deployment_ready.json", {
		schema: "sure.onboard.deployment_ready.v1",
		generated_at: new Date().toISOString(),
		status: "blocked",
		model_name: modelName,
		package_profile: profile,
		required_artifact_sha256: {},
		bundle_identity_sha256: "",
		execution_policy: { container_only: false },
	});
	write("extraction_declaration.json", {
		schema: "sure.memory.extraction.v2",
		no_new_lessons: true,
		no_lessons_reason:
			"Harness stop: no new lesson was accepted; extraction is marked failed and nothing will be published.",
		covered_by: [],
		candidates: [],
		infra_noise: false,
		infra_evidence: [],
	});
	const manifestPath = join(ctx.runDir, "stop-manifest.json");
	writeFileSync(
		manifestPath,
		`${JSON.stringify({ schema_version: "sure.manifest.v1", run_id: ctx.run.runId, skill_name: ctx.skill.name, status, created_at: new Date().toISOString(), inputs: { args: ctx.args }, outputs: { deployment_ready: "blocked" }, validation: { completed_units: checkpoint.data.completedUnits, stopped_unit: checkpoint.data.currentUnit, reason }, artifacts: ["package_gate.json", "deployment_ready.json", "extraction_declaration.json"].map((path) => ({ path: join(artifactsDir, path) })) }, null, 2)}\n`,
		"utf8",
	);
	return {
		ok: true,
		finish: { status, manifest_path: manifestPath, summary: reason, error_summary: reason },
		state_patch: {
			checkpoint: {
				...checkpoint,
				data: { ...checkpoint.data, memory: { ...checkpoint.data.memory, extractionStatus: "failed" } },
			},
		},
	};
}
