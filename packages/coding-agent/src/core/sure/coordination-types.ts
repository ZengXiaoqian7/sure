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
	duringHold?: boolean;
}

export interface SureCheckEvidence {
	unitId: string;
	outcome: SureCheckOutcome;
	failureKind?: SureFailureKind;
	/** Retained skill hint; cannot remove a first error's local correction. */
	recovery?: "local_once" | "diagnose";
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

export type SureCoordinationStatus = "executing" | "yielding" | "diagnosing" | "stopped";

export interface SureStopAssessment {
	basis: "external_blocker" | "constraint_conflict" | "no_viable_route";
	blockingCondition: string;
	evidenceReferences: {
		reference: string;
		kind: "source" | "gate_failure" | "tool_result" | "user_constraint";
	}[];
	continuationAssessment: string;
	blockingUnknowns: string[];
}

export interface SureDiagnosisResult {
	runId: string;
	unitId: string;
	evidenceVersion: number;
	decision: "repair" | "stop";
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
	stopReason?: string;
	stopAssessment?: SureStopAssessment;
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
	/** Set only after stop premises pass the current evidence contract. */
	stopValidated?: boolean;
	error?: string;
	trigger?: string;
	checkpoint?: SureDiagnosisCheckpoint;
	timelineOffset?: number;
	userContextOffset?: number;
	timelineHash?: string;
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
export interface SureDiagnosisCheckpoint extends Omit<SureDiagnosisResult, "decision"> {
	decision: "checkpoint";
	checkpoint: string;
	nextReads: Record<string, unknown>[];
	candidateRange: { startBatch: string; endBatch: string } | null;
	supportingEvidence: string[];
	opposingEvidence: string[];
	automatic: boolean;
}

export type SureDiagnosisOutcome = SureDiagnosisResult | SureDiagnosisCheckpoint;

export interface SureUnitBudget {
	calls?: number;
	actions?: Record<string, number>;
	checks: number;
	noProgress: number;
	directRepairs: number;
	/** Read once when loading pre-v4 runs; never grants a fresh allowance. */
	formatRepairs?: number;
	supervisorRepairs: number;
	lastFingerprint?: string;
	progress?: { key: string; completed: number; inputFingerprint: string };
	directRepairStalledBatches?: number;
	directRepairProgressSinceBatch?: boolean;
	directRepairLastBatchId?: string;
}

export interface SureRepairRecord {
	id: string;
	source?: "executor" | "supervisor";
	triggerCheckVersion?: number;
	triggerBatchId?: string;
	/** Only an associated, actually returned check can settle a correction. */
	verificationCheckVersion?: number;
	/** A distinct error/object discovered while pursuing this repair. */
	parentRepairId?: string;
	relation?: "independent" | "related";
	toolStallHandoff?: boolean;
	unitId: string;
	task: string;
	acceptedAt: string;
	beforeSnapshotId?: string;
	afterSnapshotId?: string;
	checkVersions: number[];
	outcome: SureCheckOutcome | "invalidated" | "stopped";
	remainingBlocker?: string;
	stopReason?: string;
	remainingBudget: { kind?: "review_thresholds"; calls: number; checks: number; supervisorRepairs: number };
}

export interface SureCoordinationState {
	version: 1;
	runId: string;
	status: SureCoordinationStatus;
	unitId: string;
	evidenceVersion: number;
	updatedAt: string;
	units: Record<string, SureUnitBudget>;
	attempts: SureDiagnosisAttempt[];
	repairs?: SureRepairRecord[];
	limits?: SureCoordinationLimits;
	lastCheck?: SureCheckEvidence;
	lastCheckVersion?: number;
	originalFailure?: SureCheckEvidence;
	lastFailure?: SureCheckEvidence;
	lastFailureCheckVersion?: number;
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
	};
	pendingDirectRepairId?: string;
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
	diagnosesPerUnit: 3,
	supervisorRepairsPerUnit: 2,
	noProgressChecks: 3, // Historical setting; repeated calls/batches are observations, not handoff triggers.
	checksPerUnit: 40,
	finishNudges: 3,
	snapshotFiles: 256,
	snapshotFileBytes: 256_000,
	snapshotTotalBytes: 2_000_000,
});

export type SureCoordinationLimits = { -readonly [Key in keyof typeof SURE_COORDINATION_LIMITS]: number };
