import { describe, expect, it, vi } from "vitest";
import { completeSimple } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	chunks: [] as unknown[],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const chunks = mockState.chunks;
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) yield chunk;
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

function openRouterAuto(): Model<"openai-completions"> {
	return {
		id: "openrouter/auto",
		name: "OpenRouter Auto",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	};
}

describe("openai-completions usage observation", () => {
	it.each([
		{ raw: {}, cache: 0, input: 100 },
		{ raw: { prompt_tokens_details: { cached_tokens: 0 } }, cache: 0, input: 100 },
		{ raw: { prompt_tokens_details: { cached_tokens: null } }, cache: 0, input: 100 },
		{ raw: { prompt_tokens_details: { cached_tokens: 12, cache_write_tokens: 3 } }, cache: 12, input: 85 },
		{ raw: { prompt_cache_hit_tokens: 14 }, cache: 14, input: 86 },
		{ raw: { cached_tokens: 16 }, cache: 16, input: 84 },
		{ raw: { prompt_tokens_details: { cached_tokens: 0 }, cached_tokens: 16 }, cache: 0, input: 100 },
	])("preserves raw field presence and existing precedence: $raw", async ({ raw, cache, input }) => {
		const events: unknown[] = [];
		const usage = { prompt_tokens: 100, completion_tokens: 8, ...raw };
		mockState.chunks = [{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage }];
		const message = await completeSimple(
			openRouterAuto(),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				apiKey: "mock-only",
				onOpenAICompletionsUsage: (event) => events.push(event),
			},
		);
		expect(message.stopReason).toBe("stop");
		expect(message.usage.cacheRead).toBe(cache);
		expect(message.usage).toMatchObject({
			input,
			output: 8,
			totalTokens: 108,
		});
		expect(events).toEqual([
			{ source: "chunk.usage", chunkIndex: 1, usage, applied: true, normalized: message.usage },
		]);
	});
	it("observes multiple cumulative chunks and ignored choice usage, without summing or changing priority", async () => {
		const events: unknown[] = [];
		mockState.chunks = [
			{
				choices: [
					{ delta: { content: "o" }, usage: { prompt_tokens: 40, completion_tokens: 1, cached_tokens: 20 } },
				],
			},
			{
				choices: [
					{ delta: { content: "k" }, finish_reason: "stop", usage: { prompt_tokens: 500, cached_tokens: 400 } },
				],
				usage: { prompt_tokens: 60, completion_tokens: 2, prompt_cache_hit_tokens: 30 },
			},
			{
				choices: [],
				usage: { prompt_tokens: 80, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 50 } },
			},
		];
		const message = await completeSimple(
			openRouterAuto(),
			{ messages: [] },
			{ apiKey: "mock-only", onOpenAICompletionsUsage: (event) => events.push(event) },
		);
		expect(events).toMatchObject([
			{ source: "choice.usage", chunkIndex: 1, applied: true, normalized: { cacheRead: 20 } },
			{ source: "chunk.usage", chunkIndex: 2, applied: true, normalized: { cacheRead: 30 } },
			{ source: "choice.usage", chunkIndex: 2, applied: false, normalized: { cacheRead: 30 } },
			{ source: "chunk.usage", chunkIndex: 3, applied: true, normalized: { cacheRead: 50 } },
		]);
		expect(message.usage).toMatchObject({ input: 30, output: 3, cacheRead: 50, totalTokens: 83 });
	});
});
