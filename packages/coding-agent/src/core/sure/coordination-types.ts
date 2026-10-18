import type { ToolCallRejection } from "../tool-call-rejection.ts";

/** Versioned, skill-neutral contracts. Hook success and business gate outcome are independent. */
export interface SureCoordinationPolicy {
	version: 1;
	commonPrompt: string;
	stages: SureStageDeclaration[];
	budgets?: Partial<SureCoordinationLimits>;
}

export interface SureStageDeclaration {
	id: string;
	prompt: string;
	references: string[];
	/** Paths use project:, package:, or run: prefixes. Directories are bounded recursively. */
	snapshotPaths: string[];
	/** Preferred capture sources that never grant repair write permission. */
	diagnosticPaths?: string[];
}

export type SureCheckOutcome = "pending" | "passed" | "blocked" | "unchanged" | "exhausted" | "skipped";
export type SureFailureKind = "format" | "semantic" | "tool" | "execution" | "checker_exception" | "no_progress";

/** An observation is not a business check. Identity is captured before tool preflight. */
export interface SureToolObservation {
	toolCallId: string;
	toolName: string;
	unitId?: string;
	batchId?: string;
	requestedAt?: string;
	order?: number;
	completedAt?: string;
	cwd: string;
	input: unknown;
	content: string | { type: string; text?: string }[];
	isError: boolean;
	execution?: "returned" | "skipped";
	rejection?: ToolCallRejection;
	duringHold?: boolean;
}

export interface SureCheckEvidence {
	unitId: string;
	outcome: SureCheckOutcome;
	failureKind?: SureFailureKind;
	/** Optional semantic identity supplied by the producing skill, never inferred from shell text. */
	condition?: { id: string; target?: string; localRepair?: boolean };
	/** The skill verified the previous blocker was resolved and a clear local next step remains. */
	localProgress?: boolean;
	action?: { toolCallId: string; toolName: string; path: string; batchId?: string };
	summary: string;
	repair?: string;
	artifactPaths: string[];
	inputPaths: string[];
	/** Additional diagnosis inputs that must never become repair targets. */
	diagnosticPaths?: string[];
	checker?: string;
	/** Stable producing hook identity; independent subchecks are not merged. */
	sourceId?: string;
	checkId?: string;
	exitCode?: number | null;
	stdout?: string;
	stderr?: string;
	/** Skill-verified monotonic milestone, never inferred from changed files or LLM text. */
	progress?: { key: string; completed: number };
}

/** Invocation failures and preflight observations never establish a business gate result. */
export function isSureBusinessCheck(check: SureCheckEvidence): boolean {
	return (
		check.failureKind !== "tool" &&
		check.failureKind !== "execution" &&
		check.failureKind !== "no_progress" &&
		check.checker !== "pre_tool_call" &&
		!check.checker?.startsWith("tool:") &&
		!check.checker?.startsWith("control:") &&
		!check.checker?.startsWith("rejection:") &&
		!check.sourceId?.startsWith("pre_tool_call:")
	);
}

export type SureCoordinationStatus = "executing" | "yielding" | "diagnosing" | "stopped";

export interface SureDiagnosisResult {
	runId: string;
	unitId: string;
	evidenceVersion: number;
	decision: "repair" | "continue";
	reason?: string;
	facts: string[];
	hypotheses: string[];
	unknowns: string[];
	/** References must resolve to retained snapshots, checks or declared evidence. */
	evidenceReferences?: string[];
	targetFiles?: string[];
	/** Suggested focus only; never an execution write allowlist. */
	focusPaths?: string[];
	validation?: string;
	stopBoundary?: string;
	repair?: string;
	nextActions: string[];
}

export interface SureDiagnosisAttempt {
	supervisorSessionId?: string;
	id: string;
	unitId: string;
	evidenceVersion: number;
	startedAt: string;
	modelTurns: number;
	readCalls: number;
	readRequests?: number;
	elapsedMs: number;
	result?: SureDiagnosisResult;
	error?: string;
	trigger?: string;
	checkpoint?: SureDiagnosisCheckpoint;
	readKeys?: string[];
	segments?: { startedAt: string; modelTurns: number; readCalls: number; elapsedMs: number; error?: string }[];
	compactionCalls?: number;
	protocolErrors?: number;
	protocolErrorTurns?: number;
	protocolFeedback?: boolean;
	protocolLastError?: string;
	acceptedToolCallId?: string;
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
}

/** Internal investigation continuation, never a business repair/stop. */
export interface SureDiagnosisCheckpoint {
	runId: string;
	unitId: string;
	evidenceVersion: number;
	decision: "checkpoint";
	checkpoint: string;
	automatic: boolean;
}

export type SureDiagnosisOutcome = SureDiagnosisResult | SureDiagnosisCheckpoint;

export interface SureRepairRecord {
	id: string;
	source: "supervisor";
	triggerCheckVersion?: number;
	triggerBatchId?: string;
	unitId: string;
	task: string;
	acceptedAt: string;
	beforeSnapshotId?: string;
	afterSnapshotId?: string;
	checkVersions: number[];
	/** Original gate observation only; never proves every action in the task occurred. */
	gateOutcome?: SureCheckOutcome;
	gateCheckVersion?: number;
	remainingBlocker?: string;
	stopReason?: string;
}

export interface SureCoordinationState {
	version: 2;
	runId: string;
	status: SureCoordinationStatus;
	unitId: string;
	evidenceVersion: number;
	updatedAt: string;
	attempts: SureDiagnosisAttempt[];
	repairs?: SureRepairRecord[];
	limits?: SureCoordinationLimits;
	lastCheck?: SureCheckEvidence;
	lastCheckVersion?: number;
	originalFailure?: SureCheckEvidence;
	lastFailure?: SureCheckEvidence;
	lastFailureCheckVersion?: number;
	/** The current failure episode and debugger review position survive reload. */
	unresolvedCheckVersion?: number;
	reviewedFailureVersion?: number;
	yieldReason?: string;
	initialSnapshot?: string;
	lastSuccessSnapshot?: string;
	lastSuccessUnit?: string;
	latestSnapshot?: string;
	stageUnitId?: string;
	unitLabel?: string;
	stageStartedAt?: number;
	/** Stable identifiers survive restarts and duplicate result deliveries. */
	pendingRepair?: {
		id: string;
		result: SureDiagnosisResult;
		delivered: boolean;
		deliveryStarted?: boolean;
		receiverSessionFile?: string;
		receiverSessionId?: string;
		receiverParentId?: string | null;
		receiverMessageId?: string;
	};
	/** Deduplicated checks per unit/tool/source or hook invocation, including resume. */
	observedToolChecks?: Record<string, string>;
	stopReason?: string;
	cancelled?: boolean;
	finishNudges?: number;
	supervisorSession?: {
		id: string;
		file: string;
		status: "initializing" | "ready";
		leafId: string | null;
		accountedAttemptId?: string;
		accountedUsage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
	};
}

export const SURE_COORDINATION_LIMITS = Object.freeze({
	finishNudges: 3,
	snapshotFiles: 256,
	snapshotFileBytes: 256_000,
	snapshotTotalBytes: 2_000_000,
});

export type SureCoordinationLimits = { -readonly [Key in keyof typeof SURE_COORDINATION_LIMITS]: number };
