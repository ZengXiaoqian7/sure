import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { FileEntry } from "../session-manager.ts";
import type { SureCoordinator } from "./coordinator.ts";

/** Preflight before pi.open(), which may initialize absent files or skip malformed lines. */
export function prepareSureSupervisorSession(coordinator: SureCoordinator): {
	sessionDir: string;
	sessionFile?: string;
	sessionId?: string;
	recoveryMessages: Extract<AgentMessage, { role: "toolResult" }>[];
} {
	const sessionDir = join(coordinator.run.runDir, "supervisor", "session");
	const saved = coordinator.state.supervisorSession;
	if (!saved) return { sessionDir, recoveryMessages: [] };
	if (!existsSync(saved.file)) {
		if (saved.status === "ready") throw new Error("Persistent supervisor transcript is missing; diagnosis paused.");
		return { sessionDir, sessionId: saved.id, recoveryMessages: [] };
	}
	const rel = relative(realpathSync(sessionDir), realpathSync(saved.file));
	if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Supervisor transcript escapes its run directory.");
	const entries = readFileSync(saved.file, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as FileEntry);
	const header = entries[0];
	if (
		!header ||
		header.type !== "session" ||
		header.id !== saved.id ||
		resolve(header.cwd) !== resolve(coordinator.run.cwd)
	)
		throw new Error("Persistent supervisor transcript identity does not match this run.");
	const ids = new Set<string>();
	for (const entry of entries.slice(1)) {
		if (entry.type === "session" || !entry.id || ids.has(entry.id) || (entry.parentId && !ids.has(entry.parentId)))
			throw new Error("Persistent supervisor transcript has an invalid branch.");
		ids.add(entry.id);
	}
	if (saved.leafId && !ids.has(saved.leafId)) throw new Error("Supervisor saved checkpoint is missing.");
	const byId = new Map(
		entries
			.slice(1)
			.filter((entry) => entry.type !== "session")
			.map((entry) => [entry.id, entry]),
	);
	const branch: FileEntry[] = [];
	let leaf = entries.at(-1);
	while (leaf && leaf.type !== "session") {
		branch.push(leaf);
		leaf = leaf.parentId ? byId.get(leaf.parentId) : undefined;
	}
	if (saved.leafId && !branch.some((entry) => entry.type !== "session" && entry.id === saved.leafId))
		throw new Error("Supervisor transcript switched to another branch.");
	const pending = new Map<string, { name: string }>();
	for (const entry of branch.reverse()) {
		if (entry.type !== "message") continue;
		if (entry.message.role === "assistant")
			for (const block of entry.message.content)
				if (block.type === "toolCall") pending.set(block.id, { name: block.name });
		if (entry.message.role === "toolResult") pending.delete(entry.message.toolCallId);
	}
	const recoveryMessages: Extract<AgentMessage, { role: "toolResult" }>[] = [];
	for (const [id, call] of pending) {
		const accepted = coordinator.state.attempts.find((attempt) => attempt.acceptedToolCallId === id)?.result;
		recoveryMessages.push({
			role: "toolResult",
			toolCallId: id,
			toolName: call.name,
			isError: !accepted,
			content: [
				{
					type: "text",
					text: accepted
						? "Recovered accepted handoff from the saved coordination record. Do not resubmit it."
						: "Previous tool call was interrupted; its result is unconfirmed. It was not replayed and grants no evidence credit.",
				},
			],
			details: { recovered: true },
			timestamp: Date.now(),
		});
	}
	return { sessionDir, sessionFile: saved.file, recoveryMessages };
}
