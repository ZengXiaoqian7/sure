import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { incompleteDeploymentError, preFinish } from "../../../../sure/skills/sure_onboard/hooks/index.ts";
import { normalizeSureDisplayStatePatch } from "../../src/core/sure/state.ts";
import type { SureHookContext, SureSkillManifest } from "../../src/core/sure/types.ts";

describe("sure_onboard incomplete terminal contract", () => {
	const deployment = { status: "local_only", execution_policy: { container_only: false } };
	const packageGate = {
		status: "passed",
		readiness: { bundle_ready: false, registry_ready: false },
	};

	it("accepts blocked local-container evidence without claiming Eval readiness", () => {
		expect(incompleteDeploymentError(deployment, packageGate, "incomplete")).toBeUndefined();
	});

	it("rejects a blocked finish that claims registry readiness", () => {
		expect(
			incompleteDeploymentError(
				deployment,
				{ ...packageGate, readiness: { bundle_ready: false, registry_ready: true } },
				"incomplete",
			),
		).toContain("registry_ready=false");
	});
});

describe("sure_onboard non-success state patch", () => {
	it("marks the blocked deployment artifact with a status the state validator accepts", () => {
		const source = readFileSync(
			join(import.meta.dirname, "..", "..", "..", "..", "sure", "skills", "sure_onboard", "hooks", "index.ts"),
			"utf-8",
		);
		const artifactStatuses = [...source.matchAll(/type: "deployment_ready",[\s\S]{0,400}?status: "([a-z_]+)"/g)].map(
			(match) => match[1],
		);
		expect(artifactStatuses.length).toBeGreaterThan(0);
		for (const status of artifactStatuses) {
			const result = normalizeSureDisplayStatePatch({
				artifacts: [{ type: "deployment_ready", name: "marker", path: "artifacts/x.json", status }],
			});
			expect(result.ok, `artifact status "${status}" is dropped by the state validator`).toBe(true);
		}
	});

	it("requires caller-provided non-success evidence and preserves the original checkpoint", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sure-stop-contract-"));
		try {
			const runDir = join(cwd, ".sure/runs/stop-test");
			mkdirSync(join(runDir, "artifacts"), { recursive: true });
			const packageDir = join(import.meta.dirname, "../../../../sure/skills/sure_onboard");
			const skill = JSON.parse(readFileSync(join(packageDir, "sure.skill.json"), "utf8")) as SureSkillManifest;
			const ctx: SureHookContext = {
				point: "pre_finish",
				cwd,
				packageDir,
				runDir,
				args: "model_id=owner/model",
				skill,
				run: {
					runId: "stop-test",
					command: "sure_onboard",
					skillName: "sure_onboard",
					status: "running",
					cwd,
					packageDir,
					runDir,
					args: "model_id=owner/model",
					startedAt: "now",
					updatedAt: "now",
				},
				event: { finish: { status: "failed" } },
			};
			writeFileSync(
				join(runDir, "state.json"),
				JSON.stringify({
					checkpoint: {
						resumable: true,
						data: {
							currentUnit: "build_env",
							completedUnits: ["discover", "classify"],
							retries: { build_env: 2 },
							memory: { extractionStatus: "failed" },
						},
					},
				}),
			);
			writeFileSync(join(runDir, "artifacts/package_gate.json"), JSON.stringify({ original: "retained" }));
			const rejected = preFinish(ctx);
			expect(rejected.ok).toBe(false);
			expect(existsSync(join(runDir, "artifacts/deployment_ready.json"))).toBe(false);
			expect(JSON.parse(readFileSync(join(runDir, "artifacts/package_gate.json"), "utf8"))).toEqual({
				original: "retained",
			});
			const supplied = {
				schema: "sure.onboard.deployment_ready.v1",
				generated_at: "now",
				status: "blocked",
				model_name: "unresolved-model",
				package_profile: "docker-registry",
				execution_policy: { container_only: false },
				required_artifact_sha256: {},
				bundle_identity_sha256: "",
			};
			writeFileSync(join(runDir, "artifacts/deployment_ready.json"), JSON.stringify(supplied));
			writeFileSync(
				join(runDir, "artifacts/package_gate.json"),
				JSON.stringify({ status: "blocked", readiness: { bundle_ready: false, registry_ready: false } }),
			);
			const finished = preFinish(ctx);
			expect(finished.ok, finished.repair ?? finished.message).toBe(true);
			expect(JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")).checkpoint.data.retries.build_env).toBe(2);
			expect(JSON.parse(readFileSync(join(runDir, "artifacts/deployment_ready.json"), "utf8")).status).toBe(
				"blocked",
			);
			expect(JSON.parse(readFileSync(join(runDir, "artifacts/deployment_ready.json"), "utf8"))).toEqual(supplied);
			expect(existsSync(join(cwd, "sure/models"))).toBe(false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
