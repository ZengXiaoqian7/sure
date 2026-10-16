import { type AssistantMessage, fauxAssistantMessage, fauxToolCall, type ToolCall } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import type { IsolatedSessionRequest } from "../../src/core/session-controls.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

export function toolReply(...calls: ToolCall[]): AssistantMessage {
	return fauxAssistantMessage(calls, { stopReason: "toolUse" });
}

export function fixtureTranscript(request: IsolatedSessionRequest, cwd: string) {
	const manager = request.sessionFile
		? SessionManager.open(request.sessionFile, request.sessionDir)
		: SessionManager.create(cwd, request.sessionDir, { id: request.sessionId });
	for (const message of request.recoveryMessages ?? []) manager.appendMessage(message);
	return {
		manager,
		getSessionIdentity: () => ({
			id: manager.getSessionId(),
			file: manager.getSessionFile(),
			leafId: manager.getLeafId(),
		}),
	};
}

export async function submitControlFixture(
	request: IsolatedSessionRequest,
	manager: SessionManager,
	ctx: ExtensionContext,
	reply: AssistantMessage,
): Promise<void> {
	manager.appendMessage(reply);
	for (const call of reply.content) {
		if (call.type !== "toolCall") continue;
		const tool = request.tools.find((tool) => tool.name === call.name)!;
		const result = await tool.execute(call.id, call.arguments, undefined, undefined, ctx);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: result.content,
			details: result.details,
			isError: false,
			timestamp: Date.now(),
		});
	}
	request.onTurn();
}

export function repairHandoff(task: string, focusPaths?: string[]): AssistantMessage {
	return toolReply(fauxToolCall("sure_handoff_repair", { task, ...(focusPaths?.length ? { focusPaths } : {}) }));
}

export function pauseDiagnosis(reason: string): AssistantMessage {
	return toolReply(fauxToolCall("sure_pause_diagnosis", { reason }));
}
