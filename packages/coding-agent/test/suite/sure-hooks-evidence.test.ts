import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SureCoordinator } from "../../src/core/sure/coordinator.ts";
import { type SureHookExecution, SureHookRunner } from "../../src/core/sure/hooks.ts";
import { discoverSureSkillPackages } from "../../src/core/sure/manifest.ts";
import { SureRunManager } from "../../src/core/sure/run-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

it.each([true, false])(
	"retains each declared hook and preserves short-circuit behavior with coordination=%s",
	async (enabled) => {
		const harness = await createHarness();
		harnesses.push(harness);
		const dir = join(harness.tempDir, ".sure/skills/demo");
		mkdirSync(dir, { recursive: true });
		for (const name of ["SKILL.md", "common.md", "stage.md"]) writeFileSync(join(dir, name), "Fixture contract");
		writeFileSync(
			join(dir, "hooks.ts"),
			`
 import {writeFileSync} from "node:fs";
 import {join} from "node:path";
 const check=(outcome,checker)=>({unitId:"stage",outcome,checker,summary:checker,artifactPaths:[],inputPaths:[]});
 export const first=()=>({ok:true,check:check("passed","first")});
 export const blocked=()=>({ok:true,check:check("blocked","business-blocker")});
 export const crash=()=>{throw new Error("Checker crashed")};
 export const skipped=(ctx)=>{writeFileSync(join(ctx.runDir,"must-not-exist"),"bad");return {ok:true};};
 `,
		);
		writeFileSync(
			join(dir, "sure.skill.json"),
			JSON.stringify({
				name: "demo",
				command: "sure_feed",
				prompt: "SKILL.md",
				coordination: enabled
					? {
							version: 1,
							commonPrompt: "common.md",
							stages: [{ id: "stage", prompt: "stage.md", references: [], snapshotPaths: ["run:artifacts"] }],
						}
					: undefined,
				hooks: {
					post_tool_result: ["first", "blocked", "crash", "skipped"].map((handler) => ({
						module: "hooks.ts",
						handler,
					})),
				},
			}),
		);
		const skill = discoverSureSkillPackages(harness.tempDir).packages[0];
		const run = new SureRunManager(harness.tempDir).createRun(skill, "");
		const coordinator = enabled ? new SureCoordinator(run, "stage", ["run:artifacts"]) : undefined;
		const gate = await new SureHookRunner(skill).run("post_tool_result", {
			run,
			skill: skill.manifest,
			cwd: run.cwd,
			packageDir: dir,
			runDir: run.runDir,
			args: "",
			event: { toolCallId: "work-1" },
		});
		expect(gate.ok).toBe(false);
		expect(gate.check?.failureKind).toBe("checker_exception");
		expect(existsSync(join(run.runDir, "must-not-exist"))).toBe(false);
		const recordsDir = join(run.runDir, "evidence/hooks");
		if (!enabled) {
			expect(existsSync(recordsDir)).toBe(false);
			expect(gate.checks).toBeUndefined();
			expect(gate.statePatchHookId).toBeUndefined();
			return;
		}
		expect(gate.checks?.map((check) => check.checker)).toEqual(["first", "business-blocker", "hooks.ts"]);
		const records = readdirSync(recordsDir)
			.map((name) => JSON.parse(readFileSync(join(recordsDir, name), "utf8")) as SureHookExecution)
			.sort((a, b) => a.index - b.index);
		expect(records.map((record) => record.status)).toEqual(["completed", "completed", "exception", "not_executed"]);
		expect(records[1].result?.check?.outcome).toBe("blocked");
		expect(records[2].result?.message).toContain("Checker crashed");
		expect(new Set(records.map((record) => record.invocationId)).size).toBe(1);
		for (const record of records)
			expect(record).toMatchObject({
				point: "post_tool_result",
				invocationAttempt: 1,
				toolCallId: "work-1",
				inputEvidenceVersion: 0,
				inputSnapshotId: coordinator?.state.initialSnapshot,
			});
	},
);

it.each([
	{ handlers: ["first", "last"], selected: "last", index: 1, ok: true },
	{ handlers: ["first", "rejectPatch", "last"], selected: "rejectPatch", index: 1, ok: false },
	{ handlers: ["first", "reject", "last"], selected: "first", index: 0, ok: false },
	{ handlers: ["reject"], selected: undefined, index: undefined, ok: false },
])("retains the selected patch's source for $handlers", async ({ handlers, selected, index, ok }) => {
	const harness = await createHarness();
	harnesses.push(harness);
	const dir = join(harness.tempDir, ".sure/skills/demo");
	mkdirSync(dir, { recursive: true });
	for (const name of ["SKILL.md", "common.md", "stage.md"]) writeFileSync(join(dir, name), "Fixture contract");
	writeFileSync(
		join(dir, "hooks.ts"),
		`
const patch = name => ({checkpoint:{id:name}});
export const first=()=>({ok:true,state_patch:patch("first")});
export const last=()=>({ok:true,state_patch:patch("last")});
export const rejectPatch=()=>({ok:false,state_patch:patch("rejectPatch")});
export const reject=()=>({ok:false});
`,
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
				stages: [{ id: "stage", prompt: "stage.md", references: [], snapshotPaths: [] }],
			},
			hooks: { post_tool_result: handlers.map((handler) => ({ module: "hooks.ts", handler })) },
		}),
	);
	const skill = discoverSureSkillPackages(harness.tempDir).packages[0];
	const run = new SureRunManager(harness.tempDir).createRun(skill, "");
	const gate = await new SureHookRunner(skill).run("post_tool_result", {
		run,
		skill: skill.manifest,
		cwd: run.cwd,
		packageDir: dir,
		runDir: run.runDir,
		args: "",
	});
	expect(gate.ok).toBe(ok);
	expect(gate.state_patch).toEqual(selected ? { checkpoint: { id: selected } } : undefined);
	if (index === undefined) expect(gate.statePatchHookId).toBeUndefined();
	else {
		const record = JSON.parse(
			readFileSync(join(run.runDir, "evidence/hooks", `${gate.statePatchHookId}.json`), "utf8"),
		);
		expect(record).toMatchObject({ index, handler: selected, result: { state_patch: gate.state_patch } });
	}
	const records = readdirSync(join(run.runDir, "evidence/hooks")).map((name) =>
		JSON.parse(readFileSync(join(run.runDir, "evidence/hooks", name), "utf8")),
	);
	if (!ok && handlers.length > 2) expect(records.find((record) => record.index === 2).status).toBe("not_executed");
});
