import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SureCoordinator } from "../../src/core/sure/coordinator.ts";
import {
	buildSureFailureReport,
	persistSureFailureReport,
	renderSureFailureReport,
} from "../../src/core/sure/failure-report.ts";
import type { SureDisplayState, SureRunRecord } from "../../src/core/sure/types.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const display: SureDisplayState = {
	phase: { id: "build_env", label: "Build model environment", status: "blocked" },
	checkpoint: { resumable: true },
};
async function setup() {
	const harness = await createHarness();
	harnesses.push(harness);
	const runDir = join(harness.tempDir, ".sure/runs/report-test");
	mkdirSync(runDir, { recursive: true });
	const run: SureRunRecord = {
		runId: "report-test",
		skillName: "demo",
		command: "sure_onboard",
		cwd: harness.tempDir,
		runDir,
		packageDir: harness.tempDir,
		status: "failed",
		args: "model=demo device=cuda",
		startedAt: "now",
		updatedAt: "now",
		errorSummary: "Original CUDA import failed.",
	};
	const coordinator = new SureCoordinator(run, "build_env", []);
	coordinator.observe(
		{
			unitId: "build_env",
			outcome: "blocked",
			failureKind: "semantic",
			summary: run.errorSummary ?? "Original failure",
			artifactPaths: [],
			inputPaths: [],
		},
		[],
	);
	return { harness, run, coordinator };
}
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("Sure final user report", () => {
	it("retains the execution failure across a failed original-condition recheck and unavailable supervisor", async () => {
		const { run, coordinator } = await setup();
		run.errorSummary = undefined;
		for (let index = 0; index < 3; index++) coordinator.recordAction("build_env", "read", { path: "env.json" });
		const restored = new SureCoordinator(run, "build_env", []);
		expect(restored.state.lastCheck?.summary).toBe("Original CUDA import failed.");
		expect(restored.state.status).toBe("executing");
		restored.observe({ ...restored.state.lastCheck!, summary: "Original CUDA import failed." }, []);
		restored.verifyRepair(restored.directRepair!.id, restored.state.evidenceVersion, "recheck");
		expect(restored.state.yieldReason).toContain("Original condition still failed");
		restored.beginDiagnosis();
		restored.state.attempts.at(-1)!.error = "Supervisor provider unavailable.";
		restored.stop("Supervisor provider unavailable.");
		const report = buildSureFailureReport(run, restored, display);
		expect(report.facts).toContain("Original CUDA import failed.");
		expect(report.attempted.join("\n")).toContain("Original condition still failed");
		expect(report.diagnosisStatus).toBe("unavailable");
	});

	it.each(["failed", "incomplete", "cancelled"] as const)(
		"owns recovery actions for a non-resumable %s run",
		async (status) => {
			const { run, coordinator } = await setup();
			coordinator.beginDiagnosis();
			coordinator.state.attempts[0].result = {
				runId: run.runId,
				unitId: "build_env",
				evidenceVersion: coordinator.state.evidenceVersion,
				decision: "stop",
				facts: [],
				hypotheses: [],
				unknowns: [],
				evidenceReferences: ["check:1"],
				stopReason: "Stopped",
				nextActions: ["Run /sure_resume report-test now.", "Resume this run immediately."],
			};
			if (status === "failed") coordinator.observe({ ...coordinator.state.lastCheck!, outcome: "exhausted" }, []);
			const report = buildSureFailureReport({ ...run, status }, coordinator, display);
			expect(report.resumable).toBe(false);
			for (const expanded of [true, false]) {
				const text = renderSureFailureReport(report, expanded);
				expect(text).not.toContain("/sure_resume");
				expect(text).not.toContain("Resume this run immediately");
				expect(text).toContain("before starting a new run");
			}
		},
	);

	it("keeps confirmed execution facts, proposed causes and unknowns separate in persisted output", async () => {
		const { run, coordinator } = await setup();
		coordinator.beginDiagnosis();
		coordinator.state.attempts[0].result = {
			runId: run.runId,
			unitId: "build_env",
			evidenceVersion: coordinator.state.evidenceVersion,
			decision: "stop",
			facts: ["The import failed in the model runtime."],
			hypotheses: ["Driver mismatch is possible."],
			unknowns: ["Driver version was not observed."],
			nextActions: ["Supply the driver version and a compatible runtime."],
			stopReason: "Required runtime is unavailable.",
			evidenceReferences: ["check:1"],
		};
		coordinator.stop("Required runtime is unavailable.");
		const report = buildSureFailureReport(run, coordinator, display);
		expect(report.facts).toContain("Original CUDA import failed.");
		expect(report.facts).not.toContain("Driver mismatch is possible.");
		expect(report.facts).not.toContain("The import failed in the model runtime.");
		expect(report.hypotheses.join("\n")).toContain("not independently verified");
		expect(report.hypotheses).toContain("Driver mismatch is possible.");
		expect(report.diagnosisStatus).toBe("complete");
		expect(report.resumeCommand).toBe("/sure_resume report-test");
		persistSureFailureReport(run, report);
		expect(JSON.parse(readFileSync(join(run.runDir, "failure-report.json"), "utf8"))).toEqual(report);
		expect(readFileSync(join(run.runDir, "failure-report.md"), "utf8")).toContain("Build model environment");
		coordinator.state.evidenceVersion++;
		const stale = buildSureFailureReport(run, coordinator, display);
		expect(stale.diagnosisStatus).toBe("not_attempted");
		expect(stale.hypotheses).not.toContain("Driver mismatch is possible.");
		expect(stale.unknowns.join(" ")).toContain("current evidence version");
		coordinator.state.unitLabel = "Build model environment";
		expect(
			buildSureFailureReport(run, coordinator, {
				...display,
				phase: { id: "finish", label: "Generic terminal phase" },
			}).stageLabel,
		).toBe("Build model environment");
	});

	it("explains an unavailable supervisor without replacing the original task failure or calling a provider", async () => {
		const { harness, run, coordinator } = await setup();
		coordinator.beginDiagnosis();
		coordinator.state.attempts[0].error = "Supervisor provider unavailable.";
		coordinator.stop("Supervisor provider unavailable.");
		harness.setResponses([]);
		const report = buildSureFailureReport(run, coordinator, display);
		expect(report.facts).toContain("Original CUDA import failed.");
		expect(report.diagnosisStatus).toBe("unavailable");
		expect(report.stopReason).toContain("Supervisor provider unavailable");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("does not offer resume for an exhausted, cancelled or incomplete terminal run", async () => {
		const { run, coordinator } = await setup();
		coordinator.observe({ ...coordinator.state.lastCheck!, outcome: "exhausted" }, []);
		expect(buildSureFailureReport(run, coordinator, display).resumeCommand).toBeUndefined();
		coordinator.stop("User cancelled.", true);
		expect(buildSureFailureReport(run, coordinator, display)).toMatchObject({
			outcome: "cancelled",
			resumable: false,
		});
		coordinator.state.cancelled = false;
		coordinator.state.units.build_env.calls = 1;
		expect(buildSureFailureReport({ ...run, status: "incomplete" }, coordinator, display)).toMatchObject({
			outcome: "incomplete",
			resumable: false,
		});
	});

	it("shows the conclusion and next action first while retaining the full detailed report", async () => {
		const { run, coordinator } = await setup();
		coordinator.stop("Required CUDA runtime is unavailable.");
		const report = buildSureFailureReport(run, coordinator, display);
		const collapsed = renderSureFailureReport(report, false);
		expect(collapsed).toContain("Build model environment");
		expect(collapsed).toContain("Original CUDA import failed.");
		expect(collapsed).toContain("Required CUDA runtime is unavailable.");
		expect(collapsed).toContain("Next:");
		expect(collapsed).toContain("failure-report.md");
		expect(collapsed).not.toContain("Confirmed facts:");
		expect(renderSureFailureReport(report)).toContain("Confirmed facts:");
	});
});
