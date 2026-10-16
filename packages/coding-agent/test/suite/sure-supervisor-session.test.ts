import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { ToolDefinition } from "../../src/core/extensions/types.ts";
import { createIsolatedResourceLoader } from "../../src/core/isolated-resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { SureCoordinator } from "../../src/core/sure/coordinator.ts";
import { diagnoseSureRun } from "../../src/core/sure/supervisor.ts";
import { prepareSureSupervisorSession } from "../../src/core/sure/supervisor-session.ts";
import type { SureRunRecord } from "../../src/core/sure/types.ts";
import { createHarness, type Harness } from "./harness.ts";
import { toolReply } from "./sure-control-fixtures.ts";

const resources: { harness: Harness; session: AgentSession }[] = [];
const stage = { id: "first", prompt: "first.md", references: [], snapshotPaths: ["run:artifacts"] };
const macro = () => toolReply(fauxToolCall("sure_diagnostic_read", { operation: "timeline" }));
const handoff = (task = "Run the original probe and let its original gate check the result.") =>
	toolReply(fauxToolCall("sure_handoff_repair", { task }));

async function fixture() {
	const harness = await createHarness();
	const { session } = await createAgentSession({
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		model: harness.getModel(),
		modelRuntime: harness.session.modelRuntime,
		sessionManager: SessionManager.inMemory(harness.tempDir),
		tools: [],
		resourceLoader: createIsolatedResourceLoader("Executor"),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
	});
	resources.push({ harness, session });
	await session.bindExtensions({});
	const runDir = join(harness.tempDir, ".sure/runs/persistent");
	const packageDir = join(harness.tempDir, "skill");
	mkdirSync(join(runDir, "artifacts"), { recursive: true });
	mkdirSync(packageDir);
	writeFileSync(join(packageDir, "first.md"), "FIRST_STAGE_COMPLETE_RULES");
	writeFileSync(join(packageDir, "second.md"), "SECOND_STAGE_COMPLETE_RULES");
	const run: SureRunRecord = {
		runId: "persistent",
		command: "sure_feed",
		skillName: "generic",
		status: "running",
		cwd: harness.tempDir,
		packageDir,
		runDir,
		args: "mode=local",
		startedAt: "now",
		updatedAt: "now",
	};
	const scope = ["run:artifacts", "package:first.md", "package:second.md"];
	const coordinator = new SureCoordinator(run, stage.id, scope);
	return { harness, session, coordinator, scope, ctx: session.extensionRunner.createContext() };
}

afterEach(() => {
	for (const { harness, session } of resources.splice(0)) {
		session.dispose();
		harness.cleanup();
	}
});

