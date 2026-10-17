import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolExecutionEndEvent } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("projected session rejection observations", () => {
	it.each([false, true])(
		"observes actual phases without repeating preparation or execution; projected=%s",
		async (projected) => {
			const ends: ToolExecutionEndEvent[] = [];
			let prepared = 0;
			let executed = 0;
			const parameters = Type.Object({ value: Type.String() });
			const tool: AgentTool<typeof parameters> = {
				name: "work",
				label: "Work",
				description: "Observe preparation",
				parameters,
				prepareArguments(input) {
					prepared++;
					if (this.name !== "work") throw new Error("Preparation lost its tool receiver");
					if (typeof input === "object" && input && "prepareError" in input) throw new Error("Preparation failed");
					return input as { value: string };
				},
				execute: async (_id, args) => {
					executed++;
					if (args.value === "error") throw new Error("Real execution error");
					return { content: [{ type: "text", text: args.value }], details: {} };
				},
			};
			const harness = await createHarness({
				tools: [tool],
				settings: { compaction: { enabled: false }, retry: { enabled: false } },
				extensionFactories: [
					(pi) => {
						pi.on("session_start", (_event, ctx) => {
							if (projected) ctx.setContextProjection?.((messages) => messages);
						});
						pi.on("tool_call", (event) =>
							"value" in event.input && event.input.value === "blocked"
								? { block: true, reason: "Original preflight refusal" }
								: undefined,
						);
						pi.on("tool_execution_end", (event) => {
							ends.push(event);
						});
					},
				],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({});
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("work", { prepareError: true }),
						fauxToolCall("work", { missing: true }),
						fauxToolCall("work", { value: "blocked" }),
						fauxToolCall("unknown", {}),
						fauxToolCall("work", { value: "error" }),
						fauxToolCall("work", { value: "good" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Done"),
			]);
			await harness.session.prompt("Exercise the real call phases");
			expect(prepared).toBe(5);
			expect(executed).toBe(2);
			expect(ends.map((event) => event.rejection)).toEqual(
				projected
					? ["preparation", "arguments", "preflight", "tool_not_found", undefined, undefined]
					: Array(6).fill(undefined),
			);
			expect(ends.map((event) => event.isError)).toEqual([true, true, true, true, true, false]);
		},
	);

	it("uses the actual turn's tool snapshot when an earlier call activates a tool", async () => {
		const ends: ToolExecutionEndEvent[] = [];
		let harness: Harness;
		let hiddenExecutions = 0;
		const parameters = Type.Object({});
		harness = await createHarness({
			initialActiveToolNames: ["activate"],
			tools: [
				{
					name: "activate",
					label: "Activate",
					description: "Activate",
					parameters,
					execute: async () => {
						harness.session.setActiveToolsByName(["activate", "hidden"]);
						return { content: [{ type: "text", text: "Activated for the next turn" }], details: {} };
					},
				},
				{
					name: "hidden",
					label: "Hidden",
					description: "Hidden",
					parameters,
					execute: async () => {
						hiddenExecutions++;
						return { content: [{ type: "text", text: "Executed" }], details: {} };
					},
				},
			],
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => ctx.setContextProjection?.((messages) => messages));
					pi.on("tool_execution_end", (event) => {
						ends.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("activate", {}, { id: "activate" }), fauxToolCall("hidden", {}, { id: "old-snapshot" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("hidden", {}, { id: "new-snapshot" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done"),
		]);
		await harness.session.prompt("Activate then use the tool");
		expect(ends.find((event) => event.toolCallId === "activate")?.rejection).toBeUndefined();
		expect(ends.find((event) => event.toolCallId === "old-snapshot")?.rejection).toBe("tool_not_found");
		expect(ends.find((event) => event.toolCallId === "new-snapshot")?.rejection).toBeUndefined();
		expect(hiddenExecutions).toBe(1);
	});

	it.each(["hold", "cancel", "length"] as const)("does not label %s as a call rejection", async (mode) => {
		const ends: ToolExecutionEndEvent[] = [];
		let executions = 0;
		const harness = await createHarness({
			tools: [
				{
					name: "work",
					label: "Work",
					description: "Work",
					parameters: Type.Object({ value: Type.String() }),
					execute: async () => {
						executions++;
						return { content: [{ type: "text", text: "Executed" }], details: {} };
					},
				},
			],
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => ctx.setContextProjection?.((messages) => messages));
					pi.on("tool_call", (_event, ctx) => {
						if (mode === "cancel") ctx.abort();
						if (mode === "hold") ctx.setExecutionHold?.(true);
						return { block: true, reason: "Original hold or cancellation", terminate: true };
					});
					pi.on("tool_execution_end", (event) => {
						ends.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("work", { value: "valid" })], {
				stopReason: mode === "length" ? "length" : "toolUse",
			}),
			fauxAssistantMessage("Done"),
		]);
		await harness.session.prompt("Respect the original interruption");
		expect(executions).toBe(0);
		expect(ends.length).toBeGreaterThan(0);
		expect(ends.every((event) => event.rejection === undefined)).toBe(true);
	});
});
