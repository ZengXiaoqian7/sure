import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { noOpUIContext } from "../../src/core/extensions/runner.ts";
import type { AgentActivity } from "../../src/core/extensions/types.ts";
import { createIsolatedResourceLoader } from "../../src/core/isolated-resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import type { IsolatedSessionActivity } from "../../src/core/session-controls.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness } from "./harness.ts";

describe("isolated session activity", () => {
	it("forwards actual tool events through the UI seam without executor messages or business hooks", async () => {
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
		const activity: IsolatedSessionActivity[] = [];
		const presentations: AgentActivity[] = [];
		const executorEvents: string[] = [];
		session.subscribe((event) => executorEvents.push(event.type));
		await session.bindExtensions({
			uiContext: { ...noOpUIContext, showAgentActivity: (event) => presentations.push(event) },
		});
		const ctx = session.extensionRunner.createContext();
		const isolated = await ctx.createIsolatedSession!({
			systemPrompt: "Supervisor private context",
			sessionDir: join(harness.tempDir, "isolated"),
			onTurn: () => true,
			onActivity: (event) => {
				activity.push(event);
				ctx.ui.showAgentActivity?.({
					role: "Supervisor",
					runId: "run",
					attemptId: "attempt",
					runtimeId: "runtime",
					event,
				});
			},
			tools: [
				{
					name: "evidence_read",
					label: "Read evidence",
					description: "Read test evidence",
					parameters: Type.Object({}),
					execute: async (_id, _args, _signal, onUpdate) => {
						onUpdate?.({ content: [{ type: "text", text: "partial" }], details: {} });
						return { content: [{ type: "text", text: "evidence" }], details: {} };
					},
				},
			],
		});
		try {
			harness.setResponses([fauxAssistantMessage([fauxToolCall("evidence_read", {})], { stopReason: "toolUse" })]);
			await isolated.prompt("Read the evidence");
			expect(activity.map((event) => event.type)).toEqual([
				"tool_execution_start",
				"tool_execution_update",
				"tool_execution_end",
			]);
			expect(presentations.map((entry) => entry.event)).toEqual(activity);
			expect(executorEvents).not.toContain("agent_start");
			expect(executorEvents).not.toContain("tool_execution_start");
			expect(session.messages).toEqual([]);
			expect(JSON.stringify(isolated.getMessages())).toContain("evidence");
		} finally {
			isolated.dispose();
			session.dispose();
			harness.cleanup();
		}
	});
});
