import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { captureSureExecutorProgress, planSureContextTrim, projectSureContext } from "../../src/core/sure/context.ts";
import type { SureCoordinationState } from "../../src/core/sure/coordination-types.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const coordination: SureCoordinationState = {
	version: 1,
	runId: "run",
	unitId: "current",
	status: "executing",
	evidenceVersion: 2,
	updatedAt: "now",
	units: {},
	attempts: [],
};
const projection = (messages: AgentMessage[], purpose?: "execution" | "compaction") =>
	projectSureContext(messages, purpose === "compaction" ? planSureContextTrim(messages, 200, coordination) : []);
const old = fauxAssistantMessage([fauxToolCall("read", { path: "old" }, { id: "old-call" })], {
	timestamp: 100,
	stopReason: "toolUse",
});
const current = fauxAssistantMessage([fauxToolCall("read", { path: "current" }, { id: "current-call" })], {
	timestamp: 200,
	stopReason: "toolUse",
});
const transcript: AgentMessage[] = [
	{ role: "user", content: "Keep CUDA and the user's output constraints", timestamp: 1 },
	old,
	{
		role: "toolResult",
		toolCallId: "old-call",
		toolName: "read",
		content: [{ type: "text", text: "OLD_BULK".repeat(10_000) }],
		isError: false,
		timestamp: 150,
	},
	current,
	{
		role: "toolResult",
		toolCallId: "current-call",
		toolName: "read",
		content: [{ type: "text", text: "Current evidence" }],
		isError: false,
		timestamp: 250,
	},
];

