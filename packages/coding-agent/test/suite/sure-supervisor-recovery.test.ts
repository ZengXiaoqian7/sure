import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { createIsolatedResourceLoader } from "../../src/core/isolated-resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { captureSureExecutorProgress } from "../../src/core/sure/context.ts";
import { parseSureDiagnosisResult } from "../../src/core/sure/coordination-contracts.ts";
import type {
	SureCheckOutcome,
	SureDiagnosisOutcome,
	SureDiagnosisResult,
} from "../../src/core/sure/coordination-types.ts";
import { SureCoordinator } from "../../src/core/sure/coordinator.ts";
import { captureSureSnapshot, writeSureJson } from "../../src/core/sure/evidence.ts";
import { buildSureFailureReport, renderSureFailureReport } from "../../src/core/sure/failure-report.ts";
import { diagnoseSureRun } from "../../src/core/sure/supervisor.ts";
import type { SureRunRecord } from "../../src/core/sure/types.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";
import { pauseDiagnosis, repairHandoff } from "./sure-control-fixtures.ts";

function checkpointReason(outcome: SureDiagnosisOutcome): string {
	expect(outcome.decision).toBe("checkpoint");
	if (outcome.decision !== "checkpoint") throw new Error("Expected an incomplete investigation.");
	return outcome.checkpoint;
}

const harnesses: Harness[] = [];
const sessions: AgentSession[] = [];
const stage = {
	id: "prepare_report",
	prompt: "stage.md",
	references: ["helper.txt"],
	snapshotPaths: ["run:artifacts"],
};

async function setup(helperText = "Read declared options and produce the requested report.\n") {
	const harness = await createHarness();
	harnesses.push(harness);
	const { session } = await createAgentSession({
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		model: harness.getModel(),
		modelRuntime: harness.session.modelRuntime,
		sessionManager: SessionManager.inMemory(harness.tempDir),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
		resourceLoader: createIsolatedResourceLoader("Executor"),
		tools: [],
	});
	sessions.push(session);
	await session.bindExtensions({});
	const runDir = join(harness.tempDir, ".sure/runs/report-recovery");
	const packageDir = join(harness.tempDir, "skill");
	mkdirSync(join(runDir, "artifacts"), { recursive: true });
	mkdirSync(packageDir);
	writeFileSync(join(packageDir, "helper.txt"), helperText);
	writeFileSync(
		join(packageDir, "stage.md"),
		"Produce artifacts/report.json using the passed research output. File reads alone do not define prerequisites.",
	);
	writeFileSync(join(harness.tempDir, "source.json"), '{"requested_mode":"local"}\n');
	const run: SureRunRecord = {
		runId: "report-recovery",
		skillName: "report",
		command: "sure_feed",
		cwd: harness.tempDir,
		runDir,
		packageDir,
		status: "running",
		args: "mode=local",
		startedAt: "now",
		updatedAt: "now",
	};
	const scope = ["run:artifacts", "package:stage.md", "package:helper.txt", "project:source.json"];
	const coordinator = new SureCoordinator(run, "prepare_report", scope);
	const ctx = session.extensionRunner.createContext();
	ctx.setExecutionHold?.(true);
	return { harness, coordinator, ctx, scope };
}

function recordAction(
	coordinator: SureCoordinator,
	id: string,
	isError: boolean,
	text: string,
	outcome: SureCheckOutcome,
) {
	const path = `run:evidence/tools/${id}.json`;
	writeSureJson(join(coordinator.run.runDir, `evidence/tools/${id}.json`), {
		toolCallId: id,
		execution: "returned",
		toolName: id === "inspect" ? "read" : "generate_report",
		input: { destination: id === "partial" ? "alternate/report.json" : "artifacts/report.json" },
		cwd: coordinator.run.cwd,
		content: [{ type: "text", text }],
		isError,
		batchId: id,
	});
	coordinator.observe(
		{
			unitId: "prepare_report",
			outcome,
			failureKind: isError ? "tool" : undefined,
			summary: isError ? text : "Original report gate is still pending.",
			artifactPaths: ["run:artifacts/report.json"],
			inputPaths: ["package:helper.txt"],
			diagnosticPaths: ["project:source.json"],
			action: { toolCallId: id, toolName: id === "inspect" ? "read" : "generate_report", path, batchId: id },
		},
		[
			path,
			"package:stage.md",
			"package:helper.txt",
			"project:source.json",
			"run:artifacts",
			"run:artifacts/report.json",
		],
	);
}

