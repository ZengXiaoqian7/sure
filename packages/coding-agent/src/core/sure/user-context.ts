import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SureCoordinator } from "./coordinator.ts";
import { sureHash, writeSureJson } from "./evidence.ts";

interface UserInstruction {
	id: string;
	text: string;
	pending?: boolean;
}

function instruction(message: AgentMessage, runId: string): UserInstruction | undefined {
	if (message.role !== "user") return undefined;
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.map((part) =>
						part.type === "text"
							? part.text
							: "[User image attachment: consult the executor transcript; content not available to this text-only diagnosis.]",
					)
					.join("\n");
	if (
		!text.trim() ||
		/^<sure_(?:invocation|stage_context|supervisor_repair|supervisor_continue)\b/.test(text) ||
		text.startsWith(`Sure run ${runId} is still active, but the last turn ended`)
	)
		return undefined;
	return { id: sureHash(JSON.stringify({ timestamp: message.timestamp, text })), text };
}

/** Persist user-authored instructions, without assistant/tool history or harness prompts. */
export function syncSureUserContext(coordinator: SureCoordinator, messages: AgentMessage[], pending = false): void {
	coordinator.assertOwner?.();
	const path = join(coordinator.run.runDir, "evidence/user-context.json");
	const saved = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as UserInstruction[]) : [];
	const ids = new Set(saved.map(({ id }) => id));
	let changed = false;
	let rebound = false;
	for (const message of messages) {
		const entry = instruction(message, coordinator.run.runId);
		if (!entry) continue;
		if (ids.has(entry.id)) {
			const existing = saved.find((saved) => saved.id === entry.id);
			if (!pending && existing?.pending) {
				delete existing.pending;
				rebound = true;
			}
			continue;
		}
		if (!pending) {
			const queued = saved.find((saved) => saved.pending && saved.text === entry.text);
			if (queued) {
				ids.delete(queued.id);
				Object.assign(queued, entry);
				delete queued.pending;
				ids.add(entry.id);
				rebound = true;
				continue;
			}
		}
		ids.add(entry.id);
		saved.push({ ...entry, ...(pending ? { pending: true } : {}) });
		changed = true;
	}
	if (!changed && !rebound) return;
	writeSureJson(path, saved);
	if (!changed) return;
	coordinator.state.evidenceVersion++;
	coordinator.state.reviewedFailureVersion = undefined;
	if (coordinator.state.pendingRepair || coordinator.state.unresolvedCheckVersion !== undefined) {
		coordinator.invalidateRepair("User instructions changed.");
		if (coordinator.state.status === "executing") coordinator.state.status = "yielding";
		coordinator.state.yieldReason = "User instructions changed; the previous repair must be reconsidered.";
	}
	coordinator.save();
}

/** With a view supplied, restore only instructions absent after compaction or restart. */
export function readSureUserContext(coordinator: SureCoordinator, view: AgentMessage[] = []): string {
	const path = join(coordinator.run.runDir, "evidence/user-context.json");
	if (!existsSync(path)) return "";
	const saved = JSON.parse(readFileSync(path, "utf8")) as UserInstruction[];
	const present = new Set(view.map((message) => instruction(message, coordinator.run.runId)?.id));
	return saved
		.filter(
			({ id, text }) =>
				!present.has(id) &&
				!view.some(
					(message) =>
						message.role === "custom" &&
						message.customType === "sure_user_context" &&
						typeof message.content === "string" &&
						message.content.includes(`[User instruction ${id}]\n${text}`),
				),
		)
		.map(({ id, text }) => `[User instruction ${id}]\n${text}`)
		.join("\n\n");
}
