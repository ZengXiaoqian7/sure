import { Container, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentActivity } from "../src/core/extensions/types.ts";
import type { WorkingStatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const actor = { role: "Supervisor", runId: "run", attemptId: "attempt", runtimeId: "runtime" };

function fixture() {
	initTheme("dark");
	const state = {
		activeAgentActivity: undefined as string | undefined,
		agentActivityTools: new Map<string, ToolExecutionComponent>(),
		pendingTools: new Map<string, ToolExecutionComponent>(),
		chatContainer: new Container(),
		toolOutputExpanded: false,
		workingVisible: true,
		session: { isStreaming: false },
		sessionManager: { getCwd: () => "/tmp" },
		settingsManager: { getShowImages: () => false, getImageWidthCells: () => 60 },
		showWorkingStatusIndicator: vi.fn(),
		clearStatusIndicator: vi.fn(),
		ui: { requestRender: vi.fn() } as unknown as TUI,
	};
	const show = Reflect.get(InteractiveMode.prototype, "showAgentActivity") as (
		this: typeof state,
		activity: AgentActivity,
	) => void;
	return {
		state,
		show: (event: AgentActivity["event"], identity = actor) => show.call(state, { ...identity, event }),
	};
}

describe("isolated agent activity presentation", () => {
	it("shows real tool updates without consuming executor tool ids and ignores other identities", () => {
		const { state, show } = fixture();
		show({ type: "start" });
		expect(state.session.isStreaming).toBe(false);
		expect(state.showWorkingStatusIndicator).toHaveBeenCalledOnce();
		show({ type: "tool_execution_start", toolCallId: "same-id", toolName: "read", args: { path: "/tmp/evidence" } });
		show({
			type: "tool_execution_update",
			toolCallId: "same-id",
			toolName: "read",
			args: { path: "/tmp/evidence" },
			partialResult: { content: [{ type: "text", text: "partial evidence" }], details: {} },
		});
		expect(state.agentActivityTools.size).toBe(1);
		expect(state.pendingTools.size).toBe(0);
		const component = state.chatContainer.children[0];
		expect(component).toBeInstanceOf(ToolExecutionComponent);
		expect(stripAnsi(component.render(100).join("\n"))).toContain("Supervisor · read");
		expect(stripAnsi(component.render(100).join("\n"))).toContain("partial evidence");
		show({ type: "end" }, { ...actor, runtimeId: "stale-runtime" });
		show({ type: "end" }, { ...actor, runId: "other-run" });
		expect(state.agentActivityTools.size).toBe(1);
		show({
			type: "tool_execution_end",
			toolCallId: "same-id",
			toolName: "read",
			result: { content: [{ type: "text", text: "final evidence" }], details: {} },
			isError: false,
		});
		expect(state.agentActivityTools.size).toBe(0);
		expect(stripAnsi(component.render(100).join("\n"))).toContain("final evidence");
		show({ type: "end" });
		expect(state.clearStatusIndicator).toHaveBeenCalledWith("working");
		const before = state.chatContainer.children.length;
		show({ type: "tool_execution_start", toolCallId: "late", toolName: "read", args: {} });
		expect(state.chatContainer.children).toHaveLength(before);
	});

	it("settles interrupted tool rows and restores the executor working state", () => {
		const { state, show } = fixture();
		state.session.isStreaming = true;
		show({ type: "start" });
		show({ type: "tool_execution_start", toolCallId: "pending", toolName: "read", args: {} });
		show({ type: "end" });
		expect(state.agentActivityTools.size).toBe(0);
		expect(state.activeAgentActivity).toBeUndefined();
		expect(state.showWorkingStatusIndicator).toHaveBeenCalledTimes(2);
		expect(state.clearStatusIndicator).not.toHaveBeenCalled();
		expect(stripAnsi(state.chatContainer.render(100).join("\n"))).toContain(
			"Activity ended before this tool returned.",
		);
	});

	it("renders the exact supervisor working message through the existing indicator", () => {
		const indicators: WorkingStatusIndicator[] = [];
		const state = {
			activeAgentActivity: "active",
			workingMessage: "executor message",
			defaultWorkingMessage: "Working…",
			workingIndicatorOptions: { frames: ["*"] },
			editor: {},
			ui: { requestRender: vi.fn() },
			showStatusIndicator: (indicator: WorkingStatusIndicator) => indicators.push(indicator),
		};
		const show = Reflect.get(InteractiveMode.prototype, "showWorkingStatusIndicator") as (this: typeof state) => void;
		show.call(state);
		try {
			expect(stripAnsi(indicators[0].render(120).join("\n"))).toContain(
				"Supervisor · reviewing evidence and preparing guidance…",
			);
		} finally {
			indicators[0].dispose();
		}
	});
});
