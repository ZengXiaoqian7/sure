import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IsolatedSessionRequest } from "../../src/core/session-controls.ts";
import { surePromptPaths } from "../../src/core/sure/context.ts";
import type { SureCoordinationState, SureDiagnosisResult } from "../../src/core/sure/coordination-types.ts";
import { SureCoordinator } from "../../src/core/sure/coordinator.ts";
import { sureExtension } from "../../src/core/sure/index.ts";
import { discoverSureSkillPackages } from "../../src/core/sure/manifest.ts";
import { SureRunManager } from "../../src/core/sure/run-manager.ts";
import { syncSureUserContext } from "../../src/core/sure/user-context.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";
import {
	continueExecution,
	fixtureTranscript,
	pauseDiagnosis,
	repairHandoff,
	submitControlFixture,
} from "./sure-control-fixtures.ts";

const harnesses: Harness[] = [];
function runDir(harness: Harness): string {
	return join(harness.tempDir, ".sure/runs", readdirSync(join(harness.tempDir, ".sure/runs"))[0]);
}
function json(path: string, value: unknown): void {
	writeFileSync(path, JSON.stringify(value));
}
function state(harness: Harness): SureCoordinationState {
	return JSON.parse(readFileSync(join(runDir(harness), "coordination.json"), "utf8"));
}
function result(harness: Harness): SureDiagnosisResult {
	const current = state(harness);
	return {
		runId: current.runId,
		unitId: current.unitId,
		evidenceVersion: current.evidenceVersion,
		decision: "repair",
		facts: [
			current.lastCheck?.outcome === "pending"
				? "The business gate is pending; the tool error is separate."
				: "The original unit gate failed.",
		],
		hypotheses: [],
		unknowns: [],
		repair: "Repair the current artifact and rerun its original gate.",
		evidenceReferences: [`snapshot:${current.latestSnapshot}`],
		targetFiles: [],
		validation: "Rerun the original current.json gate.",
		stopBoundary: "Return to diagnosis if the original gate still fails.",
		nextActions: ["Inspect the retained evidence."],
	};
}

