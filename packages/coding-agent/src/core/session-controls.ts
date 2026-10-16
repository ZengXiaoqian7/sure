import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "./extensions/types.ts";
import type { UsageTotals } from "./usage-totals.ts";

/** A projection changes the effective model view; the persisted transcript stays intact. */
export type SessionContextProjection = (
	messages: AgentMessage[],
	purpose?: "execution" | "compaction",
) => AgentMessage[];

export interface IsolatedSessionRequest {
	systemPrompt: string;
	sessionDir: string;
	/** Restore this exact transcript, with freshly registered tools. */
	sessionFile?: string;
	sessionId?: string;
	recoveryMessages?: Extract<AgentMessage, { role: "toolResult" }>[];
	tools: ToolDefinition[];
	onTurn: () => boolean;
	resume?: boolean;
	onCompaction?: () => void;
}

export interface IsolatedSession {
	prompt(text: string): Promise<void>;
	disableTools(): void;
	abort(): Promise<void>;
	dispose(): void;
	getMessages(): AgentMessage[];
	getUsage?(): UsageTotals;
	getSessionIdentity?(): { id: string; file: string | undefined; leafId: string | null };
}

/** Supplied by session creation, keeping extensions independent of the SDK module. */
export type IsolatedSessionFactory = (request: IsolatedSessionRequest) => Promise<IsolatedSession>;
