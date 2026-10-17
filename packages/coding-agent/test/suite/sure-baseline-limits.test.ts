import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { postToolResult } from "../../../../sure/skills/sure_onboard/hooks/index.ts";
import { SureCoordinator } from "../../src/core/sure/coordinator.ts";
import { discoverSureSkillPackages } from "../../src/core/sure/manifest.ts";
import { SureRunManager } from "../../src/core/sure/run-manager.ts";
import type { SureDisplayState, SureHookContext } from "../../src/core/sure/types.ts";
import { createHarness } from "./harness.ts";

it.each([1, 2, 3, 5])(
	"preserves the original gate's max_retries=%s across handoffs and extra tool work",
	async (max) => {
		const harness = await createHarness();
		try {
			const repository = resolve(import.meta.dirname, "../../../..");
			const skill = discoverSureSkillPackages(repository).packages.find(
				(skill) => skill.manifest.command === "sure_onboard",
			)!;
			const manager = new SureRunManager(harness.tempDir);
			const run = manager.createRun(skill, `model=fixture max_retries=${max}`);
			manager.updateState(run, {
				checkpoint: { resumable: true, data: { currentUnit: "classify", completedUnits: [], retries: {} } },
			});
			const coordinator = new SureCoordinator(run, "classify", ["run:artifacts"]);
			const ctx: SureHookContext = {
				point: "post_tool_result",
				run,
				skill: skill.manifest,
				cwd: run.cwd,
				packageDir: skill.packageDir,
				runDir: run.runDir,
				args: run.args,
				event: { toolName: "write", isError: false },
			};
			for (let attempt = 1; attempt <= max; attempt++) {
				writeFileSync(
					join(run.runDir, "artifacts/classification.json"),
					JSON.stringify({ task_type: `invalid-${attempt}` }),
				);
				const checked = postToolResult(ctx);
				manager.updateState(run, checked.state_patch as SureDisplayState);
				coordinator.observe(
					{ ...checked.check!, sourceId: "fixture:classification", checkId: `classification:${attempt}` },
					["run:artifacts"],
				);
				expect(checked.check?.outcome).toBe(attempt === max ? "exhausted" : "blocked");
				expect(manager.readState(run)?.checkpoint?.data).toMatchObject({
					retries: { classify: attempt },
					completedUnits: [],
				});
				if (attempt === max) break;
				coordinator.requestDiagnosis("The fixture needs a different correction route.");
				if (coordinator.state.status === "yielding") {
					coordinator.beginDiagnosis();
					coordinator.acceptDiagnosis({
						runId: run.runId,
						unitId: "classify",
						evidenceVersion: coordinator.state.evidenceVersion,
						decision: "repair",
						facts: [],
						hypotheses: [],
						unknowns: [],
						evidenceReferences: [`snapshot:${coordinator.state.latestSnapshot}`],
						targetFiles: ["run:artifacts/classification.json"],
						repair: "Correct the classification using the original supported task types.",
						validation: "Original classification gate",
						stopBoundary: "Return for assessment if still blocked",
						nextActions: [],
					});
				}
				for (let action = 0; action < 12; action++) coordinator.recordAction("classify");
				const unchanged = postToolResult({ ...ctx, event: { toolName: "read", isError: false } });
				expect(unchanged.check?.outcome).toBe("unchanged");
				expect((unchanged.state_patch as SureDisplayState).checkpoint?.data).toMatchObject({
					retries: { classify: attempt },
				});
			}
			expect(coordinator.state.status).toBe("executing");
			expect(coordinator.resumeBlocker).toBeUndefined();
			expect(coordinator.state.lastCheck?.outcome).toBe("exhausted");
			expect(coordinator.state.repairs ?? []).toHaveLength(max - 1);
			expect(manager.readRun(run.runId)?.status).toBe("pending");
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	},
);