const repairTask = "Correct the invocation destination using the retained evidence.";

function storedRepairResult(coordinator: SureCoordinator): SureDiagnosisResult {
	return {
		runId: coordinator.run.runId,
		unitId: coordinator.state.unitId,
		evidenceVersion: coordinator.state.evidenceVersion,
		decision: "repair",
		facts: [],
		hypotheses: [],
		unknowns: [],
		nextActions: [],
		evidenceReferences: ["check:1"],
		targetFiles: [],
		repair: repairTask,
		validation: "Rerun the original report gate.",
		stopBoundary: "Stop if the original gate still fails.",
	};
}

afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("supervisor recovery interfaces", () => {
	it("reads a complete public next step through saved pages after compaction and coordinator reload", async () => {
		const { harness, coordinator, ctx, scope } = await setup();
		const executor = sessions.at(-1)!;
		const body = `${"Public evidence and hypotheses. ".repeat(2500)}NEXT_STEP: probe the actual loader; the environment is still unknown.`;
		const message = fauxAssistantMessage(
			[
				{ type: "thinking", thinking: "PRIVATE", thinkingSignature: "opaque" },
				{ type: "text", text: body },
			],
			{ timestamp: 200 },
		);
		const id = executor.sessionManager.appendMessage(message);
		captureSureExecutorProgress(
			coordinator.run,
			stage.id,
			[message],
			undefined,
			executor.sessionFile,
			new Map([[message, id]]),
			100,
		);
		const packet = JSON.parse(readFileSync(join(coordinator.run.runDir, "evidence/executor-progress.json"), "utf8"));
		const reference = packet.claims[0].sourcePath;
		const kept = executor.sessionManager.appendMessage({ role: "user", content: "Continue", timestamp: 250 });
		executor.sessionManager.appendCompaction("Public summary", kept, 200);
		expect(JSON.stringify(executor.sessionManager.buildSessionContext().messages)).not.toContain("NEXT_STEP:");
		scope.push("run:evidence/executor-progress.json");
		recordAction(coordinator, "generate", true, "Actual unresolved execution error", "blocked");
		coordinator.barrier(scope);
		const restored = new SureCoordinator(coordinator.run, stage.id, scope);
		let assembled = "";
		const continuation: FauxResponseStep = (context) => {
			const page = JSON.parse(
				getMessageText(context.messages.filter((message) => message.role === "toolResult").at(-1)),
			);
			assembled += page.text;
			if (page.complete) {
				expect(JSON.parse(assembled)).toMatchObject({
					text: body,
					sourceMessageId: id,
					unitId: stage.id,
					sourceHash: packet.claims[0].sourceHash,
				});
				expect(assembled).not.toContain("PRIVATE");
				return repairHandoff(
					"Probe the actual loader first, then continue the report using its real result; preserve the unknown environment premise.",
				);
			}
			return fauxAssistantMessage(
				[fauxToolCall("sure_diagnostic_read", { operation: "file", path: reference, offset: page.nextOffset })],
				{ stopReason: "toolUse" },
			);
		};
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("sure_diagnostic_read", { operation: "timeline" }, { id: "macro" }),
					fauxToolCall("sure_diagnostic_read", { operation: "user_context" }),
				],
				{
					stopReason: "toolUse",
				},
			),
			(context) => {
				const page = JSON.parse(
					getMessageText(
						context.messages.find((message) => message.role === "toolResult" && message.toolCallId === "macro"),
					),
				);
				const progress = JSON.parse(JSON.parse(page.text).executorProgress);
				expect(progress).toMatchObject({ currentIntentAvailable: true });
				expect(progress.claims[0].sourcePath).toBe(reference);
				return fauxAssistantMessage(
					[fauxToolCall("sure_diagnostic_read", { operation: "file", path: reference })],
					{ stopReason: "toolUse" },
				);
			},
			...Array.from({ length: 4 }, () => continuation),
		]);
		const outcome = await diagnoseSureRun(restored, ctx, scope, stage);
		expect(outcome.decision, JSON.stringify(outcome)).toBe("repair");
		expect(JSON.parse(assembled).text).toContain("NEXT_STEP: probe the actual loader");
	});
	it.each(["file", "log"] as const)(
		"reads a large %s through every page beyond snapshot storage limits",
		async (operation) => {
			const body = operation === "file" ? "说明🌍\n".repeat(40_000) : "L".repeat(2_000_001);
			const { harness, coordinator, ctx, scope } = await setup(body);
			recordAction(coordinator, "generate", true, "Original failure", "blocked");
			writeFileSync(join(coordinator.run.runDir, "events.jsonl"), body);
			const path = "package:helper.txt";
			let assembled = "";
			const continuation: FauxResponseStep = (context) => {
				const page = JSON.parse(getMessageText(context.messages.filter((m) => m.role === "toolResult").at(-1)));
				expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(50 * 1024);
				if (operation === "file") expect(page.source).toBe("file");
				assembled += page.text;
				if (page.complete) return repairHandoff(repairTask);
				return fauxAssistantMessage(
					[
						fauxToolCall("sure_diagnostic_read", {
							operation,
							offset: page.nextOffset,
							...(operation === "file" ? { path } : {}),
						}),
					],
					{ stopReason: "toolUse" },
				);
			};
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(
					[fauxToolCall("sure_diagnostic_read", { operation, ...(operation === "file" ? { path } : {}) })],
					{ stopReason: "toolUse" },
				),
				...Array.from({ length: 50 }, () => continuation),
			]);
			expect((await diagnoseSureRun(coordinator, ctx, scope, stage)).decision).toBe("repair");
			expect(assembled).toBe(body);
			expect(coordinator.state.attempts[0].readCalls).toBeGreaterThan(9);
			expect(coordinator.state.attempts[0].modelTurns).toBeGreaterThan(4);
			expect(coordinator.state.lastCheckVersion).toBe(1);
		},
	);
	it("returns four explicit action previews together within the baseline response size", async () => {
		const { harness, coordinator, ctx, scope } = await setup();
		const ids = ["first", "second", "third", "fourth"];
		for (const id of ids) recordAction(coordinator, id, true, "Original result ".repeat(200), "blocked");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "actions", toolCallIds: ids })], {
				stopReason: "toolUse",
			}),
			(context) => {
				const page = JSON.parse(getMessageText(context.messages.filter((m) => m.role === "toolResult").at(-1)));
				expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(50 * 1024);
				expect(page.complete).toBe(true);
				const actions = JSON.parse(page.text);
				expect(actions.map((action: { toolCallId: string }) => action.toolCallId)).toEqual(ids);
				expect(
					actions.every((action: { resultPreview: { complete: boolean } }) => !action.resultPreview.complete),
				).toBe(true);
				return repairHandoff(repairTask);
			},
		]);
		expect((await diagnoseSureRun(coordinator, ctx, scope, stage)).decision).toBe("repair");
		expect(coordinator.state.attempts[0]).toMatchObject({ modelTurns: 3, readCalls: 2 });
	});

	it.each([
		{ toolCallIds: [] },
		{ toolCallIds: ["a", "a"] },
		{ toolCallIds: ["a", "b", "c", "d", "e"] },
		{ toolCallIds: ["unknown"] },
	])("rejects invalid action selections %j", async ({ toolCallIds }) => {
		const { harness, coordinator, ctx, scope } = await setup();
		recordAction(coordinator, "a", true, "Original failure", "blocked");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "actions", toolCallIds })], {
				stopReason: "toolUse",
			}),
			(context) => {
				expect(context.messages.filter((message) => message.role === "toolResult").at(-1)?.isError).toBe(true);
				return repairHandoff(repairTask);
			},
		]);
		expect((await diagnoseSureRun(coordinator, ctx, scope, stage)).decision).toBe("repair");
		expect(coordinator.state.attempts[0].readRequests).toBe(2);
	});

	it.each([
		{ operation: "diff", snapshotId: "00000000-0000-0000-0000-000000000000" },
		{ operation: "timeline", path: "run:artifacts" },
		{ operation: "actions", checkVersion: 1 },
		{ operation: "file", path: "package:helper.txt", query: "declared" },
		{ operation: "snapshot", toolCallId: "inspect" },
	])("rejects unsupported parameters for $operation instead of silently ignoring them", async (request) => {
		const { harness, coordinator, ctx, scope } = await setup();
		recordAction(coordinator, "inspect", true, "Actual lookup failed.", "blocked");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", request)], { stopReason: "toolUse" }),
			(context) => {
				const denied = context.messages.filter((message) => message.role === "toolResult").at(-1)!;
				expect(denied.isError).toBe(true);
				expect(getMessageText(denied)).toContain("Unsupported parameter");
				return repairHandoff(repairTask);
			},
		]);
		expect((await diagnoseSureRun(coordinator, ctx, scope, stage)).decision).toBe("repair");
		expect(coordinator.state.attempts[0]).toMatchObject({ readCalls: 2, modelTurns: 3 });
	});

	it("keeps default task diffs free of action capture noise but permits explicit action-file inspection", async () => {
		const { harness, coordinator, ctx, scope } = await setup();
		const taskPath = "run:artifacts/research.json";
		writeSureJson(join(coordinator.run.runDir, "artifacts/research.json"), { revision: 1 });
		coordinator.observe(
			{
				unitId: "research",
				outcome: "passed",
				summary: "Research verified",
				inputPaths: [],
				artifactPaths: [taskPath],
			},
			scope,
		);
		writeSureJson(join(coordinator.run.runDir, "artifacts/research.json"), { revision: 2 });
		recordAction(coordinator, "inspect", true, "Actual lookup failed.", "blocked");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				[
					fauxToolCall("sure_diagnostic_read", { operation: "diff" }),
					fauxToolCall("sure_diagnostic_read", { operation: "diff", path: "run:evidence/tools/inspect.json" }),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				const pages = context.messages
					.filter((message) => message.role === "toolResult")
					.slice(-2)
					.map((message) => JSON.parse(getMessageText(message)));
				const diff = JSON.parse(pages[0].text);
				expect(diff.index.some((file: { path: string }) => file.path.startsWith("run:evidence/tools/"))).toBe(
					false,
				);
				expect(diff.index).toContainEqual({ path: taskPath, before: "text", after: "text" });
				expect(diff.snapshotReferences).toEqual({
					before: `snapshot:${coordinator.state.lastSuccessSnapshot}`,
					after: `snapshot:${coordinator.state.latestSnapshot}`,
				});
				expect(JSON.parse(pages[1].text).diff).toContain("run:evidence/tools/inspect.json");
				return repairHandoff(repairTask);
			},
		]);
		expect((await diagnoseSureRun(coordinator, ctx, scope, stage)).decision).toBe("repair");
	});

	it("supplies the retained stage contract and actual upstream output without promoting guessed inputs", async () => {
		const { harness, coordinator, ctx, scope } = await setup();
		writeSureJson(join(coordinator.run.runDir, "artifacts/research.json"), { source: "retained research" });
		coordinator.observe(
			{
				unitId: "research",
				outcome: "passed",
				summary: "Research verified",
				artifactPaths: ["run:artifacts/research.json"],
				inputPaths: [],
			},
			scope,
		);
		recordAction(coordinator, "inspect", true, "ENOENT: artifacts/guessed-prerequisite.json", "blocked");
		writeFileSync(join(coordinator.run.packageDir, "stage.md"), "CHANGED_LIVE_CONTRACT");
		harness.setResponses([
			(context) => {
				const prompt = context.messages.map(getMessageText).join("\n");
				expect(prompt).toContain("Produce artifacts/report.json using the passed research output.");
				expect(prompt).not.toContain("CHANGED_LIVE_CONTRACT");
				expect(prompt).toContain("Evidence scope is not a prerequisite list");
				expect(prompt).toContain("missing file itself is not a valid file reference");
				return fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline" })], {
					stopReason: "toolUse",
				});
			},
			(context) => {
				const page = JSON.parse(getMessageText(context.messages.filter((m) => m.role === "toolResult").at(-1)));
				const timeline = JSON.parse(page.text);
				expect(timeline.currentStage).toMatchObject({
					unitId: stage.id,
					prompt: "package:stage.md",
					checkVersion: 2,
					artifactPaths: ["run:artifacts/report.json"],
				});
				expect(timeline.stages[0].lastPassed).toEqual({
					checkVersion: 1,
					artifactPaths: ["run:artifacts/research.json"],
				});
				return fauxAssistantMessage(
					[
						fauxToolCall("sure_diagnostic_read", { operation: "file", path: "run:artifacts/research.json" }),
						fauxToolCall("sure_diagnostic_read", { operation: "diff", path: "run:artifacts/report.json" }),
					],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				const pages = context.messages
					.filter((m) => m.role === "toolResult")
					.slice(-2)
					.map((m) => JSON.parse(getMessageText(m)));
				expect(pages[0].text).toContain("retained research");
				expect(JSON.parse(pages[1].text)).toMatchObject({
					snapshotReferences: {
						before: `snapshot:${coordinator.state.lastSuccessSnapshot}`,
						after: `snapshot:${coordinator.state.latestSnapshot}`,
					},
				});
				return repairHandoff(
					"Produce the current report from the verified research; then run the original report check.",
				);
			},
		]);
		expect((await diagnoseSureRun(coordinator, ctx, scope, stage)).decision).toBe("repair");
		expect(coordinator.state.attempts[0]).toMatchObject({ readCalls: 3, modelTurns: 3 });
	});

	it.each(["missing", "uncaptured", "over_limit", "mismatched", "undeclared", "truncated"])(
		"does not diagnose from an unavailable declared stage contract: %s",
		async (condition) => {
			const { harness, coordinator, ctx, scope } = await setup();
			recordAction(coordinator, "generate", true, "Original error", "blocked");
			if (condition === "missing") {
				rmSync(join(coordinator.run.packageDir, "stage.md"));
				coordinator.barrier(scope);
			}
			if (condition === "uncaptured") coordinator.barrier(["run:artifacts"]);
			if (condition === "over_limit") {
				writeFileSync(join(coordinator.run.packageDir, "stage.md"), "X".repeat(256001));
				coordinator.barrier(scope);
			}
			if (condition === "truncated") {
				const snapshot = captureSureSnapshot(coordinator.run, stage.id, "barrier", scope, {
					...coordinator.limits,
					snapshotFiles: 1,
				});
				expect(snapshot.truncated).toBe(true);
				coordinator.state.latestSnapshot = snapshot.id;
			}
			harness.setResponses([fauxAssistantMessage("must not be called")]);
			const diagnosis = await diagnoseSureRun(
				coordinator,
				ctx,
				scope,
				condition === "undeclared" ? undefined : condition === "mismatched" ? { ...stage, id: "other" } : stage,
			);
			expect(diagnosis.decision).toBe("checkpoint");
			expect(checkpointReason(diagnosis)).toContain("stage contract");
			expect(harness.getPendingResponseCount()).toBe(1);
		},
	);

	it("never permits the stage contract as a repair target", async () => {
		const { harness, coordinator, ctx, scope } = await setup();
		recordAction(coordinator, "generate", true, "Original error", "blocked");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline" })], {
				stopReason: "toolUse",
			}),
			repairHandoff(repairTask, ["package:stage.md"]),
		]);
		expect(checkpointReason(await diagnoseSureRun(coordinator, ctx, scope, stage))).toContain(
			"Focus path is outside original task permissions",
		);
	});
	it("allows direct local reads and explicit independent pages without navigation delivery state", async () => {
		const { harness, coordinator, ctx, scope } = await setup("SOURCE_LINE\n".repeat(5000));
		recordAction(coordinator, "generate", true, "Generation failed.", "blocked");
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("sure_diagnostic_read", { operation: "file", path: "package:helper.txt", offset: 20000 }),
					fauxToolCall("sure_diagnostic_read", { operation: "check", checkVersion: 1 }),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				const results = context.messages.filter((message) => message.role === "toolResult");
				expect(results.every((message) => !message.isError)).toBe(true);
				expect(JSON.parse(getMessageText(results[0]))).toMatchObject({ offset: 20000 });
				return repairHandoff(repairTask);
			},
		]);
		expect((await diagnoseSureRun(coordinator, ctx, scope, stage)).decision).toBe("repair");
		expect(coordinator.state.attempts[0]).toMatchObject({ readCalls: 2, modelTurns: 2 });
	});

	it("continues past four tool turns and reports a later real provider failure", async () => {
		const { harness, coordinator, ctx, scope } = await setup();
		recordAction(coordinator, "generate", true, "Original generation error.", "blocked");
		harness.setResponses([
			...Array.from({ length: 6 }, () =>
				fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline", offset: 0 })], {
					stopReason: "toolUse",
				}),
			),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Provider refused request" }),
			fauxAssistantMessage("must not be called"),
		]);
		const diagnosis = await diagnoseSureRun(coordinator, ctx, scope, stage);
		expect(checkpointReason(diagnosis)).toContain("Provider refused request");
		expect(checkpointReason(diagnosis)).toContain("model turns 7, reads 6");
		expect(harness.getPendingResponseCount()).toBe(1);
		const report = buildSureFailureReport({ ...coordinator.run, status: "failed" }, coordinator);
		for (const expanded of [false, true]) {
			const text = renderSureFailureReport(report, expanded);
			expect(text).toContain("Original generation error.");
			expect(text).toContain("Provider refused request");
			expect(text).toContain("No validated supervisor task");
		}
	});

	it("provides simple handoff tool parameters without model-filled identity or audit fields", async () => {
		const { harness, coordinator, ctx, scope } = await setup();
		harness.setResponses([
			(context) => {
				const tools = context.tools ?? [];
				const tool = tools.find((tool) => tool.name === "sure_handoff_repair")!;
				const validator = Compile(tool.parameters);
				expect(validator.Check({ task: "Run the original check." })).toBe(true);
				expect(validator.Check({ task: {} })).toBe(false);
				expect(JSON.stringify(context.messages)).toContain(coordinator.state.unitId);
				return fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline" })], {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage([fauxToolCall("sure_handoff_repair", { task: "Run the original check." })], {
				stopReason: "toolUse",
			}),
		]);
		expect((await diagnoseSureRun(coordinator, ctx, scope, stage)).decision).toBe("repair");
	});

	it("keeps a successful partial attempt visible beside the subsequent blocker", async () => {
		const { harness, coordinator, ctx, scope } = await setup();
		recordAction(coordinator, "generate", true, "Generation failed: default mode unavailable.", "blocked");
		recordAction(coordinator, "partial", false, "Generated alternate/report.json", "pending");
		recordAction(coordinator, "inspect", true, "ENOENT: artifacts/report.json", "blocked");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline" })], {
				stopReason: "toolUse",
			}),
			(context) => {
				const page = JSON.parse(
					getMessageText(context.messages.filter((message) => message.role === "toolResult").at(-1)),
				);
				expect(page.complete).toBe(true);
				const timeline = JSON.parse(page.text);
				const actions = [...timeline.priorUnitActions, ...timeline.currentAttempt.actions];
				expect(actions.map((action: { toolCallId: string }) => action.toolCallId).sort()).toEqual([
					"generate",
					"inspect",
					"partial",
				]);
				const partial = actions.find((action: { toolCallId: string }) => action.toolCallId === "partial");
				expect(partial).toMatchObject({
					outcome: "pending",
					isError: false,
				});
				expect(partial.inputTruncated).toBeUndefined();
				expect(partial.resultPreview).toBeUndefined();
				expect(timeline.repairScope.readOnly).toContain("project:source.json");
				return fauxAssistantMessage(
					[fauxToolCall("sure_diagnostic_read", { operation: "actions", toolCallId: "partial" })],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				const page = JSON.parse(
					getMessageText(context.messages.filter((message) => message.role === "toolResult").at(-1)),
				);
				const action = JSON.parse(page.text);
				expect(action).toMatchObject({
					toolCallId: "partial",
					outcome: "pending",
					isError: false,
					inputPreview: { complete: true },
					resultPreview: { text: "Generated alternate/report.json", complete: true },
				});
				expect(action.exitCode).toBeUndefined();
				return repairHandoff(repairTask);
			},
		]);
		expect((await diagnoseSureRun(coordinator, ctx, scope, stage)).decision).toBe("repair");
		expect(coordinator.state.repairs).toEqual([]);
	});

	it("locates relevant logic beyond the first page and reads raw source offsets", async () => {
		const body = `说明🌍\n${"padding\n".repeat(1600)}effective_option = requested_options\n`;
		const { harness, coordinator, ctx, scope } = await setup(body);
		recordAction(coordinator, "generate", true, "Generation failed.", "blocked");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				[
					fauxToolCall("sure_diagnostic_read", {
						operation: "search",
						path: "package:helper.txt",
						query: "effective_option",
					}),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				const page = JSON.parse(
					getMessageText(context.messages.filter((message) => message.role === "toolResult").at(-1)),
				);
				const search = JSON.parse(page.text);
				expect(search.matches[0]).toMatchObject({ sourceOffset: body.indexOf("effective_option"), line: 1602 });
				return fauxAssistantMessage(
					[
						fauxToolCall("sure_diagnostic_read", {
							operation: "file",
							path: "package:helper.txt",
							offset: search.matches[0].sourceOffset,
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				const page = JSON.parse(
					getMessageText(context.messages.filter((message) => message.role === "toolResult").at(-1)),
				);
				expect(page).toMatchObject({
					format: "text",
					path: "package:helper.txt",
					complete: true,
					text: "effective_option = requested_options\n",
				});
				return repairHandoff(repairTask);
			},
		]);
		expect((await diagnoseSureRun(coordinator, ctx, scope, stage)).decision).toBe("repair");
		expect(coordinator.state.attempts[0]).toMatchObject({ readCalls: 3, modelTurns: 4 });
	});

	it("feeds back invalid task shape and keeps the original execution failure in the pause report", async () => {
		const { harness, coordinator, ctx, scope } = await setup();
		recordAction(coordinator, "generate", true, "Generation failed: default mode unavailable.", "blocked");
		recordAction(coordinator, "partial", false, "Generated alternate/report.json", "pending");
		recordAction(coordinator, "inspect", true, "ENOENT: artifacts/report.json", "blocked");
		const invalidTask = { focusPaths: ["project:source.json"], nextActions: ["Change the original source input."] };
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("sure_handoff_repair", { task: invalidTask })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("must not be called"),
		]);
		const diagnosis = await diagnoseSureRun(coordinator, ctx, scope, stage);
		expect(checkpointReason(diagnosis)).toMatch(/task.*string|task.*object/);
		coordinator.acceptDiagnosis(diagnosis);
		expect(coordinator.state.repairs).toEqual([]);
		const report = buildSureFailureReport({ ...coordinator.run, status: "failed" }, coordinator, {
			checkpoint: { resumable: true },
		});
		for (const expanded of [true, false]) {
			const text = renderSureFailureReport(report, expanded);
			expect(text).toContain("ENOENT: artifacts/report.json");
			expect(text).toMatch(/task.*string|task.*object/);
			expect(text).toContain("No validated supervisor task");
		}
		expect(report.hypotheses).not.toContain(invalidTask.nextActions[0]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it.each([
		{ field: "validation", value: "  " },
		{ field: "stopBoundary", value: 3 },
		{ field: "evidenceReferences", value: [] },
		{ field: "targetFiles", value: [3] },
		{ field: "hypotheses", value: [3] },
		{ field: "evidenceVersion", value: "3" },
	])("rejects malformed persisted diagnosis $field without coercion", async ({ field, value }) => {
		const { coordinator } = await setup();
		recordAction(coordinator, "generate", true, "Generation failed.", "blocked");
		const output = JSON.parse(JSON.stringify({ ...storedRepairResult(coordinator), [field]: value }));
		expect(() => parseSureDiagnosisResult(output)).toThrow(field);
	});

	it("uses the retained file version for both search and raw reads", async () => {
		const { harness, coordinator, ctx, scope } = await setup("retained_logic\n");
		recordAction(coordinator, "generate", true, "Generation failed.", "blocked");
		writeFileSync(join(coordinator.run.packageDir, "helper.txt"), "changed_live_logic\n");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				[
					fauxToolCall("sure_diagnostic_read", {
						operation: "search",
						path: "package:helper.txt",
						query: "retained_logic",
					}),
					fauxToolCall("sure_diagnostic_read", { operation: "file", path: "package:helper.txt" }),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				const pages = context.messages
					.filter((message) => message.role === "toolResult")
					.slice(-2)
					.map((message) => JSON.parse(getMessageText(message)));
				for (const page of pages)
					expect(page).toMatchObject({ source: "snapshot", snapshotId: coordinator.state.latestSnapshot });
				expect(JSON.parse(pages[0].text).matches).toHaveLength(1);
				expect(pages[1].text).toBe("retained_logic\n");
				return repairHandoff(repairTask);
			},
		]);
		expect((await diagnoseSureRun(coordinator, ctx, scope, stage)).decision).toBe("repair");
	});

	it.each(["file", "search"])("keeps %s inside the declared text-file boundary", async (operation) => {
		const { harness, coordinator, ctx, scope } = await setup();
		writeFileSync(join(coordinator.run.cwd, ".env"), "PRIVATE_FIXTURE_CONTENT");
		recordAction(coordinator, "generate", true, "Generation failed.", "blocked");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				["project:../../outside.txt", "project:.env", "package:"].map((path) =>
					fauxToolCall("sure_diagnostic_read", {
						operation,
						path,
						...(operation === "search" ? { query: "logic" } : {}),
					}),
				),
				{ stopReason: "toolUse" },
			),
			(context) => {
				const denied = context.messages.filter((message) => message.role === "toolResult").slice(-3);
				expect(denied.every((message) => message.isError)).toBe(true);
				expect(denied.map(getMessageText).join("\n")).not.toContain("PRIVATE_FIXTURE_CONTENT");
				return pauseDiagnosis("Requested evidence could not be inspected.");
			},
		]);
		expect((await diagnoseSureRun(coordinator, ctx, [...scope, "project:.env", "package:"], stage)).decision).toBe(
			"checkpoint",
		);
		expect(coordinator.state.attempts[0].readCalls).toBe(4);
	});

	it("allows ninth and later search calls before the final decision", async () => {
		const { harness, coordinator, ctx, scope } = await setup();
		recordAction(coordinator, "generate", true, "Generation failed.", "blocked");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				Array.from({ length: 8 }, () =>
					fauxToolCall("sure_diagnostic_read", {
						operation: "search",
						path: "package:helper.txt",
						query: "declared",
					}),
				),
				{ stopReason: "toolUse" },
			),
			(context) => {
				expect(context.messages.filter((m) => m.role === "toolResult").every((m) => !m.isError)).toBe(true);
				return repairHandoff(repairTask);
			},
		]);
		expect((await diagnoseSureRun(coordinator, ctx, scope, stage)).decision).toBe("repair");
		expect(coordinator.state.attempts[0].readCalls).toBe(9);
	});
});
