import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

let harness: Harness | undefined;
let session: AgentSession | undefined;
afterEach(() => {
	session?.dispose();
	harness?.cleanup();
	vi.unstubAllGlobals();
});

describe("coordinated sessions preserve provider behavior", () => {
	it("preserves payload hooks, affinity, usage and stream errors without provider evidence", async () => {
		harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_provider_request", (event) => ({ ...(event.payload as object), temperature: 0.125 }));
				},
			],
		});
		const runtime = harness.session.modelRuntime;
		runtime.registerProvider("mock-openai", {
			apiKey: "SECRET_AUTH",
			api: "openai-completions",
			baseUrl: "https://api.openai.com/v1",
			models: [
				{
					id: "mock-model",
					name: "Mock model",
					contextWindow: 200000,
					maxTokens: 1000,
					reasoning: false,
					compat: { sendSessionAffinityHeaders: true },
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			],
		});
		const model = runtime.getModel("mock-openai", "mock-model")!;
		const sent: string[] = [];
		const headers: Headers[] = [];
		const raw = [
			{ prompt_tokens: 100, completion_tokens: 2 },
			{ prompt_tokens: 100, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } },
			{ prompt_tokens: 100, completion_tokens: 2, cached_tokens: 30 },
			{ prompt_tokens: 100, completion_tokens: 2, cached_tokens: null },
			{ prompt_tokens: "invalid-token-count", completion_tokens: 2 },
		];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input, init: RequestInit) => {
				sent.push(String(init.body));
				headers.push(new Headers(init.headers));
				const usage = raw[sent.length - 1];
				if (sent.length === 7)
					return new Response('data: {"usage":INVALID_JSON}\n\n', {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					});
				return new Response(
					`data: ${JSON.stringify({ id: "mock-response", choices: [{ index: 0, delta: { content: "SECRET_TOOL_BODY" }, finish_reason: "stop" }], ...(usage ? { usage } : {}) })}\n\ndata: [DONE]\n\n`,
					{ status: 200, headers: { "content-type": "text/event-stream", "x-request-id": "mock-response" } },
				);
			}),
		);
		const manager = SessionManager.inMemory(harness.tempDir);
		const runDir = join(harness.tempDir, "mock-run");
		mkdirSync(runDir);
		writeFileSync(join(runDir, "coordination.json"), "{}");
		writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId: "mock-run", status: "running" }));
		manager.appendCustomEntry("sure.run", { runId: "mock-run", runDir, status: "running" });
		({ session } = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			model,
			modelRuntime: runtime,
			sessionManager: manager,
			resourceLoader: harness.session.resourceLoader,
			tools: [],
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		}));
		await session.bindExtensions({});
		const messages = [];
		for (const text of [
			"SECRET_USER_BODY",
			"zero",
			"positive",
			"null",
			"invalid usage",
			"no usage",
			"malformed stream",
		]) {
			await session.prompt(text);
			messages.push(session.messages.at(-1));
		}
		expect(sent).toHaveLength(7);
		for (let i = 0; i < 7; i++) {
			const body = JSON.parse(sent[i]);
			expect(body.temperature).toBe(0.125);
			expect(body.prompt_cache_key).toBe(manager.getSessionId());
			expect(headers[i].get("x-session-affinity")).toBe(manager.getSessionId());
		}
		expect(messages[0]).toMatchObject({ usage: { input: 100, output: 2, cacheRead: 0 } });
		expect(messages[1]).toMatchObject({ usage: { input: 100, output: 2, cacheRead: 0 } });
		expect(messages[2]).toMatchObject({ usage: { input: 70, output: 2, cacheRead: 30 } });
		expect(messages[3]).toMatchObject({ usage: { input: 100, output: 2, cacheRead: 0 } });
		expect(messages[4]).toMatchObject({ usage: { input: NaN, totalTokens: NaN, cacheRead: 0 } });
		expect(messages[5]).toMatchObject({ stopReason: "stop", usage: { cacheRead: 0 } });
		expect(messages[6]).toMatchObject({ stopReason: "error", usage: { cacheRead: 0 } });
		const directory = join(runDir, "evidence/provider");
		expect(existsSync(directory)).toBe(false);
		expect(session.getLastAssistantText()).toBeUndefined();
		expect(session.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: expect.any(String),
		});
		writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId: "mock-run", status: "failed" }));
		await session.prompt("paused run with a stale transcript entry");
		expect(existsSync(directory)).toBe(false);
		manager.appendCustomEntry("sure.run", { runId: "mock-run", runDir, status: "success" });
		await session.prompt("ordinary path");
		expect(existsSync(directory)).toBe(false);
		expect(existsSync(join(runDir, "snapshots"))).toBe(false);
	});
});
