import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it } from "vitest";
import { SESSION_OUTCOME_ENTRY } from "../../src/core/session-outcome.ts";
import { SureCoordinator } from "../../src/core/sure/coordinator.ts";
import type { SureFailureReport } from "../../src/core/sure/failure-report.ts";
import { sureExtension } from "../../src/core/sure/index.ts";
import { discoverSureSkillPackages } from "../../src/core/sure/manifest.ts";
import { SureRunManager } from "../../src/core/sure/run-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});
async function setup(mode: "tui" | "print" | "json", reject = false) {
	const harness = await createHarness({ extensionFactories: [sureExtension] });
	harnesses.push(harness);
	const dir = join(harness.tempDir, ".sure/skills/demo");
	mkdirSync(dir, { recursive: true });
	for (const name of ["SKILL.md", "common.md", "stage.md"]) writeFileSync(join(dir, name), "Fixture contract");
	writeFileSync(
		join(dir, "hooks.ts"),
		reject
			? 'export const start=()=>({ok:false,message:"Missing task input",repair:"Provide the required input."});'
			: 'export const start=()=>({ok:true,state_patch:{phase:{id:"stage",status:"running"},checkpoint:{resumable:true,data:{currentUnit:"stage"}}}});',
	);
	writeFileSync(
		join(dir, "sure.skill.json"),
		JSON.stringify({
			name: "demo",
			command: "sure_feed",
			prompt: "SKILL.md",
			coordination: {
				version: 1,
				commonPrompt: "common.md",
				stages: [{ id: "stage", prompt: "stage.md", references: [], snapshotPaths: ["run:artifacts"] }],
			},
			hooks: { pre_start: [{ module: "hooks.ts", handler: "start" }] },
		}),
	);
	await harness.session.bindExtensions({ mode });
	harness.setResponses([fauxAssistantMessage("must not be called")]);
	return { harness, skill: discoverSureSkillPackages(harness.tempDir).packages[0] };
}
it.each(["tui", "print", "json"] as const)(
	"persists and exports the same pre-start failure report in %s without a model",
	async (mode) => {
		const { harness } = await setup(mode, true);
		const output = join(harness.tempDir, "output");
		await harness.session.prompt(`/sure_feed output_dir=${output}`);
		const manager = new SureRunManager(harness.tempDir),
			run = manager.readRun(manager.listRunIds()[0])!;
		expect(run.status).toBe("failed");
		expect(run.errorSummary).toContain("Provide the required input");
		const report = JSON.parse(readFileSync(join(run.runDir, "failure-report.json"), "utf8")) as SureFailureReport;
		expect(report).toMatchObject({ diagnosisStatus: "not_attempted", resumable: false });
		expect(report.facts).toContain(run.errorSummary);
		expect(JSON.parse(readFileSync(join(output, "failure-report.json"), "utf8"))).toEqual(report);
		expect(existsSync(join(output, "failure-report.md"))).toBe(true);
		expect(readdirSync(join(run.runDir, "evidence/hooks"))).toHaveLength(1);
		const entries = harness.sessionManager.getBranch();
		expect(entries.some((entry) => entry.type === "custom" && entry.customType === "sure.failure_report")).toBe(true);
		expect(entries.some((entry) => entry.type === "custom" && entry.customType === SESSION_OUTCOME_ENTRY)).toBe(true);
		expect(harness.getPendingResponseCount()).toBe(1);
	},
);
it("reports a failed coordination restore without overwriting its corrupt evidence or calling a model", async () => {
	const { harness, skill } = await setup("tui");
	const manager = new SureRunManager(harness.tempDir);
	const run = manager.createRun(skill, "");
	manager.setStatus(run, "failed");
	manager.updateState(run, {
		phase: { id: "stage", status: "blocked" },
		checkpoint: { resumable: true, data: { currentUnit: "stage" } },
	});
	new SureCoordinator(run, "stage", ["run:artifacts"]);
	writeFileSync(join(run.runDir, "coordination.json"), "CORRUPT_COORDINATION_RECORD");
	await harness.session.prompt(`/sure_resume ${run.runId}`);
	expect(readFileSync(join(run.runDir, "coordination.json"), "utf8")).toBe("CORRUPT_COORDINATION_RECORD");
	const report = JSON.parse(readFileSync(join(run.runDir, "failure-report.json"), "utf8")) as SureFailureReport;
	expect(report.diagnosisStatus).toBe("not_attempted");
	expect(report.resumable).toBe(false);
	expect(report.stopReason).toContain("failed to resume");
	expect(harness.getPendingResponseCount()).toBe(1);
});

it("uses the same fallback when coordination cannot be installed after the start hook", async () => {
	const { harness, skill } = await setup("tui");
	writeFileSync(
		join(skill.packageDir, "hooks.ts"),
		`import {writeFileSync} from "node:fs";import {join} from "node:path";export const start=ctx=>{writeFileSync(join(ctx.runDir,"coordination.json"),"UNREADABLE_START_STATE");return {ok:true};};`,
	);
	await harness.session.prompt("/sure_feed");
	const manager = new SureRunManager(harness.tempDir),
		run = manager.readRun(manager.listRunIds()[0])!;
	const report = JSON.parse(readFileSync(join(run.runDir, "failure-report.json"), "utf8")) as SureFailureReport;
	expect(run.status).toBe("failed");
	expect(report.stopReason).toContain("failed to start");
	expect(report.diagnosisStatus).toBe("not_attempted");
	expect(harness.getPendingResponseCount()).toBe(1);
});
