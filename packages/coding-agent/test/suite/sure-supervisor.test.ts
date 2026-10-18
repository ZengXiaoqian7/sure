import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { AgentActivity } from "../../src/core/extensions/types.ts";
import type { IsolatedSession, IsolatedSessionRequest } from "../../src/core/session-controls.ts";
import type { SureDiagnosisOutcome, SureDiagnosisResult } from "../../src/core/sure/coordination-types.ts";
import { SureCoordinator } from "../../src/core/sure/coordinator.ts";
import { writeSureJson } from "../../src/core/sure/evidence.ts";
import { diagnoseSureRun } from "../../src/core/sure/supervisor.ts";
import type { SureRunRecord, SureSkillPackage } from "../../src/core/sure/types.ts";
import { readSureUserContext, syncSureUserContext } from "../../src/core/sure/user-context.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";
import { fixtureExecutor, pauseDiagnosis, repairHandoff } from "./sure-control-fixtures.ts";

function checkpointReason(outcome: SureDiagnosisOutcome): string {
	expect(outcome.decision).toBe("checkpoint");
	if (outcome.decision !== "checkpoint") throw new Error("Expected an incomplete investigation.");
	return outcome.checkpoint;
}

const harnesses: Harness[] = [];
const sessions: AgentSession[] = [];
const externalSources: string[] = [];
const stage = { id: "build_env", prompt: "stage.md", references: [], snapshotPaths: ["run:artifacts"] };

async function setup() {
	const harness = await createHarness();
	harnesses.push(harness);
	const { session } = await fixtureExecutor(harness, "Parent executor");
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
	const result: SureDiagnosisResult = {
		runId: run.runId,
		unitId: "build_env",
		evidenceVersion: coordinator.state.evidenceVersion,
		decision: "repair",
		facts: ["CUDA import failed"],
		hypotheses: ["Runtime mismatch"],
		unknowns: [],
		evidenceReferences: ["check:1"],
		targetFiles: [],
		validation: "Rerun the original build_env gate.",
		stopBoundary: "Stop this repair if the original gate still fails.",
		repair: "Repair CUDA dependencies in the declared model runtime and rerun the same gate.",
		nextActions: [],
	};
	return { harness, session, coordinator, ctx, result };
}

