import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { createIsolatedResourceLoader } from "../../src/core/isolated-resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import type { IsolatedSession } from "../../src/core/session-controls.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { SureDiagnosisOutcome } from "../../src/core/sure/coordination-types.ts";
import { SureCoordinator } from "../../src/core/sure/coordinator.ts";
import { writeSureJson } from "../../src/core/sure/evidence.ts";
import { diagnoseSureRun } from "../../src/core/sure/supervisor.ts";
import type { SureRunRecord, SureSkillPackage } from "../../src/core/sure/types.ts";
import { readSureUserContext, syncSureUserContext } from "../../src/core/sure/user-context.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";
import { pauseDiagnosis, repairHandoff, toolReply } from "./sure-control-fixtures.ts";

function checkpointReason(outcome: SureDiagnosisOutcome): string {
	expect(outcome.decision).toBe("checkpoint");
	if (outcome.decision !== "checkpoint") throw new Error("Expected an incomplete investigation.");
	return outcome.checkpoint;
}

const harnesses: Harness[] = [];
const sessions: AgentSession[] = [];
const repairTask = "Repair CUDA dependencies in the declared model runtime and rerun the same gate.";
const stage = { id: "build_env", prompt: "stage.md", references: [], snapshotPaths: ["run:artifacts"] };

async function setup() {
	const harness = await createHarness();
	harnesses.push(harness);
	const { session } = await createAgentSession({
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		model: harness.getModel(),
		modelRuntime: harness.session.modelRuntime,
		sessionManager: SessionManager.inMemory(harness.tempDir),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
		resourceLoader: createIsolatedResourceLoader("Parent executor"),
		tools: [],
	});
	sessions.push(session);
	await session.bindExtensions({});
	const runDir = join(harness.tempDir, ".sure/runs/test-run");
	mkdirSync(join(runDir, "artifacts"), { recursive: true });
	const run: SureRunRecord = {
		runId: "test-run",
		skillName: "demo",
		command: "sure_feed",
		status: "running",
		cwd: harness.tempDir,
		packageDir: harness.tempDir,
		runDir,
		args: "model=demo device=cuda",
		startedAt: "now",
		updatedAt: "now",
	};
	writeFileSync(
		join(run.packageDir, "stage.md"),
		"Prepare the declared model environment and rerun its original check.",
	);
	const coordinator = new SureCoordinator(run, "build_env", ["run:artifacts", "package:stage.md"]);
	coordinator.observe(
		{
			unitId: "build_env",
			outcome: "blocked",
			failureKind: "semantic",
			summary: "Original CUDA environment failure",
			inputPaths: ["run:artifacts"],
			artifactPaths: [],
		},
		["run:artifacts", "package:stage.md"],
	);
	const ctx = session.extensionRunner.createContext();
	ctx.setExecutionHold?.(true);

	return { harness, session, coordinator, ctx };
}