describe("SURE persistent repair-only supervisor", () => {
	it.each([
		'{"decision":"repair","stopBoundary":"probe"],"repair":"continue"}',
		JSON.stringify({ decision: "repair", repair: "A JSON report cannot submit a task." }),
		JSON.stringify({ decision: "stop", stopReason: "A JSON report cannot stop the business task." }),
	])("rejects report text and accepts a tool handoff in the same conversation: %s", async (malformed) => {
		const { harness, coordinator, ctx, scope } = await fixture();
		harness.setResponses([
			macro(),
			fauxAssistantMessage(malformed),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain(malformed.replaceAll('"', '\\"'));
				expect(JSON.stringify(context.messages)).toContain("No task has been accepted");
				return handoff();
			},
		]);
		const outcome = await diagnoseSureRun(coordinator, ctx, scope, stage);
		expect(outcome).toMatchObject({ decision: "repair", facts: [], targetFiles: [] });
		expect(coordinator.acceptDiagnosis(outcome)).toBe(true);
		expect(coordinator.state.repairs).toHaveLength(1);
		expect(coordinator.state.supervisorSession?.status).toBe("ready");
	});

	it("reopens the exact transcript with fresh tools and current stage packet across handoffs", async () => {
		const { harness, coordinator, ctx, scope } = await fixture();
		const factory = ctx.createIsolatedSession!;
		let oldRead: ToolDefinition | undefined;
		ctx.createIsolatedSession = async (request) => {
			oldRead ??= request.tools[0];
			return factory(request);
		};
		harness.setResponses([macro(), handoff("FIRST_TASK_EVIDENCE_ROUTE")]);
		const first = await diagnoseSureRun(coordinator, ctx, scope, stage);
		expect(coordinator.acceptDiagnosis(first)).toBe(true);
		const identity = { ...coordinator.state.supervisorSession! };
		const firstAttempt = coordinator.state.attempts[0];
		await expect(oldRead!.execute("late", { operation: "timeline" }, undefined, undefined, ctx)).rejects.toThrow(
			/Stale supervisor runtime|Diagnosis segment has ended/,
		);
		const { session: compactor } = await createAgentSession({
			cwd: coordinator.run.cwd,
			agentDir: harness.tempDir,
			model: harness.getModel(),
			modelRuntime: harness.session.modelRuntime,
			sessionManager: SessionManager.open(identity.file),
			tools: [],
			resourceLoader: createIsolatedResourceLoader("Supervisor"),
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
			}),
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(
					"FIRST_TASK_EVIDENCE_ROUTE is the previous repair; its original gate remains authoritative.",
				),
			]);
			await compactor.prompt("Preserve a public note for the next stage.");
			harness.setResponses([
				fauxAssistantMessage(
					"FIRST_TASK_EVIDENCE_ROUTE remains the prior accepted repair. Its original gate is still authoritative. Resume with the current stage packet and evidence references.",
				),
			]);
			harness.appendResponses([
				fauxAssistantMessage("FIRST_TASK_EVIDENCE_ROUTE: retain the original gate and current stage facts."),
			]);
			await compactor.compact("Preserve repair identity and evidence references.");
		} finally {
			compactor.dispose();
		}
		coordinator.observe(
			{
				unitId: "first",
				outcome: "passed",
				summary: "Original first gate passed",
				inputPaths: [],
				artifactPaths: [],
			},
			scope,
		);
		coordinator.recordAction("second", "probe", { current: true });
		coordinator.barrier(scope);
		harness.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("FIRST_TASK_EVIDENCE_ROUTE");
				expect(JSON.stringify(context.messages)).toContain("SECOND_STAGE_COMPLETE_RULES");
				expect(context.tools?.map((tool) => tool.name)).toEqual([
					"sure_diagnostic_read",
					"sure_handoff_repair",
					"sure_pause_diagnosis",
				]);
				return macro();
			},
			(context) => {
				const result = context.messages.filter((message) => message.role === "toolResult").at(-1)!;
				const page = JSON.parse(result.content.find((block) => block.type === "text")!.text);
				expect(JSON.parse(page.text).unitId).toBe("second");
				return handoff("SECOND_TASK");
			},
		]);
		const second = await diagnoseSureRun(coordinator, ctx, scope, { ...stage, id: "second", prompt: "second.md" });
		expect(second).toMatchObject({ unitId: "second", repair: "SECOND_TASK" });
		expect(coordinator.state.supervisorSession).toMatchObject({ id: identity.id, file: identity.file });
		expect(coordinator.state.attempts).toHaveLength(2);
		expect(coordinator.state.attempts.map((attempt) => attempt.supervisorSessionId)).toEqual([
			identity.id,
			identity.id,
		]);
		expect(firstAttempt.modelTurns).toBe(2);
		expect(coordinator.state.attempts[1].modelTurns).toBe(2);
	});

	it("pauses after the initial failure and three corrective rereads without new evidence, without a business stop", async () => {
		const { harness, coordinator, ctx, scope } = await fixture();
		harness.setResponses([
			macro(),
			fauxAssistantMessage("Still writing a report rather than handing off."),
			...Array.from({ length: 3 }, () => macro()),
		]);
		const outcome = await diagnoseSureRun(coordinator, ctx, scope, stage);
		expect(outcome).toMatchObject({ decision: "checkpoint", automatic: false });
		if (outcome.decision === "checkpoint") expect(outcome.checkpoint).toContain("protocol_paused");
		expect(coordinator.state.status).toBe("diagnosing");
		expect(coordinator.state.stopReason).toBeUndefined();
		expect(coordinator.state.attempts[0].modelTurns).toBe(5);
	});

	it("refuses retired stop capability and can then hand off a repair", async () => {
		const { harness, coordinator, ctx, scope } = await fixture();
		harness.setResponses([
			macro(),
			toolReply(fauxToolCall("sure_request_stop", { reason: "Impossible" })),
			handoff(),
		]);
		const outcome = await diagnoseSureRun(coordinator, ctx, scope, stage);
		expect(outcome.decision).toBe("repair");
		expect(coordinator.acceptDiagnosis({ decision: "stop" })).toBe(false);
		expect(coordinator.state.stopReason).toBeUndefined();
	});

	it("rejects conflicting control calls in a batch before any repair is accepted", async () => {
		const { harness, coordinator, ctx, scope } = await fixture();
		harness.setResponses([
			macro(),
			toolReply(
				fauxToolCall("sure_handoff_repair", { task: "one" }),
				fauxToolCall("sure_handoff_repair", { task: "two" }),
			),
			handoff("unique"),
		]);
		const outcome = await diagnoseSureRun(coordinator, ctx, scope, stage);
		expect(outcome).toMatchObject({ repair: "unique" });
		expect(coordinator.state.repairs).toEqual([]);
	});

	it("preserves damaged transcripts and marks interrupted calls without replay", async () => {
		const { harness, coordinator, ctx, scope } = await fixture();
		harness.setResponses([macro(), handoff()]);
		await diagnoseSureRun(coordinator, ctx, scope, stage);
		const file = coordinator.state.supervisorSession!.file;
		const manager = SessionManager.open(file);
		manager.appendMessage(toolReply(fauxToolCall("sure_handoff_repair", { task: "abandoned branch" })));
		manager.branch(coordinator.state.supervisorSession!.leafId!);
		manager.appendMessage(fauxAssistantMessage("Current branch retained the saved checkpoint."));
		expect(prepareSureSupervisorSession(coordinator).recoveryMessages).toEqual([]);
		manager.appendMessage(toolReply(fauxToolCall("sure_handoff_repair", { task: "interrupted" })));
		const prepared = prepareSureSupervisorSession(coordinator);
		expect(prepared.recoveryMessages).toHaveLength(1);
		expect(prepared.recoveryMessages[0]).toMatchObject({ isError: true });
		writeFileSync(file, `${readFileSync(file, "utf8")}broken-tail`);
		expect(() => prepareSureSupervisorSession(coordinator)).toThrow();
		expect(readFileSync(file, "utf8")).toContain("broken-tail");
		rmSync(file);
		expect(() => prepareSureSupervisorSession(coordinator)).toThrow("missing");
		expect(existsSync(file)).toBe(false);
	});

	it("rejects cached results and a new investigation after cancellation without writing evidence", async () => {
		const { harness, coordinator, ctx, scope } = await fixture();
		harness.setResponses([macro(), handoff()]);
		const outcome = await diagnoseSureRun(coordinator, ctx, scope, stage);
		coordinator.stop("User cancelled after the result was saved.", true);
		const before = readFileSync(join(coordinator.run.runDir, "coordination.json"), "utf8");
		expect(coordinator.acceptDiagnosis(outcome)).toBe(false);
		expect(() => coordinator.beginDiagnosis()).toThrow("stopped or cancelled");
		await expect(diagnoseSureRun(coordinator, ctx, scope, stage)).rejects.toThrow("stopped or cancelled");
		expect(readFileSync(join(coordinator.run.runDir, "coordination.json"), "utf8")).toBe(before);
		expect(coordinator.state.attempts).toHaveLength(1);
	});

	it("aborts the independent provider from authoritative stop even when the executor signal stays live", async () => {
		const { harness, coordinator, ctx, scope } = await fixture();
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		harness.setResponses([
			async (_context, options) => {
				started();
				await new Promise<void>((resolve) => {
					options?.signal?.addEventListener("abort", () => resolve(), { once: true });
					if (options?.signal?.aborted) resolve();
				});
				return fauxAssistantMessage("", { stopReason: "aborted" });
			},
		]);
		const signal = new AbortController().signal;
		const pending = diagnoseSureRun(coordinator, { ...ctx, signal }, scope, stage);
		await ready;
		coordinator.stop("User cancelled the authoritative run.", true);
		const outcome = await pending;
		expect(signal.aborted).toBe(false);
		expect(outcome).toMatchObject({ decision: "checkpoint" });
		expect(coordinator.state).toMatchObject({ status: "stopped", cancelled: true });
		expect(coordinator.supervisorRuntime).toBeUndefined();
		expect(coordinator.diagnosisAbortController).toBeUndefined();
	});
});