async function setup(
	options: {
		mode?: "tui" | "print" | "json";
		onWorkStarted?: (value: string) => void;
		omitCheck?: boolean;
		multipleChecks?: boolean;
		complexSubcheck?: "first" | "last";
		factoryError?: boolean;
		decision?: "repair" | "pause" | "continue";
		parallel?: boolean;
		longReads?: boolean;
		longErrors?: boolean;
		priorStages?: boolean;
		twoStages?: boolean;
		delayGate?: boolean;
		delayFinish?: boolean;
		preflightReject?: boolean;
		duringDiagnosis?: (harness: Harness) => void | Promise<void>;
		onTimeline?: (timeline: string) => void;
		onDiagnosisPrompt?: (prompt: string) => void;
	} = {},
) {
	let harness: Harness;
	let diagnoses = 0;
	const diagnosisSessions: string[] = [];
	const executed: string[] = [];
	const completed: string[] = [];
	const workParams = Type.Object({ value: Type.String() });
	const work: AgentTool<typeof workParams> = {
		name: "work",
		label: "Work",
		description: "Fixture task work",
		parameters: workParams,
		executionMode: options.parallel ? "parallel" : "sequential",
		execute: async (_id, params) => {
			const value = String(params.value);
			executed.push(value);
			options.onWorkStarted?.(value);
			if (value.startsWith("tool-error")) {
				if (value.endsWith("-late")) await new Promise((resolve) => setTimeout(resolve, 30));
				completed.push(value);
				throw new Error(
					`Execution failed: ${value}${options.longErrors ? `${"diagnostic detail ".repeat(400)}UNRESOLVED_TAIL` : ""}`,
				);
			}
			if (value.startsWith("inspect-slow")) await new Promise((resolve) => setTimeout(resolve, 30));
			if (value === "slow") {
				await new Promise((resolve) => setTimeout(resolve, 30));
				writeFileSync(
					join(runDir(harness), "artifacts/script-side-effect.py"),
					"print('script edit after failure')\n",
				);
			} else if (!value.startsWith("inspect")) {
				json(join(runDir(harness), "artifacts/current.json"), { value });
				const run = JSON.parse(readFileSync(join(runDir(harness), "run.json"), "utf8"));
				json(join(runDir(harness), "manifest.json"), {
					schema_version: "1",
					run_id: run.runId,
					skill_name: "demo",
					status: "success",
					created_at: new Date().toISOString(),
					inputs: {},
					outputs: {},
					validation: {},
				});
			}
			completed.push(value);
			return {
				content: [
					{
						type: "text",
						text: `Original output ${value}${options.longReads ? "\nLarge dependency evidence".repeat(2000) : ""}`,
					},
				],
				details: {},
			};
		},
	};
	harness = await createHarness({
		tools: [work],
		extensionFactories: [sureExtension],
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		isolatedSessionFactory: async (request: IsolatedSessionRequest) => {
			diagnoses++;
			if (options.factoryError) throw new Error("Supervisor provider unavailable.");
			expect(completed).toEqual(executed);
			expect(request.tools.map((tool) => tool.name)).toEqual([
				"sure_diagnostic_read",
				"sure_handoff_repair",
				"sure_pause_diagnosis",
				"sure_continue_execution",
			]);
			const transcript = fixtureTranscript(request, harness.tempDir);
			diagnosisSessions.push(transcript.manager.getSessionId());
			return {
				getSessionIdentity: transcript.getSessionIdentity,
				prompt: async (prompt) => {
					transcript.manager.appendMessage({ role: "user", content: prompt, timestamp: Date.now() });
					options.onDiagnosisPrompt?.(`${request.systemPrompt}\n${prompt}`);
					const timeline = await request.tools[0].execute(
						"macro",
						{ operation: "timeline" },
						undefined,
						undefined,
						harness.session.extensionRunner.createContext(),
					);
					options.onTimeline?.(JSON.stringify(timeline));
					const page = JSON.parse(timeline.content.find((block) => block.type === "text")?.text ?? "{}");
					const data = JSON.parse(page.text);
					if (data.task?.userContext?.characters)
						await request.tools[0].execute(
							"constraints",
							{ operation: "user_context", offset: 0 },
							undefined,
							undefined,
							harness.session.extensionRunner.createContext(),
						);
					request.onTurn();
					await options.duringDiagnosis?.(harness);
					await submitControlFixture(
						request,
						transcript.manager,
						harness.session.extensionRunner.createContext(),
						options.decision === "pause"
							? pauseDiagnosis("More diagnostic evidence is needed; retain the current checkpoint.")
							: options.decision === "continue"
								? continueExecution("The existing route remains viable.")
								: repairHandoff("Repair the current artifact and rerun its original gate.", undefined),
					);
				},
				abort: async () => {},
				dispose: () => {},
				getMessages: () => transcript.manager.buildSessionContext().messages,
			};
		},
	});
	harnesses.push(harness);
	const skillDir = join(harness.tempDir, ".sure/skills/demo");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), "FULL_MANUAL_MUST_NOT_BE_INJECTED");
	writeFileSync(join(skillDir, "common.md"), "Keep original task constraints.");
	writeFileSync(join(skillDir, "stage.md"), "Produce current.json with value=good.");
	writeFileSync(
		join(skillDir, "next.md"),
		"NEXT_COMPLETE_CONTRACT: preserve the selected device and finish with the original manifest.",
	);
	writeFileSync(
		join(skillDir, "hooks.ts"),
		`
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export function resolved(ctx) { writeFileSync(join(ctx.runDir,"artifacts/request.json"),"{}"); return {ok:true,check:{unitId:"resolve",outcome:"passed",summary:"Fixture request resolved",inputPaths:[],artifactPaths:["run:artifacts/request.json"]}}; }
export function selected(ctx) { writeFileSync(join(ctx.runDir,"artifacts/context.json"),"{}"); return {ok:true,check:{unitId:"context",outcome:"passed",summary:"Fixture context selected",inputPaths:[],artifactPaths:["run:artifacts/context.json"]}}; }
export function preStart() { return { ok:true, state_patch:{ phase:{id:"stage",status:"running"}, checkpoint:{resumable:true,data:{currentUnit:"stage",completedUnits:[]}} } }; }
export function preflight(ctx) { return ctx.event.input.value?.startsWith("reject") ? {ok:false,repair:"Correct the rejected value."} : {ok:true}; }
export async function postToolResult(ctx) {
 ${options.delayGate ? 'writeFileSync(join(ctx.runDir,"gate-started"),"started"); await new Promise(resolve=>setTimeout(resolve,50));' : ""}
 if(ctx.event.isError) return {ok:true,check:{unitId:"stage",outcome:"blocked",failureKind:"tool",summary:"Execution tool failed",repair:"Inspect and correct the call.",artifactPaths:["run:artifacts/current.json"],inputPaths:[]}};
 const file=join(ctx.runDir,"artifacts/current.json");
 const value=existsSync(file)?JSON.parse(readFileSync(file,"utf8")).value:"pending";
 const check={unitId:"stage",outcome:value==="good"?"passed":value==="pending"?"pending":"blocked",failureKind:value==="format"?"format":"semantic",summary:"Gate saw "+value,artifactPaths:["run:artifacts/current.json"],inputPaths:[]};
 return { ok:value!=="format",repair:value==="format"?"Fix the required field.":undefined,check:${options.omitCheck ? "undefined" : "check"},state_patch:{phase:{id:"stage",status:value==="good"?"running":"blocked"},checkpoint:{resumable:value!=="good",data:{currentUnit:${options.twoStages ? 'value==="good"?"next":"stage"' : '"stage"'},completedUnits:value==="good"?["stage"]:[]}}} };
}
export async function preFinish(ctx) {
 ${options.delayFinish ? 'writeFileSync(join(ctx.runDir,"finish-gate-started"),"started"); await new Promise(resolve=>setTimeout(resolve,50));' : ""}
 const status=ctx.event.finish.status;
 const path=join(ctx.runDir,"artifacts",status==="success"?"current.json":"stopped.json");
 const valid=existsSync(path)&&JSON.parse(readFileSync(path,"utf8")).value===(status==="success"?"good":"blocked");
 return {ok:valid,repair:valid?undefined:"Terminal evidence is invalid."};
}
export function passingSubcheck() {
 return {ok:true,check:{unitId:"stage",outcome:"passed",summary:"Independent subcheck passed",artifactPaths:[],inputPaths:[]}};
}
export function complexSubcheck() {
 return {ok:true,check:{unitId:"stage",outcome:"blocked",failureKind:"semantic",summary:"Independent semantic blocker",artifactPaths:[],inputPaths:[]}};
}

`,
	);
	json(join(skillDir, "sure.skill.json"), {
		name: "demo",
		command: "sure_feed",
		prompt: "SKILL.md",
		coordination: {
			version: 1,
			commonPrompt: "common.md",
			stages: [
				...(options.priorStages ? ["resolve", "context"] : []),
				"stage",
				...(options.twoStages ? ["next"] : []),
			].map((id) => ({
				id,
				prompt: id === "next" ? "next.md" : "stage.md",
				references: [],
				snapshotPaths: ["run:artifacts"],
			})),
		},
		hooks: {
			...(options.preflightReject ? { pre_tool_call: [{ module: "hooks.ts", handler: "preflight" }] } : {}),
			pre_start: [...(options.priorStages ? ["resolved", "selected"] : []), "preStart"].map((handler) => ({
				module: "hooks.ts",
				handler,
			})),
			post_tool_result: [
				...(options.complexSubcheck === "first" ? ["complexSubcheck"] : []),
				"postToolResult",
				...(options.multipleChecks ? ["passingSubcheck"] : []),
				...(options.complexSubcheck === "last" ? ["complexSubcheck"] : []),
			].map((handler) => ({ module: "hooks.ts", handler })),
			pre_finish: [{ module: "hooks.ts", handler: "preFinish" }],
		},
	});
	await harness.session.bindExtensions({
		mode: options.mode ?? "tui",
		onError: (error) => {
			throw new Error(error.error);
		},
	});
	const finish = () =>
		fauxAssistantMessage(
			[
				fauxToolCall("sure_finish", {
					status: "success",
					manifest_path: join(runDir(harness), "manifest.json"),
					summary: "Validated task",
				}),
			],
			{ stopReason: "toolUse" },
		);
	return {
		harness,
		executed,
		completed,
		diagnosisSessions,
		get diagnoses() {
			return diagnoses;
		},
		finish,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function seedInterruptedRun(harness: Harness, failureKind: "semantic" | "tool" = "semantic"): SureCoordinator {
	const manager = new SureRunManager(harness.tempDir);
	const skill = discoverSureSkillPackages(harness.tempDir).packages[0];
	const run = manager.createRun(skill, "model=demo device=cuda");
	manager.setStatus(run, "running");
	manager.updateState(run, {
		phase: { id: "stage", status: "blocked" },
		checkpoint: { resumable: true, data: { currentUnit: "stage", completedUnits: [] } },
	});
	json(join(run.runDir, "artifacts/current.json"), { value: "bad" });
	const coordinator = new SureCoordinator(run, "stage", ["run:artifacts", ...surePromptPaths(skill, "stage")]);
	coordinator.observe(
		{
			unitId: "stage",
			outcome: "blocked",
			failureKind,
			summary: "Gate saw bad",
			inputPaths: [],
			artifactPaths: ["run:artifacts/current.json"],
		},
		["run:artifacts", ...surePromptPaths(skill, "stage")],
	);
	coordinator.requestDiagnosis("Interrupted fixture needs investigation.");
	return coordinator;
}

describe("Sure executor/supervisor handoff", () => {
	it("automatically diagnoses a failed correction without an executor help signal", async () => {
		const fixture = await setup();
		fixture.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("work", { value: "tool-error" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("work", { value: "tool-error-again" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("work", { value: "good" })], { stopReason: "toolUse" }),
			() => fixture.finish(),
		]);
		await fixture.harness.session.prompt("/sure_feed model=demo");
		expect(fixture.diagnoses).toBe(1);
		expect(fixture.executed).toEqual(["tool-error", "tool-error-again", "good"]);
		expect(state(fixture.harness).repairs).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(runDir(fixture.harness), "run.json"), "utf8")).status).toBe("success");
	});

	it("returns a continue decision to the executor without creating a repair", async () => {
		const fixture = await setup({ decision: "continue" });
		let executorContext = "";
		fixture.harness.setResponses([
			...Array.from({ length: 2 }, () =>
				fauxAssistantMessage([fauxToolCall("work", { value: "bad" })], { stopReason: "toolUse" }),
			),
			(context) => {
				executorContext = context.messages.map(getMessageText).join("\n");
				return fauxAssistantMessage([fauxToolCall("work", { value: "good" })], { stopReason: "toolUse" });
			},
			() => fixture.finish(),
		]);
		await fixture.harness.session.prompt("/sure_feed model=demo");
		expect(fixture.diagnoses).toBe(1);
		expect(executorContext).toContain("The existing route remains viable.");
		expect(executorContext).toContain("without returning for supervisor approval");
		expect(state(fixture.harness).repairs ?? []).toHaveLength(0);
		expect(state(fixture.harness).attempts[0].result).toMatchObject({ decision: "continue" });
		expect(fixture.executed).toEqual(["bad", "bad", "good"]);
	});

	it.each(["arguments", "preflight", "control"] as const)(
		"automatically investigates continued %s rejection after feedback, without double-counting one batch",
		async (rejection) => {
			const fixture = await setup({ preflightReject: rejection === "preflight" });
			const rejected = () =>
				rejection === "control"
					? fauxToolCall("sure_update_state", { phase: { status: "success" } })
					: fauxToolCall("work", rejection === "arguments" ? { missing: true } : { value: "reject-this" });
			let firstBatchDiagnoses = -1;
			fixture.harness.setResponses([
				fauxAssistantMessage([rejected(), rejected()], { stopReason: "toolUse" }),
				() => {
					firstBatchDiagnoses = fixture.diagnoses;
					return fauxAssistantMessage([rejected()], { stopReason: "toolUse" });
				},
				fauxAssistantMessage([fauxToolCall("work", { value: "good" })], { stopReason: "toolUse" }),
				() => fixture.finish(),
			]);
			await fixture.harness.session.prompt("/sure_feed model=demo");
			expect(firstBatchDiagnoses).toBe(0);
			expect(fixture.diagnoses).toBe(1);
			expect(fixture.executed).toEqual(["good"]);
			expect(state(fixture.harness).repairs).toHaveLength(1);
			const actions = readdirSync(join(runDir(fixture.harness), "evidence/tools")).map((name) =>
				JSON.parse(readFileSync(join(runDir(fixture.harness), "evidence/tools", name), "utf8")),
			);
			const failures = actions.filter((action) => action.isError);
			expect(failures).toHaveLength(3);
			expect(
				failures.every((action) => action.execution === (rejection === "control" ? "returned" : "skipped")),
			).toBe(true);
			if (rejection !== "control") expect(failures.every((action) => action.rejection === rejection)).toBe(true);
		},
	);

	it("leaves a corrected first argument rejection with the executor", async () => {
		const fixture = await setup();
		fixture.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("work", { missing: true })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("work", { value: "good" })], { stopReason: "toolUse" }),
			() => fixture.finish(),
		]);
		await fixture.harness.session.prompt("/sure_feed model=demo");
		expect(fixture.diagnoses).toBe(0);
		expect(fixture.executed).toEqual(["good"]);
		expect(state(fixture.harness).unresolvedCheckVersion).toBeUndefined();
	});

	it("investigates a new rejected attempt after continue without replaying reviewed evidence", async () => {
		const fixture = await setup({ decision: "continue" });
		fixture.harness.setResponses([
			...Array.from({ length: 3 }, () =>
				fauxAssistantMessage([fauxToolCall("work", { missing: true })], { stopReason: "toolUse" }),
			),
			fauxAssistantMessage([fauxToolCall("work", { value: "good" })], { stopReason: "toolUse" }),
			() => fixture.finish(),
		]);
		await fixture.harness.session.prompt("/sure_feed model=demo");
		expect(fixture.diagnoses).toBe(2);
		expect(new Set(fixture.diagnosisSessions).size).toBe(1);
		expect(state(fixture.harness).repairs).toHaveLength(0);
	});

	it.each(["arguments", "preflight"] as const)(
		"does not let an unrelated supporting success clear a %s rejection",
		async (rejection) => {
			const fixture = await setup({ decision: "pause", preflightReject: rejection === "preflight" });
			fixture.harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("work", rejection === "arguments" ? { missing: true } : { value: "reject" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage([fauxToolCall("work", { value: "inspect" })], { stopReason: "toolUse" }),
				fauxAssistantMessage(
					[fauxToolCall("work", { value: rejection === "arguments" ? "tool-error-new" : "reject" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Inspect the new failure before correcting it."),
			]);
			await fixture.harness.session.prompt("/sure_feed model=demo");
			expect(fixture.diagnoses).toBe(1);
			expect(fixture.executed).toEqual(rejection === "arguments" ? ["inspect", "tool-error-new"] : ["inspect"]);
			expect(state(fixture.harness).lastFailure?.summary).toContain(
				rejection === "arguments" ? "tool-error-new" : "Correct the rejected value",
			);
		},
	);

	it("does not treat removed help or evidence controls as valid state updates", async () => {
		const fixture = await setup();
		fixture.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("sure_update_state", { request_diagnosis: true })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Wait after the original refusal."),
		]);
		await fixture.harness.session.prompt("/sure_feed model=demo");
		expect(fixture.diagnoses).toBe(0);
		expect(
			fixture.harness.session.messages
				.filter((message) => message.role === "toolResult")
				.map(getMessageText)
				.join("\n"),
		).toContain("not supported");
	});

	it("appends one stage change after complete tool batches and keeps unchanged request prefixes", async () => {
		const fixture = await setup({ twoStages: true });
		const requests: unknown[][] = [];
		const capture = (context: { messages: unknown[] }) => requests.push(JSON.parse(JSON.stringify(context.messages)));
		fixture.harness.setResponses([
			(context) => {
				capture(context);
				return fauxAssistantMessage([fauxToolCall("work", { value: "inspect-one" })], { stopReason: "toolUse" });
			},
			(context) => {
				capture(context);
				return fauxAssistantMessage([fauxToolCall("work", { value: "inspect-two" })], { stopReason: "toolUse" });
			},
			(context) => {
				capture(context);
				return fauxAssistantMessage(
					[
						fauxToolCall("work", { value: "good" }, { id: "change-a" }),
						fauxToolCall("work", { value: "inspect" }, { id: "change-b" }),
					],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				capture(context);
				return fixture.finish();
			},
		]);
		await fixture.harness.session.prompt("/sure_feed model=demo device=cpu");
		expect(requests).toHaveLength(4);
		for (let i = 1; i < requests.length; i++)
			expect(requests[i].slice(0, requests[i - 1].length)).toEqual(requests[i - 1]);
		const final = requests[3] as Array<{ role: string; content: unknown; toolCallId?: string }>;
		expect(JSON.stringify(final).match(/NEXT_COMPLETE_CONTRACT/g)).toHaveLength(1);
		expect(JSON.stringify(final).match(/Keep original task constraints/g)).toHaveLength(1);
		const stageIndex = final.findIndex((message) =>
			JSON.stringify(message.content).includes("NEXT_COMPLETE_CONTRACT"),
		);
		for (const id of ["change-a", "change-b"])
			expect(final.findIndex((message) => message.toolCallId === id)).toBeLessThan(stageIndex);
		expect(fixture.harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(fixture.diagnoses).toBe(0);
	});

	it("restores complete contracts, user constraints and the same passed supervisor body after compaction and reload", async () => {
		const fixture = await setup();
		const coordinator = seedInterruptedRun(fixture.harness);
		syncSureUserContext(coordinator, [{ role: "user", content: "CONSTRAINT_KEEP_CPU", timestamp: 1 }]);
		coordinator.acceptDiagnosis(result(fixture.harness));
		const id = coordinator.state.pendingRepair!.id;
		coordinator.state.pendingRepair!.delivered = true;
		fixture.harness.sessionManager.appendMessage({
			role: "user",
			content: `<sure_supervisor_repair id="${id}" run_id="${coordinator.run.runId}">Repair the current artifact and rerun its original gate.</sure_supervisor_repair>`,
			timestamp: 2,
		});
		coordinator.observe(
			{ unitId: "stage", outcome: "passed", summary: "Original gate passed", inputPaths: [], artifactPaths: [] },
			["run:artifacts"],
		);
		expect(coordinator.state.pendingRepair).toBeUndefined();
		fixture.harness.setResponses([fauxAssistantMessage("Await finish with existing evidence.")]);
		await fixture.harness.session.prompt(`/sure_resume ${coordinator.run.runId}`);
		fixture.harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1, reserveTokens: 1000 } });
		fixture.harness.setResponses(
			Array.from({ length: 2 }, () => fauxAssistantMessage("Summary deliberately omits exact task and rules.")),
		);
		await fixture.harness.session.compact();
		const check = (context: { messages: unknown[] }) => {
			const view = JSON.stringify(context.messages);
			for (const text of [
				"CONSTRAINT_KEEP_CPU",
				"Produce current.json with value=good.",
				"Keep original task constraints.",
				id,
				"Repair the current artifact and rerun its original gate.",
				"not a new assignment",
			])
				expect(view).toContain(text);
			expect(view.match(/Repair the current artifact and rerun its original gate\./g)).toHaveLength(1);
			return fauxAssistantMessage("Continue using the same accepted goal.");
		};
		fixture.harness.setResponses([check]);
		await fixture.harness.session.prompt("Continue after compaction");
		await fixture.harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
		fixture.harness.setResponses([check]);
		await fixture.harness.session.prompt(`/sure_resume ${coordinator.run.runId}`);
		expect(state(fixture.harness).repairs?.length ?? 0).toBe(1);
		expect(state(fixture.harness).repairs!.filter((repair) => repair.id === id)).toHaveLength(1);
		expect(fixture.diagnoses).toBe(0);
	});

	it("trims obsolete bulk at compaction and then preserves the new prefix", async () => {
		const fixture = await setup({ twoStages: true, longReads: true });
		fixture.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("work", { value: "inspect-earlier" }, { id: "old-bulk" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("work", { value: "good" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Ready to finish after reviewing the next contract."),
		]);
		await fixture.harness.session.prompt("/sure_feed device=cpu");
		fixture.harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 500, reserveTokens: 1000 } });
		fixture.harness.setResponses(
			Array.from({ length: 2 }, () => fauxAssistantMessage("Retain selected CPU and finish goal.")),
		);
		await fixture.harness.session.compact();
		const requests: unknown[][] = [];
		fixture.harness.setResponses(
			Array.from({ length: 2 }, () => (context) => {
				requests.push(JSON.parse(JSON.stringify(context.messages)));
				expect(JSON.stringify(context.messages)).toContain("NEXT_COMPLETE_CONTRACT");
				expect(JSON.stringify(context.messages)).not.toContain("Large dependency evidence".repeat(100));
				return fauxAssistantMessage("Still applying the same goal.");
			}),
		);
		await fixture.harness.session.prompt("Continue");
		await fixture.harness.session.prompt("Continue again");
		expect(requests[1].slice(0, requests[0].length)).toEqual(requests[0]);
		expect(JSON.stringify(fixture.harness.sessionManager.getBranch())).toContain("Large dependency evidence");
		const trim = fixture.harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "sure.context.trim");
		expect(trim).toHaveLength(1);
		expect(JSON.stringify(trim)).toContain("old-bulk");
	});

	it("restores concrete continue guidance after lossy compaction and reload without a new investigation", async () => {
		const fixture = await setup({ decision: "continue" });
		fixture.harness.setResponses([
			...Array.from({ length: 2 }, () =>
				fauxAssistantMessage([fauxToolCall("work", { value: "bad" })], { stopReason: "toolUse" }),
			),
			fauxAssistantMessage("Await further work on the existing route."),
		]);
		await fixture.harness.session.prompt("/sure_feed model=demo");
		const runId = state(fixture.harness).runId;
		fixture.harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1, reserveTokens: 1000 } });
		fixture.harness.setResponses(
			Array.from({ length: 2 }, () => fauxAssistantMessage("Summary omits the supervisor guidance.")),
		);
		await fixture.harness.session.compact();
		await fixture.harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
		let effective = "";
		fixture.harness.setResponses([
			(context) => {
				effective = context.messages.map(getMessageText).join("\n");
				return fauxAssistantMessage("Continue the existing route.");
			},
		]);
		await fixture.harness.session.prompt(`/sure_resume ${runId}`);
		expect(effective).toContain("The existing route remains viable.");
		expect(effective).toContain("Retained guidance from the same investigation");
		expect(fixture.diagnoses).toBe(1);
		expect(state(fixture.harness).repairs).toHaveLength(0);
	});

	it("keeps full unresolved feedback and its source after a lossy native summary", async () => {
		const fixture = await setup({ longErrors: true });
		fixture.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("work", { value: "tool-error" }, { id: "unresolved" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Investigate before original-condition verification."),
		]);
		await fixture.harness.session.prompt("/sure_feed device=cpu");
		fixture.harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1, reserveTokens: 1000 } });
		fixture.harness.setResponses(
			Array.from({ length: 2 }, () => fauxAssistantMessage("Lossy summary of an earlier error.")),
		);
		await fixture.harness.session.compact();
		fixture.harness.setResponses([
			(context) => {
				const view = context.messages.map(getMessageText).join("\n");
				expect(view).toContain("UNRESOLVED_TAIL");
				expect(view).toContain("Retained original-condition evidence");
				expect(view).toContain("run:evidence/tools/");
				expect(view).toContain("unresolved");
				const calls = context.messages.flatMap((message) =>
					message.role === "assistant"
						? message.content.filter((block) => block.type === "toolCall").map((block) => block.id)
						: [],
				);
				for (const message of context.messages)
					if (message.role === "toolResult") expect(calls).toContain(message.toolCallId);
				return fauxAssistantMessage("Use retained feedback to verify the original condition.");
			},
		]);
		await fixture.harness.session.sendUserMessage(
			"<sure_invocation>Continue after native compaction.</sure_invocation>",
		);
		expect(fixture.diagnoses).toBe(0);
		expect(state(fixture.harness).repairs ?? []).toHaveLength(0);
	});

	it("continues the executor's drafted next step through pending research without a stall handoff", async () => {
		let fixture: Awaited<ReturnType<typeof setup>>;
		fixture = await setup({
			onWorkStarted: (value) => {
				if (value === "inspect-draft")
					json(join(runDir(fixture.harness), "artifacts/draft.json"), { ready_to_seal: true });
			},
			onTimeline: (response) => {
				const macro = JSON.parse(JSON.parse(JSON.parse(response).content[0].text).text);
				expect(macro.currentStage.gateOutcome).toBe("pending");
				expect(macro.executorProgress).toContain("next seal it with the original helper");
				expect(macro.priorUnitActions[0].input).toContain("inspect-prior-source");
			},
		});
		fixture.harness.setResponses([
			...["inspect-prior-source", "tool-error", "inspect-policy", "inspect-helper"].map((value) =>
				fauxAssistantMessage([fauxToolCall("work", { value })], { stopReason: "toolUse" }),
			),
			fauxAssistantMessage(
				[
					{
						type: "text",
						text: "The guessed lookup failed; draft is ready, next seal it with the original helper.",
					},
					fauxToolCall("work", { value: "inspect-draft" }),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				const view = context.messages.map(getMessageText).join("\n");
				expect(view).toContain("Keep original task constraints.");
				expect(view).toContain("Produce current.json with value=good.");
				return fauxAssistantMessage([fauxToolCall("work", { value: "good" })], { stopReason: "toolUse" });
			},
			() => fixture.finish(),
		]);
		await fixture.harness.session.prompt("/sure_feed model=demo");
		expect(fixture.diagnoses).toBe(0);
		expect(state(fixture.harness).lastCheck?.outcome).toBe("passed");
		expect(state(fixture.harness).repairs ?? []).toHaveLength(0);
		expect(JSON.parse(readFileSync(join(runDir(fixture.harness), "run.json"), "utf8")).status).toBe("success");
	});

	it("completes after four reviewed repairs while the original fixture gate still permits work", async () => {
		const fixture = await setup();
		fixture.harness.setResponses([
			...["bad-a", "bad-b", "bad-c", "bad-d", "bad-e"].map((value) =>
				fauxAssistantMessage([fauxToolCall("work", { value })], { stopReason: "toolUse" }),
			),
			fauxAssistantMessage([fauxToolCall("work", { value: "good" })], { stopReason: "toolUse" }),
			() => fixture.finish(),
		]);
		await fixture.harness.session.prompt("/sure_feed model=demo");
		expect(fixture.diagnoses).toBe(4);
		expect(state(fixture.harness).repairs?.length ?? 0).toBe(4);
		expect(state(fixture.harness).lastCheck?.outcome).toBe("passed");
		expect(JSON.parse(readFileSync(join(runDir(fixture.harness), "run.json"), "utf8")).status).toBe("success");
	});

	it("hands the authored objective and verified prior outputs to diagnosis, then validates the sole repair", async () => {
		const fixture = await setup({
			priorStages: true,
			onDiagnosisPrompt: (prompt) => {
				expect(prompt).toContain("Produce current.json with value=good.");
				expect(prompt).toContain("FULL_MANUAL_MUST_NOT_BE_INJECTED");
			},
			onTimeline: (response) => {
				const page = JSON.parse(JSON.parse(response).content[0].text);
				const macro = JSON.parse(page.text);
				expect(macro.currentStage).toMatchObject({
					unitId: "stage",
					prompt: "package:stage.md",
					artifactPaths: ["run:artifacts/current.json"],
				});
				expect(macro.stages[0].lastPassed.artifactPaths).toEqual(["run:artifacts/request.json"]);
				expect(macro.stages[1].lastPassed.artifactPaths).toEqual(["run:artifacts/context.json"]);
				expect(macro.stages[2].lastPassed).toBeUndefined();
			},
		});
		fixture.harness.setResponses([
			(context) => {
				const view = context.messages.map(getMessageText).join("\n");
				expect(view).toContain('"projectRoot":');
				expect(view).toContain(`"runDir":${JSON.stringify(runDir(fixture.harness))}`);
				expect(view).not.toContain('"passedArtifacts":');
				expect(view).not.toContain('"repairs":{"resolve":');
				return fauxAssistantMessage([fauxToolCall("work", { value: "tool-error" })], { stopReason: "toolUse" });
			},
			fauxAssistantMessage([fauxToolCall("work", { value: "tool-error" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("work", { value: "good" })], { stopReason: "toolUse" }),
			() => fixture.finish(),
		]);
		await fixture.harness.session.prompt("/sure_feed model=demo");
		expect(fixture.diagnoses).toBe(1);
		const current = state(fixture.harness);
		const repair = current.repairs!.find((repair) => repair.source === "supervisor")!;
		expect(repair.gateOutcome).toBe("passed");
		expect(repair).not.toHaveProperty("outcome");
		expect(repair.checkVersions).toHaveLength(1);
		expect(
			JSON.parse(readFileSync(join(runDir(fixture.harness), `evidence/${repair.checkVersions[0]}.json`), "utf8")),
		).toMatchObject({ repairId: repair.id, check: { outcome: "passed", unitId: "stage" } });
		expect(current.pendingRepair).toBeUndefined();
	});
	it("resumes an unfinished direct repair with the spent allowance and no extra diagnosis", async () => {
		const fixture = await setup();
		const coordinator = seedInterruptedRun(fixture.harness, "tool");
		coordinator.state.status = "executing";
		coordinator.save();
		fixture.harness.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("Keep original task constraints.");
				return fauxAssistantMessage([fauxToolCall("work", { value: "good" })], { stopReason: "toolUse" });
			},
			() => fixture.finish(),
		]);
		await fixture.harness.session.prompt(`/sure_resume ${coordinator.run.runId}`);
		expect(fixture.diagnoses).toBe(0);
		expect(state(fixture.harness).repairs ?? []).toHaveLength(0);
		expect(state(fixture.harness)).not.toHaveProperty("pendingDirectRepairId");
	});
	it.each(["first", "last"] as const)(
		"retains first-error correction for each independent subcheck in %s position",
		async (position) => {
			const fixture = await setup({ complexSubcheck: position, decision: "pause" });
			fixture.harness.setResponses([
				fauxAssistantMessage([fauxToolCall("work", { value: "tool-error" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("Awaiting original-condition verification."),
			]);
			await fixture.harness.session.prompt("/sure_feed model=demo");
			expect(fixture.diagnoses).toBe(0);
			expect(state(fixture.harness).repairs ?? []).toHaveLength(0);
			expect(state(fixture.harness).attempts).toHaveLength(0);
		},
	);
	it("lets the executor inspect and recover one ordinary tool error without diagnosis", async () => {
		const fixture = await setup();
		fixture.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("work", { value: "tool-error" })], { stopReason: "toolUse" }),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("Keep original task constraints.");
				return fauxAssistantMessage([fauxToolCall("work", { value: "inspect" })], { stopReason: "toolUse" });
			},
			fauxAssistantMessage([fauxToolCall("work", { value: "good" })], { stopReason: "toolUse" }),
			() => fixture.finish(),
		]);
		await fixture.harness.session.prompt("/sure_feed model=demo");
		expect(fixture.diagnoses).toBe(0);
		expect(state(fixture.harness).repairs ?? []).toHaveLength(0);
		expect(state(fixture.harness).lastCheck?.outcome).toBe("passed");
	});
	it("keeps three pending research batches inside the local correction", async () => {
		const fixture = await setup({ decision: "pause" });
		fixture.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("work", { value: "tool-error" })], { stopReason: "toolUse" }),
			...["inspect-a", "inspect-b", "inspect-c"].map((value) =>
				fauxAssistantMessage([fauxToolCall("work", { value })], { stopReason: "toolUse" }),
			),
			fauxAssistantMessage("Awaiting original-condition verification."),
		]);
		await fixture.harness.session.prompt("/sure_feed model=demo");
		const coordination = state(fixture.harness);
		expect(fixture.executed).toEqual(["tool-error", "inspect-a", "inspect-b", "inspect-c"]);
		expect(fixture.diagnoses).toBe(0);
		expect(coordination.attempts).toHaveLength(0);
		expect(coordination.repairs ?? []).toHaveLength(0);
		const toolActions = readdirSync(join(runDir(fixture.harness), "evidence/tools")).map((file) =>
			JSON.parse(readFileSync(join(runDir(fixture.harness), "evidence/tools", file), "utf8")),
		);
		const batches = new Set(toolActions.map((action) => action.batchId));
		expect(batches.size).toBe(4);
		expect(toolActions.find((action) => action.isError)?.batchId).toBeDefined();
	});

	it("hands a failed direct repair to the supervisor once, then validates its repair", async () => {
		const fixture = await setup();
		fixture.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("work", { value: "tool-error" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("work", { value: "tool-error" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("work", { value: "good" })], { stopReason: "toolUse" }),
			() => fixture.finish(),
		]);
		await fixture.harness.session.prompt("/sure_feed model=demo");
		expect(fixture.diagnoses).toBe(1);
		expect(state(fixture.harness).repairs).toHaveLength(1);
		expect(state(fixture.harness).repairs?.map((repair) => repair.gateOutcome)).toEqual(["passed"]);
		expect(readFileSync(join(runDir(fixture.harness), "events.jsonl"), "utf8")).not.toContain(
			'"type":"finish_missing"',
		);
	});

	it("preserves an unattempted correction when the executor ends naturally", async () => {
		const fixture = await setup({ decision: "pause" });
		fixture.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("work", { value: "tool-error" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("I could not repair this."),
		]);
		await fixture.harness.session.prompt("/sure_feed model=demo");
		expect(fixture.diagnoses).toBe(0);
		expect(state(fixture.harness).unresolvedCheckVersion).toBeDefined();
		expect(readFileSync(join(runDir(fixture.harness), "events.jsonl"), "utf8")).toContain('"type":"finish_missing"');
	});

	it("distinguishes compound original-batch failures from a failed executor repair", async () => {
		const fixture = await setup({ decision: "pause" });
		fixture.harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("work", { value: "tool-error" }), fauxToolCall("work", { value: "tool-error-other" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Awaiting original-condition verification."),
		]);
		await fixture.harness.session.prompt("/sure_feed model=demo");
		expect(fixture.diagnoses).toBe(0);
		expect(state(fixture.harness).repairs ?? []).toHaveLength(0);
	});
	it("persists initial and later user constraints for diagnosis and terminal export", async () => {
		let timeline = "";
		const fixture = await setup({
			decision: "pause",
			onTimeline: (value) => {
				timeline = value;
			},
		});
		fixture.harness.sessionManager.appendMessage({ role: "user", content: "NO_NETWORK_DOWNLOADS", timestamp: 1 });
		fixture.harness.setResponses([
			async () => {
				await fixture.harness.session.prompt("ONLY_REPAIR_CURRENT_ARTIFACT", { streamingBehavior: "steer" });
				return fauxAssistantMessage([fauxToolCall("work", { value: "bad" })], { stopReason: "toolUse" });
			},
		]);
		await fixture.harness.session.prompt(
			`/sure_feed model=demo output_dir=${join(fixture.harness.tempDir, "output")}`,
		);
		expect(fixture.diagnoses).toBe(1);
		expect(timeline).toContain("NO_NETWORK_DOWNLOADS");
		expect(timeline).toContain("ONLY_REPAIR_CURRENT_ARTIFACT");
		const saved = readFileSync(join(fixture.harness.tempDir, "output/evidence/user-context.json"), "utf8");
		expect(saved).toContain("NO_NETWORK_DOWNLOADS");
		expect(saved).toContain("ONLY_REPAIR_CURRENT_ARTIFACT");
		expect(saved).not.toContain("sure_invocation");
	});

	it.each(["failed", "incomplete"] as const)(
		"preserves baseline manifest repairs for an executor-declared %s onboard without changing artifacts",
		async (status) => {
			const harness = await createHarness({
				extensionFactories: [sureExtension],
				settings: { compaction: { enabled: false }, retry: { enabled: false } },
			});
			harnesses.push(harness);
			const source = join(import.meta.dirname, "../../../../sure/skills/sure_onboard");
			const skillDir = join(harness.tempDir, ".sure/skills/sure_onboard");
			cpSync(source, skillDir, { recursive: true });
			for (const name of ["index"])
				writeFileSync(
					join(skillDir, `hooks/${name}.ts`),
					`export * from ${JSON.stringify(join(source, `hooks/${name}.ts`).replaceAll("\\", "/"))};`,
				);
			const skill = discoverSureSkillPackages(harness.tempDir).packages[0];
			const manager = new SureRunManager(harness.tempDir);
			const run = manager.createRun(skill, "model_id=fixture repo=fixture task_type=asr package=none");
			manager.setStatus(run, "running");
			manager.updateState(run, {
				phase: { id: "build_env", label: "Build model environment", status: "running" },
				checkpoint: {
					resumable: true,
					data: { currentUnit: "build_env", completedUnits: ["discover"], retries: { build_env: 1 } },
				},
			});
			await harness.session.bindExtensions({
				mode: "tui",
				onError: (error) => {
					throw new Error(error.error);
				},
			});
			for (const name of ["package_gate", "deployment_ready", "extraction_declaration"])
				json(join(run.runDir, `artifacts/${name}.json`), { original: name });
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("sure_finish", {
							status,
							manifest_path: join(run.runDir, "manifest.json"),
							summary: "Onboarding could not prepare its environment.",
							error_summary: "Required model dependency is unavailable.",
						}),
					],
					{ stopReason: "toolUse" },
				),
				(context) => {
					const feedback = context.messages.filter((message) => message.role === "toolResult").at(-1)!;
					expect(getMessageText(feedback)).toContain("Create the final manifest");
					json(join(run.runDir, "manifest.json"), {});
					return fauxAssistantMessage(
						[
							fauxToolCall("sure_finish", {
								status,
								manifest_path: join(run.runDir, "manifest.json"),
								summary: "Retain the actual failure.",
							}),
						],
						{ stopReason: "toolUse" },
					);
				},
				(context) => {
					const feedback = context.messages.filter((message) => message.role === "toolResult").at(-1)!;
					expect(getMessageText(feedback)).toContain("missing required field");
					return fauxAssistantMessage("The caller must repair its manifest before finishing.");
				},
			]);
			await harness.session.prompt(`/sure_resume ${run.runId}`);
			expect(manager.readRun(run.runId)?.status).toBe("running");
			expect(manager.readRun(run.runId)?.manifestPath).toBeUndefined();
			expect(manager.readState(run)?.checkpoint?.data).toMatchObject({
				completedUnits: ["discover"],
				retries: { build_env: 1 },
			});
			expect(manager.readState(run)?.checkpoint?.data).not.toHaveProperty("memory");
			for (const name of ["package_gate", "deployment_ready", "extraction_declaration"])
				expect(JSON.parse(readFileSync(join(run.runDir, `artifacts/${name}.json`), "utf8"))).toEqual({
					original: name,
				});
			expect(existsSync(join(run.runDir, "stop-manifest.json"))).toBe(false);
			expect(existsSync(join(run.runDir, "artifacts/stop_previous"))).toBe(false);
			expect(harness.getPendingResponseCount()).toBe(0);
			expect(state(harness).attempts).toHaveLength(0);
		},
	);

	it("runs real onboard hooks through inspection, direct repair and a diagnostic pause", async () => {
		let harness: Harness;
		let diagnoses = 0;
		const parameters = Type.Object({ action: Type.String() });
		const work: AgentTool<typeof parameters> = {
			name: "fixture_work",
			label: "Fixture work",
			description: "Inspect or write the current onboard fixture artifact",
			parameters,
			execute: async (_id, { action }) => {
				const artifacts = join(runDir(harness), "artifacts");
				if (action === "invalid") json(join(artifacts, "repo_summary.json"), { repo_url: 17 });
				else if (action === "repair")
					json(join(artifacts, "repo_summary.json"), { repo_url: "https://example.test/fixture" });
				else if (action.startsWith("classify")) json(join(artifacts, "classification.json"), { task_type: action });
				const text =
					action === "inspect-artifact"
						? readFileSync(join(artifacts, "repo_summary.json"), "utf8")
						: action === "inspect-schema"
							? readFileSync(join(skillDir, "schemas/repo_summary.schema.json"), "utf8")
							: action;
				return { content: [{ type: "text", text }], details: {} };
			},
		};
		harness = await createHarness({
			tools: [work],
			extensionFactories: [sureExtension],
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			isolatedSessionFactory: async (request) => {
				diagnoses++;
				const transcript = fixtureTranscript(request, harness.tempDir);
				return {
					getSessionIdentity: transcript.getSessionIdentity,
					prompt: async () => {
						await request.tools[0].execute(
							"macro",
							{ operation: "timeline" },
							undefined,
							undefined,
							harness.session.extensionRunner.createContext(),
						);
						await request.tools[0].execute(
							"premise",
							{ operation: "snapshot" },
							undefined,
							undefined,
							harness.session.extensionRunner.createContext(),
						);
						await submitControlFixture(
							request,
							transcript.manager,
							harness.session.extensionRunner.createContext(),
							pauseDiagnosis("Inspect the unsupported classification before resuming."),
						);
					},
					abort: async () => {},
					dispose: () => {},
					getMessages: () => transcript.manager.buildSessionContext().messages,
				};
			},
		});
		harnesses.push(harness);
		const source = join(import.meta.dirname, "../../../../sure/skills/sure_onboard");
		const skillDir = join(harness.tempDir, ".sure/skills/sure_onboard");
		cpSync(source, skillDir, { recursive: true });
		// Keep production imports anchored in the repository; only fixture data lives in the temp project.
		for (const name of ["index", "stop"])
			writeFileSync(
				join(skillDir, `hooks/${name}.ts`),
				`export * from ${JSON.stringify(join(source, `hooks/${name}.ts`).replaceAll("\\", "/"))};`,
			);
		const discovered = discoverSureSkillPackages(harness.tempDir);
		expect(discovered.diagnostics).toEqual([]);
		const manager = new SureRunManager(harness.tempDir);
		const run = manager.createRun(
			discovered.packages[0],
			"model_id=fixture repo=fixture task_type=asr deployment_type=local",
		);
		manager.setStatus(run, "running");
		manager.updateState(run, {
			phase: { id: "discover", label: "Discover repo", status: "running" },
			checkpoint: { resumable: true, data: { currentUnit: "discover", completedUnits: [], retries: {} } },
		});
		await harness.session.bindExtensions({
			mode: "tui",
			onError: (error) => {
				throw new Error(error.error);
			},
		});
		harness.setResponses(
			["invalid", "inspect-artifact", "inspect-schema", "repair", "classify-invalid", "classify-still-invalid"].map(
				(action) => fauxAssistantMessage([fauxToolCall("fixture_work", { action })], { stopReason: "toolUse" }),
			),
		);
		await harness.session.prompt(`/sure_resume ${run.runId}`);
		const coordination = state(harness);
		expect(diagnoses).toBe(1);
		expect(coordination.repairs?.filter((repair) => repair.unitId === "discover") ?? []).toHaveLength(0);
		expect(coordination).not.toHaveProperty("units");
		expect(manager.readState(run)?.checkpoint?.data).toMatchObject({ completedUnits: ["discover"] });
		expect(manager.readRun(run.runId)?.status).toBe("failed");
		const report = JSON.parse(readFileSync(join(run.runDir, "failure-report.json"), "utf8"));
		expect(report).toMatchObject({ stage: "classify", outcome: "incomplete" });
		expect(existsSync(join(run.runDir, "stop-manifest.json"))).toBe(false);
		expect(coordination.status).toBe("diagnosing");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("finishes the normal path with zero diagnoses", async () => {
		const fixture = await setup();
		fixture.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("work", { value: "good" })], { stopReason: "toolUse" }),
			() => fixture.finish(),
		]);
		await fixture.harness.session.prompt("/sure_feed model=demo device=cuda");
		expect(fixture.diagnoses).toBe(0);
		expect(JSON.parse(readFileSync(join(runDir(fixture.harness), "run.json"), "utf8")).status).toBe("success");
		expect(JSON.stringify(fixture.harness.session.messages)).not.toContain("FULL_MANUAL_MUST_NOT_BE_INJECTED");
	});

	it("repairs a semantic failure even when the hook returned ok:true, without finish_missing", async () => {
		const fixture = await setup();
		fixture.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("work", { value: "bad" })], { stopReason: "toolUse" }),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("Keep original task constraints.");
				return fauxAssistantMessage([fauxToolCall("work", { value: "good" })], { stopReason: "toolUse" });
			},
			() => fixture.finish(),
		]);
		await fixture.harness.session.prompt("/sure_feed model=demo device=cuda");
		expect(fixture.diagnoses).toBe(0);
		expect(fixture.executed).toEqual(["bad", "good"]);
		expect(state(fixture.harness).repairs?.length ?? 0).toBe(0);
		expect(readFileSync(join(runDir(fixture.harness), "events.jsonl"), "utf8")).not.toContain(
			'"type":"finish_missing"',
		);
	});

	it("repairs a simple format error directly without a supervisor call", async () => {
		const fixture = await setup();
		fixture.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("work", { value: "format" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("work", { value: "good" })], { stopReason: "toolUse" }),
			() => fixture.finish(),
		]);
		await fixture.harness.session.prompt("/sure_feed model=demo");
		expect(fixture.diagnoses).toBe(0);
		expect(state(fixture.harness).repairs ?? []).toHaveLength(0);
	});

	it("keeps a unit blocked when another hook passes its independent subcheck", async () => {
		const fixture = await setup({ multipleChecks: true, decision: "pause" });
		fixture.harness.setResponses([
			...Array.from({ length: 2 }, () =>
				fauxAssistantMessage([fauxToolCall("work", { value: "bad" })], { stopReason: "toolUse" }),
			),
		]);
		await fixture.harness.session.prompt("/sure_feed model=demo");
		expect(fixture.diagnoses).toBe(1);
		expect(state(fixture.harness).lastCheck?.outcome).toBe("blocked");
		expect(state(fixture.harness).lastSuccessSnapshot).toBeUndefined();
		const records = readdirSync(join(runDir(fixture.harness), "evidence/hooks")).map((name) =>
			JSON.parse(readFileSync(join(runDir(fixture.harness), "evidence/hooks", name), "utf8")),
		);
		expect(
			records.some((record) => record.handler === "passingSubcheck" && record.result.check.outcome === "passed"),
		).toBe(true);
	});

	it("blocks later sequential calls and preserves valid tool-result pairs before a diagnostic pause", async () => {
		const fixture = await setup({ decision: "pause" });
		fixture.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("work", { value: "bad" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[
					fauxToolCall("work", { value: "bad" }, { id: "first" }),
					fauxToolCall("work", { value: "must-not-run" }, { id: "second" }),
				],
				{ stopReason: "toolUse" },
			),
		]);
		await fixture.harness.session.prompt("/sure_feed model=demo");
		expect(fixture.executed).toEqual(["bad", "bad"]);
		const observations = readdirSync(join(runDir(fixture.harness), "evidence/tools")).map((name) =>
			JSON.parse(readFileSync(join(runDir(fixture.harness), "evidence/tools", name), "utf8")),
		);
		expect(observations.find((action) => action.toolCallId === "second")).toMatchObject({
			execution: "skipped",
			unitId: "stage",
		});
		expect(
			fixture.harness.session.messages
				.filter((message) => message.role === "toolResult")
				.map((message) => message.toolCallId),
		).toEqual([expect.any(String), "first", "second"]);
		expect(existsSync(join(runDir(fixture.harness), "artifacts/stopped.json"))).toBe(false);
		expect(JSON.parse(readFileSync(join(runDir(fixture.harness), "failure-report.json"), "utf8"))).toMatchObject({
			stage: "stage",
			resumable: true,
			outcome: "incomplete",
		});
	});

	it("waits for all already-started parallel tools and snapshots script-made edits", async () => {
		const fixture = await setup({ decision: "pause", parallel: true });
		fixture.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("work", { value: "bad" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("work", { value: "bad" }), fauxToolCall("work", { value: "slow" })], {
				stopReason: "toolUse",
			}),
		]);
		await fixture.harness.session.prompt("/sure_feed model=demo");
		expect(fixture.completed).toEqual(["bad", "bad", "slow"]);
		const current = state(fixture.harness);
		const snapshot = JSON.parse(
			readFileSync(join(runDir(fixture.harness), "snapshots", `${current.latestSnapshot}.json`), "utf8"),
		);
		expect(JSON.stringify(snapshot)).toContain("script edit after failure");
		expect(current.attempts).toHaveLength(1);
		const observations = readdirSync(join(runDir(fixture.harness), "evidence/tools")).map((name) =>
			JSON.parse(readFileSync(join(runDir(fixture.harness), "evidence/tools", name), "utf8")),
		);
		expect(observations.find((action) => action.input.value === "slow")).toMatchObject({
			unitId: "stage",
			execution: "returned",
			duringHold: true,
			isError: false,
		});
		expect(current.lastCheckVersion).toBe(2);
	});

	it("hands over sixteen actions in one macro page without running gates for five drained results", async () => {
		let macro:
			| {
					currentAttempt: { actions: { toolCallId: string }[]; batches: { phase: string }[] };
					stages: unknown[];
					diffIndex: unknown[];
			  }
			| undefined;
		const fixture = await setup({
			decision: "pause",
			parallel: true,
			longReads: true,
			priorStages: true,
			onTimeline: (text) => {
				const page = JSON.parse(JSON.parse(text).content[0].text);
				expect(page.complete).toBe(true);
				expect(page.totalCharacters).toBeLessThanOrEqual(50 * 1024);
				macro = JSON.parse(page.text);
			},
		});
		fixture.harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("work", { value: "tool-error" }, { id: "initial-error" }),
					...Array.from({ length: 9 }, (_, i) =>
						fauxToolCall("work", { value: `inspect-${i}` }, { id: `original-${i}` }),
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxToolCall("work", { value: "tool-error" }, { id: "later-error" }),
					...Array.from({ length: 5 }, (_, i) =>
						fauxToolCall("work", { value: `inspect-slow-${i}` }, { id: `drained-${i}` }),
					),
				],
				{ stopReason: "toolUse" },
			),
		]);
		await fixture.harness.session.prompt("/sure_feed model=demo");
		expect(fixture.executed).toHaveLength(16);
		expect(macro?.currentAttempt.actions.map((action) => action.toolCallId)).toEqual([
			"initial-error",
			...Array.from({ length: 9 }, (_, i) => `original-${i}`),
			"later-error",
			...Array.from({ length: 5 }, (_, i) => `drained-${i}`),
		]);
		expect(macro?.currentAttempt.batches.map((batch) => batch.phase)).toEqual(["trigger_batch", "subsequent_batch"]);
		expect(macro?.stages).toHaveLength(3);
		expect(macro?.diffIndex).toBeDefined();
		expect(
			readdirSync(join(runDir(fixture.harness), "evidence")).filter((name) => /^\d+\.json$/.test(name)),
		).toHaveLength(13);
		const observations = readdirSync(join(runDir(fixture.harness), "evidence/tools")).map((name) =>
			JSON.parse(readFileSync(join(runDir(fixture.harness), "evidence/tools", name), "utf8")),
		);
		expect(observations.filter((action) => action.duringHold)).toHaveLength(5);
		expect(observations.every((action) => action.unitId === "stage" && action.execution === "returned")).toBe(true);
		const hooks = readdirSync(join(runDir(fixture.harness), "evidence/hooks")).map((name) =>
			JSON.parse(readFileSync(join(runDir(fixture.harness), "evidence/hooks", name), "utf8")),
		);
		expect(hooks.filter((hook) => hook.point === "post_tool_result")).toHaveLength(11);
	});

	it("records a late tool error for diagnosis without replacing the original complex blocker", async () => {
		let macro:
			| { currentAttempt: { actions: { toolCallId: string; isError: boolean; outcome?: string }[] } }
			| undefined;
		const fixture = await setup({
			parallel: true,
			decision: "pause",
			onTimeline: (text) => {
				macro = JSON.parse(JSON.parse(JSON.parse(text).content[0].text).text);
			},
		});
		fixture.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("work", { value: "bad" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[
					fauxToolCall("work", { value: "bad" }, { id: "complex-blocker" }),
					fauxToolCall("work", { value: "tool-error-late" }, { id: "late-error" }),
				],
				{ stopReason: "toolUse" },
			),
		]);
		await fixture.harness.session.prompt("/sure_feed model=demo");
		expect(state(fixture.harness).lastCheckVersion).toBe(2);
		expect(state(fixture.harness).lastFailure?.summary).toBe("Gate saw bad");
		expect(macro?.currentAttempt.actions.slice(-2)).toMatchObject([
			{ toolCallId: "complex-blocker", isError: false, outcome: "blocked" },
			{ toolCallId: "late-error", isError: true },
		]);
		expect(macro?.currentAttempt.actions.at(-1)?.outcome).toBeUndefined();
	});

	it.each([false, true])(
		"drains shutdown evidence without applying post-result gates, hook already started=%s",
		async (delayGate) => {
			let started!: () => void;
			const ready = new Promise<void>((resolve) => {
				started = resolve;
			});
			const fixture = await setup({ onWorkStarted: () => started(), delayGate });
			fixture.harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("work", { value: delayGate ? "good" : "slow" }, { id: "shutdown-late" })],
					{
						stopReason: "toolUse",
					},
				),
				fauxAssistantMessage("must not be called"),
			]);
			const pending = fixture.harness.session.prompt("/sure_feed model=demo");
			await ready;
			if (delayGate) {
				while (!existsSync(join(runDir(fixture.harness), "gate-started")))
					await new Promise((resolve) => setTimeout(resolve, 1));
			}
			await fixture.harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			await pending;
			expect(fixture.completed).toEqual([delayGate ? "good" : "slow"]);
			expect(fixture.diagnoses).toBe(0);
			const current = state(fixture.harness);
			expect(current.lastCheckVersion).toBeUndefined();
			const run = JSON.parse(readFileSync(join(runDir(fixture.harness), "run.json"), "utf8"));
			expect(new SureRunManager(fixture.harness.tempDir).readState(run)?.checkpoint?.data).toMatchObject({
				completedUnits: [],
			});
			const snapshot = JSON.parse(
				readFileSync(join(runDir(fixture.harness), "snapshots", `${current.latestSnapshot}.json`), "utf8"),
			);
			expect(
				snapshot.files.some(
					(file: { path: string; text?: string }) =>
						file.path.startsWith("run:evidence/tools/") && file.text?.includes('"toolCallId": "shutdown-late"'),
				),
			).toBe(true);
			expect(fixture.harness.getPendingResponseCount()).toBe(1);
		},
	);

	it.each(["run", "session", "branch", "message"] as const)(
		"pauses an unconfirmed receipt from another %s without replay",
		async (mismatch) => {
			const fixture = await setup();
			const coordinator = seedInterruptedRun(fixture.harness);
			coordinator.acceptDiagnosis(result(fixture.harness));
			const pending = coordinator.state.pendingRepair!;
			const session = fixture.harness.sessionManager;
			const anchor = session.appendMessage(fauxAssistantMessage("Current executor branch", { timestamp: 1 }));
			pending.deliveryStarted = true;
			pending.receiverSessionId = mismatch === "session" ? "another-session" : session.getSessionId();
			pending.receiverSessionFile = session.getSessionFile();
			pending.receiverParentId = anchor;
			pending.receiverMessageId = session.appendMessage({
				role: "user",
				timestamp: 2,
				content: `<sure_supervisor_repair id="${pending.id}" run_id="${mismatch === "run" ? "another-run" : coordinator.run.runId}" unit="stage">Repair the current artifact and rerun its original gate.</sure_supervisor_repair>`,
			});
			if (mismatch === "message") pending.receiverMessageId = "another-message";
			if (mismatch === "branch") {
				session.branch(anchor);
				session.appendMessage(fauxAssistantMessage("Sibling branch", { timestamp: 3 }));
			}
			coordinator.save();
			fixture.harness.session.agent.state.messages = session.buildSessionContext().messages;
			fixture.harness.setResponses([fauxAssistantMessage("must not run")]);
			await fixture.harness.session.prompt(`/sure_resume ${coordinator.run.runId}`);
			expect(fixture.diagnoses).toBe(0);
			expect(fixture.executed).toEqual([]);
			expect(fixture.harness.getPendingResponseCount()).toBe(1);
			expect(state(fixture.harness).attempts.at(-1)?.checkpoint?.checkpoint).toContain(
				"handoff_delivery_unconfirmed",
			);
			expect(state(fixture.harness).pendingRepair?.delivered).toBe(false);
		},
	);

	it("retains invocation identity across stage changes and deduplicates returned observations", async () => {
		let fixture: Awaited<ReturnType<typeof setup>>;
		fixture = await setup({
			parallel: true,
			decision: "pause",
			onWorkStarted: (value) => {
				if (value === "slow")
					setTimeout(() => {
						const manager = new SureRunManager(fixture.harness.tempDir);
						const run = JSON.parse(readFileSync(join(runDir(fixture.harness), "run.json"), "utf8"));
						manager.updateState(run, {
							phase: { id: "external-marker", status: "running" },
							checkpoint: { resumable: true, data: { currentUnit: "external-marker" } },
						});
					}, 5);
			},
			duringDiagnosis: async (harness) => {
				const before = state(harness);
				const directory = join(runDir(harness), "evidence/tools");
				const observations = readdirSync(directory).map((name) => ({
					name,
					value: JSON.parse(readFileSync(join(directory, name), "utf8")),
				}));
				const late = observations.find(({ value }) => value.toolCallId === "late")!;
				expect(late.value).toMatchObject({ unitId: "stage", execution: "returned", duringHold: true });
				expect(late.value.batchId).toBe(
					observations.find(({ value }) => value.toolCallId === "first")!.value.batchId,
				);
				const run = JSON.parse(readFileSync(join(runDir(harness), "run.json"), "utf8"));
				expect(new SureRunManager(harness.tempDir).readState(run)?.phase?.id).toBe("external-marker");
				const original = readFileSync(join(directory, late.name), "utf8");
				await harness.session.extensionRunner.emitToolResult({
					type: "tool_result",
					toolName: "work",
					toolCallId: "late",
					input: { value: "different" },
					content: [{ type: "text", text: "Duplicate must not overwrite original." }],
					details: {},
					isError: true,
				});
				expect(readFileSync(join(directory, late.name), "utf8")).toBe(original);
				expect(state(harness).evidenceVersion).toBe(before.evidenceVersion);
				expect(state(harness).lastCheckVersion).toEqual(before.lastCheckVersion);
				const snapshot = JSON.parse(
					readFileSync(join(runDir(harness), "snapshots", `${before.latestSnapshot}.json`), "utf8"),
				);
				expect(
					snapshot.files.some(
						(file: { path: string; text?: string }) =>
							file.path.endsWith(late.name) && file.text?.includes('"execution": "returned"'),
					),
				).toBe(true);
			},
		});
		fixture.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("work", { value: "bad" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[
					fauxToolCall("work", { value: "bad" }, { id: "first" }),
					fauxToolCall("work", { value: "slow" }, { id: "late" }),
				],
				{ stopReason: "toolUse" },
			),
		]);
		await fixture.harness.session.prompt("/sure_feed model=demo");
		expect(state(fixture.harness).attempts[0].error).toBeUndefined();
		expect(state(fixture.harness).lastCheckVersion).toBe(2);
	});

	it.each(["artifact", "contract"])(
		"rejects a diagnosis if its %s changes during diagnosis and exports the saved failure report",
		async (changed) => {
			const fixture = await setup({
				decision: "repair",
				onDiagnosisPrompt: (prompt) => {
					expect(prompt).toMatch(/Produce current.json with value=good.|changed externally/);
					expect(prompt).toContain("FULL_MANUAL_MUST_NOT_BE_INJECTED");
				},
				duringDiagnosis: (harness) => {
					const target =
						changed === "artifact"
							? join(runDir(harness), "artifacts/changed.py")
							: join(harness.tempDir, ".sure/skills/demo/stage.md");
					if (existsSync(target) && readFileSync(target, "utf8") === "changed externally")
						throw new Error("Fixture diagnostic service paused after the stale suggestion was rejected.");
					writeFileSync(
						changed === "artifact"
							? join(runDir(harness), "artifacts/changed.py")
							: join(harness.tempDir, ".sure/skills/demo/stage.md"),
						"changed externally",
					);
				},
			});
			fixture.harness.setResponses([
				...Array.from({ length: 2 }, () =>
					fauxAssistantMessage([fauxToolCall("work", { value: "bad" })], { stopReason: "toolUse" }),
				),
			]);
			await fixture.harness.session.prompt(
				`/sure_feed model=demo output_dir=${join(fixture.harness.tempDir, "output")}`,
			);
			expect(fixture.executed).toEqual(["bad", "bad"]);
			expect(state(fixture.harness).attempts.length).toBeGreaterThanOrEqual(2);
			expect(existsSync(join(fixture.harness.tempDir, "output/failure-report.json"))).toBe(true);
			expect(existsSync(join(fixture.harness.tempDir, "output/snapshots"))).toBe(true);
		},
	);

	it("resumes a completed diagnosis after a crash without starting another investigation", async () => {
		const fixture = await setup();
		const coordinator = seedInterruptedRun(fixture.harness);
		coordinator.beginDiagnosis();
		coordinator.state.attempts[0].result = result(fixture.harness);
		coordinator.save();
		fixture.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("work", { value: "good" })], { stopReason: "toolUse" }),
			() => fixture.finish(),
		]);
		await fixture.harness.session.prompt(`/sure_resume ${coordinator.run.runId}`);
		expect(fixture.diagnoses).toBe(0);
		expect(fixture.executed).toEqual(["good"]);
		expect(state(fixture.harness).repairs?.length ?? 0).toBe(1);
	});

	it("restores persisted user constraints into a resumed executor with an empty transcript", async () => {
		const fixture = await setup();
		const coordinator = seedInterruptedRun(fixture.harness);
		syncSureUserContext(coordinator, [{ role: "user", content: "NO_NETWORK_DOWNLOADS", timestamp: 1 }]);
		coordinator.acceptDiagnosis(result(fixture.harness));
		fixture.harness.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("NO_NETWORK_DOWNLOADS");
				return fauxAssistantMessage([fauxToolCall("work", { value: "good" })], { stopReason: "toolUse" });
			},
			() => fixture.finish(),
		]);
		await fixture.harness.session.prompt(`/sure_resume ${coordinator.run.runId}`);
		expect(fixture.diagnoses).toBe(0);
		expect(fixture.executed).toEqual(["good"]);
	});

	it.each([false, true])(
		"restores the same repair task when delivered=%s without duplicate delivery or budget charge",
		async (delivered) => {
			const fixture = await setup();
			const coordinator = seedInterruptedRun(fixture.harness);
			coordinator.acceptDiagnosis(result(fixture.harness));
			if (coordinator.state.pendingRepair) coordinator.state.pendingRepair.delivered = delivered;
			if (delivered) {
				const pending = coordinator.state.pendingRepair!;
				pending.deliveryStarted = true;
				pending.receiverSessionId = fixture.harness.sessionManager.getSessionId();
				pending.receiverSessionFile = fixture.harness.sessionManager.getSessionFile();
				pending.receiverParentId = fixture.harness.sessionManager.getLeafId();
				pending.receiverMessageId = fixture.harness.session.sessionManager.appendMessage({
					role: "user",
					timestamp: Date.now(),
					content: `<sure_supervisor_repair id="${pending.id}" run_id="${coordinator.run.runId}" unit="stage">Repair the current artifact and rerun its original gate.</sure_supervisor_repair>`,
				});
			}
			coordinator.save();
			// Native reopen restores both the branch and its in-memory messages.
			fixture.harness.session.agent.state.messages = fixture.harness.sessionManager.buildSessionContext().messages;
			fixture.harness.setResponses([
				(context) => {
					expect(JSON.stringify(context.messages)).toContain(
						"Repair the current artifact and rerun its original gate.",
					);
					return fauxAssistantMessage([fauxToolCall("work", { value: "good" })], { stopReason: "toolUse" });
				},
				() => fixture.finish(),
			]);
			await fixture.harness.session.prompt(`/sure_resume ${coordinator.run.runId}`);
			expect(fixture.diagnoses).toBe(0);
			expect(fixture.executed).toEqual(["good"]);
			expect(state(fixture.harness).repairs?.length ?? 0).toBe(1);
			expect(state(fixture.harness).pendingRepair).toBeUndefined();
		},
	);

	it("resumes with review counters retained instead of imposing a new business cap", async () => {
		const fixture = await setup();
		const coordinator = seedInterruptedRun(fixture.harness);
		for (let i = 0; i < 80; i++) coordinator.recordAction("stage");
		coordinator.stop("Legacy unit action threshold.");
		fixture.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("work", { value: "good" })], { stopReason: "toolUse" }),
			() => fixture.finish(),
		]);
		await fixture.harness.session.prompt(`/sure_resume ${coordinator.run.runId}`);
		expect(fixture.executed).toEqual(["good"]);
		expect(fixture.diagnoses).toBe(0);
		expect(state(fixture.harness)).not.toHaveProperty("units");
		expect(JSON.parse(readFileSync(join(runDir(fixture.harness), "run.json"), "utf8")).status).toBe("success");
	});

	it("resumes a supervisor goal after recorded supporting work without retiring local correction identities", async () => {
		const fixture = await setup();
		const coordinator = seedInterruptedRun(fixture.harness);
		coordinator.acceptDiagnosis(result(fixture.harness));
		const taskId = coordinator.state.pendingRepair!.id;
		json(join(runDir(fixture.harness), "artifacts/current.json"), { value: "draft" });
		coordinator.observe(
			{
				unitId: "stage",
				outcome: "pending",
				summary: "Supporting work recorded",
				inputPaths: [],
				artifactPaths: ["run:artifacts/current.json"],
			},
			["run:artifacts", ...surePromptPaths(discoverSureSkillPackages(fixture.harness.tempDir).packages[0], "stage")],
		);
		fixture.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("work", { value: "good" })], { stopReason: "toolUse" }),
			() => fixture.finish(),
		]);
		await fixture.harness.session.prompt(`/sure_resume ${coordinator.run.runId}`);
		expect(fixture.diagnoses).toBe(0);
		expect(state(fixture.harness).repairs).toHaveLength(1);
		expect(state(fixture.harness).repairs!.find((repair) => repair.id === taskId)?.gateOutcome).toBe("passed");
	});

	it("invalidates an accepted repair when files changed before resume and obtains fresh evidence", async () => {
		const fixture = await setup();
		const coordinator = seedInterruptedRun(fixture.harness);
		coordinator.acceptDiagnosis(result(fixture.harness));
		const oldVersion = coordinator.state.evidenceVersion;
		json(join(runDir(fixture.harness), "artifacts/current.json"), { value: "externally-changed" });
		fixture.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("work", { value: "good" })], { stopReason: "toolUse" }),
			() => fixture.finish(),
		]);
		await fixture.harness.session.prompt(`/sure_resume ${coordinator.run.runId}`);
		expect(fixture.diagnoses).toBe(1);
		expect(state(fixture.harness).attempts[0].evidenceVersion).toBeGreaterThan(oldVersion);
		expect(state(fixture.harness).repairs?.length ?? 0).toBe(2);
		expect(
			state(fixture.harness)
				.repairs?.filter((repair) => repair.source === "supervisor")
				.map((repair) => repair.gateOutcome ?? repair.stopReason),
		).toEqual([expect.stringContaining("changed"), "passed"]);
		expect(fixture.executed).toEqual(["good"]);
	});

	it("cancels both roles and reports cancellation without generating a final model summary", async () => {
		const fixture = await setup({
			duringDiagnosis: (harness) => {
				void harness.session.abort();
			},
		});
		fixture.harness.setResponses([
			...Array.from({ length: 2 }, () =>
				fauxAssistantMessage([fauxToolCall("work", { value: "bad" })], { stopReason: "toolUse" }),
			),
			fauxAssistantMessage("must not be called"),
		]);
		await fixture.harness.session.prompt("/sure_feed model=demo");
		expect(fixture.executed).toEqual(["bad", "bad"]);
		expect(fixture.harness.getPendingResponseCount()).toBe(1);
		expect(JSON.parse(readFileSync(join(runDir(fixture.harness), "run.json"), "utf8")).status).toBe("cancelled");
		expect(JSON.parse(readFileSync(join(runDir(fixture.harness), "failure-report.json"), "utf8"))).toMatchObject({
			outcome: "cancelled",
			resumable: false,
		});
		expect(readFileSync(join(runDir(fixture.harness), "events.jsonl"), "utf8")).not.toContain(
			'"type":"finish_missing"',
		);
	});

	it("diagnoses ok:true plus a blocked phase even without an explicit error classification", async () => {
		const fixture = await setup({ omitCheck: true, decision: "pause" });
		fixture.harness.setResponses([
			...Array.from({ length: 2 }, () =>
				fauxAssistantMessage([fauxToolCall("work", { value: "bad" })], { stopReason: "toolUse" }),
			),
		]);
		await fixture.harness.session.prompt("/sure_feed model=demo");
		expect(fixture.diagnoses).toBe(1);
		expect(state(fixture.harness).lastCheck?.outcome).toBe("blocked");
	});

	it("keeps the original execution failure when the supervisor is unavailable", async () => {
		const fixture = await setup({ factoryError: true });
		fixture.harness.setResponses([
			...Array.from({ length: 2 }, () =>
				fauxAssistantMessage([fauxToolCall("work", { value: "bad" })], { stopReason: "toolUse" }),
			),
			fauxAssistantMessage("must not be called"),
		]);
		await fixture.harness.session.prompt("/sure_feed model=demo");
		const report = JSON.parse(readFileSync(join(runDir(fixture.harness), "failure-report.json"), "utf8"));
		expect(report.facts).toContain("Gate saw bad");
		expect(report.diagnosisStatus).toBe("unavailable");
		expect(report.stopReason).toContain("Supervisor provider unavailable");
		expect(fixture.harness.getPendingResponseCount()).toBe(1);
	});

	it("bounds headless auto nudges without terminalizing the business run", async () => {
		const fixture = await setup({ mode: "json" });
		fixture.harness.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("Still unfinished.")));
		await fixture.harness.session.prompt("/sure_feed model=demo");
		expect(fixture.diagnoses).toBe(0);
		expect(state(fixture.harness).finishNudges).toBe(3);
		expect(JSON.parse(readFileSync(join(runDir(fixture.harness), "run.json"), "utf8")).status).toBe("running");
		expect(state(fixture.harness).stopReason).toBeUndefined();
	});

	it("retains baseline handling of a first executor provider error without an unnecessary debugger call", async () => {
		const fixture = await setup({ factoryError: true });
		fixture.harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Original executor provider failure." }),
			fauxAssistantMessage("must not be called"),
		]);
		await fixture.harness.session.prompt("/sure_feed model=demo");
		expect(fixture.diagnoses).toBe(0);
		expect(JSON.parse(readFileSync(join(runDir(fixture.harness), "run.json"), "utf8")).lastRepair).toContain(
			"Original executor provider failure.",
		);
		expect(state(fixture.harness).lastFailure?.summary).toBe("Original executor provider failure.");
		expect(fixture.harness.getPendingResponseCount()).toBe(1);
	});

	it.each(["failed", "incomplete"] as const)(
		"validates the caller's %s manifest without replacing its terminal evidence",
		async (status) => {
			const fixture = await setup();
			const coordinator = seedInterruptedRun(fixture.harness);
			json(join(coordinator.run.runDir, "artifacts/stopped.json"), { value: "blocked" });
			const manifest = join(coordinator.run.runDir, `executor-${status}.json`);
			json(manifest, {
				schema_version: "1",
				run_id: coordinator.run.runId,
				skill_name: "demo",
				status,
				created_at: new Date().toISOString(),
				inputs: {},
				outputs: {},
				validation: {},
			});
			const originalManifest = readFileSync(manifest, "utf8");
			coordinator.barrier([
				"run:artifacts",
				...surePromptPaths(discoverSureSkillPackages(fixture.harness.tempDir).packages[0], "stage"),
			]);
			coordinator.acceptDiagnosis(result(fixture.harness));
			fixture.harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("sure_finish", {
							status,
							manifest_path: manifest,
							summary: "Executor-declared failure",
							error_summary: "Original task could not proceed.",
						}),
					],
					{ stopReason: "toolUse" },
				),
			]);
			await fixture.harness.session.prompt(`/sure_resume ${coordinator.run.runId}`);
			expect(fixture.diagnoses).toBe(0);
			const report = JSON.parse(readFileSync(join(runDir(fixture.harness), "failure-report.json"), "utf8"));
			expect(report.outcome).toBe(status);
			expect(report.facts).toContain("Original task could not proceed.");
			expect(readFileSync(manifest, "utf8")).toBe(originalManifest);
			expect(existsSync(join(coordinator.run.runDir, "stop.json"))).toBe(false);
			expect(JSON.parse(readFileSync(join(coordinator.run.runDir, "run.json"), "utf8"))).toMatchObject({
				status,
				manifestPath: manifest,
			});
		},
	);

	it("preserves a user abort that happened before the executor tool barrier created its hold signal", async () => {
		let started: (() => void) | undefined;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const fixture = await setup({ onWorkStarted: () => started?.() });
		fixture.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("work", { value: "slow" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("must not be called"),
		]);
		const pending = fixture.harness.session.prompt("/sure_feed model=demo");
		await ready;
		await fixture.harness.session.abort();
		await pending;
		expect(fixture.diagnoses).toBe(0);
		expect(fixture.completed).toEqual(["slow"]);
		expect(JSON.parse(readFileSync(join(runDir(fixture.harness), "run.json"), "utf8")).status).toBe("cancelled");
		expect(fixture.harness.getPendingResponseCount()).toBe(1);
	});

	it.each(["quit", "reload", "new", "resume", "fork"] as const)(
		"keeps an idle unfinished run failed and resumable on %s, then resumes through the original gate",
		async (reason) => {
			const fixture = await setup();
			fixture.harness.setResponses([fauxAssistantMessage("Work remains at the saved checkpoint.")]);
			await fixture.harness.session.prompt("/sure_feed model=demo");
			const directory = runDir(fixture.harness);
			await fixture.harness.session.extensionRunner.emit({ type: "session_shutdown", reason });
			const run = JSON.parse(readFileSync(join(directory, "run.json"), "utf8"));
			expect(run.status).toBe("failed");
			expect(state(fixture.harness).status).toBe("stopped");
			expect(state(fixture.harness).cancelled).not.toBe(true);
			expect(new SureRunManager(fixture.harness.tempDir).readState(run)?.checkpoint?.resumable).toBe(true);
			expect(existsSync(join(directory, ".coordination-owner.json"))).toBe(false);
			expect(existsSync(join(directory, "artifacts/stopped.json"))).toBe(false);
			fixture.harness.setResponses([
				fauxAssistantMessage([fauxToolCall("work", { value: "good" })], { stopReason: "toolUse" }),
				() => fixture.finish(),
			]);
			await fixture.harness.session.prompt(`/sure_resume ${run.runId}`);
			expect(JSON.parse(readFileSync(join(directory, "run.json"), "utf8")).status).toBe("success");
			expect(fixture.diagnoses).toBe(0);
		},
	);

	it("retains the new-run owner guard after installing the stage context", async () => {
		const saves = vi.spyOn(SureCoordinator.prototype, "save");
		const fixture = await setup();
		fixture.harness.setResponses([fauxAssistantMessage("Checkpoint retained.")]);
		await fixture.harness.session.prompt("/sure_feed model=demo");
		const directory = runDir(fixture.harness);
		const before = readFileSync(join(directory, "coordination.json"), "utf8");
		const coordinator = saves.mock.contexts.at(-1) as SureCoordinator;
		expect(coordinator.assertOwner).toBeTypeOf("function");
		json(join(directory, ".coordination-owner.json"), { replacement: true });
		expect(() =>
			coordinator.observe(
				{ unitId: "stage", outcome: "passed", summary: "Stale callback", inputPaths: [], artifactPaths: [] },
				[],
			),
		).toThrow("ownership is stale");
		await expect(
			fixture.harness.session.extensionRunner.emitToolCall({
				type: "tool_call",
				toolName: "work",
				toolCallId: "stale-owner",
				input: { value: "inspect" },
			}),
		).rejects.toThrow("ownership is stale");
		expect(fixture.executed).toEqual([]);
		expect(readFileSync(join(directory, "coordination.json"), "utf8")).toBe(before);
	});

	it("keeps shutdown during diagnosis cancelled without a late handoff or another executor request", async () => {
		let shutdown: Promise<void> | undefined;
		const fixture = await setup({
			duringDiagnosis: (harness) => {
				shutdown = harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
			},
		});
		fixture.harness.setResponses([
			...Array.from({ length: 2 }, () =>
				fauxAssistantMessage([fauxToolCall("work", { value: "bad" })], { stopReason: "toolUse" }),
			),
			fauxAssistantMessage("must not run after shutdown"),
		]);
		await fixture.harness.session.prompt("/sure_feed model=demo");
		await shutdown;
		expect(fixture.diagnoses).toBe(1);
		expect(state(fixture.harness)).toMatchObject({ status: "stopped", cancelled: true });
		expect(JSON.parse(readFileSync(join(runDir(fixture.harness), "run.json"), "utf8")).status).toBe("cancelled");
		expect(fixture.harness.getPendingResponseCount()).toBe(1);
		expect(JSON.stringify(fixture.harness.session.messages)).not.toContain("<sure_supervisor_repair");
		expect(existsSync(join(runDir(fixture.harness), ".coordination-owner.json"))).toBe(false);
	});

	it("does not accept a finish gate that returns after user cancellation", async () => {
		const fixture = await setup({ delayFinish: true });
		fixture.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("work", { value: "good" })], { stopReason: "toolUse" }),
			() => fixture.finish(),
			fauxAssistantMessage("must not run after cancellation"),
		]);
		const pending = fixture.harness.session.prompt("/sure_feed model=demo");
		await vi.waitFor(() => expect(existsSync(join(runDir(fixture.harness), "finish-gate-started"))).toBe(true));
		await fixture.harness.session.abort();
		await pending;
		expect(state(fixture.harness)).toMatchObject({ status: "stopped", cancelled: true });
		const run = JSON.parse(readFileSync(join(runDir(fixture.harness), "run.json"), "utf8"));
		expect(run.status).toBe("cancelled");
		expect(run.manifestPath).toBeUndefined();
		expect(fixture.harness.getPendingResponseCount()).toBe(1);
	});

	it.each(["before_accept", "after_accept"])(
		"does not revive or deliver a cached handoff when cancellation arrives %s",
		async (when) => {
			const original = SureCoordinator.prototype.acceptDiagnosis;
			let accepts = 0;
			vi.spyOn(SureCoordinator.prototype, "acceptDiagnosis").mockImplementation(function (
				this: SureCoordinator,
				value,
			) {
				if (++accepts > 1) throw new Error("Cancelled diagnosis was retried.");
				if (when === "before_accept") this.stop("User cancelled at the handoff boundary.", true);
				const accepted = original.call(this, value);
				if (when === "after_accept") this.stop("User cancelled at the handoff boundary.", true);
				return accepted;
			});
			const fixture = await setup();
			fixture.harness.setResponses([
				...Array.from({ length: 2 }, () =>
					fauxAssistantMessage([fauxToolCall("work", { value: "bad" })], { stopReason: "toolUse" }),
				),
				fauxAssistantMessage("must not run after cancellation"),
			]);
			await fixture.harness.session.prompt("/sure_feed model=demo");
			expect(accepts).toBe(1);
			expect(fixture.diagnoses).toBe(1);
			expect(state(fixture.harness)).toMatchObject({ status: "stopped", cancelled: true });
			expect(state(fixture.harness).pendingRepair?.delivered).not.toBe(true);
			expect(JSON.stringify(fixture.harness.session.messages)).not.toContain("<sure_supervisor_repair");
			expect(fixture.harness.getPendingResponseCount()).toBe(1);
			expect(JSON.parse(readFileSync(join(runDir(fixture.harness), "run.json"), "utf8")).status).toBe("cancelled");
		},
	);
});