afterEach(() => {
	vi.useRealTimers();
	for (const session of sessions.splice(0)) session.dispose();
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const path of externalSources.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Sure independent read-only supervisor", () => {
	it("keeps the business gate distinct from preflight and accepts project focus hints outside capture scope", async () => {
		const { harness, coordinator, ctx, result } = await setup();
		coordinator.run.packageDir = join(coordinator.run.cwd, "skill");
		mkdirSync(coordinator.run.packageDir);
		writeFileSync(join(coordinator.run.packageDir, "stage.md"), "Prepare the environment.");
		coordinator.observe(
			{
				unitId: "build_env",
				outcome: "passed",
				checker: "pre_tool_call",
				sourceId: "pre_tool_call:probe",
				summary: "Probe preflight allowed",
				inputPaths: [],
				artifactPaths: [],
			},
			["package:stage.md"],
		);
		harness.setResponses([
			(context) => {
				const packet = JSON.parse(
					getMessageText(context.messages.filter((message) => message.role === "user").at(-1)).split("\n")[1],
				);
				expect(packet.currentGate.summary).toBe("Original CUDA environment failure");
				expect(packet.latestCheck.summary).toBe("Probe preflight allowed");
				expect(packet.scope.hints).not.toContain("project:models/demo/loader.py");
				return fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline" })], {
					stopReason: "toolUse",
				});
			},
			(context) => {
				const response = context.messages.filter((message) => message.role === "toolResult").at(-1)!;
				const timeline = JSON.parse(JSON.parse(getMessageText(response)).text);
				expect(
					timeline.stages.find((item: { unitId: string }) => item.unitId === "build_env").lastPassed,
				).toBeUndefined();
				return repairHandoff(result.repair!, ["project:models/demo/loader.py"]);
			},
		]);
		expect((await diagnoseSureRun(coordinator, ctx, [], stage)).decision).toBe("repair");
	});
	it("keeps full rules stable across snapshots and loads whole-run actions only on demand", async () => {
		const { harness, coordinator, ctx, result } = await setup();
		writeFileSync(join(coordinator.run.packageDir, "SKILL.md"), "FULL_GLOBAL_RULES");
		writeFileSync(join(coordinator.run.packageDir, "common.md"), "FULL_COMMON_RULES");
		const scope = ["package:stage.md", "package:SKILL.md", "package:common.md"];
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
			prompt: "FULL_GLOBAL_RULES",
			source: "project",
			sourceRoot: coordinator.run.packageDir,
		};
		for (const unitId of ["prior_unit", "build_env"])
			writeSureJson(join(coordinator.run.runDir, `evidence/tools/${unitId}.json`), {
				toolCallId: `${unitId}-action`,
				unitId,
				toolName: "read",
				cwd: coordinator.run.cwd,
				input: { path: `${unitId}-source.txt` },
				requestedAt: "2000-01-01",
				execution: "returned",
				isError: false,
			});
		let systemPrompt: string | undefined;
		for (const iteration of [0, 1]) {
			coordinator.barrier(scope);
			harness.setResponses([
				(context) => {
					if (iteration === 0) systemPrompt = context.systemPrompt;
					else expect(context.systemPrompt).toBe(systemPrompt);
					expect(context.systemPrompt).toContain("FULL_GLOBAL_RULES");
					expect(context.systemPrompt).toContain("FULL_COMMON_RULES");
					const packet = JSON.parse(
						getMessageText(context.messages.filter((message) => message.role === "user").at(-1)).split("\n")[1],
					);
					expect(JSON.stringify(packet)).not.toContain("prior_unit-action");
					expect(packet.navigation.actionIndex).toEqual({ count: 2, operation: "actions", unitId: "build_env" });
					return fauxAssistantMessage(
						[
							fauxToolCall("sure_diagnostic_read", { operation: "actions", unitId: "build_env" }),
							fauxToolCall("sure_diagnostic_read", { operation: "timeline" }),
						],
						{ stopReason: "toolUse" },
					);
				},
				(context) => {
					const replies = context.messages.filter((message) => message.role === "toolResult").slice(-2);
					expect(replies.every((message) => !message.isError)).toBe(true);
					expect(getMessageText(replies[0])).toContain("build_env-action");
					expect(getMessageText(replies[0])).not.toContain("prior_unit-action");
					expect(getMessageText(replies[1])).toContain("prior_unit-action");
					return repairHandoff(result.repair!);
				},
			]);
			const outcome = await diagnoseSureRun(coordinator, ctx, scope, stage, skill);
			expect(outcome.decision).toBe("repair");
			coordinator.acceptDiagnosis(outcome);
			coordinator.observe(
				{ ...coordinator.state.lastCheck!, summary: `Gate failed at iteration ${iteration}` },
				scope,
			);
		}
		expect(coordinator.state.attempts).toHaveLength(2);
	});
	it.each([false, true])(
		"reads external runtime sources while preserving freshness and write scope, changed=%s",
		async (changed) => {
			const { harness, coordinator, ctx, result } = await setup();
			const runtime = mkdtempSync("/private/tmp/sure-runtime-source-");
			externalSources.push(runtime);
			const dependency = join(runtime, "node_modules/runtime/loader.js");
			const python = join(runtime, ".venv/lib/loader.py");
			mkdirSync(join(runtime, "node_modules/runtime"), { recursive: true });
			mkdirSync(join(runtime, ".venv/lib"), { recursive: true });
			writeFileSync(dependency, "export const backend = 'cpu';\n");
			writeFileSync(python, "backend = 'cpu'\n");
			writeFileSync(join(runtime, ".env"), "PRIVATE_RUNTIME_TOKEN");
			writeFileSync(join(runtime, "model.safetensors"), "PRIVATE_WEIGHT_PAYLOAD");
			symlinkSync(join(runtime, ".env"), join(runtime, "alias.txt"));
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("sure_diagnostic_read", { operation: "file", path: dependency }),
						fauxToolCall("sure_diagnostic_read", { operation: "file", path: python }),
						fauxToolCall("sure_diagnostic_read", { operation: "file", path: join(runtime, "alias.txt") }),
						fauxToolCall("sure_diagnostic_read", { operation: "file", path: join(runtime, "model.safetensors") }),
					],
					{ stopReason: "toolUse" },
				),
				(context) => {
					const replies = context.messages.filter((message) => message.role === "toolResult");
					expect(replies.map((message) => !!message.isError)).toEqual([false, false, true, true]);
					const output = JSON.stringify(replies);
					expect(output).toContain("backend = 'cpu'");
					expect(output).not.toContain("PRIVATE_RUNTIME_TOKEN");
					expect(output).not.toContain("PRIVATE_WEIGHT_PAYLOAD");
					if (changed) writeFileSync(dependency, "export const backend = 'cuda';\n");
					return repairHandoff(result.repair!);
				},
			]);
			const outcome = await diagnoseSureRun(coordinator, ctx, ["run:artifacts"], stage);
			expect(outcome.decision).toBe(changed ? "checkpoint" : "repair");
			if (changed) expect(checkpointReason(outcome)).toContain("Live diagnostic source changed");
			expect(JSON.stringify(coordinator.state)).not.toContain("PRIVATE_RUNTIME_TOKEN");
		},
	);

	it("rejects a retired evidence return and accepts complete corrective guidance", async () => {
		const { harness, coordinator, ctx } = await setup();
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("sure_handoff_repair", { kind: "evidence", task: "Probe and return for approval." })],
				{ stopReason: "toolUse" },
			),
			repairHandoff(
				"Inspect the loader, run the required probe, correct the dtype if it differs, and verify with the original gate. Continue after it passes.",
			),
		]);
		const outcome = await diagnoseSureRun(coordinator, ctx, [], stage);
		expect(outcome).toMatchObject({ decision: "repair", repair: expect.stringContaining("correct the dtype") });
		expect(outcome).not.toHaveProperty("kind");
		expect(coordinator.state.attempts).toHaveLength(1);
		expect(coordinator.state.attempts[0].protocolErrorTurns).toBe(1);
		expect(coordinator.acceptDiagnosis(outcome)).toBe(true);
		expect(coordinator.state.repairs).toHaveLength(1);
	});

	it("continues the existing plan without manufacturing a repair or touching executor messages", async () => {
		const { harness, session, coordinator, ctx } = await setup();
		const activities: AgentActivity[] = [];
		ctx.ui.showAgentActivity = (activity) => activities.push(activity);
		let lateActivity: IsolatedSessionRequest["onActivity"];
		const factory = ctx.createIsolatedSession!;
		ctx.createIsolatedSession = (request) => {
			lateActivity = request.onActivity;
			return factory(request);
		};
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "check", checkVersion: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				[fauxToolCall("sure_continue_execution", { reason: "The current probe remains useful." })],
				{ stopReason: "toolUse" },
			),
		]);
		const outcome = await diagnoseSureRun(coordinator, ctx, [], stage);
		expect(outcome).toMatchObject({ decision: "continue", reason: "The current probe remains useful." });
		expect(coordinator.acceptDiagnosis(outcome)).toBe(true);
		expect(coordinator.state.repairs).toEqual([]);
		expect(coordinator.state.pendingRepair).toBeUndefined();
		expect(session.messages).toEqual([]);
		expect(activities.map(({ event }) => event.type)).toEqual([
			"start",
			"tool_execution_start",
			"tool_execution_end",
			"tool_execution_start",
			"tool_execution_end",
			"end",
		]);
		expect(new Set(activities.map(({ runtimeId }) => runtimeId)).size).toBe(1);
		lateActivity?.({
			type: "tool_execution_start",
			toolCallId: "late",
			toolName: "sure_diagnostic_read",
			args: { operation: "log" },
		});
		expect(activities).toHaveLength(6);
	});

	it.each(["read", "edit", "change"])(
		"discovers related sources and checks read/write/version boundaries: %s",
		async (mode) => {
			const { harness, coordinator, ctx, result } = await setup();
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
				fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline" })], {
					stopReason: "toolUse",
				}),
				(context) => {
					const message = context.messages.filter((message) => message.role === "toolResult").at(-1)!;
					const macro = JSON.parse(JSON.parse(message.content.find((block) => block.type === "text")!.text).text);
					expect(macro.priorUnitActions[0].toolCallId).toBe("prior-read");
					return fauxAssistantMessage(
						[
							fauxToolCall("sure_diagnostic_read", { operation: "list", path: "project:config" }),
							fauxToolCall("sure_diagnostic_read", { operation: "file", path: "project:loader.txt" }),
							fauxToolCall("sure_diagnostic_read", { operation: "file", path: "project:alias.txt" }),
						],
						{ stopReason: "toolUse" },
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
					return repairHandoff(result.repair!, mode === "edit" ? ["project:config/actual.yaml"] : []);
				},
			]);
			const outcome = await diagnoseSureRun(coordinator, ctx, scope, declaredStage);
			expect(outcome.decision).toBe(mode === "read" ? "repair" : "checkpoint");
			if (mode === "edit")
				expect(checkpointReason(outcome)).toContain("Focus path is outside original task permissions");
			if (mode === "change") {
				expect(checkpointReason(outcome)).toContain("Live diagnostic source changed");
				harness.setResponses([
					fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline" })], {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage(
						[fauxToolCall("sure_diagnostic_read", { operation: "file", path: "project:loader.txt" })],
						{ stopReason: "toolUse" },
					),
					() => repairHandoff(result.repair!),
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
		expect(coordinator.state.lastFailure?.summary).toBe("Original CUDA environment failure");
		expect(coordinator.state.stopReason).toBeUndefined();
		const attempt = coordinator.state.attempts[0];
		expect(
			JSON.parse(readFileSync(join(coordinator.run.runDir, "diagnoses", attempt.id, "segment-error-1.json"), "utf8"))
				.reason,
		).toBe(reason);
		expect(existsSync(join(coordinator.run.runDir, "diagnoses", attempt.id, "result.json"))).toBe(false);
	});

	it("delivers the complete frozen global manual and common rules alongside the local contract", async () => {
		const { harness, coordinator, ctx, result } = await setup();
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
				return fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline" })], {
					stopReason: "toolUse",
				});
			},
			repairHandoff(result.repair!),
		]);
		expect((await diagnoseSureRun(coordinator, ctx, scope, stage, skill)).decision).toBe("repair");
	});

	it("continues one persisted investigation across segments without resetting usage or replaying the macro", async () => {
		const { harness, coordinator, ctx, result } = await setup();
		const checkpoint = "The macro is complete; inspect check 1 before choosing a correction.";
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline" })], {
				stopReason: "toolUse",
			}),
			pauseDiagnosis(checkpoint),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain(checkpoint);
				expect(context.tools?.map((tool) => tool.name)).toEqual([
					"sure_diagnostic_read",
					"sure_handoff_repair",
					"sure_pause_diagnosis",
					"sure_continue_execution",
				]);
				return fauxAssistantMessage(
					[fauxToolCall("sure_diagnostic_read", { operation: "check", checkVersion: 1 })],
					{ stopReason: "toolUse" },
				);
			},
			repairHandoff(result.repair!),
		]);
		const first = await diagnoseSureRun(coordinator, ctx, [], stage);
		expect(first).toMatchObject({ decision: "checkpoint", automatic: false });
		expect(coordinator.acceptDiagnosis(first)).toBe(false);
		expect(coordinator.state.attempts[0].result).toBeUndefined();
		const restored = new SureCoordinator(coordinator.run, stage.id, []);
		expect(await diagnoseSureRun(restored, ctx, [], stage)).toMatchObject({
			decision: "repair",
			repair: result.repair,
		});
		expect(restored.state.attempts).toHaveLength(1);
		expect(restored.state.attempts[0]).toMatchObject({ modelTurns: 4, readCalls: 2 });
		expect(restored.state.attempts[0].segments).toMatchObject([
			{ modelTurns: 2, readCalls: 1 },
			{ modelTurns: 2, readCalls: 1 },
		]);
		expect(restored.state.attempts[0].usage).toBeDefined();
		expect(restored.state.repairs).toEqual([]);
	});

	it("pauses repeated investigation checkpoints without inventing a business stop", async () => {
		const { harness, coordinator, ctx } = await setup();
		const checkpoint = "No new evidence was found.";
		for (const _iteration of [0, 1]) {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline", offset: 0 })], {
					stopReason: "toolUse",
				}),
				pauseDiagnosis(checkpoint),
			]);
			expect(await diagnoseSureRun(coordinator, ctx, [], stage)).toMatchObject({
				decision: "checkpoint",
				automatic: false,
			});
		}
		expect(coordinator.state.stopReason).toBeUndefined();
		expect(coordinator.state.attempts).toHaveLength(1);
	});

	it("can hand off directly from the complete initial navigation and constraints", async () => {
		const { harness, coordinator, ctx, result } = await setup();
		syncSureUserContext(coordinator, [{ role: "user", timestamp: 1, content: "NO_NETWORK" }]);
		harness.setResponses([
			(context) => {
				const prompt = JSON.stringify(context.messages);
				expect(prompt).toContain("NO_NETWORK");
				expect(prompt).toContain("navigation");
				expect(prompt).toContain("Original CUDA environment failure");
				expect(prompt).toContain("Prepare the declared model environment");
				return repairHandoff(result.repair!);
			},
		]);
		expect((await diagnoseSureRun(coordinator, ctx, [], stage)).decision).toBe("repair");
		expect(coordinator.state.attempts[0]).toMatchObject({ modelTurns: 1, readCalls: 0 });
		expect(coordinator.state.attempts[0]).not.toHaveProperty("timelineOffset");
		expect(coordinator.state.attempts[0]).not.toHaveProperty("userContextOffset");
	});

	it.each([1, 4, 12])("allows %s relevant reads without a new investigation cap", async (reads) => {
		const { harness, coordinator, ctx, result } = await setup();
		harness.setResponses([
			...Array.from({ length: reads }, () =>
				fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "check", checkVersion: 1 })], {
					stopReason: "toolUse",
				}),
			),
			repairHandoff(result.repair!),
		]);
		expect((await diagnoseSureRun(coordinator, ctx, [], stage)).decision).toBe("repair");
		expect(coordinator.state.attempts[0]).toMatchObject({ modelTurns: reads + 1, readCalls: reads });
	});

	it("offers same-session feedback for truncated final text", async () => {
		const { harness, coordinator, ctx } = await setup();
		harness.setResponses([
			...Array.from({ length: 3 }, () =>
				fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline" })], {
					stopReason: "toolUse",
				}),
			),
			(context) => {
				expect(context.tools?.map((tool) => tool.name)).toEqual([
					"sure_diagnostic_read",
					"sure_handoff_repair",
					"sure_pause_diagnosis",
					"sure_continue_execution",
				]);
				return fauxAssistantMessage('{"runId":"test-run","decision":');
			},
			fauxAssistantMessage("must not be called"),
		]);
		expect((await diagnoseSureRun(coordinator, ctx, [], stage)).decision).toBe("checkpoint");
		expect(coordinator.state.attempts[0].modelTurns).toBe(6);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("rebuilds the current initial packet when resuming an investigation without messages", async () => {
		const { harness, coordinator, ctx, result } = await setup();
		coordinator.beginDiagnosis();
		Object.assign(coordinator.state.attempts[0], { modelTurns: 3, readCalls: 2 });
		coordinator.save();
		harness.setResponses([
			(context) => {
				expect(context.tools?.map((tool) => tool.name)).toEqual([
					"sure_diagnostic_read",
					"sure_handoff_repair",
					"sure_pause_diagnosis",
					"sure_continue_execution",
				]);
				return repairHandoff(result.repair!);
			},
			fauxAssistantMessage("must not be called"),
		]);
		const restored = new SureCoordinator(coordinator.run, "build_env", []);
		expect((await diagnoseSureRun(restored, ctx, [], stage)).decision).toBe("repair");
		expect(restored.state.attempts[0]).toMatchObject({ modelTurns: 4, readCalls: 2 });
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("cancels the decision response without applying a repair or requesting another response", async () => {
		const { harness, session, coordinator, ctx } = await setup();
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		harness.setResponses([
			...Array.from({ length: 3 }, () =>
				fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline" })], {
					stopReason: "toolUse",
				}),
			),
			async (context, options) => {
				expect(context.tools?.map((tool) => tool.name)).toEqual([
					"sure_diagnostic_read",
					"sure_handoff_repair",
					"sure_pause_diagnosis",
					"sure_continue_execution",
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
		expect(coordinator.state.attempts[0].modelTurns).toBeLessThanOrEqual(4);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("keeps readable prior diagnosis results outside repair targets even under a broad run scope", async () => {
		const { harness, coordinator, ctx, result } = await setup();
		coordinator.beginDiagnosis();
		const previous = coordinator.state.attempts.at(-1)!;
		previous.result = result;
		writeSureJson(join(coordinator.run.runDir, "diagnoses", previous.id, "result.json"), result);
		coordinator.observe({ ...coordinator.state.lastCheck!, summary: "New failure" }, ["package:stage.md"]);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline" })], {
				stopReason: "toolUse",
			}),
			repairHandoff(result.repair!, [`run:diagnoses/${previous.id}/result.json`]),
		]);
		expect(checkpointReason(await diagnoseSureRun(coordinator, ctx, ["run:"], stage))).toContain(
			"Focus path is outside original task permissions",
		);
	});

	it("exposes the failed action and snapshot indexes, and can decide after exactly eight reads", async () => {
		const { harness, coordinator, ctx, result } = await setup();
		const actionPath = "run:evidence/tools/failed.json";
		const helperPath = "package:helper.py";
		writeSureJson(join(coordinator.run.runDir, "evidence/tools/failed.json"), {
			toolCallId: "failed",
			toolName: "bash",
			execution: "returned",
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
				return fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline" })], {
					stopReason: "toolUse",
				});
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
				return fauxAssistantMessage(
					[
						fauxToolCall("sure_diagnostic_read", { operation: "file", path: actionPath }),
						fauxToolCall("sure_diagnostic_read", { operation: "snapshot" }),
						fauxToolCall("sure_diagnostic_read", { operation: "diff" }),
						fauxToolCall("sure_diagnostic_read", { operation: "check", checkVersion: 2 }),
						fauxToolCall("sure_diagnostic_read", { operation: "file", path: helperPath }),
						fauxToolCall("sure_diagnostic_read", { operation: "snapshot", path: helperPath }),
						fauxToolCall("sure_diagnostic_read", { operation: "check", checkVersion: 1 }),
					],
					{ stopReason: "toolUse" },
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
				return repairHandoff(result.repair!);
			},
		]);
		const diagnosis = await diagnoseSureRun(coordinator, ctx, [helperPath], stage);
		expect(coordinator.state.stopReason).toBeUndefined();
		expect(diagnosis.decision).toBe("repair");
		expect(coordinator.state.attempts.at(-1)).toMatchObject({ readCalls: 8, modelTurns: 3 });
	});

	it("keeps newly registered diagnostic-only inputs out of repair targets", async () => {
		const { harness, coordinator, ctx, result } = await setup();
		coordinator.run.packageDir = join(coordinator.run.cwd, "skill");
		mkdirSync(coordinator.run.packageDir);
		writeFileSync(join(coordinator.run.packageDir, "stage.md"), "Prepare the environment.");
		writeSureJson(join(coordinator.run.runDir, "run.json"), { package: "none", device: "cpu" });
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
			fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline" })], {
				stopReason: "toolUse",
			}),
			repairHandoff(result.repair!, ["run:run.json"]),
		]);
		expect(checkpointReason(await diagnoseSureRun(coordinator, ctx, ["run:"], stage))).toContain(
			"Focus path is outside original task permissions",
		);
	});
	it("reads a prior repair's full task and actual checks from its stable identity", async () => {
		const { harness, coordinator, ctx, result } = await setup();
		const task = `${"Repair detail. ".repeat(100)} END_OF_REPAIR`;
		coordinator.beginDiagnosis();
		const previous = coordinator.state.attempts.at(-1)!;
		previous.result = { ...result, repair: task };
		writeSureJson(join(coordinator.run.runDir, "diagnoses", previous.id, "result.json"), previous.result);
		coordinator.acceptDiagnosis({ ...result, repair: task });
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
		coordinator.requestDiagnosis("The original gate still fails after the actual correction.");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline" })], {
				stopReason: "toolUse",
			}),
			(context) => {
				const response = context.messages.find((message) => message.role === "toolResult")!;
				const page = JSON.parse(response.content.find((block) => block.type === "text")!.text);
				const macro = JSON.parse(page.text);
				expect(page.text).not.toContain("END_OF_REPAIR");
				expect(macro.previousDiagnoses[0]).toMatchObject({ id: previous.id, decision: "repair" });
				expect(macro.previousDiagnoses[0].repair).toBeUndefined();
				expect(macro.repairs[0].checkVersions).toBeUndefined();
				return fauxAssistantMessage(
					[
						fauxToolCall("sure_diagnostic_read", { operation: "repairs", repairId }),
						fauxToolCall("sure_diagnostic_read", {
							operation: "file",
							path: `run:diagnoses/${previous.id}/result.json`,
						}),
					],
					{ stopReason: "toolUse" },
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
					gateOutcome: "blocked",
					checkVersions: [2],
					remainingBlocker: "The original gate still fails after repair",
				});
				return repairHandoff(result.repair!);
			},
		]);
		expect((await diagnoseSureRun(coordinator, ctx, [], stage)).decision).toBe("repair");
	});

	it("retains cumulative investigation usage on current-protocol resume without caps", async () => {
		const { harness, coordinator, ctx, result } = await setup();
		coordinator.beginDiagnosis();
		Object.assign(coordinator.state.attempts[0], { modelTurns: 40, readCalls: 80, elapsedMs: 240_000 });
		coordinator.save();
		const restored = new SureCoordinator(coordinator.run, "build_env", []);
		expect(restored.limits).not.toHaveProperty("diagnosisReadCalls");
		expect(restored.limits).not.toHaveProperty("diagnosisModelTurns");
		expect(restored.limits).not.toHaveProperty("diagnosisElapsedMs");
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("sure_diagnostic_read", { operation: "timeline" }),
					fauxToolCall("sure_diagnostic_read", { operation: "check", checkVersion: 1 }),
				],
				{ stopReason: "toolUse" },
			),
			repairHandoff(result.repair!),
		]);
		expect(await diagnoseSureRun(restored, ctx, [], stage)).toMatchObject({
			decision: "repair",
			repair: result.repair,
		});
		expect(restored.state.attempts[0]).toMatchObject({ modelTurns: 42, readCalls: 82 });
		expect(restored.state.attempts[0].elapsedMs).toBeGreaterThanOrEqual(240_000);
	});
	it("delivers long saved user instructions directly without a second tool-reading obligation", async () => {
		const { harness, session, coordinator, ctx, result } = await setup();
		syncSureUserContext(coordinator, [{ role: "user", timestamp: 1, content: `${"A".repeat(60_000)}\nNO_NETWORK` }]);
		session.sessionManager.appendMessage({
			role: "user",
			content: "Only repair the declared wrapper.",
			timestamp: 2,
		});
		const restored = new SureCoordinator(coordinator.run, "build_env", []);
		harness.setResponses([
			(context) => {
				const text = JSON.stringify(context.messages);
				expect(text).toContain("NO_NETWORK");
				expect(text).toContain("Only repair the declared wrapper.");
				return repairHandoff(result.repair!);
			},
		]);
		expect((await diagnoseSureRun(restored, ctx, [], stage)).decision).toBe("repair");
		expect(restored.state.attempts[0]).toMatchObject({ readCalls: 0, modelTurns: 1 });
	});

	it("deduplicates harness prompts, restores constraints missing from the view and invalidates old repairs", async () => {
		const { coordinator, result } = await setup();
		const message = { role: "user" as const, timestamp: 1, content: "NO_NETWORK_DOWNLOADS" };
		syncSureUserContext(coordinator, [message]);
		expect(coordinator.acceptDiagnosis({ ...result, evidenceVersion: coordinator.state.evidenceVersion })).toBe(true);
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
		expect(coordinator.state.repairs).toHaveLength(1);
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
		const { harness, session, coordinator, ctx, result } = await setup();
		writeFileSync(join(harness.tempDir, "AGENTS.md"), "UNTRUSTED_LOCAL_PROMPT");
		harness.setResponses([
			(context, _options, _state, model) => {
				expect(context.tools?.map((tool) => tool.name)).toEqual([
					"sure_diagnostic_read",
					"sure_handoff_repair",
					"sure_pause_diagnosis",
					"sure_continue_execution",
				]);
				expect(context.systemPrompt).not.toContain("UNTRUSTED_LOCAL_PROMPT");
				expect(model.id).toBe(session.model?.id);
				return fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline" })], {
					stopReason: "toolUse",
				});
			},
			(context) => {
				const timeline = context.messages.find((message) => message.role === "toolResult");
				expect(JSON.stringify(timeline)).toContain("model=demo device=cuda");
				return repairHandoff(result.repair!);
			},
		]);
		expect(await diagnoseSureRun(coordinator, ctx, ["run:artifacts"], stage)).toMatchObject({
			decision: "repair",
			repair: result.repair,
		});
		expect(session.messages).toHaveLength(0);
		expect(coordinator.state.attempts[0]).toMatchObject({
			modelTurns: 2,
			readCalls: 1,
			result: { decision: "repair", repair: result.repair },
		});
		const diagnosisDir = join(coordinator.run.runDir, "diagnoses", coordinator.state.attempts[0].id);
		expect(existsSync(join(diagnosisDir, "result.json"))).toBe(true);
		expect(
			readdirSync(join(coordinator.run.runDir, "supervisor", "session")).some((name) => name.endsWith(".jsonl")),
		).toBe(true);
	});

	it("preserves recoverable evidence when same-session correction reaches provider failure", async () => {
		const { harness, coordinator, ctx } = await setup();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("invalid JSON"),
			fauxAssistantMessage("must not be called"),
		]);
		const result = await diagnoseSureRun(coordinator, ctx, ["run:artifacts"], stage);
		expect(result.decision).toBe("checkpoint");
		expect(coordinator.state.lastFailure?.summary).toBe("Original CUDA environment failure");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("returns a denied read to the debugger without imposing a macro-reading gate", async () => {
		const { harness, coordinator, ctx, result } = await setup();
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("sure_diagnostic_read", { operation: "file", path: "run:artifacts/env.json" })],
				{
					stopReason: "toolUse",
				},
			),
			repairHandoff(result.repair!),
		]);
		const diagnosis = await diagnoseSureRun(coordinator, ctx, ["run:artifacts"], stage);
		expect(diagnosis.decision).toBe("repair");
		expect(coordinator.state.attempts[0].error).toBeUndefined();
	});

	it("does not reset persisted turn/read/time counters on a diagnosing restart", async () => {
		const { harness, coordinator, ctx } = await setup();
		coordinator.beginDiagnosis();
		coordinator.state.attempts[0].modelTurns = 4;
		coordinator.save();
		harness.setResponses([fauxAssistantMessage("invalid response"), fauxAssistantMessage("must not be called")]);
		const restored = new SureCoordinator(coordinator.run, "build_env", []);
		const result = await diagnoseSureRun(restored, ctx, ["run:artifacts"], stage);
		expect(result.decision).toBe("checkpoint");
		expect(restored.state.attempts).toHaveLength(1);
		expect(restored.state.attempts[0].modelTurns).toBe(7);
		expect(restored.state.attempts[0].result).toBeUndefined();
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("cancels an in-flight independent provider and retains cancellation evidence", async () => {
		const { harness, session, coordinator, ctx } = await setup();
		let started: (() => void) | undefined;
		const providerStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		harness.setResponses([
			async (_context, options) => {
				started?.();
				await new Promise<void>((resolve) =>
					options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
				);
				return fauxAssistantMessage("", { stopReason: "aborted" });
			},
		]);
		const diagnosis = diagnoseSureRun(coordinator, ctx, ["run:artifacts"], stage);
		await providerStarted;
		await session.abort();
		const result = await diagnosis;
		expect(checkpointReason(result)).toContain("cancelled");
		expect(
			JSON.parse(readFileSync(join(coordinator.run.runDir, "coordination.json"), "utf8")).attempts[0].error,
		).toContain("cancelled");
	});

	it("reuses a completed persisted diagnosis without another provider call", async () => {
		const { harness, coordinator, ctx, result } = await setup();
		coordinator.beginDiagnosis();
		coordinator.state.attempts[0].result = result;
		coordinator.save();
		harness.setResponses([fauxAssistantMessage("must not be called")]);
		expect(
			await diagnoseSureRun(new SureCoordinator(coordinator.run, "build_env", []), ctx, [], stage),
		).toMatchObject(result);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("accepts the ninth and later parallel evidence reads and preserves final synthesis", async () => {
		const { harness, coordinator, ctx, result } = await setup();
		harness.setResponses([
			fauxAssistantMessage(
				Array.from({ length: 17 }, () =>
					fauxToolCall("sure_diagnostic_read", { operation: "timeline", offset: 0 }),
				),
				{ stopReason: "toolUse" },
			),
			(context) => {
				expect(context.messages.filter((m) => m.role === "toolResult").every((m) => !m.isError)).toBe(true);
				return repairHandoff(result.repair!);
			},
		]);
		expect(await diagnoseSureRun(coordinator, ctx, [], stage)).toMatchObject({
			decision: "repair",
			repair: result.repair,
		});
		expect(coordinator.state.attempts[0]).toMatchObject({ readCalls: 17, readRequests: 17, modelTurns: 2 });
	});
	it.each([3, 4, 8])("synthesizes after the live failure's 1+4+%s read sequence", async (lastBatch) => {
		const { harness, coordinator, ctx, result } = await setup();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline" })], {
				stopReason: "toolUse",
			}),
			...[4, lastBatch].map((count) =>
				fauxAssistantMessage(
					Array.from({ length: count }, () =>
						fauxToolCall("sure_diagnostic_read", { operation: "check", checkVersion: 1 }),
					),
					{ stopReason: "toolUse" },
				),
			),
			(context) => {
				expect(
					context.messages.filter((message) => message.role === "toolResult").every((message) => !message.isError),
				).toBe(true);
				return repairHandoff(result.repair!);
			},
		]);
		expect(await diagnoseSureRun(coordinator, ctx, [], stage)).toMatchObject({
			decision: "repair",
			repair: result.repair,
		});
		expect(coordinator.state.attempts[0]).toMatchObject({
			readCalls: 5 + lastBatch,
			readRequests: 5 + lastBatch,
			modelTurns: 4,
		});
		expect(coordinator.state.lastCheckVersion).toBe(1);
	});

	it("keeps an investigation active beyond 120 seconds until its provider completes", async () => {
		const { harness, coordinator, ctx, result } = await setup();
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
			fauxAssistantMessage([fauxToolCall("sure_diagnostic_read", { operation: "timeline" })], {
				stopReason: "toolUse",
			}),
			async () => {
				started();
				await released;
				return repairHandoff(result.repair!);
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
		expect(await pending).toMatchObject({ decision: "repair", repair: result.repair });
		expect(coordinator.state.attempts[0].elapsedMs).toBeGreaterThanOrEqual(240_000);
	});

	it("falls back if historical evidence is missing, preserving the original task error", async () => {
		const { harness, coordinator, ctx } = await setup();
		rmSync(join(coordinator.run.runDir, "snapshots", `${coordinator.state.initialSnapshot}.json`));
		harness.setResponses([fauxAssistantMessage("must not be called")]);
		const result = await diagnoseSureRun(coordinator, ctx, [], stage);
		expect(result.decision).toBe("checkpoint");
		expect(coordinator.state.lastFailure?.summary).toBe("Original CUDA environment failure");
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
		created?.({ prompt: async () => {}, abort, dispose, getMessages: () => [] });
		await Promise.resolve();
		expect(abort).toHaveBeenCalledTimes(1);
		expect(dispose).toHaveBeenCalledTimes(1);
	});
});
