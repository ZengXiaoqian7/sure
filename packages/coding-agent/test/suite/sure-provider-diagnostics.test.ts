import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { sureHash } from "../../src/core/sure/evidence.ts";
import { sureUsageFields } from "../../src/core/sure/provider-diagnostics.ts";
import { createHarness, type Harness } from "./harness.ts";

let harness: Harness | undefined;
let session: AgentSession | undefined;
afterEach(() => {
	session?.dispose();
	harness?.cleanup();
	vi.unstubAllGlobals();
});

describe("coordinated provider evidence", () => {
	it("records final wire hashes, actual affinity and raw/normalized usage without changing requests or leaking text", async () => {
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
		for (const text of [
			"SECRET_USER_BODY",
			"zero",
			"positive",
			"null",
			"invalid usage",
			"no usage",
			"malformed stream",
		])
			await session.prompt(text);
		expect(sent).toHaveLength(7);
		const directory = join(runDir, "evidence/provider");
		const evidence = readdirSync(directory)
			.map((file) => JSON.parse(readFileSync(join(directory, file), "utf8")))
			.sort((a, b) => a.sequence - b.sequence);
		expect(evidence).toHaveLength(7);
		for (let i = 0; i < 7; i++) {
			const body = JSON.parse(sent[i]);
			expect(body.temperature).toBe(0.125);
			expect(evidence[i].payload.sha256).toBe(sureHash(sent[i]));
			expect(evidence[i].payload.messages.map((message: { sha256: string }) => message.sha256)).toEqual(
				body.messages.map((message: unknown) => sureHash(JSON.stringify(message))),
			);
			expect(evidence[i].affinity.authorization).toBeUndefined();
			expect(evidence[i].affinity["x-session-affinity"]).toEqual({
				present: true,
				hash: sureHash(manager.getSessionId()),
			});
			expect(evidence[i].cache.prompt_cache_key).toMatchObject({
				present: true,
				hash: sureHash(JSON.stringify(manager.getSessionId())),
			});
			expect(evidence[i].dispatches).toHaveLength(1);
			if (i < 6) {
				expect(evidence[i].sentAt).toBeLessThanOrEqual(evidence[i].firstDeltaAt);
				expect(evidence[i].firstDeltaAt).toBeLessThanOrEqual(evidence[i].endedAt);
			}
			if (i)
				expect(evidence[i].payload.previous).toMatchObject({
					commonMessages: JSON.parse(sent[i - 1]).messages.length,
					systemUnchanged: true,
					toolsUnchanged: true,
				});
		}
		expect(evidence[0].rawUsage[0].fields["prompt_tokens_details.cached_tokens"]).toEqual({ present: false });
		expect(evidence[1].rawUsage[0].fields["prompt_tokens_details.cached_tokens"]).toEqual({
			present: true,
			value: 0,
		});
		expect(evidence[2].rawUsage[0].fields.cached_tokens).toEqual({ present: true, value: 30 });
		expect(evidence[2].normalizedUsage.cacheRead).toBe(30);
		expect(evidence[0].normalizedUsage.cacheRead).toBe(0);
		expect(evidence[1].normalizedUsage.cacheRead).toBe(0);
		expect(evidence[3].rawUsage[0].fields.cached_tokens).toEqual({ present: true, value: null });
		expect(evidence[3].normalizedUsage.cacheRead).toBe(0);
		// The unchanged parser accepts bad numeric types; NaN becomes null on disk, never a reported zero.
		expect(evidence[4].rawUsage[0].fields.prompt_tokens).toEqual({ present: true, type: "string" });
		expect(evidence[4].normalizedUsage).toMatchObject({ input: null, totalTokens: null, cacheRead: 0 });
		expect(evidence[5]).toMatchObject({ rawUsage: [], stopReason: "stop", normalizedUsage: { cacheRead: 0 } });
		expect(evidence[6]).toMatchObject({
			rawUsage: [],
			firstDeltaAt: null,
			stopReason: "error",
			normalizedUsage: { cacheRead: 0 },
		});
		expect(evidence[6].endedAt).toBeGreaterThanOrEqual(evidence[6].sentAt);
		expect(session.getLastAssistantText()).toBeUndefined();
		expect(session.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: expect.any(String),
		});
		for (const secret of ["SECRET_AUTH", "SECRET_USER_BODY", "SECRET_TOOL_BODY"])
			expect(JSON.stringify(evidence)).not.toContain(secret);
		writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId: "mock-run", status: "failed" }));
		await session.prompt("paused run with a stale transcript entry");
		expect(readdirSync(directory)).toHaveLength(7);
		manager.appendCustomEntry("sure.run", { runId: "mock-run", runDir, status: "success" });
		await session.prompt("ordinary path");
		expect(readdirSync(directory)).toHaveLength(7);
		expect(existsSync(join(runDir, "snapshots"))).toBe(false);
	});
	it("records absent, null, explicit zero, positive and invalid types separately", () => {
		expect(
			sureUsageFields({
				cached_tokens: 0,
				prompt_cache_hit_tokens: 12,
				prompt_tokens_details: { cached_tokens: null, cache_write_tokens: "secret" },
			}),
		).toMatchObject({
			cached_tokens: { present: true, value: 0 },
			prompt_cache_hit_tokens: { present: true, value: 12 },
			"prompt_tokens_details.cached_tokens": { present: true, value: null },
			"prompt_tokens_details.cache_write_tokens": { present: true, type: "string" },
			prompt_tokens: { present: false },
		});
	});
});