afterEach(() => {
	vi.useRealTimers();
	for (const session of sessions.splice(0)) session.dispose();
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("Sure independent read-only supervisor", () => {
	it.each(["read", "edit", "change"])(
		"discovers related sources and checks read/write/version boundaries: %s",
		async (mode) => {
			const { harness, coordinator, ctx } = await setup();
			coordinator.run.packageDir = join(coordinator.run.cwd, "skill");
			mkdirSync(coordinator.run.packageDir);
			writeFileSync(
				join(coordinator.run.packageDir, "stage.md"),
				"Prepare and seal the draft with the original helper.",
			);
			mkdirSync(join(coordinator.run.cwd, "config"));
			writeFileSync(join(coordinator.run.cwd, "config/actual.yaml"), "local_python: true\n");
			writeFileSync(join(coordinator.run.cwd, "config/.env"), "PRIVATE_CONTENT");
			symlinkSync(join(coordinator.run.cwd, "config/.env"), join(coordinator.run.cwd, "alias.txt"));
			writeFileSync(join(coordinator.run.cwd, "loader.txt"), "policy comes from config/actual.yaml\n");
			writeSureJson(join(coordinator.run.runDir, "evidence/tools/prior-read.json"), {
				toolCallId: "prior-read",
				toolName: "read",
				unitId: "build_env",
				requestedAt: "2000-01-01",
				cwd: coordinator.run.cwd,
				input: { path: "loader.txt" },
				content: "policy comes from config/actual.yaml",
				isError: false,
			});
			const scope = ["run:artifacts", "package:stage.md", "project:config"];
			const declaredStage = { ...stage, diagnosticPaths: ["project:config"] };
			coordinator.barrier(scope);
			harness.setResponses([
				toolReply(fauxToolCall("sure_diagnostic_read", { operation: "timeline" })),
				(context) => {
					const message = context.messages.filter((message) => message.role === "toolResult").at(-1)!;
					const macro = JSON.parse(JSON.parse(message.content.find((block) => block.type === "text")!.text).text);
					expect(macro.priorUnitActions[0].toolCallId).toBe("prior-read");
					return toolReply(
						fauxToolCall("sure_diagnostic_read", { operation: "list", path: "project:config" }),
						fauxToolCall("sure_diagnostic_read", { operation: "file", path: "project:loader.txt" }),
						fauxToolCall("sure_diagnostic_read", { operation: "file", path: "project:alias.txt" }),
					);
				},
				(context) => {
					const messages = context.messages.filter((message) => message.role === "toolResult").slice(-3);
					const text = (index: number) => messages[index].content.find((block) => block.type === "text")!.text;
					expect(
						JSON.parse(JSON.parse(text(0)).text).entries.map((entry: { name: string }) => entry.name),
					).toEqual(["actual.yaml"]);
					expect(JSON.parse(text(1))).toMatchObject({
						source: "file",
						resolvedPath: "project:loader.txt",
						text: "policy comes from config/actual.yaml\n",
					});
					expect(messages[2].isError).toBe(true);
					expect(text(2)).not.toContain("PRIVATE_CONTENT");
					if (mode === "change") writeFileSync(join(coordinator.run.cwd, "loader.txt"), "new policy source\n");
					return repairHandoff(repairTask, mode === "edit" ? ["project:config/actual.yaml"] : []);
				},
			]);
			const outcome = await diagnoseSureRun(coordinator, ctx, scope, declaredStage);
			expect(outcome.decision).toBe(mode === "read" ? "repair" : "checkpoint");
			if (mode === "edit")
				expect(checkpointReason(outcome)).toContain("Focus path is outside original task permissions");
			if (mode === "change") {
				expect(checkpointReason(outcome)).toContain("Live diagnostic source changed");
				harness.setResponses([
					toolReply(fauxToolCall("sure_diagnostic_read", { operation: "timeline" })),
					toolReply(fauxToolCall("sure_diagnostic_read", { operation: "file", path: "project:loader.txt" })),
					() => repairHandoff(repairTask),
				]);
				expect((await diagnoseSureRun(coordinator, ctx, scope, declaredStage)).decision).toBe("repair");
				expect(coordinator.state.attempts).toHaveLength(2);
			}
		},
	);

	it("bounds host pause text while retaining a long original diagnostic error", async () => {
		const { coordinator, ctx } = await setup();
		const reason = "provider unavailable ".repeat(1000);
		ctx.createIsolatedSession = async () => {
			throw new Error(reason);
		};
		const outcome = await diagnoseSureRun(coordinator, ctx, [], stage);
		expect(checkpointReason(outcome).length).toBeLessThanOrEqual(4000);
		expect(outcome.facts).toContain("Original CUDA environment failure");
		expect(coordinator.state.stopReason).toBeUndefined();
		const attempt = coordinator.state.attempts[0];
		expect(
			JSON.parse(readFileSync(join(coordinator.run.runDir, "diagnoses", attempt.id, "segment-error-1.json"), "utf8"))
				.reason,
		).toBe(reason);
		expect(existsSync(join(coordinator.run.runDir, "diagnoses", attempt.id, "result.json"))).toBe(false);
	});

	it("delivers the complete frozen global manual and common rules alongside the local contract", async () => {
		const { harness, coordinator, ctx } = await setup();
		const manual = `GLOBAL_START\n${"Long global instruction.\n".repeat(1000)}GLOBAL_END`;
		writeFileSync(join(coordinator.run.packageDir, "SKILL.md"), manual);
		writeFileSync(join(coordinator.run.packageDir, "common.md"), "COMPLETE_COMMON_RULES");
		const scope = ["run:artifacts", "package:stage.md", "package:SKILL.md", "package:common.md"];
		coordinator.barrier(scope);
		const skill: SureSkillPackage = {
			manifest: {
				name: "demo",
				command: "sure_feed",
				prompt: "SKILL.md",
				coordination: { version: 1, commonPrompt: "common.md", stages: [stage] },
			},
			packageDir: coordinator.run.packageDir,
			manifestPath: "",
			promptPath: "",
			prompt: manual,
			source: "project",
			sourceRoot: coordinator.run.packageDir,
		};
		writeFileSync(join(coordinator.run.packageDir, "SKILL.md"), "CHANGED_LIVE_MANUAL");
		harness.setResponses([
			(context) => {
				expect(context.systemPrompt).toContain(manual);
				expect(context.systemPrompt).toContain("COMPLETE_COMMON_RULES");
				expect(context.systemPrompt).not.toContain("CHANGED_LIVE_MANUAL");
				return toolReply(fauxToolCall("sure_diagnostic_read", { operation: "timeline" }));
			},
			repairHandoff(repairTask),
		]);
		expect((await diagnoseSureRun(coordinator, ctx, scope, stage, skill)).decision).toBe("repair");
	});

	it("continues a three-page macro in the same logical investigation beyond one segment", async () => {
		const { harness, coordinator, ctx } = await setup();
		coordinator.run.args = "long argument ".repeat(8500);
		let offset = 0;
		for (let segment = 0; segment < 3; segment++) {
			harness.setResponses([
				toolReply(fauxToolCall("sure_diagnostic_read", { operation: "timeline" })),
				(context) => {
					const message = context.messages.filter((message) => message.role === "toolResult").at(-1)!;
					const page = JSON.parse(message.content.find((block) => block.type === "text")!.text);
					expect(page.offset).toBe(offset);
					offset = page.nextOffset;
					if (segment === 2) {
						expect(page.timelineProgress.complete).toBe(true);
						return repairHandoff(repairTask);
					}
					return pauseDiagnosis("Continue the undelivered macro; local cause remains unknown.");
				},
			]);
			const outcome = await diagnoseSureRun(coordinator, ctx, [], stage);
			expect(outcome.decision).toBe(segment === 2 ? "repair" : "checkpoint");
		}
		expect(coordinator.state.attempts).toHaveLength(1);
		expect(coordinator.state.attempts[0]).toMatchObject({ modelTurns: 6, readCalls: 3, timelineOffset: offset });
		expect(coordinator.state.attempts[0].segments).toHaveLength(3);
		expect(coordinator.state.attempts[0].usage).toBeDefined();
		expect(coordinator.state.stopReason).toBeUndefined();
		expect(coordinator.state.units.build_env.supervisorRepairs).toBe(0);
	});

	it("cancels the decision response without applying a repair or requesting another response", async () => {
		const { harness, session, coordinator, ctx } = await setup();
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		harness.setResponses([
			...Array.from({ length: 3 }, () => toolReply(fauxToolCall("sure_diagnostic_read", { operation: "timeline" }))),
			async (context, options) => {
				expect(context.tools?.map((tool) => tool.name)).toEqual([
					"sure_diagnostic_read",
					"sure_handoff_repair",
					"sure_pause_diagnosis",
				]);
				started();
				await new Promise<void>((resolve) =>
					options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
				);
				return fauxAssistantMessage("", { stopReason: "aborted" });
			},
			fauxAssistantMessage("must not be called"),
		]);
		const pending = diagnoseSureRun(coordinator, ctx, [], stage);
		await ready;
		await session.abort();
		expect(checkpointReason(await pending)).toContain("cancelled");
		expect(coordinator.state.pendingRepair).toBeUndefined();
		expect(
			JSON.parse(readFileSync(join(coordinator.run.runDir, "coordination.json"), "utf8")).attempts[0].error,
		).toContain("cancelled");
		expect(coordinator.state.attempts[0].modelTurns).toBeLessThanOrEqual(4);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("exposes failed actions and snapshot indexes through native diagnostic tools", async () => {
		const { harness, coordinator, ctx } = await setup();
		const actionPath = "run:evidence/tools/failed.json";
		const helperPath = "package:helper.py";
		writeSureJson(join(coordinator.run.runDir, "evidence/tools/failed.json"), {
			toolCallId: "failed",
			toolName: "bash",
			cwd: coordinator.run.cwd,
			input: { command: "cd skill && helper --run-dir ../../.sure/runs/test-run" },
			content: "Missing network.container_registry",
			isError: true,
		});
		writeFileSync(
			join(coordinator.run.packageDir, "helper.py"),
			`# Original helper\n${"HELPER_BODY\n".repeat(10000)}`,
		);
		coordinator.observe(
			{
				unitId: "build_env",
				outcome: "blocked",
				failureKind: "tool",
				summary: "Helper command failed",
				inputPaths: [helperPath],
				artifactPaths: [],
				action: { toolCallId: "failed", toolName: "bash", path: actionPath },
			},
			[helperPath, actionPath, "package:stage.md"],
		);
		harness.setResponses([
			(context) => {
				const prompt = context.messages
					.filter((message) => message.role === "user")
					.map((message) =>
						typeof message.content === "string"
							? message.content
							: message.content
									.filter((block) => block.type === "text")
									.map((block) => block.text)
									.join("\n"),
					)
					.join("\n");
				expect(prompt).toContain('"reads":{"used":0}');
				expect(prompt).not.toContain('"limit":8');
				return toolReply(fauxToolCall("sure_diagnostic_read", { operation: "timeline" }));
			},
			(context) => {
				const message = context.messages.find((message) => message.role === "toolResult")!;
				const page = JSON.parse(message.content.find((block) => block.type === "text")!.text);
				expect(page.budget.reads.used).toBe(1);
				expect(JSON.parse(page.text)).toMatchObject({
					task: { cwd: coordinator.run.cwd, runDir: coordinator.run.runDir },
					lastCheck: { sameAs: "lastFailure" },
					lastFailure: { action: { toolCallId: "failed" } },
				});
				return toolReply(
					fauxToolCall("sure_diagnostic_read", { operation: "file", path: actionPath }),
					fauxToolCall("sure_diagnostic_read", { operation: "snapshot" }),
					fauxToolCall("sure_diagnostic_read", { operation: "diff" }),
					fauxToolCall("sure_diagnostic_read", { operation: "check", checkVersion: 2 }),
					fauxToolCall("sure_diagnostic_read", { operation: "file", path: helperPath }),
					fauxToolCall("sure_diagnostic_read", { operation: "snapshot", path: helperPath }),
					fauxToolCall("sure_diagnostic_read", { operation: "check", checkVersion: 1 }),
				);
			},
			(context) => {
				const pages = context.messages
					.filter((message) => message.role === "toolResult")
					.map((message) => JSON.parse(message.content.find((block) => block.type === "text")!.text));
				expect(pages.at(-1).budget.reads.used).toBe(8);
				expect(pages[1].text).toContain("--run-dir ../../");
				const snapshot = JSON.parse(pages[2].text);
				expect(snapshot.files.every((file: { text?: string }) => file.text === undefined)).toBe(true);
				expect(pages[2].complete).toBe(true);
				expect(JSON.parse(pages[3].text).index).toBeDefined();
				return repairHandoff(repairTask);
			},
		]);
		const diagnosis = await diagnoseSureRun(coordinator, ctx, [helperPath], stage);
		expect(diagnosis.stopReason).toBeUndefined();
		expect(diagnosis.decision).toBe("repair");
		expect(coordinator.state.attempts.at(-1)).toMatchObject({ readCalls: 8, modelTurns: 3 });
	});

	it.each(["run:run.json", "package:stage.md", "run:diagnoses/prior/result.json"])(
		"keeps read-only %s out of repair targets",
		async (target) => {
			const { harness, coordinator, ctx } = await setup();
			coordinator.run.packageDir = join(coordinator.run.cwd, "skill");
			mkdirSync(coordinator.run.packageDir);
			writeFileSync(join(coordinator.run.packageDir, "stage.md"), "Prepare the environment.");
			writeSureJson(join(coordinator.run.runDir, "run.json"), { package: "none", device: "cpu" });
			writeSureJson(join(coordinator.run.runDir, "diagnoses/prior/result.json"), { repair: "Historical task" });
			coordinator.observe(
				{
					unitId: "build_env",
					outcome: "blocked",
					failureKind: "tool",
					summary: "Call failed",
					inputPaths: [],
					artifactPaths: [],
					diagnosticPaths: ["run:run.json"],
				},
				["run:run.json", "package:stage.md"],
			);
			harness.setResponses([
				toolReply(fauxToolCall("sure_diagnostic_read", { operation: "timeline" })),
				repairHandoff(repairTask, [target]),
			]);
			expect(checkpointReason(await diagnoseSureRun(coordinator, ctx, ["run:"], stage))).toContain(
				"Focus path is outside original task permissions",
			);
		},
	);
	it("reads a prior repair's full task and actual checks from its stable identity", async () => {
		const { harness, coordinator, ctx } = await setup();
		const task = `${"Repair detail. ".repeat(100)} END_OF_REPAIR`;
		harness.setResponses([
			toolReply(fauxToolCall("sure_diagnostic_read", { operation: "timeline" })),
			repairHandoff(task),
		]);
		const result = await diagnoseSureRun(coordinator, ctx, [], stage);
		const previous = coordinator.state.attempts.at(-1)!;
		coordinator.acceptDiagnosis(result);
		coordinator.observe(
			{
				unitId: "build_env",
				outcome: "blocked",
				failureKind: "semantic",
				summary: "The original gate still fails after repair",
				inputPaths: [],
				artifactPaths: [],
			},
			["package:stage.md"],
		);
		const repairId = coordinator.state.pendingRepair!.id;
		coordinator.verifyRepair(repairId, coordinator.state.evidenceVersion, "recheck");
		harness.setResponses([
			toolReply(fauxToolCall("sure_diagnostic_read", { operation: "timeline" })),
			(context) => {
				const response = context.messages.filter((message) => message.role === "toolResult").at(-1)!;
				const page = JSON.parse(response.content.find((block) => block.type === "text")!.text);
				const macro = JSON.parse(page.text);
				expect(page.text).not.toContain("END_OF_REPAIR");
				expect(macro.previousDiagnoses[0]).toMatchObject({ id: previous.id, decision: "repair" });
				expect(macro.previousDiagnoses[0].repair).toBeUndefined();
				expect(macro.repairs[0].checkVersions).toBeUndefined();
				return toolReply(
					fauxToolCall("sure_diagnostic_read", { operation: "repairs", repairId }),
					fauxToolCall("sure_diagnostic_read", {
						operation: "file",
						path: `run:diagnoses/${previous.id}/result.json`,
					}),
				);
			},
			(context) => {
				const responses = context.messages.filter((message) => message.role === "toolResult").slice(-2);
				expect(responses[1].isError).toBe(false);
				expect(JSON.parse(responses[1].content.find((block) => block.type === "text")!.text).text).toContain(
					"END_OF_REPAIR",
				);
				const response = responses[0];
				const page = JSON.parse(response.content.find((block) => block.type === "text")!.text);
				expect(JSON.parse(page.text)).toMatchObject({
					task,
					outcome: "blocked",
					checkVersions: [2],
					remainingBlocker: "The original gate still fails after repair",
				});
				return repairHandoff(repairTask);
			},
		]);
		expect((await diagnoseSureRun(coordinator, ctx, [], stage)).decision).toBe("repair");
	});

	it("retires old persisted investigation caps while retaining cumulative use on resume", async () => {
		const { harness, coordinator, ctx } = await setup();
		coordinator.beginDiagnosis();
		Object.assign(coordinator.state.attempts[0], { modelTurns: 40, readCalls: 80, elapsedMs: 240_000 });
		writeSureJson(join(coordinator.run.runDir, "coordination.json"), {
			...coordinator.state,
			limits: { ...coordinator.limits, diagnosisReadCalls: 1, diagnosisModelTurns: 2, diagnosisElapsedMs: 1000 },
		});
		const restored = new SureCoordinator(coordinator.run, "build_env", []);
		expect(restored.limits).not.toHaveProperty("diagnosisReadCalls");
		expect(restored.limits).not.toHaveProperty("diagnosisModelTurns");
		expect(restored.limits).not.toHaveProperty("diagnosisElapsedMs");
		harness.setResponses([
			toolReply(
				fauxToolCall("sure_diagnostic_read", { operation: "timeline" }),
				fauxToolCall("sure_diagnostic_read", { operation: "check", checkVersion: 1 }),
			),
			repairHandoff(repairTask),
		]);
		expect(await diagnoseSureRun(restored, ctx, [], stage)).toMatchObject({
			decision: "repair",
			repair: repairTask,
		});
		expect(restored.state.attempts[0]).toMatchObject({ modelTurns: 42, readCalls: 82 });
		expect(restored.state.attempts[0].elapsedMs).toBeGreaterThanOrEqual(240_000);
	});
	it.each([false, true])("requires every page of the macro timeline, complete=%s", async (complete) => {
		const { harness, coordinator, ctx } = await setup();
		coordinator.run.args = `${"A".repeat(53_604)} END_OF_TASK_ARGS`;
		let text = "";
		const responses: FauxResponseStep[] = [
			toolReply(fauxToolCall("sure_diagnostic_read", { operation: "timeline" })),
			(context) => {
				const page = JSON.parse(getMessageText(context.messages.filter((m) => m.role === "toolResult").at(-1)));
				expect(page.complete).toBe(false);
				expect(page.text.length).toBeLessThanOrEqual(50 * 1024);
				text += page.text;
				return complete
					? toolReply(fauxToolCall("sure_diagnostic_read", { operation: "timeline", offset: page.nextOffset }))
					: repairHandoff(repairTask);
			},
		];
		if (complete)
			responses.push((context) => {
				const page = JSON.parse(getMessageText(context.messages.filter((m) => m.role === "toolResult").at(-1)));
				expect(page.complete).toBe(true);
				expect(JSON.parse(text + page.text).task.args).toContain("END_OF_TASK_ARGS");
				return repairHandoff(repairTask);
			});
		harness.setResponses(responses);
		const diagnosis = await diagnoseSureRun(coordinator, ctx, [], stage);
		expect(diagnosis.decision).toBe(complete ? "repair" : "checkpoint");
		expect(coordinator.state.attempts[0].readCalls).toBe(complete ? 2 : 1);
		if (!complete) expect(coordinator.state.attempts[0].error).toContain("complete macro timeline");
	});

	it.each([false, true])("requires the complete saved user instructions, with reads=%s", async (read) => {
		const { harness, session, coordinator, ctx } = await setup();
		const earlier = {
			role: "user" as const,
			content: `${"Original instruction. ".repeat(3000)}NO_NETWORK`,
			timestamp: 1,
		};
		syncSureUserContext(coordinator, [earlier]);
		session.sessionManager.appendMessage({
			role: "user",
			content: "Only repair the declared wrapper.",
			timestamp: 2,
		});
		const restored = new SureCoordinator(coordinator.run, "build_env", []);
		harness.setResponses([
			toolReply(fauxToolCall("sure_diagnostic_read", { operation: "timeline" })),
			...(read
				? [
						toolReply(
							fauxToolCall("sure_diagnostic_read", { operation: "user_context", offset: 0 }),
							fauxToolCall("sure_diagnostic_read", { operation: "user_context", offset: 50 * 1024 }),
						),
					]
				: []),
			(context) => {
				if (read) {
					expect(JSON.stringify(context.messages)).toContain("NO_NETWORK");
					expect(JSON.stringify(context.messages)).toContain("Only repair the declared wrapper.");
				}
				return repairHandoff(repairTask);
			},
		]);
		const diagnosis = await diagnoseSureRun(restored, ctx, ["run:artifacts"], stage);
		expect(diagnosis.decision).toBe(read ? "repair" : "checkpoint");
		expect(restored.state.evidenceVersion).toBeGreaterThan(coordinator.state.evidenceVersion);
		expect(readSureUserContext(restored)).toContain(earlier.content);
		if (read) expect(restored.state.attempts[0].error).toBeUndefined();
		else expect(restored.state.attempts[0].error).toContain("Read complete user_context");
	});

	it("deduplicates harness prompts, restores constraints missing from the view and invalidates old repairs", async () => {
		const { harness, coordinator, ctx } = await setup();
		const message = { role: "user" as const, timestamp: 1, content: "NO_NETWORK_DOWNLOADS" };
		syncSureUserContext(coordinator, [message]);
		harness.setResponses([
			toolReply(fauxToolCall("sure_diagnostic_read", { operation: "timeline" })),
			toolReply(fauxToolCall("sure_diagnostic_read", { operation: "user_context" })),
			repairHandoff(repairTask),
		]);
		expect(coordinator.acceptDiagnosis(await diagnoseSureRun(coordinator, ctx, [], stage))).toBe(true);
		const version = coordinator.state.evidenceVersion;
		syncSureUserContext(coordinator, [
			message,
			{
				role: "user",
				timestamp: 2,
				content: '<sure_supervisor_repair id="x">INTERNAL_REPAIR</sure_supervisor_repair>',
			},
		]);
		expect(coordinator.state.evidenceVersion).toBe(version);
		expect(readSureUserContext(coordinator, [message])).toBe("");
		expect(readSureUserContext(coordinator)).toContain(message.content);
		expect(readSureUserContext(coordinator)).not.toContain("INTERNAL_REPAIR");
		syncSureUserContext(coordinator, [{ role: "user", timestamp: 3, content: "ONLY_REPAIR_WRAPPER" }]);
		expect(coordinator.state.pendingRepair).toBeUndefined();
		expect(coordinator.state.status).toBe("yielding");
		expect(coordinator.state.units.build_env.supervisorRepairs).toBe(1);
	});

	it("binds queued user input to its delivered message without charging another evidence version", async () => {
		const { coordinator } = await setup();
		syncSureUserContext(coordinator, [{ role: "user", timestamp: 1, content: "NO_NETWORK" }], true);
		const version = coordinator.state.evidenceVersion;
		const delivered = { role: "user" as const, timestamp: 2, content: "NO_NETWORK" };
		syncSureUserContext(coordinator, [delivered]);
		expect(coordinator.state.evidenceVersion).toBe(version);
		expect(readSureUserContext(coordinator, [delivered])).toBe("");
		expect(readSureUserContext(coordinator).match(/NO_NETWORK/g)).toHaveLength(1);
		syncSureUserContext(coordinator, [{ role: "user", timestamp: 3, content: "NETWORK_ALLOWED" }], true);
		syncSureUserContext(coordinator, [{ role: "user", timestamp: 4, content: "NO_NETWORK" }], true);
		// Re-reading old history cannot consume the later queued reassertion.
		syncSureUserContext(coordinator, [delivered]);
		expect(readSureUserContext(coordinator).match(/NO_NETWORK/g)).toHaveLength(2);
		expect(coordinator.state.evidenceVersion).toBe(version + 2);
		syncSureUserContext(coordinator, [{ role: "user", timestamp: 5, content: "NO_NETWORK" }]);
		expect(coordinator.state.evidenceVersion).toBe(version + 2);
	});

	it("uses a separate persisted session with only the diagnostic read tool and the same model", async () => {
		const { harness, session, coordinator, ctx } = await setup();
		writeFileSync(join(harness.tempDir, "AGENTS.md"), "UNTRUSTED_LOCAL_PROMPT");
		harness.setResponses([
			(context, _options, _state, model) => {
				expect(context.tools?.map((tool) => tool.name)).toEqual([
					"sure_diagnostic_read",
					"sure_handoff_repair",
					"sure_pause_diagnosis",
				]);
				expect(context.systemPrompt).not.toContain("UNTRUSTED_LOCAL_PROMPT");
				expect(model.id).toBe(session.model?.id);
				return toolReply(fauxToolCall("sure_diagnostic_read", { operation: "timeline" }));
			},
			(context) => {
				const timeline = context.messages.find((message) => message.role === "toolResult");
				expect(JSON.stringify(timeline)).toContain("model=demo device=cuda");
				return repairHandoff(repairTask);
			},
		]);
		expect(await diagnoseSureRun(coordinator, ctx, ["run:artifacts"], stage)).toMatchObject({
			decision: "repair",
			repair: repairTask,
		});
		expect(session.messages).toHaveLength(0);
		expect(coordinator.state.attempts[0]).toMatchObject({
			modelTurns: 2,
			readCalls: 1,
			result: { decision: "repair", repair: repairTask },
		});
		const diagnosisDir = join(coordinator.run.runDir, "diagnoses", coordinator.state.attempts[0].id);
		expect(existsSync(join(diagnosisDir, "result.json"))).toBe(true);
		expect(
			readdirSync(join(coordinator.run.runDir, "supervisor", "session")).some((name) => name.endsWith(".jsonl")),
		).toBe(true);
	});

	it("does not accept a diagnosis after a denied read without a successful macro inspection", async () => {
		const { harness, coordinator, ctx } = await setup();
		harness.setResponses([
			toolReply(fauxToolCall("sure_diagnostic_read", { operation: "file", path: "run:artifacts/env.json" })),
			repairHandoff(repairTask),
		]);
		const diagnosis = await diagnoseSureRun(coordinator, ctx, ["run:artifacts"], stage);
		expect(diagnosis.decision).toBe("checkpoint");
		expect(coordinator.state.attempts[0].error).toContain("macro timeline");
	});

	it("keeps an investigation active beyond 120 seconds until its provider completes", async () => {
		const { harness, coordinator, ctx } = await setup();
		vi.useFakeTimers();
		let started!: () => void;
		let finish!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const released = new Promise<void>((resolve) => {
			finish = resolve;
		});
		harness.setResponses([
			toolReply(fauxToolCall("sure_diagnostic_read", { operation: "timeline" })),
			async () => {
				started();
				await released;
				return repairHandoff(repairTask);
			},
		]);
		let settled = false;
		const pending = diagnoseSureRun(coordinator, ctx, [], stage).then((outcome) => {
			settled = true;
			return outcome;
		});
		await ready;
		await vi.advanceTimersByTimeAsync(240_001);
		expect(settled).toBe(false);
		finish();
		expect(await pending).toMatchObject({ decision: "repair", repair: repairTask });
		expect(coordinator.state.attempts[0].elapsedMs).toBeGreaterThanOrEqual(240_000);
	});

	it("falls back if historical evidence is missing, preserving the original task error", async () => {
		const { harness, coordinator, ctx } = await setup();
		rmSync(join(coordinator.run.runDir, "snapshots", `${coordinator.state.initialSnapshot}.json`));
		harness.setResponses([fauxAssistantMessage("must not be called")]);
		const result = await diagnoseSureRun(coordinator, ctx, [], stage);
		expect(result.decision).toBe("checkpoint");
		expect(result.facts).toContain("Original CUDA environment failure");
		expect(coordinator.state.attempts[0].error).toContain("ENOENT");
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("cancels pending session creation and disposes a session that arrives after cancellation", async () => {
		const { session, coordinator, ctx } = await setup();
		let created: ((session: IsolatedSession) => void) | undefined;
		ctx.createIsolatedSession = () =>
			new Promise<IsolatedSession>((resolve) => {
				created = resolve;
			});
		const pending = diagnoseSureRun(coordinator, ctx, [], stage);
		await session.abort();
		expect(checkpointReason(await pending)).toContain("cancelled");
		const abort = vi.fn(async () => {});
		const dispose = vi.fn();
		created?.({ prompt: async () => {}, disableTools: () => {}, abort, dispose, getMessages: () => [] });
		await Promise.resolve();
		expect(abort).toHaveBeenCalledTimes(1);
		expect(dispose).toHaveBeenCalledTimes(1);
	});
});
