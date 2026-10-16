import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
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
import { pauseDiagnosis, repairHandoff, toolReply } from "./sure-control-fixtures.ts";

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
			recovery: "local_once",
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

const storedRepairResult: SureDiagnosisResult = {
	runId: "report-recovery",
	unitId: "prepare_report",
	evidenceVersion: 1,
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
			return toolReply(
				fauxToolCall("sure_diagnostic_read", { operation: "file", path: reference, offset: page.nextOffset }),
			);
		};
		harness.setResponses([
			toolReply(
				fauxToolCall("sure_diagnostic_read", { operation: "timeline" }, { id: "macro" }),
				fauxToolCall("sure_diagnostic_read", { operation: "user_context" }),
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
				return toolReply(fauxToolCall("sure_diagnostic_read", { operation: "file", path: reference }));
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
				return toolReply(
					fauxToolCall("sure_diagnostic_read", {
						operation,
						offset: page.nextOffset,
						...(operation === "file" ? { path } : {}),
					}),
				);
			};
			harness.setResponses([
				toolReply(fauxToolCall("sure_diagnostic_read", { operation: "timeline" })),
				toolReply(fauxToolCall("sure_diagnostic_read", { operation, ...(operation === "file" ? { path } : {}) })),
				...Array.from({ length: 50 }, () => continuation),
			]);
			expect((await diagnoseSureRun(coordinator, ctx, scope, stage)).decision).toBe("repair");
			expect(assembled).toBe(body);
			expect(coordinator.state.attempts[0].readCalls).toBeGreaterThan(9);
			expect(coordinator.state.attempts[0].modelTurns).toBeGreaterThan(4);
			expect(coordinator.state.units.prepare_report.checks).toBe(1);
		},
	);
	it("returns four explicit action previews together within the baseline response size", async () => {
		const { harness, coordinator, ctx, scope } = await setup();
		const ids = ["first", "second", "third", "fourth"];
		for (const id of ids) recordAction(coordinator, id, true, "Original result ".repeat(200), "blocked");
		harness.setResponses([
			toolReply(fauxToolCall("sure_diagnostic_read", { operation: "timeline" })),
			toolReply(fauxToolCall("sure_diagnostic_read", { operation: "actions", toolCallIds: ids })),
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
			toolReply(fauxToolCall("sure_diagnostic_read", { operation: "timeline" })),
			toolReply(fauxToolCall("sure_diagnostic_read", { operation: "actions", toolCallIds })),
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
			toolReply(fauxToolCall("sure_diagnostic_read", { operation: "timeline" })),
			toolReply(fauxToolCall("sure_diagnostic_read", request)),
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

	it("retains stage contracts and upstream outputs while separating task diffs from action evidence", async () => {
		const { harness, coordinator, ctx, scope } = await setup();
		writeSureJson(join(coordinator.run.runDir, "artifacts/research.json"), {
			source: "retained research",
			revision: 1,
		});
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
		writeSureJson(join(coordinator.run.runDir, "artifacts/research.json"), {
			source: "retained research",
			revision: 2,
		});
		recordAction(coordinator, "inspect", true, "ENOENT: artifacts/guessed-prerequisite.json", "blocked");
		writeFileSync(join(coordinator.run.packageDir, "stage.md"), "CHANGED_LIVE_CONTRACT");
		harness.setResponses([
			(context) => {
				const prompt = context.messages.map(getMessageText).join("\n");
				expect(prompt).toContain("Produce artifacts/report.json using the passed research output.");
				expect(prompt).not.toContain("CHANGED_LIVE_CONTRACT");
				expect(prompt).toContain("Evidence scope is not a prerequisite list");
				expect(prompt).toContain("missing file itself is not a valid file reference");
				return toolReply(fauxToolCall("sure_diagnostic_read", { operation: "timeline" }));
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
				return toolReply(
					fauxToolCall("sure_diagnostic_read", { operation: "file", path: "run:artifacts/research.json" }),
					fauxToolCall("sure_diagnostic_read", { operation: "diff" }),
					fauxToolCall("sure_diagnostic_read", { operation: "diff", path: "run:evidence/tools/inspect.json" }),
				);
			},
			(context) => {
				const pages = context.messages
					.filter((m) => m.role === "toolResult")
					.slice(-3)
					.map((m) => JSON.parse(getMessageText(m)));
				expect(pages[0].text).toContain("retained research");
				expect(
					JSON.parse(pages[1].text).index.some((file: { path: string }) =>
						file.path.startsWith("run:evidence/tools/"),
					),
				).toBe(false);
				expect(JSON.parse(pages[1].text).index).toContainEqual({
					path: "run:artifacts/research.json",
					before: "text",
					after: "text",
				});
				expect(JSON.parse(pages[2].text).diff).toContain("run:evidence/tools/inspect.json");
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
		expect(coordinator.state.attempts[0]).toMatchObject({ readCalls: 4, modelTurns: 3 });
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

	it("continues omitted offsets, rejects gaps and preserves progress across concurrent rereads", async () => {
		const { harness, coordinator, ctx, scope } = await setup();
		coordinator.run.args = "long authoritative argument ".repeat(4500);
		recordAction(coordinator, "generate", true, "Generation failed.", "blocked");
		harness.setResponses([
			toolReply(fauxToolCall("sure_diagnostic_read", { operation: "timeline" })),
			(context) => {
				const page = JSON.parse(
					getMessageText(context.messages.filter((message) => message.role === "toolResult").at(-1)),
				);
				expect(page.timelineProgress).toMatchObject({ deliveredCharacters: 50 * 1024, complete: false });
				return toolReply(
					fauxToolCall("sure_diagnostic_read", { operation: "timeline", offset: 100 * 1024 }),
					fauxToolCall("sure_diagnostic_read", { operation: "diff" }),
					fauxToolCall("sure_diagnostic_read", { operation: "timeline", offset: 0 }),
					fauxToolCall("sure_diagnostic_read", { operation: "timeline" }),
					fauxToolCall("sure_diagnostic_read", { operation: "timeline" }),
				);
			},
			(context) => {
				const responses = context.messages.filter((message) => message.role === "toolResult").slice(-5);
				for (const response of responses.slice(0, 2)) {
					expect(response.isError).toBe(true);
					const denied = JSON.parse(getMessageText(response));
					expect(denied.nextRead).toEqual({ operation: "timeline", offset: 50 * 1024 });
					expect(denied.timelineProgress.deliveredCharacters).toBe(50 * 1024);
					expect(denied.budget.reads.used).toBeGreaterThan(1);
				}
				const pages = responses.slice(2).map((message) => JSON.parse(getMessageText(message)));
				expect(pages.map((page) => page.offset)).toEqual([0, 50 * 1024, 100 * 1024]);
				expect(pages[0].timelineProgress.deliveredCharacters).toBe(50 * 1024);
				expect(pages[2].timelineProgress).toMatchObject({
					deliveredCharacters: pages[2].totalCharacters,
					complete: true,
				});
				return toolReply(fauxToolCall("sure_diagnostic_read", { operation: "timeline", offset: 0 }));
			},
			(context) => {
				const page = JSON.parse(
					getMessageText(context.messages.filter((message) => message.role === "toolResult").at(-1)),
				);
				expect(page.complete).toBe(false);
				expect(page.timelineProgress.complete).toBe(true);
				return repairHandoff(repairTask);
			},
		]);
		expect((await diagnoseSureRun(coordinator, ctx, scope, stage)).decision).toBe("repair");
		expect(coordinator.state.attempts[0]).toMatchObject({ readCalls: 7, modelTurns: 4 });
	});

	it("continues past four tool turns and reports a later real provider failure", async () => {
		const { harness, coordinator, ctx, scope } = await setup();
		recordAction(coordinator, "generate", true, "Original generation error.", "blocked");
		harness.setResponses([
			...Array.from({ length: 6 }, () =>
				toolReply(fauxToolCall("sure_diagnostic_read", { operation: "timeline", offset: 0 })),
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

	it("cannot accept a repair after requesting only an undelivered later page", async () => {
		const { harness, coordinator, ctx, scope } = await setup();
		coordinator.run.args = "long argument ".repeat(4000);
		recordAction(coordinator, "generate", true, "Original generation error.", "blocked");
		harness.setResponses([
			toolReply(fauxToolCall("sure_diagnostic_read", { operation: "timeline", offset: 50 * 1024 })),
			(context) => {
				const message = context.messages.filter((message) => message.role === "toolResult").at(-1)!;
				expect(message.isError).toBe(true);
				const denied = JSON.parse(getMessageText(message));
				expect(denied.timelineProgress).toMatchObject({ deliveredCharacters: 0, complete: false });
				expect(denied.nextRead).toEqual({ operation: "timeline", offset: 0 });
				return repairHandoff(repairTask);
			},
		]);
		const diagnosis = await diagnoseSureRun(coordinator, ctx, scope, stage);
		expect(checkpointReason(diagnosis)).toContain("complete macro timeline");
		expect(checkpointReason(diagnosis)).toMatch(/macro delivered 0\/\d+/);
		expect(coordinator.state.attempts[0]).toMatchObject({ readCalls: 1, modelTurns: 3 });
	});
	it("keeps a successful partial attempt visible beside the subsequent blocker", async () => {
		const { harness, coordinator, ctx, scope } = await setup();
		recordAction(coordinator, "generate", true, "Generation failed: default mode unavailable.", "blocked");
		recordAction(coordinator, "partial", false, "Generated alternate/report.json", "pending");
		recordAction(coordinator, "inspect", true, "ENOENT: artifacts/report.json", "blocked");
		harness.setResponses([
			toolReply(fauxToolCall("sure_diagnostic_read", { operation: "timeline" })),
			(context) => {
				const page = JSON.parse(
					getMessageText(context.messages.filter((message) => message.role === "toolResult").at(-1)),
				);
				expect(page.complete).toBe(true);
				const timeline = JSON.parse(page.text);
				expect(
					[...timeline.priorUnitActions, ...timeline.currentAttempt.actions].map(
						(action: { toolCallId: string }) => action.toolCallId,
					),
				).toEqual(["generate", "partial", "inspect"]);
				expect(timeline.priorUnitActions[1]).toMatchObject({
					outcome: "pending",
					isError: false,
				});
				expect(timeline.priorUnitActions[1].inputTruncated).toBeUndefined();
				expect(timeline.priorUnitActions[1].resultPreview).toBeUndefined();
				expect(timeline.repairScope.readOnly).toContain("project:source.json");
				return toolReply(fauxToolCall("sure_diagnostic_read", { operation: "actions", toolCallId: "partial" }));
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
		expect(coordinator.state.units.prepare_report).toMatchObject({ directRepairs: 2, supervisorRepairs: 0 });
	});

	it("searches and reads retained raw source offsets after the live file changes", async () => {
		const body = `说明🌍\n${"padding\n".repeat(1600)}effective_option = requested_options\n`;
		const { harness, coordinator, ctx, scope } = await setup(body);
		recordAction(coordinator, "generate", true, "Generation failed.", "blocked");
		writeFileSync(join(coordinator.run.packageDir, "helper.txt"), "CHANGED_LIVE_LOGIC");
		harness.setResponses([
			toolReply(fauxToolCall("sure_diagnostic_read", { operation: "timeline" })),
			toolReply(
				fauxToolCall("sure_diagnostic_read", {
					operation: "search",
					path: "package:helper.txt",
					query: "effective_option",
				}),
			),
			(context) => {
				const page = JSON.parse(
					getMessageText(context.messages.filter((message) => message.role === "toolResult").at(-1)),
				);
				expect(page).toMatchObject({ source: "snapshot", snapshotId: coordinator.state.latestSnapshot });
				const search = JSON.parse(page.text);
				expect(search.matches[0]).toMatchObject({ sourceOffset: body.indexOf("effective_option"), line: 1602 });
				return toolReply(
					fauxToolCall("sure_diagnostic_read", {
						operation: "file",
						path: "package:helper.txt",
						offset: search.matches[0].sourceOffset,
					}),
				);
			},
			(context) => {
				const page = JSON.parse(
					getMessageText(context.messages.filter((message) => message.role === "toolResult").at(-1)),
				);
				expect(page).toMatchObject({
					format: "text",
					source: "snapshot",
					snapshotId: coordinator.state.latestSnapshot,
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
			toolReply(fauxToolCall("sure_diagnostic_read", { operation: "timeline" })),
			toolReply(fauxToolCall("sure_handoff_repair", { task: invalidTask })),
			fauxAssistantMessage("must not be called"),
		]);
		const diagnosis = await diagnoseSureRun(coordinator, ctx, scope, stage);
		expect(checkpointReason(diagnosis)).toMatch(/task.*string|task.*object/);
		coordinator.acceptDiagnosis(diagnosis);
		expect(coordinator.state.units.prepare_report.supervisorRepairs).toBe(0);
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
		{ field: "stopBoundary", value: undefined },
		{ field: "evidenceReferences", value: [] },
		{ field: "targetFiles", value: undefined },
		{ field: "hypotheses", value: [3] },
		{ field: "evidenceVersion", value: "3" },
	])("rejects malformed persisted diagnosis $field without coercion", ({ field, value }) => {
		const output = { ...storedRepairResult, [field]: value };
		expect(() => parseSureDiagnosisResult(output)).toThrow(field);
	});

	it.each(["file", "search"])("keeps %s inside the declared text-file boundary", async (operation) => {
		const { harness, coordinator, ctx, scope } = await setup();
		writeFileSync(join(coordinator.run.cwd, ".env"), "PRIVATE_FIXTURE_CONTENT");
		recordAction(coordinator, "generate", true, "Generation failed.", "blocked");
		harness.setResponses([
			toolReply(fauxToolCall("sure_diagnostic_read", { operation: "timeline" })),
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
		expect(coordinator.state.attempts[0].stopValidated).toBeUndefined();
	});
});