afterEach(() => {
	vi.restoreAllMocks();
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("Sure effective stage context", () => {
	it("hands over bounded attributed public progress without private thinking or a new model call", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const run = { runDir: harness.tempDir } as Parameters<typeof captureSureExecutorProgress>[0];
		const messages = Array.from({ length: 20 }, (_, index) =>
			fauxAssistantMessage(
				[
					{ type: "thinking" as const, thinking: "PRIVATE_REASONING", thinkingSignature: "opaque" },
					{ type: "text" as const, text: `${index}: public hypothesis ${"x".repeat(1500)}` },
				],
				{ timestamp: index + 1 },
			),
		);
		const raw = JSON.stringify(messages);
		const ids = new Map<AgentMessage, string>(messages.map((message, index) => [message, `message-${index}`]));
		captureSureExecutorProgress(
			run,
			"current",
			messages,
			{ id: "main", data: { retries: { current: 2, irrelevant: 999 } } },
			"/session.jsonl",
			ids,
		);
		const path = join(harness.tempDir, "evidence/executor-progress.json");
		const saved = readFileSync(path, "utf8");
		const packet = JSON.parse(saved);
		expect(JSON.stringify(packet).length).toBeLessThanOrEqual(4000);
		expect(saved).not.toContain("PRIVATE_REASONING");
		expect(saved).not.toContain("irrelevant");
		expect(packet.attribution).toContain("claims, not verified");
		expect(packet.omitted + packet.claims.length).toBe(20);
		expect(packet.claims.at(-1)).toMatchObject({
			timestamp: 20,
			sourceMessageId: "message-19",
			truncated: true,
			sourceHash: expect.any(String),
		});
		const modifiedAt = statSync(path).mtimeMs;
		captureSureExecutorProgress(
			run,
			"current",
			messages,
			{ id: "main", data: { retries: { current: 2 } } },
			"/session.jsonl",
			ids,
		);
		expect(statSync(path).mtimeMs).toBe(modifiedAt);
		captureSureExecutorProgress(run, "current", [], undefined);
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ claims: [], currentIntentAvailable: false });
		expect(JSON.stringify(messages)).toBe(raw);
	});
	it("keeps current intent ahead of eight later historical claims and retains full public text", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const run = { runDir: harness.tempDir } as Parameters<typeof captureSureExecutorProgress>[0];
		const body = `${"Current reasoning. ".repeat(400)}NEXT_STEP: verify the actual loader before materializing.`;
		const messages = [body, ...Array.from({ length: 8 }, () => "Historical observation. ".repeat(100))].map(
			(text, index) =>
				fauxAssistantMessage([{ type: "text", text }, fauxToolCall("read", {}, { id: `call-${index}` })], {
					timestamp: index + 1,
				}),
		);
		const ids = new Map<AgentMessage, string>(messages.map((message, index) => [message, `message-${index}`]));
		const units = new Map(messages.map((_, index) => [`call-${index}`, index ? "historical" : "current"]));
		captureSureExecutorProgress(run, "current", messages, undefined, "/executor.jsonl", ids, 100, units);
		const packetPath = join(run.runDir, "evidence/executor-progress.json");
		const packet = JSON.parse(readFileSync(packetPath, "utf8"));
		expect(JSON.stringify(packet).length).toBeLessThanOrEqual(4000);
		expect(packet.currentIntentAvailable).toBe(true);
		const claim = packet.claims.find((claim: { unitId: string }) => claim.unitId === "current");
		expect(claim).toMatchObject({ sourceMessageId: "message-0", truncated: true });
		const source = JSON.parse(readFileSync(join(run.runDir, claim.sourcePath.slice(4)), "utf8"));
		expect(source).toMatchObject({
			unitId: "current",
			sourceMessageId: "message-0",
			sourceHash: claim.sourceHash,
			text: body,
		});
		captureSureExecutorProgress(run, "current", messages.slice(1), undefined, "/executor.jsonl", ids, 100, units);
		expect(JSON.parse(readFileSync(packetPath, "utf8")).currentIntentAvailable).toBe(false);
		captureSureExecutorProgress(
			run,
			"current",
			[fauxAssistantMessage("Unknown origin", { timestamp: 1 })],
			undefined,
		);
		const unknown = JSON.parse(readFileSync(packetPath, "utf8"));
		expect(unknown).toMatchObject({
			currentIntentAvailable: false,
			claims: [expect.objectContaining({ unitId: null, text: "Unknown origin" })],
		});
	});

	it("only trims selected old successful bulk at compaction; retains errors and referenced evidence", () => {
		const failure = { ...transcript[2], toolCallId: "failed", isError: true } as AgentMessage;
		const native = {
			...transcript[2],
			toolCallId: "native",
			content: [{ type: "image", data: "opaque", mimeType: "image/png" }],
		} as AgentMessage;
		const messages = [...transcript, failure, native];
		expect(projection(messages)).toEqual(messages);
		const selected = planSureContextTrim(messages, 200, coordination);
		expect(selected).toEqual(["old-call"]);
		const trimmed = projectSureContext(messages, selected);
		expect(trimmed).toContain(failure);
		expect(trimmed).toContain(native);
		expect(trimmed).toContain(current);
		expect(JSON.stringify(trimmed)).toContain("run:evidence/tools/");
		expect(JSON.stringify(trimmed)).toContain("OLD_BULK");
		expect(JSON.stringify(trimmed).length).toBeLessThan(JSON.stringify(messages).length);
		expect(
			projectSureContext([...trimmed, { role: "user", content: "next", timestamp: 500 }], selected).slice(
				0,
				trimmed.length,
			),
		).toEqual(trimmed);
		expect(
			planSureContextTrim(messages, 200, {
				...coordination,
				originalFailure: {
					unitId: "earlier",
					outcome: "blocked",
					summary: "still unresolved",
					artifactPaths: [],
					inputPaths: [],
					action: { toolCallId: "old-call", toolName: "read", path: "run:source" },
				},
			}),
		).toEqual([]);
	});

	it.each([false, true])("keeps bounded overflow and length recovery with projection=%s", async (projected) => {
		const harness = await createHarness({ settings: { compaction: { enabled: true } } });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		if (projected) harness.session.extensionRunner.createContext().setContextProjection?.(projection);
		const internals = harness.session as unknown as {
			_checkCompaction: (message: typeof current) => Promise<boolean>;
			_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
			_overflowRecoveryAttempted: boolean;
		};
		const compact = vi.spyOn(internals, "_runAutoCompaction").mockResolvedValue(true);
		const model = harness.getModel();
		for (const stopReason of ["error", "length"] as const) {
			internals._overflowRecoveryAttempted = false;
			compact.mockClear();
			const message = {
				...fauxAssistantMessage("short", {
					stopReason,
					errorMessage: stopReason === "error" ? "Your input exceeds the context window of this model" : undefined,
				}),
				provider: model.provider,
				model: model.id,
			};
			harness.session.agent.state.messages = [{ role: "user", content: "short", timestamp: 1 }, message];
			expect(await internals._checkCompaction(message)).toBe(true);
			expect(compact).toHaveBeenCalledExactlyOnceWith("overflow", true);
			expect(await internals._checkCompaction(message)).toBe(false);
			expect(compact).toHaveBeenCalledTimes(1);
			expect(harness.session.agent.state.messages.at(-1)?.role).toBe("user");
		}
		internals._overflowRecoveryAttempted = false;
		compact.mockClear();
		const stale = {
			...fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "Your input exceeds the context window of this model",
				timestamp: 1,
			}),
			provider: model.provider,
			model: model.id,
		};
		const entryId = harness.sessionManager.appendMessage(stale);
		harness.sessionManager.appendCompaction("already compacted", entryId, 100);
		expect(await internals._checkCompaction(stale)).toBe(false);
		expect(compact).not.toHaveBeenCalled();
	});

	it("keeps global constraints and complete current pairs, without changing the audit transcript", () => {
		const effective = projectSureContext(transcript, planSureContextTrim(transcript, 200, coordination));
		expect(JSON.stringify(effective).length).toBeLessThan(JSON.stringify(transcript).length);
		expect(JSON.stringify(effective)).toContain("Keep CUDA");
		expect(effective).toContain(current);
		expect(effective.filter((message) => message.role === "toolResult").map((message) => message.toolCallId)).toEqual(
			["old-call", "current-call"],
		);
		expect(transcript).toHaveLength(5);
		expect(JSON.stringify(transcript)).toContain("OLD_BULK");
		expect(projection(effective)).toHaveLength(effective.length);
	});

	it("supplies selected excerpts and current evidence to native manual compaction", async () => {
		let context: ExtensionContext | undefined;
		let compacted = "";
		const harness = await createHarness({
			models: [{ id: "small", contextWindow: 10_000, maxTokens: 1000 }],
			settings: { compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						context = ctx;
						ctx.setContextProjection?.(projection);
					});
					pi.on("session_before_compact", (event) => {
						compacted = JSON.stringify(event.preparation);
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		for (const message of transcript) {
			if (message.role === "user" || message.role === "assistant" || message.role === "toolResult")
				harness.sessionManager.appendMessage(message);
		}
		harness.sessionManager.appendMessage(fauxAssistantMessage("Current completed work", { timestamp: 280 }));
		harness.sessionManager.appendMessage({ role: "user", content: "Continue this unit", timestamp: 300 });
		harness.sessionManager.appendMessage(fauxAssistantMessage("Current later work", { timestamp: 350 }));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([
			fauxAssistantMessage("Compacted current stage"),
			fauxAssistantMessage("Compacted turn prefix"),
		]);
		await harness.session.compact();
		expect(compacted).toContain("OLD_BULK");
		expect(compacted).toContain("Historical success excerpt");
		expect(compacted).not.toContain("OLD_BULK".repeat(100));
		expect(compacted).toContain("Current evidence");
		expect(JSON.stringify(harness.sessionManager.getBranch())).toContain("OLD_BULK");
		context?.setContextProjection?.(undefined);
	});

	it.each(["string", "array"])("leaves a delivered supervisor body unchanged with %s user content", (format) => {
		const raw: AgentMessage[] = [
			...transcript,
			{
				role: "user",
				timestamp: 300,
				content:
					format === "string"
						? '<sure_supervisor_repair id="current:2">UNIQUE_REPAIR</sure_supervisor_repair>'
						: [
								{
									type: "text",
									text: '<sure_supervisor_repair id="current:2">UNIQUE_REPAIR</sure_supervisor_repair>',
								},
							],
			},
		];
		const effective = projectSureContext(raw, []);
		expect(effective).toEqual(raw);
		expect(JSON.stringify(effective).match(/UNIQUE_REPAIR/g)).toHaveLength(1);
		expect(JSON.stringify(raw)).toContain("sure_supervisor_repair");
	});
	it.each([12, 50])("compacts %s old reads with real excerpts, fits actual requests and continues", async (count) => {
		const sizes: number[] = [];
		for (const projected of [false, true]) {
			const harness = await createHarness({
				models: [{ id: "small", contextWindow: 10_000, maxTokens: 1000 }],
				settings: { compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 300 } },
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({});
			if (projected) harness.session.extensionRunner.createContext().setContextProjection?.(projection);
			harness.sessionManager.appendMessage({
				role: "user",
				content: "Preserve the selected CPU runtime",
				timestamp: 1,
			});
			for (let index = 0; index < count; index++) {
				const call = `read-${index}`;
				harness.sessionManager.appendMessage(
					fauxAssistantMessage([fauxToolCall("read", { path: `source-${index}` }, { id: call })], {
						timestamp: 100,
						stopReason: "toolUse",
					}),
				);
				harness.sessionManager.appendMessage({
					role: "toolResult",
					toolName: "read",
					toolCallId: call,
					timestamp: 150,
					isError: false,
					content: [
						{ type: "text", text: `Verified source ${index}: useful original text. ${"bulk ".repeat(800)}` },
					],
				});
			}
			harness.sessionManager.appendMessage({ role: "user", content: "Current unit request", timestamp: 220 });
			harness.sessionManager.appendMessage(current);
			const currentResult = transcript[4];
			if (currentResult.role !== "toolResult") throw new Error("Missing current tool result fixture");
			harness.sessionManager.appendMessage(currentResult);
			harness.sessionManager.appendMessage(
				fauxAssistantMessage("Current work awaits its next check", { timestamp: 280 }),
			);
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			const raw = JSON.stringify(harness.sessionManager.getBranch());
			let requests = 0;
			let largest = 0;
			let sawOriginal = false;
			let repeated = false;
			let sawPrevious = false;
			harness.setResponses(
				Array.from({ length: 12 }, () => (context, options) => {
					const text = context.messages.map(getMessageText).join("\n");
					if (text.startsWith("<conversation>")) {
						requests++;
						largest = Math.max(largest, text.length);
						if (projected) {
							expect(
								Math.ceil(Buffer.byteLength(JSON.stringify(context), "utf8") / 3) +
									256 +
									(options?.maxTokens ?? 0),
							).toBeLessThanOrEqual(10_000);
							expect(text).not.toContain("sure_stage_context");
							if (text.includes("Verified source")) {
								sawOriginal = true;
								expect(text).toContain("run:evidence/tools/");
							}
							if (repeated && text.includes("<previous-summary>")) {
								sawPrevious = true;
								expect(text).toContain("CHECKPOINT: preserve CPU");
							}
						}
						return fauxAssistantMessage("CHECKPOINT: preserve CPU and verify current work");
					}
					const calls = context.messages.flatMap((message) =>
						message.role === "assistant"
							? message.content.filter((block) => block.type === "toolCall").map((block) => block.id)
							: [],
					);
					for (const message of context.messages)
						if (message.role === "toolResult") expect(calls).toContain(message.toolCallId);
					if (projected) expect(text).toContain("CHECKPOINT: preserve CPU");
					return fauxAssistantMessage("Continued after compaction");
				}),
			);
			await harness.session.compact();
			expect(requests).toBeGreaterThan(0);
			if (projected) expect(sawOriginal).toBe(true);
			sizes.push(largest);
			expect(JSON.stringify(harness.sessionManager.getBranch())).toContain("bulk bulk bulk");
			expect(raw).toContain("bulk bulk bulk");
			await harness.session.prompt("Continue after checkpoint");
			expect(harness.session.getLastAssistantText()).toBe("Continued after compaction");
			if (projected) {
				repeated = true;
				harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
				await harness.session.compact();
				expect(sawPrevious).toBe(true);
				await harness.session.prompt("Continue after another checkpoint");
				expect(harness.session.getLastAssistantText()).toBe("Continued after compaction");
			}
		}
		expect(sizes[1]).toBeLessThan(sizes[0]);
		if (count === 50) expect(sizes[0]).toBeGreaterThan(40_000);
	});
	it("includes previous summary, custom instructions and output reserve in the request bound", async () => {
		const harness = await createHarness({
			models: [{ id: "small", contextWindow: 10_000, maxTokens: 1000 }],
			settings: { compaction: { reserveTokens: 1000, keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.session.extensionRunner.createContext().setContextProjection?.(projection);
		const first = harness.sessionManager.appendMessage({ role: "user", content: "Earlier work", timestamp: 1 });
		harness.sessionManager.appendCompaction("PREVIOUS ".repeat(2500), first, 100);
		harness.sessionManager.appendMessage({ role: "user", content: "Current work", timestamp: 250 });
		harness.sessionManager.appendMessage(fauxAssistantMessage("Await next step", { timestamp: 260 }));
		harness.setResponses([fauxAssistantMessage("must not run")]);
		await expect(harness.session.compact("CUSTOM ".repeat(1500))).rejects.toThrow("exceeds the model window");
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});
	it("cancels a projected summary in flight without persisting a checkpoint", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.session.extensionRunner.createContext().setContextProjection?.(projection);
		harness.sessionManager.appendMessage({ role: "user", content: "Work to compact", timestamp: 1 });
		harness.sessionManager.appendMessage(fauxAssistantMessage("Public next step", { timestamp: 250 }));
		let started = () => {};
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		harness.setResponses([
			async (_context, options) => {
				started();
				await new Promise<void>((resolve) =>
					options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
				);
				return fauxAssistantMessage("", { stopReason: "aborted" });
			},
		]);
		const operation = harness.session.compact();
		const cancelled = expect(operation).rejects.toThrow("Compaction cancelled");
		await ready;
		harness.session.abortCompaction();
		await cancelled;
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(harness.session.isCompacting).toBe(false);
	});
});
