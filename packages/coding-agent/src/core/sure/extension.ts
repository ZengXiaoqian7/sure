import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type AgentEndEvent,
	defineTool,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionFactory,
} from "../extensions/index.ts";
import { sessionEntryToContextMessages } from "../session-manager.ts";
import { SESSION_OUTCOME_ENTRY } from "../session-outcome.ts";
import {
	buildSureCommonPrompt,
	buildSureStagePrompt,
	captureSureExecutorProgress,
	planSureContextTrim,
	projectSureContext,
	sureCurrentUnit,
	surePromptPaths,
} from "./context.ts";
import {
	SURE_COORDINATION_LIMITS,
	type SureCheckEvidence,
	type SureDiagnosisCheckpoint,
} from "./coordination-types.ts";
import { SureCoordinator } from "./coordinator.ts";
import { loadSureCheckRecords, loadSureDiagnosticIndex } from "./diagnostic-view.ts";
import { readSureSnapshot, sureHash, writeSureJson } from "./evidence.ts";
import {
	buildSureFailureReport,
	persistSureFailureReport,
	renderSureFailureReport,
	type SureFailureReport,
} from "./failure-report.ts";
import { SureHookRunner } from "./hooks.ts";
import { runSureInit } from "./init.ts";
import type { SureInitManifest } from "./init-types.ts";
import { discoverSureSkillPackages, SURE_COMMANDS, type SureDiscoveryDiagnostic } from "./manifest.ts";
import { resolveOutputDir, stripOutputDir } from "./output-dir.ts";
import { acquireSureRunOwnership, type SureRunOwnership } from "./ownership.ts";
import { SureRunManager } from "./run-manager.ts";
import { formatSureDisplayStatus, normalizeSureDisplayStatePatch } from "./state.ts";
import { diagnoseSureRun } from "./supervisor.ts";
import type {
	SureArtifactRequirement,
	SureDisplayState,
	SureFinishDetails,
	SureFinishParams,
	SureHookResult,
	SureManifestEnvelope,
	SureRunRecord,
	SureSkillPackage,
	SureToolContent,
	SureUpdateStateDetails,
} from "./types.ts";
import { readSureUserContext, syncSureUserContext } from "./user-context.ts";

const FINISH_TOOL_NAME = "sure_finish";
const UPDATE_STATE_TOOL_NAME = "sure_update_state";
const STATUS_KEY = "sure";

const finishToolParams = Type.Object({
	status: StringEnum(["success", "incomplete", "failed"] as const, {
		description: "Final Sure run status.",
	}),
	manifest_path: Type.String({
		description:
			"Path to the run-level Sure finish manifest (normally .sure/runs/<run_id>/manifest.json), not a skill-produced artifact manifest such as Feed's artifacts/debug/handoff_manifest.json; use a project-relative path or an absolute path inside the project.",
	}),
	summary: Type.String({ description: "Concise final summary of the Sure run." }),
	artifacts: Type.Optional(Type.Unsafe<unknown>({ description: "Structured final artifact summary." })),
	error_summary: Type.Optional(Type.String({ description: "Failure or incompleteness summary, when relevant." })),
	next_actions: Type.Optional(Type.Array(Type.String(), { description: "Concrete follow-up actions." })),
});

const displayPhaseParams = Type.Object({
	id: Type.Optional(Type.String({ description: "Skill-defined phase id." })),
	label: Type.Optional(Type.String({ description: "Human-readable phase label." })),
	status: Type.Optional(
		StringEnum(["pending", "running", "success", "failed", "incomplete", "skipped", "blocked"] as const, {
			description: "Skill-defined phase status.",
		}),
	),
	progress: Type.Optional(Type.Number({ description: "Optional phase progress value." })),
});

const displayDiagnosticParams = Type.Object({
	severity: Type.Optional(StringEnum(["info", "warning", "error"] as const)),
	code: Type.Optional(Type.String({ description: "Skill-defined diagnostic code." })),
	message: Type.String({ description: "Human-readable diagnostic message." }),
	repair: Type.Optional(Type.String({ description: "Suggested repair action." })),
	data: Type.Optional(Type.Unsafe<unknown>({ description: "Optional skill-defined diagnostic payload." })),
});

const displayArtifactParams = Type.Object({
	type: Type.Optional(Type.String({ description: "Skill-defined artifact type." })),
	name: Type.Optional(Type.String({ description: "Human-readable artifact name." })),
	path: Type.Optional(Type.String({ description: "Artifact path relative to the project or run workspace." })),
	status: Type.Optional(StringEnum(["draft", "ready", "failed", "incomplete"] as const)),
	summary: Type.Optional(Type.String({ description: "Artifact summary." })),
	metadata: Type.Optional(Type.Record(Type.String(), Type.Unsafe<unknown>({}))),
});

const updateStateToolParams = Type.Object({
	phase: Type.Optional(displayPhaseParams),
	message: Type.Optional(Type.String({ description: "Current run message for TUI/WebUI display." })),
	progress: Type.Optional(Type.Number({ description: "Optional overall progress value." })),
	counters: Type.Optional(Type.Record(Type.String(), Type.Number())),
	diagnostics: Type.Optional(Type.Array(displayDiagnosticParams)),
	artifacts: Type.Optional(Type.Array(displayArtifactParams)),
	next_actions: Type.Optional(Type.Array(Type.String())),
});

interface ActiveRun {
	ownership?: SureRunOwnership;
	batchId?: string;
	/** Request identity survives stage changes while parallel tools are running. */
	toolInvocations?: Map<
		string,
		{
			checkVersionAtStart: number;
			identity: {
				unitId: string;
				batchId?: string;
				requestedAt: string;
				order: number;
				cwd: string;
				toolName: string;
				input: unknown;
			};
			settled: Promise<void>;
			complete: () => void;
		}
	>;
	coordinator?: SureCoordinator;
	trimmedCalls?: string[];
	compactionTrim?: string[];
	resultQueue?: Promise<void>;
	terminalizing?: boolean;
	shuttingDown?: boolean;
	diagnosis?: ReturnType<typeof diagnoseSureRun>;
	record: SureRunRecord;
	skillPackage: SureSkillPackage;
	hooks: SureHookRunner;
	previousActiveTools: string[];
	/** Set when an agent turn ended without sure_finish (excluding user aborts). */
	finishMissing?: boolean;
	/** Headless continuation prompts sent for this run. */
	finishNudges?: number;
	/** Messages from the latest agent_end, read once the run settles. */
	lastAgentMessages?: AgentEndEvent["messages"];
}

/** Cap on automatic continuation prompts for headless (print/json) runs. */
const MAX_FINISH_NUDGES = SURE_COORDINATION_LIMITS.finishNudges;

function buildFinishNudge(run: SureRunRecord): string {
	return [
		`Sure run ${run.runId} is still active, but the last turn ended without calling ${FINISH_TOOL_NAME}.`,
		`Continue the run now: complete the remaining work, then call ${FINISH_TOOL_NAME} with the final manifest.`,
		`If the run cannot proceed, call ${FINISH_TOOL_NAME} with status "failed" and summarize the blocker.`,
	].join(" ");
}

function formatDiagnostics(diagnostics: SureDiscoveryDiagnostic[]): string {
	return diagnostics.map((diagnostic) => `${diagnostic.type}: ${diagnostic.message}`).join("\n");
}

export function buildInvocationPrompt(skillPackage: SureSkillPackage, run: SureRunRecord): string {
	const relativePackage = relative(run.cwd, skillPackage.packageDir) || ".";
	const agentArgs = stripOutputDir(run.args);
	return [
		`<sure_invocation run_id="${run.runId}" skill="${skillPackage.manifest.name}" command="/${skillPackage.manifest.command}">`,
		`Package directory: ${relativePackage}`,
		`Run directory: ${relative(run.cwd, run.runDir)}`,
		`User arguments: ${agentArgs || "(none)"}`,
		"",
		"Run this Sure skill as a scientific task. Produce durable artifacts in the run directory or project workspace.",
		"Use the skill instructions below. References are relative to the package directory.",
		"",
		skillPackage.manifest.coordination
			? `# /${skillPackage.manifest.command}\nThe harness supplies common rules, the current unit contract and reference entry points in the effective stage context.`
			: skillPackage.prompt,
		"",
		"Completion protocol:",
		`- Finish by calling ${FINISH_TOOL_NAME} as a standalone final tool call.`,
		"- Do not emit a normal final answer instead of the finish tool.",
		"- If the finish tool returns repair instructions, fix the artifacts and call it again.",
		"- The final manifest must include schema_version, run_id, skill_name, status, created_at, inputs, outputs, and validation.",
		"</sure_invocation>",
	].join("\n");
}

export function buildResumePrompt(
	skillPackage: SureSkillPackage,
	run: SureRunRecord,
	state: SureDisplayState | undefined,
): string {
	const checkpoint = state?.checkpoint;
	return [
		buildInvocationPrompt(skillPackage, run),
		"",
		`<sure_resume run_id="${run.runId}">`,
		"This run already produced work in its run directory. Pick it back up rather than starting over.",
		`Checkpoint: ${checkpoint?.label ?? checkpoint?.id ?? "(unnamed)"}`,
		`Where it stopped: ${state?.message ?? "(not recorded)"}`,
		`Resume from: ${checkpoint?.resume_hint ?? "(no hint recorded; read the run directory to see what is already done)"}`,
		"Read the existing artifacts before writing anything, and do not redo units that are already complete.",
		"</sure_resume>",
	].join("\n");
}

function toolText(text: string): SureToolContent[] {
	return [{ type: "text", text }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && !Array.isArray(value);
}

function isPathInside(baseDir: string, candidate: string): boolean {
	const rel = relative(baseDir, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && rel !== "..");
}

function isManifestArtifact(value: unknown): value is { type?: string; path?: string } {
	if (!isStringRecord(value)) {
		return false;
	}
	return (
		(value.type === undefined || typeof value.type === "string") &&
		(value.path === undefined || typeof value.path === "string")
	);
}

function hasCheckpointPatch(value: unknown): boolean {
	return isStringRecord(value) && value.checkpoint !== undefined;
}

const CHECKPOINT_COUNTER_KEYS = new Set(["completed_units", "total_units", "gate_blocks"]);
const CHECKPOINT_TERMINAL_PHASE_STATUSES = new Set(["success", "failed", "incomplete", "skipped"]);

function validateAgentStateUpdatePolicy(
	runManager: SureRunManager,
	active: ActiveRun,
	patch: SureDisplayState,
): string | undefined {
	const currentState = runManager.readState(active.record);
	if (!currentState?.checkpoint) {
		return undefined;
	}
	const phaseStatus = patch.phase?.status;
	if (phaseStatus && CHECKPOINT_TERMINAL_PHASE_STATUSES.has(phaseStatus)) {
		return `${UPDATE_STATE_TOOL_NAME} cannot set terminal phase status "${phaseStatus}" during checkpoint-controlled Sure runs; produce the required artifact and let hooks advance or call ${FINISH_TOOL_NAME}.`;
	}
	for (const key of Object.keys(patch.counters ?? {})) {
		if (CHECKPOINT_COUNTER_KEYS.has(key)) {
			return `${UPDATE_STATE_TOOL_NAME} cannot update checkpoint counter "${key}"; checkpoint counters are controlled by Sure hooks.`;
		}
	}
	for (const artifact of patch.artifacts ?? []) {
		if (artifact.status !== "ready") {
			continue;
		}
		if (!artifact.path) {
			return `${UPDATE_STATE_TOOL_NAME} cannot mark an artifact ready without a path during checkpoint-controlled Sure runs.`;
		}
		const resolved = isAbsolute(artifact.path)
			? resolve(artifact.path)
			: runManager.resolveRunPath(active.record, artifact.path);
		if (!resolved || !existsSync(resolved)) {
			return `${UPDATE_STATE_TOOL_NAME} cannot mark missing artifact "${artifact.path}" as ready during checkpoint-controlled Sure runs.`;
		}
	}
	return undefined;
}

function setRunStatusText(ctx: ExtensionContext, run: SureRunRecord, state?: SureDisplayState): void {
	ctx.ui.setStatus(STATUS_KEY, formatSureDisplayStatus(run.command, run.runId, state));
}

function applyStatePatch(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	active: ActiveRun,
	patchValue: unknown,
	eventType: string,
	hookExecutionId?: string,
): { ok: boolean; state?: SureDisplayState; repair?: string } {
	if (patchValue === undefined) {
		return { ok: true };
	}
	active.ownership?.assertCurrent();
	const normalized = normalizeSureDisplayStatePatch(patchValue);
	if (!normalized.ok || !normalized.state) {
		const repair = normalized.message ?? "Invalid Sure state patch.";
		pi.appendEntry("sure.diagnostic", {
			type: "warning",
			message: repair,
			path: active.skillPackage.manifestPath,
		});
		return { ok: false, repair };
	}
	const runManager = new SureRunManager(active.record.cwd);
	const previous = runManager.readState(active.record);
	const state = runManager.updateState(active.record, normalized.state, eventType, hookExecutionId);
	if (
		active.skillPackage.manifest.coordination &&
		(previous?.phase?.id !== state.phase?.id || previous?.message !== state.message)
	) {
		ctx.ui.notify(
			`${state.phase?.label ?? state.phase?.id ?? "SURE"}: ${normalized.state.message ?? normalized.state.diagnostics?.at(-1)?.message ?? normalized.state.phase?.status ?? "running"}`,
			state.phase?.status === "blocked" ? "warning" : "info",
		);
	}
	pi.appendEntry("sure.state", {
		runId: active.record.runId,
		command: active.record.command,
		skillName: active.record.skillName,
		state,
	});
	setRunStatusText(ctx, active.record, state);
	return { ok: true, state };
}

function activeToolNames(active: ActiveRun): string[] {
	return [...new Set([...active.previousActiveTools, FINISH_TOOL_NAME, UPDATE_STATE_TOOL_NAME])];
}

function installCoordinatedContext(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	active: ActiveRun,
	extraScope: string[] = [],
): void {
	const policy = active.skillPackage.manifest.coordination;
	if (!policy) return;
	const manager = new SureRunManager(active.record.cwd);
	const unit = sureCurrentUnit(active.skillPackage, manager.readState(active.record));
	const stage = policy.stages.find((stage) => stage.id === unit);
	const scope = [...(stage?.snapshotPaths ?? []), ...surePromptPaths(active.skillPackage, unit), ...extraScope];
	active.coordinator = new SureCoordinator(
		active.record,
		unit,
		scope,
		policy.budgets,
		active.ownership?.assertCurrent,
	);
	syncSureUserContext(
		active.coordinator,
		ctx.sessionManager.getBranch().flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
	);
	const coordinator = active.coordinator;
	const coordination = coordinator.state;
	const phase = manager.readState(active.record)?.phase;
	if (phase?.id === unit && phase.label) {
		coordination.unitLabel = phase.label;
		active.coordinator.save();
	}
	if (coordination.stageStartedAt === undefined) {
		coordination.stageStartedAt = Date.now();
		coordination.stageUnitId = unit;
		active.coordinator.save();
	}
	const savedTrim = ctx.sessionManager
		.getBranch()
		.reverse()
		.find(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === "sure.context.trim" &&
				(entry.data as { runId?: string })?.runId === active.record.runId,
		);
	active.trimmedCalls = savedTrim?.type === "custom" ? (savedTrim.data as { calls: string[] }).calls : [];
	ctx.setContextProjection?.((messages, purpose) =>
		projectSureContext(
			messages,
			purpose === "compaction"
				? planSureContextTrim(
						messages,
						coordination.stageStartedAt ?? 0,
						coordination,
						loadSureCheckRecords(coordinator),
					)
				: (active.trimmedCalls ?? []),
		),
	);
	syncCoordinatedMessages(pi, ctx, active, true);
}

/** Native custom-message queue: persisted once, after a whole tool batch, without starting a turn. */
function syncCoordinatedMessages(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	active: ActiveRun,
	restoreEvidence = false,
): void {
	const coordinator = active.coordinator;
	if (!coordinator || coordinator.isStopped || active.shuttingDown) return;
	active.ownership?.assertCurrent();
	const state = new SureRunManager(active.record.cwd).readState(active.record);
	const unit = sureCurrentUnit(active.skillPackage, state);
	if (coordinator.state.stageUnitId !== unit) {
		coordinator.state.stageUnitId = unit;
		coordinator.state.stageStartedAt = Date.now();
		coordinator.save();
	}
	const view = ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
	const append = (kind: string, text: string) => {
		const id = `${active.record.runId}:${kind}:${sureHash(text)}`;
		if (
			view.some(
				(message) =>
					message.role === "custom" &&
					(message.details as { sureContextId?: string } | undefined)?.sureContextId === id,
			)
		)
			return;
		pi.sendMessage(
			{ customType: `sure_${kind}`, content: text, display: false, details: { sureContextId: id } },
			{ triggerTurn: false },
		);
	};
	append("common_context", buildSureCommonPrompt(active.skillPackage, active.record));
	append(
		"stage_context",
		`<sure_stage_context>\n${buildSureStagePrompt(active.skillPackage, active.record, state)}\n</sure_stage_context>`,
	);
	const constraints = readSureUserContext(coordinator, view);
	if (constraints) append("user_context", constraints);
	if (restoreEvidence) {
		const records = loadSureCheckRecords(coordinator);
		const required = new Map<string, SureCheckEvidence>();
		const unresolved = records.find((record) => record.version === coordinator.state.unresolvedCheckVersion)?.check;
		if (unresolved?.action) required.set(unresolved.action.toolCallId, unresolved);
		if (required.size || coordinator.state.pendingRepair)
			for (const check of [coordinator.state.originalFailure, coordinator.state.lastFailure])
				if (check?.action) required.set(check.action.toolCallId, check);
		for (const [id, check] of required) {
			if (view.some((message) => message.role === "toolResult" && message.toolCallId === id)) continue;
			const path = join(active.record.runDir, "evidence/tools", `${sureHash(id)}.json`);
			if (!existsSync(path)) continue;
			const action = JSON.parse(readFileSync(path, "utf8")) as {
				toolName: string;
				input: unknown;
				content: unknown;
				isError: boolean;
			};
			append(
				"unresolved_evidence",
				`Retained original-condition evidence for unresolved correction; historical, not a current validation. Source: run:evidence/tools/${sureHash(id)}.json\n${JSON.stringify({ toolCallId: id, toolName: action.toolName, input: action.input, content: action.content, isError: action.isError, check })}`,
			);
		}
	}
	// Keep the most recent task body even when an original gate has cleared pendingRepair.
	const repair = [...(coordinator.state.repairs ?? [])]
		.reverse()
		.find((repair) => repair.source === "supervisor" && repair.unitId === unit);
	if (
		repair &&
		(repair.stopReason === undefined || coordinator.state.pendingRepair?.id === repair.id) &&
		(!coordinator.state.pendingRepair || coordinator.state.pendingRepair.delivered) &&
		!view.some(
			(message) =>
				(message.role === "user" || message.role === "custom") &&
				(typeof message.content === "string" ? message.content : JSON.stringify(message.content)).includes(
					`<sure_supervisor_repair id="${repair.id}"`,
				),
		)
	)
		append(
			"retained_repair",
			`<sure_supervisor_repair id="${repair.id}" run_id="${active.record.runId}" unit="${repair.unitId}" retained="true">\n${repair.task}\n</sure_supervisor_repair>\nRetained body of the same accepted task, not a new assignment. Original gate observation: ${repair.gateOutcome ?? "not recorded"}; this alone does not establish every action in the goal. Reuse verified current-version evidence; do not repeat completed work merely because the body was restored.`,
		);
	const continued = coordinator.lastDiagnosis;
	if (
		coordinator.state.status === "executing" &&
		!coordinator.state.pendingRepair &&
		coordinator.state.reviewedFailureVersion !== undefined &&
		continued?.decision === "continue" &&
		continued.unitId === unit
	) {
		const id = `${active.record.runId}:${unit}:${continued.evidenceVersion}`;
		if (
			!view.some(
				(message) =>
					(message.role === "user" || message.role === "custom") &&
					(typeof message.content === "string" ? message.content : JSON.stringify(message.content)).includes(
						`<sure_supervisor_continue id="${id}"`,
					),
			)
		)
			append(
				"retained_continue",
				`<sure_supervisor_continue id="${id}" run_id="${active.record.runId}" unit="${unit}" retained="true">\n${continued.reason}\n</sure_supervisor_continue>\nRetained guidance from the same investigation, not a new assignment. Continue with the original permissions and gates, without returning for supervisor approval.`,
			);
	}
}

function coordinatedScope(active: ActiveRun): string[] {
	const coordinator = active.coordinator;
	const stage = active.skillPackage.manifest.coordination?.stages.find(
		(stage) => stage.id === coordinator?.state.unitId,
	);
	return [
		...new Set([
			...(stage?.snapshotPaths ?? []),
			...surePromptPaths(active.skillPackage, coordinator?.state.unitId ?? "unknown"),
			...(coordinator?.state.lastCheck?.inputPaths ?? []),
			...(coordinator?.state.lastCheck?.artifactPaths ?? []),
			...(coordinator?.state.lastCheck?.diagnosticPaths ?? []),
			...[
				coordinator?.state.lastCheck?.action?.path,
				coordinator?.state.originalFailure?.action?.path,
				coordinator?.state.lastFailure?.action?.path,
			].filter((path): path is string => Boolean(path)),
			...(stage?.references.map((path) => `package:${path}`) ?? []),
			...(coordinator
				? loadSureDiagnosticIndex(coordinator)
						.actions.filter(
							(action) =>
								action.unitId === coordinator.state.unitId ||
								action.checkUnitId === coordinator.state.unitId ||
								(active.batchId !== undefined && action.batchId === active.batchId),
						)
						.map((action) => action.path)
				: []),
		]),
	];
}

function observeCoordinatedCheck(
	active: ActiveRun,
	ctx: ExtensionContext,
	check: SureHookResult["check"] | NonNullable<SureHookResult["check"]>[],
	patch?: unknown,
): void {
	if (Array.isArray(check)) {
		if (!check.length) observeCoordinatedCheck(active, ctx, undefined, patch);
		// Retain each failed source; passing subchecks cannot promote a blocked unit.
		const priority = { pending: 0, skipped: 1, passed: 2, unchanged: 3, blocked: 4, exhausted: 5 };
		const units = new Map<string, NonNullable<SureHookResult["check"]>[]>();
		for (const item of check) {
			const items = units.get(item.unitId) ?? [];
			items.push(item);
			units.set(item.unitId, items);
		}
		for (const items of units.values()) {
			const failures = items.filter((item) => item.outcome === "blocked" || item.outcome === "exhausted");
			for (const item of failures.length
				? failures
				: [items.reduce((a, b) => (priority[a.outcome] >= priority[b.outcome] ? a : b))])
				observeCoordinatedCheck(active, ctx, item, patch);
		}
		return;
	}
	const coordinator = active.coordinator;
	if (!check && isRecord(patch) && isRecord(patch.phase) && patch.phase.status === "blocked") {
		check = {
			unitId: sureCurrentUnit(active.skillPackage, new SureRunManager(active.record.cwd).readState(active.record)),
			outcome: "blocked",
			summary:
				typeof patch.message === "string"
					? patch.message
					: "The skill reported a blocked phase without an error classification.",
			artifactPaths: [],
			inputPaths: [],
		};
	}
	if (!coordinator || !check) return;
	const phase = new SureRunManager(active.record.cwd).readState(active.record)?.phase;
	if (phase?.id === check.unitId && phase.label) coordinator.state.unitLabel = phase.label;
	if (check.unitId === "unknown")
		check = {
			...check,
			unitId: sureCurrentUnit(active.skillPackage, new SureRunManager(active.record.cwd).readState(active.record)),
		};
	const stage = active.skillPackage.manifest.coordination?.stages.find((stage) => stage.id === check.unitId);
	coordinator.observe(check, [
		...(stage?.snapshotPaths ?? []),
		...surePromptPaths(active.skillPackage, check.unitId),
		...check.inputPaths,
		...check.artifactPaths,
		...(check.diagnosticPaths ?? []),
		...(check.action ? [check.action.path] : []),
	]);
	if (coordinator.state.status !== "executing") ctx.setExecutionHold?.(true);
}

function possibleArtifactPaths(runManager: SureRunManager, run: SureRunRecord, pathValue: string): string[] {
	const paths: string[] = [];
	const projectOrAbsolutePath = runManager.resolveRunPath(run, pathValue);
	if (projectOrAbsolutePath) {
		paths.push(projectOrAbsolutePath);
	}
	if (!isAbsolute(pathValue)) {
		const runRelativePath = resolve(run.runDir, pathValue);
		if (isPathInside(run.runDir, runRelativePath)) {
			paths.push(runRelativePath);
		}
	}
	return [...new Set(paths)];
}

function artifactPathExists(runManager: SureRunManager, run: SureRunRecord, pathValue: string): boolean {
	return possibleArtifactPaths(runManager, run, pathValue).some((artifactPath) => existsSync(artifactPath));
}

function artifactPathMatchesRequirement(
	runManager: SureRunManager,
	run: SureRunRecord,
	artifactPath: string | undefined,
	requirementPath: string,
): boolean {
	if (!artifactPath) {
		return false;
	}
	if (artifactPath === requirementPath) {
		return true;
	}
	const artifactPaths = new Set(possibleArtifactPaths(runManager, run, artifactPath));
	return possibleArtifactPaths(runManager, run, requirementPath).some((path) => artifactPaths.has(path));
}

function artifactSatisfiesRequirement(
	runManager: SureRunManager,
	run: SureRunRecord,
	artifact: { type?: string; path?: string },
	requirement: SureArtifactRequirement,
): boolean {
	const requirementPath = requirement.path ?? "";
	if (artifactPathMatchesRequirement(runManager, run, artifact.path, requirementPath)) {
		return true;
	}
	if (!artifact.path || !artifactPathExists(runManager, run, artifact.path)) {
		return false;
	}
	if (requirementPath !== "" && basename(artifact.path) === basename(requirementPath)) {
		return true;
	}
	if (requirement.type && artifact.type !== requirement.type) {
		return false;
	}
	return false;
}

function formatArtifactDescription(artifact: { type?: string; path?: string }, index: number): string {
	if (artifact.type) {
		return `"${artifact.type}"`;
	}
	if (artifact.path) {
		return `"${artifact.path}"`;
	}
	return `at index ${index}`;
}

function validateManifestArtifacts(
	manifest: SureManifestEnvelope,
	runManager: SureRunManager,
	run: SureRunRecord,
): string | undefined {
	for (const [index, artifact] of (manifest.artifacts ?? []).entries()) {
		const description = formatArtifactDescription(artifact, index);
		if (!artifact.path || artifact.path.trim() === "") {
			return `Final manifest artifact ${description} must include a path.`;
		}
		if (!artifactPathExists(runManager, run, artifact.path)) {
			return `Manifest artifact path does not exist: ${artifact.path}.`;
		}
	}
	return undefined;
}

function outputArtifacts(manifest: SureManifestEnvelope): Array<{ type?: string; path?: string }> {
	const artifacts: Array<{ type?: string; path?: string }> = [];
	for (const [key, value] of Object.entries(manifest.outputs ?? {})) {
		if (typeof value === "string" && value.trim() !== "") {
			artifacts.push({ type: key, path: value });
			continue;
		}
		if (isStringRecord(value) && typeof value.path === "string" && value.path.trim() !== "") {
			artifacts.push({
				type: typeof value.type === "string" ? value.type : key,
				path: value.path,
			});
		}
	}
	return artifacts;
}

function validateRequiredArtifact(
	requirement: SureArtifactRequirement,
	manifest: SureManifestEnvelope,
	runManager: SureRunManager,
	run: SureRunRecord,
): string | undefined {
	if (!requirement.required) {
		return undefined;
	}
	if (!requirement.path || requirement.path.trim() === "") {
		const label = requirement.type
			? `"${requirement.type}"`
			: requirement.description
				? `"${requirement.description}"`
				: "";
		return `Required artifact ${label} must declare a path in sure.skill.json.`;
	}

	const artifacts = [...(manifest.artifacts ?? []), ...outputArtifacts(manifest)];
	const candidate = artifacts.find((artifact) => artifactSatisfiesRequirement(runManager, run, artifact, requirement));
	if (!candidate) {
		const description = requirement.description ? ` (${requirement.description})` : "";
		return `Final manifest is missing required artifact${description}.`;
	}
	if (!candidate.path || !artifactPathExists(runManager, run, candidate.path)) {
		return `Required artifact path does not exist: ${candidate.path ?? requirement.path}.`;
	}
	return undefined;
}

function validateManifestEnvelope(
	value: unknown,
	run: SureRunRecord,
	finish: SureFinishParams,
	runManager: SureRunManager,
	skillPackage: SureSkillPackage,
): string | undefined {
	if (!isRecord(value)) {
		return "Final manifest must be a JSON object.";
	}
	const required = [
		"schema_version",
		"run_id",
		"skill_name",
		"status",
		"created_at",
		"inputs",
		"outputs",
		"validation",
	];
	const missing = required.filter((key) => !(key in value));
	if (missing.length > 0) {
		return `Final manifest is missing required field(s) ${missing.map((key) => `"${key}"`).join(", ")}.`;
	}
	if (value.run_id !== run.runId) {
		return `Final manifest run_id must be "${run.runId}".`;
	}
	if (value.skill_name !== run.skillName) {
		return `Final manifest skill_name must be "${run.skillName}".`;
	}
	if (typeof value.schema_version !== "string" || value.schema_version.trim() === "") {
		return 'Final manifest field "schema_version" must be a non-empty string.';
	}
	if (value.status !== finish.status) {
		return `Final manifest status must match sure_finish status "${finish.status}".`;
	}
	if (typeof value.created_at !== "string" || Number.isNaN(Date.parse(value.created_at))) {
		return 'Final manifest field "created_at" must be an ISO date string.';
	}
	if (!isStringRecord(value.inputs)) {
		return 'Final manifest field "inputs" must be a JSON object.';
	}
	if (!isStringRecord(value.outputs)) {
		return 'Final manifest field "outputs" must be a JSON object.';
	}
	if (!isStringRecord(value.validation)) {
		return 'Final manifest field "validation" must be a JSON object.';
	}
	if (value.artifacts !== undefined) {
		if (!Array.isArray(value.artifacts) || !value.artifacts.every(isManifestArtifact)) {
			return 'Final manifest field "artifacts" must be an array of objects with optional string type/path fields.';
		}
	}
	const manifest = value as unknown as SureManifestEnvelope;
	const artifactError = validateManifestArtifacts(manifest, runManager, run);
	if (artifactError) {
		return artifactError;
	}
	// Required artifacts describe what a completed run delivers. Demanding them
	// from a run that stopped early leaves the agent no way to report the failure
	// except by fabricating the evidence, so only a success finish is held to them.
	if (finish.status === "success") {
		for (const requirement of skillPackage.manifest.artifacts ?? []) {
			const requirementError = validateRequiredArtifact(requirement, manifest, runManager, run);
			if (requirementError) {
				return requirementError;
			}
		}
	}
	return undefined;
}

async function finishActiveRun(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	active: ActiveRun,
	finish: SureFinishParams,
	setActiveRun: (run: ActiveRun | undefined) => void,
) {
	const runManager = new SureRunManager(active.record.cwd);
	active.ownership?.assertCurrent();
	if (active.coordinator && (active.shuttingDown || active.coordinator.isStopped || ctx.signal?.aborted))
		return {
			content: toolText("SURE finish was interrupted; no completion was accepted."),
			details: { runId: active.record.runId, accepted: false } satisfies SureFinishDetails,
		};
	const manifestPath = runManager.resolveRunPath(active.record, finish.manifest_path);
	if (!manifestPath || !existsSync(manifestPath)) {
		const repair = `Create the final manifest at ${finish.manifest_path} inside the project or run workspace, then call ${FINISH_TOOL_NAME} again.`;
		active.record = runManager.updateRun(active.record, { lastRepair: repair }, "finish_repair", {
			repair,
		});
		return {
			content: toolText(repair),
			details: {
				runId: active.record.runId,
				accepted: false,
				repair,
				...(active.coordinator ? { rejection: "manifest_path" as const } : {}),
			} satisfies SureFinishDetails,
		};
	}

	let manifest: unknown;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
	} catch (error) {
		const repair = `Final manifest must be valid JSON: ${error instanceof Error ? error.message : String(error)}`;
		active.record = runManager.updateRun(active.record, { lastRepair: repair }, "finish_repair", {
			repair,
		});
		return {
			content: toolText(repair),
			details: {
				runId: active.record.runId,
				accepted: false,
				repair,
				...(active.coordinator ? { rejection: "manifest_json" as const } : {}),
			} satisfies SureFinishDetails,
		};
	}

	const envelopeError = validateManifestEnvelope(manifest, active.record, finish, runManager, active.skillPackage);
	if (envelopeError) {
		const repair = `${envelopeError} Repair the manifest and call ${FINISH_TOOL_NAME} again.`;
		active.record = runManager.updateRun(active.record, { lastRepair: repair }, "finish_repair", {
			repair,
		});
		return {
			content: toolText(repair),
			details: {
				runId: active.record.runId,
				accepted: false,
				repair,
				...(active.coordinator ? { rejection: "manifest_envelope" as const } : {}),
			} satisfies SureFinishDetails,
		};
	}

	const gate = await active.hooks.run("pre_finish", {
		run: active.record,
		skill: active.skillPackage.manifest,
		cwd: ctx.cwd,
		packageDir: active.skillPackage.packageDir,
		runDir: active.record.runDir,
		args: active.record.args,
		event: { finish, manifest, manifestPath },
	});
	active.ownership?.assertCurrent();
	if (active.coordinator && (active.shuttingDown || active.coordinator.isStopped || ctx.signal?.aborted))
		return {
			content: toolText("SURE finish was interrupted; no completion was accepted."),
			details: { runId: active.record.runId, accepted: false } satisfies SureFinishDetails,
		};
	applyStatePatch(pi, ctx, active, gate.state_patch, "pre_finish_state", gate.statePatchHookId);
	if (!active.terminalizing) observeCoordinatedCheck(active, ctx, gate.checks ?? gate.check, gate.state_patch);
	if (!gate.ok) {
		const repair = gate.repair ?? gate.message ?? "Repair the Sure artifacts and call sure_finish again.";
		active.record = runManager.updateRun(active.record, { lastRepair: repair }, "finish_repair", gate);
		return {
			content: toolText(repair),
			details: {
				runId: active.record.runId,
				accepted: false,
				repair,
				diagnostics: gate.diagnostics,
			} satisfies SureFinishDetails,
		};
	}

	active.record = runManager.updateRun(
		active.record,
		{
			status: finish.status,
			manifestPath,
			summary: finish.summary,
			errorSummary: finish.error_summary,
			artifacts: finish.artifacts,
			finishedAt: new Date().toISOString(),
			lastRepair: undefined,
		},
		"finished",
		{ finish, manifestPath },
	);
	pi.appendEntry("sure.run", active.record);
	const postFinish = await active.hooks.run("post_finish", {
		run: active.record,
		skill: active.skillPackage.manifest,
		cwd: ctx.cwd,
		packageDir: active.skillPackage.packageDir,
		runDir: active.record.runDir,
		args: active.record.args,
		event: { finish, manifest, manifestPath },
	});
	applyStatePatch(pi, ctx, active, postFinish.state_patch, "post_finish_state", postFinish.statePatchHookId);
	if (!postFinish.ok) {
		pi.appendEntry("sure.diagnostic", {
			type: "warning",
			message: postFinish.message ?? postFinish.repair ?? "Sure post-finish hook failed.",
			path: active.skillPackage.manifestPath,
		});
	}
	ctx.ui.setStatus(STATUS_KEY, undefined);
	if (active.coordinator) ctx.setContextProjection?.(undefined);
	if (active.coordinator && active.coordinator.state.status !== "stopped")
		active.coordinator.stop(
			finish.status === "success" ? "Run finished: success." : (finish.error_summary ?? finish.summary),
		);
	if (active.coordinator && finish.status !== "success" && !active.terminalizing) {
		const report = buildSureFailureReport(active.record, active.coordinator, runManager.readState(active.record));
		persistSureFailureReport(active.record, report);
		pi.appendEntry("sure.failure_report", report);
		if (ctx.mode === "print") ctx.ui.notify(renderSureFailureReport(report), "error");
	}
	active.record = runManager.updateRun(active.record, {}, "terminal_export");
	if (active.coordinator)
		pi.appendEntry(SESSION_OUTCOME_ENTRY, { exitCode: finish.status === "success" ? 0 : 1, summary: finish.summary });
	clearActiveRun(pi, active, setActiveRun);
	return {
		content: toolText(`Sure run ${active.record.runId} finished with status ${finish.status}.`),
		details: {
			runId: active.record.runId,
			status: finish.status,
			accepted: true,
		} satisfies SureFinishDetails,
		terminate: true,
	};
}

function pauseCoordinatedRun(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	active: ActiveRun,
	result: SureDiagnosisCheckpoint,
	setActiveRun: (run: ActiveRun | undefined) => void,
): void {
	const coordinator = active.coordinator!;
	const manager = new SureRunManager(active.record.cwd);
	active.record = manager.updateRun(
		active.record,
		{
			status: "failed",
			staleSince: new Date().toISOString(),
			lastRepair: result.checkpoint,
		},
		"diagnosis_paused",
		{ attemptId: coordinator.state.attempts.at(-1)?.id, checkpoint: result },
	);
	const report = buildSureFailureReport(active.record, coordinator, manager.readState(active.record));
	persistSureFailureReport(active.record, report);
	active.record = manager.updateRun(active.record, {}, "diagnosis_pause_export");
	pi.appendEntry("sure.failure_report", report);
	pi.appendEntry(SESSION_OUTCOME_ENTRY, {
		exitCode: 1,
		summary: "Diagnosis paused; no business stop was issued.",
	});
	ctx.ui.notify(renderSureFailureReport(report), "warning");
	ctx.setContextProjection?.(undefined);
	ctx.setExecutionHold?.(false);
	clearActiveRun(pi, active, setActiveRun);
}

/** A receipt is an actual executor transcript message, never just a sender flag. */
function pendingRepairReceipt(active: ActiveRun, ctx: ExtensionContext): boolean | undefined {
	const pending = active.coordinator?.state.pendingRepair;
	if (!pending) return true;
	if (!pending.deliveryStarted && !pending.delivered) return false;
	if (
		pending.receiverSessionId !== ctx.sessionManager.getSessionId() ||
		pending.receiverSessionFile !== ctx.sessionManager.getSessionFile() ||
		pending.receiverParentId === undefined
	)
		return undefined;
	const prefix = `<sure_supervisor_repair id="${pending.id}" run_id="${active.record.runId}" unit="${pending.result.unitId}">`;
	const matches = (message: { role: string; content?: unknown }): boolean => {
		if (message.role !== "user") return false;
		if (typeof message.content === "string") return message.content.startsWith(prefix);
		return (
			Array.isArray(message.content) &&
			message.content.some(
				(block) => block?.type === "text" && typeof block.text === "string" && block.text.startsWith(prefix),
			)
		);
	};
	const branch = ctx.sessionManager.getBranch();
	const parent =
		pending.receiverParentId === null ? -1 : branch.findIndex((entry) => entry.id === pending.receiverParentId);
	if (pending.receiverParentId !== null && parent < 0) return undefined;
	const receipt = branch.slice(parent + 1).find((entry) => entry.type === "message" && matches(entry.message));
	if (!receipt || (pending.receiverMessageId && receipt.id !== pending.receiverMessageId)) return undefined;
	pending.receiverMessageId = receipt.id;
	return true;
}

async function deliverPendingRepair(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	active: ActiveRun,
	setActiveRun: (run: ActiveRun | undefined) => void,
): Promise<boolean> {
	const coordinator = active.coordinator!;
	if (active.shuttingDown || coordinator.isStopped || ctx.signal?.aborted) return false;
	const pending = coordinator.state.pendingRepair!;
	active.ownership?.assertCurrent();
	const receipt = pendingRepairReceipt(active, ctx);
	if (receipt === true) {
		pending.delivered = true;
		coordinator.save();
		ctx.setExecutionHold?.(false);
		return false;
	}
	if (receipt === undefined) {
		coordinator.beginDiagnosis();
		const checkpoint: SureDiagnosisCheckpoint = {
			runId: active.record.runId,
			unitId: coordinator.state.unitId,
			evidenceVersion: coordinator.state.evidenceVersion,
			decision: "checkpoint",
			checkpoint: "handoff_delivery_unconfirmed: executor receipt cannot be established; no blind replay.",
			automatic: false,
		};
		coordinator.state.attempts.at(-1)!.checkpoint = checkpoint;
		coordinator.save();
		pauseCoordinatedRun(pi, ctx, active, checkpoint, setActiveRun);
		return true;
	}
	syncCoordinatedMessages(pi, ctx, active, true);
	pending.deliveryStarted = true;
	pending.receiverSessionFile = ctx.sessionManager.getSessionFile();
	pending.receiverSessionId = ctx.sessionManager.getSessionId();
	pending.receiverParentId = ctx.sessionManager.getLeafId();
	pending.delivered = false;
	coordinator.save();
	ctx.setExecutionHold?.(false);
	active.lastAgentMessages = undefined;
	await pi.sendUserMessage(
		`<sure_supervisor_repair id="${pending.id}" run_id="${active.record.runId}" unit="${pending.result.unitId}">\n${pending.result.repair}\nSuggested focusPaths: ${JSON.stringify(pending.result.focusPaths ?? [])}. Preserve original permissions, user constraints and the original gate. Choose the supporting reads, probes and corrections required for the complete task. Validate the correction with the original gate and continue normally after it passes. Supporting probes are part of this complete goal; no return for supervisor approval is required.\n</sure_supervisor_repair>`,
	);
	if (
		!active.shuttingDown &&
		!coordinator.isStopped &&
		!ctx.signal?.aborted &&
		coordinator.state.pendingRepair?.id === pending.id &&
		pendingRepairReceipt(active, ctx) === true
	) {
		try {
			active.ownership?.assertCurrent();
		} catch {
			return true;
		}
		pending.delivered = true;
		coordinator.save();
	}
	return true;
}

async function settleCoordinatedRun(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	active: ActiveRun,
	setActiveRun: (run: ActiveRun | undefined) => void,
): Promise<void> {
	const coordinator = active.coordinator;
	if (!coordinator || active.shuttingDown || active.terminalizing) return;
	active.ownership?.assertCurrent();
	ctx.setExecutionHold?.(true);
	await Promise.all([...(active.toolInvocations?.values() ?? [])].map((call) => call.settled));
	await active.resultQueue;
	if (active.shuttingDown || active.terminalizing) return;
	const transcript = ctx.sessionManager
		.getBranch()
		.flatMap((entry) => (entry.type === "message" ? [{ message: entry.message, id: entry.id }] : []));
	syncSureUserContext(
		coordinator,
		transcript.map(({ message }) => message),
	);
	captureSureExecutorProgress(
		active.record,
		coordinator.state.unitId,
		transcript.map(({ message }) => message),
		new SureRunManager(active.record.cwd).readState(active.record)?.checkpoint,
		ctx.sessionManager.getSessionFile(),
		new Map(transcript.map(({ message, id }) => [message, id])),
		coordinator.state.stageStartedAt,
		new Map(
			loadSureDiagnosticIndex(coordinator).actions.flatMap((action) =>
				action.unitId ? [[action.toolCallId, action.unitId] as const] : [],
			),
		),
	);
	const scope = coordinatedScope(active);
	coordinator.barrier(scope);
	if (ctx.signal?.aborted) coordinator.stop("User cancelled execution.", true);
	while (!coordinator.isStopped) {
		active.diagnosis = diagnoseSureRun(
			coordinator,
			ctx,
			scope,
			active.skillPackage.manifest.coordination?.stages.find((stage) => stage.id === coordinator.state.unitId),
			active.skillPackage,
		);
		const result = await active.diagnosis.finally(() => {
			active.diagnosis = undefined;
		});
		if (active.shuttingDown) return;
		if (ctx.signal?.aborted) coordinator.stop("User cancelled diagnosis.", true);
		if (coordinator.isStopped) break;
		if (result.decision === "checkpoint") {
			if (result.automatic) continue;
			pauseCoordinatedRun(pi, ctx, active, result, setActiveRun);
			return;
		} else {
			coordinator.barrier(scope);
			if (coordinator.isStopped) break;
			if (!coordinator.acceptDiagnosis(result)) {
				if (coordinator.isStopped) break;
				coordinator.state.status = "diagnosing";
				coordinator.state.yieldReason =
					"Diagnosis became stale while evidence changed; investigate the new version.";
				coordinator.save();
				continue;
			}
		}
		break;
	}
	const pending = coordinator.state.pendingRepair;
	if (coordinator.state.status === "executing" && pending) {
		await deliverPendingRepair(pi, ctx, active, setActiveRun);
		return;
	}
	if (coordinator.state.status === "executing") {
		ctx.setExecutionHold?.(false);
		active.lastAgentMessages = undefined;
		await pi.sendUserMessage(
			`<sure_supervisor_continue id="${active.record.runId}:${coordinator.state.unitId}:${coordinator.lastDiagnosis!.evidenceVersion}" run_id="${active.record.runId}" unit="${coordinator.state.unitId}">\n${coordinator.lastDiagnosis!.reason}\nPreserve the original permissions, business gates and retry limits. Continue without returning for supervisor approval.\n</sure_supervisor_continue>`,
		);
		return;
	}
	if (active.terminalizing || active.shuttingDown) return;
	active.terminalizing = true;
	const manager = new SureRunManager(active.record.cwd);
	const primaryError =
		coordinator.state.lastFailure?.summary ??
		coordinator.state.originalFailure?.summary ??
		(coordinator.state.lastCheck &&
		coordinator.state.lastCheck.outcome !== "pending" &&
		coordinator.state.lastCheck.outcome !== "passed"
			? coordinator.state.lastCheck.summary
			: undefined) ??
		active.record.lastRepair ??
		coordinator.state.stopReason ??
		"Execution stopped without a valid completion.";
	active.record = manager.updateRun(
		active.record,
		{ errorSummary: primaryError, lastRepair: primaryError },
		"coordination_stopped",
		{ reason: coordinator.state.stopReason },
	);
	const context = {
		run: active.record,
		skill: active.skillPackage.manifest,
		cwd: ctx.cwd,
		packageDir: active.skillPackage.packageDir,
		runDir: active.record.runDir,
		args: active.record.args,
		event: { reason: coordinator.state.stopReason },
	};
	const onError = await active.hooks.run("on_error", context);
	applyStatePatch(pi, ctx, active, onError.state_patch, "coordination_error_state", onError.statePatchHookId);
	active.record = manager.updateRun(
		active.record,
		{
			status: coordinator.state.cancelled ? "cancelled" : "failed",
			errorSummary: primaryError,
			lastRepair: primaryError,
			finishedAt: new Date().toISOString(),
		},
		"coordination_terminal",
	);
	coordinator.save();
	const report = buildSureFailureReport(active.record, coordinator, manager.readState(active.record));
	persistSureFailureReport(active.record, report);
	pi.appendEntry("sure.failure_report", report);
	pi.appendEntry(SESSION_OUTCOME_ENTRY, {
		exitCode: coordinator.state.cancelled ? 130 : 1,
		summary: report.stopReason,
	});
	if (ctx.mode === "print") ctx.ui.notify(renderSureFailureReport(report), "error");
	active.record = manager.updateRun(active.record, {}, "terminal_export");
	pi.appendEntry("sure.run", active.record);
	ctx.ui.setStatus(STATUS_KEY, undefined);
	// A shutdown may settle tool results before agent-core checks the turn hold.
	// Keep it in place until agent_settled; clearing it here could start another request.
	if (!ctx.isIdle()) return;
	ctx.setContextProjection?.(undefined);
	ctx.setExecutionHold?.(false);
	clearActiveRun(pi, active, setActiveRun);
}

async function startRun(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	skillPackage: SureSkillPackage,
	args: string,
	setActiveRun: (run: ActiveRun | undefined) => void,
): Promise<void> {
	if (!ctx.isIdle()) {
		ctx.ui.notify("Cannot start a Sure run while the agent is busy.", "warning");
		return;
	}
	if (!ctx.isProjectTrusted()) {
		ctx.ui.notify("Cannot start a Sure run until this project is trusted.", "error");
		return;
	}

	const outputDir = resolveOutputDir(args);
	if (!outputDir.ok) {
		ctx.ui.notify(outputDir.error ?? "Sure rejected the requested output_dir.", "error");
		return;
	}

	const runManager = new SureRunManager(ctx.cwd);
	const record = runManager.createRun(skillPackage, args, outputDir.dir);
	const active: ActiveRun = {
		record,
		ownership: skillPackage.manifest.coordination ? acquireSureRunOwnership(record.runDir) : undefined,
		skillPackage,
		hooks: new SureHookRunner(skillPackage),
		previousActiveTools: pi.getActiveTools(),
	};
	setActiveRun(active);
	try {
		const initialStage = skillPackage.manifest.coordination?.stages[0];
		if (initialStage)
			active.coordinator = new SureCoordinator(
				record,
				initialStage.id,
				[...initialStage.snapshotPaths, ...surePromptPaths(skillPackage, initialStage.id)],
				skillPackage.manifest.coordination?.budgets,
				active.ownership?.assertCurrent,
			);

		const preStart = await active.hooks.run("pre_start", {
			run: active.record,
			skill: skillPackage.manifest,
			cwd: ctx.cwd,
			packageDir: skillPackage.packageDir,
			runDir: active.record.runDir,
			args,
		});
		applyStatePatch(pi, ctx, active, preStart.state_patch, "pre_start_state", preStart.statePatchHookId);
		if (!preStart.ok) {
			if (skillPackage.manifest.coordination) {
				failCoordinatedEntry(
					pi,
					ctx,
					active,
					preStart.repair ?? preStart.message ?? "Sure pre-start gate rejected the run.",
					setActiveRun,
				);
				return;
			}
			active.record = runManager.updateRun(
				active.record,
				{ status: "failed", finishedAt: new Date().toISOString(), lastRepair: preStart.repair ?? preStart.message },
				"pre_start_repair",
				preStart,
			);
			ctx.ui.notify(preStart.repair ?? preStart.message ?? "Sure pre-start gate rejected the run.", "error");
			pi.appendEntry("sure.run", active.record);
			pi.setActiveTools(active.previousActiveTools);
			setActiveRun(undefined);
			return;
		}

		active.record = runManager.setStatus(active.record, "running", "started");
		pi.setActiveTools(activeToolNames(active));
		setRunStatusText(ctx, active.record, runManager.readState(active.record));
		pi.appendEntry("sure.run", active.record);
		installCoordinatedContext(pi, ctx, active, preStart.check?.inputPaths);
		observeCoordinatedCheck(active, ctx, preStart.checks ?? preStart.check);
		await pi.sendUserMessage(buildInvocationPrompt(skillPackage, active.record));
	} catch (error) {
		active.ownership?.assertCurrent();
		const message = error instanceof Error ? error.message : String(error);
		active.record = runManager.updateRun(
			active.record,
			{
				status: "failed",
				finishedAt: new Date().toISOString(),
				lastRepair: `Sure run failed to start or continue: ${message}`,
			},
			"agent_error",
			{ message },
		);
		const onError = await active.hooks.run("on_error", {
			run: active.record,
			skill: skillPackage.manifest,
			cwd: ctx.cwd,
			packageDir: skillPackage.packageDir,
			runDir: active.record.runDir,
			args,
			event: { reason: "agent_error", message },
		});
		applyStatePatch(pi, ctx, active, onError.state_patch, "on_error_state", onError.statePatchHookId);
		if (skillPackage.manifest.coordination) {
			failCoordinatedEntry(pi, ctx, active, `Sure run failed to start or continue: ${message}`, setActiveRun);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, undefined);
		pi.appendEntry("sure.run", active.record);
		clearActiveRun(pi, active, setActiveRun);
		ctx.setContextProjection?.(undefined);
		throw error;
	}
}

/** A run the agent may pick back up: same project, not stopped on purpose, checkpoint says so. */
function isResumable(record: SureRunRecord, state: SureDisplayState | undefined, cwd: string): boolean {
	if (record.cwd !== cwd) {
		return false;
	}
	// "cancelled" is a deliberate interrupt, and the other terminal statuses mean
	// the skill itself decided the run was over.
	if (record.status !== "running" && record.status !== "failed") {
		return false;
	}
	return state?.checkpoint?.resumable === true;
}

async function resumeRun(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	setActiveRun: (run: ActiveRun | undefined) => void,
	runId: string | undefined,
): Promise<void> {
	if (!ctx.isIdle()) {
		ctx.ui.notify("Cannot resume a Sure run while the agent is busy.", "warning");
		return;
	}
	if (!ctx.isProjectTrusted()) {
		ctx.ui.notify("Cannot resume a Sure run until this project is trusted.", "error");
		return;
	}

	const runManager = new SureRunManager(ctx.cwd);
	const candidates = runId ? [runId] : runManager.listRunIds().reverse();
	let resumed: { record: SureRunRecord; state: SureDisplayState | undefined } | undefined;
	for (const candidate of candidates) {
		const record = runManager.readRun(candidate);
		if (!record) {
			continue;
		}
		const state = runManager.readState(record);
		const coordinationPath = join(record.runDir, "coordination.json");
		if (existsSync(coordinationPath)) {
			let version: unknown;
			try {
				version = (JSON.parse(readFileSync(coordinationPath, "utf8")) as { version?: unknown }).version;
			} catch {
				// The existing restore failure path reports corrupt current records.
			}
			if (version !== undefined && version !== 2) {
				if (runId) {
					ctx.ui.notify(
						`Sure run ${record.runId} uses an older coordination protocol and remains read-only. Start a new run.`,
						"warning",
					);
					return;
				}
				continue;
			}
		}
		if (isResumable(record, state, ctx.cwd)) {
			resumed = { record, state };
			break;
		}
	}
	if (!resumed) {
		ctx.ui.notify(
			runId
				? `Sure run ${runId} cannot be resumed: no resumable checkpoint for this project.`
				: "No resumable Sure run in this project.",
			"warning",
		);
		return;
	}

	const discovered = discoverSureSkillPackages(ctx.cwd);
	for (const diagnostic of discovered.diagnostics) {
		pi.appendEntry("sure.diagnostic", diagnostic);
	}
	const skillPackage = discovered.packages.find((pkg) => pkg.manifest.command === resumed.record.command);
	if (!skillPackage) {
		ctx.ui.notify(`No Sure skill package found for /${resumed.record.command}.`, "error");
		return;
	}

	let ownership: SureRunOwnership | undefined;
	try {
		if (skillPackage.manifest.coordination) ownership = acquireSureRunOwnership(resumed.record.runDir);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
		return;
	}
	const active: ActiveRun = {
		record: resumed.record,
		ownership,
		skillPackage,
		hooks: new SureHookRunner(skillPackage),
		previousActiveTools: pi.getActiveTools(),
	};
	setActiveRun(active);
	// pre_start is deliberately not re-run: it resolves inputs and resets the
	// checkpoint to the first unit, which is the progress a resume is protecting.
	active.record = runManager.updateRun(active.record, { status: "running", finishedAt: undefined }, "resumed");
	pi.setActiveTools(activeToolNames(active));
	setRunStatusText(ctx, active.record, resumed.state);
	pi.appendEntry("sure.run", active.record);
	try {
		installCoordinatedContext(pi, ctx, active);
		if (active.coordinator) {
			const pausedAttempt = active.coordinator.state.attempts.at(-1);
			if (pausedAttempt?.checkpoint && !pausedAttempt.checkpoint.automatic) {
				pausedAttempt.protocolErrors = 0;
				pausedAttempt.protocolFeedback = false;
				active.coordinator.save();
			}
			const previous = readSureSnapshot(active.record, active.coordinator.state.latestSnapshot!);
			const current = active.coordinator.barrier(coordinatedScope(active));
			const identity = ({ path, status, sha256, size, modifiedAt }: (typeof previous.files)[number]) =>
				JSON.stringify({ path, status, sha256, size, modifiedAt: sha256 ? undefined : modifiedAt });
			const priorFiles = new Map(previous.files.map((file) => [file.path, file]));
			const currentFiles = new Map(current.files.map((file) => [file.path, file]));
			const changed =
				previous.files.some(
					(file) =>
						!file.path.startsWith("run:evidence/tools/") &&
						identity(file) !== (currentFiles.has(file.path) ? identity(currentFiles.get(file.path)!) : undefined),
				) ||
				current.files.some(
					(file) =>
						!file.path.startsWith("run:evidence/tools/") &&
						!priorFiles.has(file.path) &&
						previous.checkScope.some(
							(scope) => file.path === scope || file.path.startsWith(scope.endsWith(":") ? scope : `${scope}/`),
						),
				);
			const pending = active.coordinator.state.pendingRepair;
			if (pending && changed) {
				active.coordinator.invalidateRepair("Files changed before resume; the previous repair is stale.");
				if (active.coordinator.state.status === "executing") active.coordinator.state.status = "yielding";
				active.coordinator.save();
			}
		}
		if (active.coordinator?.resumeBlocker) {
			active.coordinator.stop(active.coordinator.resumeBlocker);
			await settleCoordinatedRun(pi, ctx, active, setActiveRun);
			return;
		}
		if (
			active.coordinator &&
			(active.coordinator.state.status === "yielding" || active.coordinator.state.status === "diagnosing")
		) {
			await settleCoordinatedRun(pi, ctx, active, setActiveRun);
			return;
		}
		if (active.coordinator) {
			active.coordinator.state.status = "executing";
			if (active.coordinator.state.pendingRepair && (await deliverPendingRepair(pi, ctx, active, setActiveRun)))
				return;
			active.coordinator.save();
			ctx.setExecutionHold?.(false);
			syncCoordinatedMessages(pi, ctx, active, true);
		}
		await pi.sendUserMessage(buildResumePrompt(skillPackage, active.record, resumed.state));
	} catch (error) {
		active.ownership?.assertCurrent();
		const message = error instanceof Error ? error.message : String(error);
		if (skillPackage.manifest.coordination) {
			failCoordinatedEntry(pi, ctx, active, `Sure run failed to resume: ${message}`, setActiveRun);
			return;
		}
		active.record = runManager.updateRun(
			active.record,
			{
				status: "failed",
				finishedAt: new Date().toISOString(),
				lastRepair: `Sure run failed to resume: ${message}`,
			},
			"agent_error",
			{ message },
		);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		pi.appendEntry("sure.run", active.record);
		clearActiveRun(pi, active, setActiveRun);
		ctx.setContextProjection?.(undefined);
		throw error;
	}
}

/** Entry failures use the same report without starting either model or changing a gate. */
function failCoordinatedEntry(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	active: ActiveRun,
	message: string,
	setActiveRun: (run: ActiveRun | undefined) => void,
): void {
	const manager = new SureRunManager(active.record.cwd);
	active.coordinator?.stop(message);
	active.record = manager.updateRun(
		active.record,
		{
			status: "failed",
			finishedAt: new Date().toISOString(),
			errorSummary: active.record.errorSummary ?? message,
			lastRepair: message,
		},
		"entry_failed",
		{ message },
	);
	const report = buildSureFailureReport(active.record, active.coordinator, manager.readState(active.record));
	persistSureFailureReport(active.record, report);
	pi.appendEntry("sure.failure_report", report);
	pi.appendEntry(SESSION_OUTCOME_ENTRY, { exitCode: 1, summary: message });
	active.record = manager.updateRun(active.record, {}, "terminal_export");
	pi.appendEntry("sure.run", active.record);
	ctx.ui.notify(ctx.mode === "print" ? renderSureFailureReport(report) : message, "error");
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.setContextProjection?.(undefined);
	ctx.setExecutionHold?.(false);
	clearActiveRun(pi, active, setActiveRun);
}

function clearActiveRun(
	pi: ExtensionAPI,
	active: ActiveRun | undefined,
	setActiveRun: (run: ActiveRun | undefined) => void,
) {
	if (!active) {
		return;
	}
	active.ownership?.release();
	pi.setActiveTools(
		pi.getActiveTools().filter((toolName) => toolName !== FINISH_TOOL_NAME && toolName !== UPDATE_STATE_TOOL_NAME),
	);
	setActiveRun(undefined);
}

/**
 * After a successful /sure_init, switch the current session onto the model it just configured
 * instead of leaving the user on whatever model they started with. Returns the success line for
 * the caller to print rather than printing it here: the TUI rewrites the same status line on
 * every consecutive info notify, so notifying here would wipe out everything init reported.
 * Falls back to a warning of its own if the model can't be resolved or has no configured auth
 * yet — init itself already succeeded, so this degrades gracefully rather than as an error.
 */
export async function switchToInitializedModel(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	manifest: SureInitManifest,
): Promise<string | undefined> {
	const { defaultProvider, defaultModel } = manifest;
	await ctx.modelRegistry.refresh();
	const model = ctx.modelRegistry.find(defaultProvider, defaultModel);
	const switched = model ? await pi.setModel(model) : false;
	if (!switched) {
		ctx.ui.notify(
			`Default model set to ${defaultProvider}/${defaultModel}. ` +
				`Run "/model ${defaultProvider}/${defaultModel}" to switch once credentials are configured.`,
			"warning",
		);
		return undefined;
	}
	// The level init measured went into the manifest and the global settings but never into
	// the session, which is why the session used to sit on medium after an init that said high.
	const level = manifest.defaultThinkingLevel;
	if (level && level !== "off") {
		pi.setThinkingLevel(level);
	}
	return `Switched to ${defaultProvider}/${defaultModel}.`;
}

export function createSureExtension(): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		pi.registerEntryRenderer<SureFailureReport>("sure.failure_report", (entry, options) =>
			entry.data ? new Text(renderSureFailureReport(entry.data, options.expanded), 0, 0) : undefined,
		);
		let activeRun: ActiveRun | undefined;

		const setActiveRun = (run: ActiveRun | undefined) => {
			activeRun = run;
		};

		pi.registerTool(
			defineTool({
				name: UPDATE_STATE_TOOL_NAME,
				label: "Sure State",
				description: "Update the active Sure run display state.",
				promptSnippet: "Update the active Sure run display state",
				promptGuidelines: [
					`Use ${UPDATE_STATE_TOOL_NAME} during active Sure skill runs to report phase, progress, counters, diagnostics, artifacts, or next actions.`,
					"Use skill-defined phase ids and counter names; Harness only validates the common state shape.",
				],
				activeByDefault: false,
				executionMode: "sequential",
				parameters: updateStateToolParams,
				async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
					const active = activeRun;
					if (!active) {
						return {
							content: toolText("No active Sure run. Start a Sure slash command before updating state."),
							details: { accepted: false } satisfies SureUpdateStateDetails,
							isError: true,
						};
					}
					if ("request_diagnosis" in params || "evidence_complete" in params)
						return {
							content: toolText(
								"Supervisor investigations are scheduled by the harness. Active help and evidence-return controls are not supported.",
							),
							details: { accepted: false } satisfies SureUpdateStateDetails,
							isError: true,
						};
					if (hasCheckpointPatch(params)) {
						const repair = `${UPDATE_STATE_TOOL_NAME} cannot update checkpoints; checkpoints are controlled by Sure hooks.`;
						return {
							content: toolText(repair),
							details: {
								runId: active.record.runId,
								accepted: false,
								repair,
							} satisfies SureUpdateStateDetails,
							isError: true,
						};
					}
					const normalized = normalizeSureDisplayStatePatch(params);
					if (!normalized.ok || !normalized.state) {
						return {
							content: toolText(normalized.message ?? "Invalid Sure state update."),
							details: {
								runId: active.record.runId,
								accepted: false,
								repair: normalized.message,
							} satisfies SureUpdateStateDetails,
							isError: true,
						};
					}
					const runManager = new SureRunManager(active.record.cwd);
					const policyRepair = validateAgentStateUpdatePolicy(runManager, active, normalized.state);
					if (policyRepair) {
						return {
							content: toolText(policyRepair),
							details: {
								runId: active.record.runId,
								accepted: false,
								repair: policyRepair,
							} satisfies SureUpdateStateDetails,
							isError: true,
						};
					}
					const result = applyStatePatch(pi, ctx, active, params, "state_update");
					if (!result.ok) {
						return {
							content: toolText(result.repair ?? "Invalid Sure state update."),
							details: {
								runId: active.record.runId,
								accepted: false,
								repair: result.repair,
							} satisfies SureUpdateStateDetails,
							isError: true,
						};
					}
					return {
						content: toolText(`Updated Sure run ${active.record.runId} state.`),
						details: {
							runId: active.record.runId,
							accepted: true,
							state: result.state,
						} satisfies SureUpdateStateDetails,
					};
				},
			}),
		);

		pi.registerTool(
			defineTool({
				name: FINISH_TOOL_NAME,
				label: "Sure Finish",
				description: "Finish the active Sure scientific run after validating its artifact manifest and gates.",
				promptSnippet: "Finish an active Sure skill run with artifact validation",
				promptGuidelines: [
					`Use ${FINISH_TOOL_NAME} as the final standalone action for active Sure skill runs.`,
					"If it returns repair instructions, update artifacts and call it again.",
				],
				activeByDefault: false,
				executionMode: "sequential",
				parameters: finishToolParams,
				async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
					const active = activeRun;
					if (!active) {
						return {
							content: toolText("No active Sure run. Start a Sure slash command before calling sure_finish."),
							details: { accepted: false } satisfies SureFinishDetails,
						};
					}

					return finishActiveRun(pi, ctx, active, params as SureFinishParams, setActiveRun);
				},
			}),
		);

		pi.registerCommand("sure_init", {
			description: "Initialize SURE: select agent, configure auth, and validate environment",
			handler: async (args, ctx) => {
				if (!ctx.isProjectTrusted()) {
					ctx.ui.notify("Cannot initialize SURE until this project is trusted. Run /trust first.", "error");
					return;
				}
				const result = await runSureInit({ ctx, args: args.trim() });
				if (!result.success) {
					ctx.ui.notify(result.message, "error");
					return;
				}
				const switchedLine = result.manifest ? await switchToInitializedModel(pi, ctx, result.manifest) : undefined;
				// One info notify at the very end. Two in a row overwrite each other in the TUI,
				// which is how the probe, round-trip and table lines used to vanish on success.
				ctx.ui.notify([result.message, switchedLine].filter(Boolean).join("\n"), "info");
			},
		});

		pi.registerCommand("sure_resume", {
			description: "Resume a Sure run whose turn ended without sure_finish",
			handler: async (args, ctx) => {
				if (activeRun) {
					ctx.ui.notify(
						`Sure run ${activeRun.record.runId} is still active. Finish or abort it before resuming another run.`,
						"warning",
					);
					return;
				}
				await resumeRun(pi, ctx, setActiveRun, args.trim() || undefined);
			},
		});

		for (const command of SURE_COMMANDS) {
			pi.registerCommand(command, {
				description: `Run Sure skill /${command}`,
				handler: async (args, ctx) => {
					if (!ctx.isProjectTrusted()) {
						ctx.ui.notify("Cannot start a Sure run until this project is trusted.", "error");
						return;
					}
					if (activeRun) {
						ctx.ui.notify(
							`Sure run ${activeRun.record.runId} is still active. Finish or abort it before starting another run.`,
							"warning",
						);
						return;
					}
					const discovered = discoverSureSkillPackages(ctx.cwd);
					for (const diagnostic of discovered.diagnostics) {
						pi.appendEntry("sure.diagnostic", diagnostic);
					}
					const skillPackage = discovered.packages.find((pkg) => pkg.manifest.command === command);
					if (!skillPackage) {
						const diagnostics =
							discovered.diagnostics.length > 0 ? `\n${formatDiagnostics(discovered.diagnostics)}` : "";
						ctx.ui.notify(`No Sure skill package found for /${command}.${diagnostics}`, "error");
						return;
					}
					await startRun(pi, ctx, skillPackage, args.trim(), setActiveRun);
				},
			});
		}

		pi.on("turn_start", (event) => {
			if (activeRun) activeRun.batchId = `${event.timestamp}:${event.turnIndex}`;
		});

		pi.on("turn_end", (_event, ctx) => {
			const active = activeRun;
			if (!active?.coordinator || active.coordinator.state.status !== "executing") return;
			syncCoordinatedMessages(pi, ctx, active);
		});

		pi.on("session_before_compact", (_event, ctx) => {
			const active = activeRun;
			if (!active?.coordinator) return;
			active.compactionTrim = planSureContextTrim(
				ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages),
				active.coordinator.state.stageStartedAt ?? 0,
				active.coordinator.state,
				loadSureCheckRecords(active.coordinator),
			);
		});
		pi.on("session_compact", (event, ctx) => {
			const active = activeRun;
			if (
				!active?.coordinator ||
				active.coordinator.isStopped ||
				active.shuttingDown ||
				(ctx.signal?.aborted && event.reason !== "manual")
			)
				return;
			active.ownership?.assertCurrent();
			active.trimmedCalls = [...new Set([...(active.trimmedCalls ?? []), ...(active.compactionTrim ?? [])])];
			active.compactionTrim = undefined;
			pi.appendEntry("sure.context.trim", { runId: active.record.runId, calls: active.trimmedCalls });
			syncCoordinatedMessages(pi, ctx, active, true);
		});

		// agent-core emits this before validation/preflight, including calls it may skip.
		// Only tool_result below proves execution; tool_execution_end covers skipped calls.
		pi.on("tool_execution_start", (event, ctx) => {
			const active = activeRun;
			if (!active?.coordinator) return;
			active.toolInvocations ??= new Map();
			if (!active.toolInvocations.has(event.toolCallId)) {
				let complete!: () => void;
				const settled = new Promise<void>((resolve) => {
					complete = resolve;
				});
				active.toolInvocations.set(event.toolCallId, {
					checkVersionAtStart: active.coordinator.state.lastCheckVersion ?? 0,
					settled,
					complete,
					identity: {
						unitId: sureCurrentUnit(
							active.skillPackage,
							new SureRunManager(active.record.cwd).readState(active.record),
						),
						batchId: active.batchId,
						requestedAt: new Date().toISOString(),
						order: active.toolInvocations.size,
						cwd: ctx.cwd,
						toolName: event.toolName,
						input: event.args,
					},
				});
			}
		});

		pi.on("tool_execution_end", (event, ctx) => {
			const active = activeRun;
			const call = active?.toolInvocations?.get(event.toolCallId);
			if (!active?.coordinator || !call) return;
			try {
				active.ownership?.assertCurrent();
				if (!event.rejection && (event.toolName === FINISH_TOOL_NAME || event.toolName === UPDATE_STATE_TOOL_NAME))
					return;
				const path = join(active.record.runDir, "evidence/tools", `${sureHash(event.toolCallId)}.json`);
				if (existsSync(path)) return;
				const result = event.result as { content: SureToolContent[] };
				writeSureJson(path, {
					...call.identity,
					toolCallId: event.toolCallId,
					execution: "skipped",
					rejection: event.rejection,
					duringHold: active.coordinator.state.status !== "executing",
					completedAt: new Date().toISOString(),
					isError: event.isError,
					content: result.content.filter((block) => block.type === "text"),
				});
				if (event.rejection && !ctx.signal?.aborted && active.coordinator.state.status === "executing") {
					const exhausted = loadSureCheckRecords(active.coordinator).some(
						({ check }) => check.action?.toolCallId === event.toolCallId && check.outcome === "exhausted",
					);
					if (!exhausted)
						observeCoordinatedCheck(active, ctx, {
							unitId: call.identity.unitId,
							outcome: "blocked",
							failureKind: "tool",
							checker: `rejection:${event.rejection}`,
							summary:
								result.content
									.filter((block) => block.type === "text")
									.map((block) => block.text)
									.join("\n")
									.slice(-2000) || "Tool call was rejected before execution.",
							artifactPaths: [],
							inputPaths: [],
							action: {
								toolCallId: event.toolCallId,
								toolName: event.toolName,
								batchId: call.identity.batchId,
								path: `run:evidence/tools/${sureHash(event.toolCallId)}.json`,
							},
						});
				}
			} finally {
				call.complete();
			}
		});

		pi.on("tool_call", async (event, ctx) => {
			const active = activeRun;
			active?.ownership?.assertCurrent();
			const pending = active?.coordinator?.state.pendingRepair;
			if (active && pending && !pending.delivered && pendingRepairReceipt(active, ctx) === true) {
				pending.delivered = true;
				active.coordinator!.save();
			}
			if (active?.coordinator && active.coordinator.state.status === "executing") {
				const display = new SureRunManager(active.record.cwd).readState(active.record);
				const unit = sureCurrentUnit(active.skillPackage, display);
				if (display?.phase?.id === unit && display.phase.label)
					active.coordinator.state.unitLabel = display.phase.label;
				active.coordinator.recordAction(unit);
				if (active.coordinator.state.status !== "executing") ctx.setExecutionHold?.(true);
			}
			if (active?.coordinator && active.coordinator.state.status !== "executing") {
				return {
					block: true,
					reason: "SURE execution is held for diagnosis; this unstarted call was skipped.",
					terminate: true,
				};
			}
			if (!active || event.toolName === FINISH_TOOL_NAME || event.toolName === UPDATE_STATE_TOOL_NAME) {
				return undefined;
			}
			const runManager = new SureRunManager(active.record.cwd);
			active.record = runManager.updateRun(active.record, { staleSince: undefined }, "tool_call", {
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				input: event.input,
			});
			const gate = await active.hooks.run("pre_tool_call", {
				run: active.record,
				skill: active.skillPackage.manifest,
				cwd: ctx.cwd,
				packageDir: active.skillPackage.packageDir,
				runDir: active.record.runDir,
				args: active.record.args,
				event,
			});
			applyStatePatch(pi, ctx, active, gate.state_patch, "pre_tool_call_state", gate.statePatchHookId);
			observeCoordinatedCheck(
				active,
				ctx,
				(gate.checks?.length
					? gate.checks
					: gate.check
						? [gate.check]
						: !gate.ok
							? [
									{
										unitId: active.coordinator?.state.unitId ?? "unknown",
										outcome: "blocked" as const,
										checker: "pre_tool_call",
										summary: gate.message ?? gate.repair ?? "Tool preflight rejected the call.",
										repair: gate.repair,
										inputPaths: [],
										artifactPaths: [],
									},
								]
							: []
				).map((check) => ({
					...check,
					action: {
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						path: `run:evidence/tools/${sureHash(event.toolCallId)}.json`,
						batchId: active.toolInvocations?.get(event.toolCallId)?.identity.batchId,
					},
				})),
				gate.state_patch,
			);
			if (active.coordinator && active.coordinator.state.status !== "executing")
				return {
					block: true,
					reason: gate.repair ?? gate.message ?? "SURE held this call for diagnosis.",
					terminate: true,
				};
			if (!gate.ok) {
				const repair = gate.repair ?? gate.message ?? "Repair the tool call and retry.";
				active.record = runManager.updateRun(active.record, { lastRepair: repair }, "tool_call_repair", gate);
				return { block: true, reason: repair };
			}
			return undefined;
		});

		pi.on("tool_result", async (event, ctx) => {
			const active = activeRun;
			const control = event.toolName === FINISH_TOOL_NAME || event.toolName === UPDATE_STATE_TOOL_NAME;
			const rejectedControl =
				control && (event.isError || (isRecord(event.details) && event.details.accepted === false));
			if (control && (!rejectedControl || !active?.coordinator))
				return rejectedControl ? { isError: true } : undefined;
			if (!active) {
				return undefined;
			}
			const previousResult = active.coordinator ? (active.resultQueue ?? Promise.resolve()) : Promise.resolve();
			let release: (() => void) | undefined;
			if (active.coordinator)
				active.resultQueue = new Promise<void>((resolve) => {
					release = resolve;
				});
			await previousResult;
			try {
				active.ownership?.assertCurrent();
				const invocation = active.toolInvocations?.get(event.toolCallId)?.identity;
				const actionPath = join(active.record.runDir, "evidence/tools", `${sureHash(event.toolCallId)}.json`);
				if (active.coordinator && existsSync(actionPath)) return undefined;
				const action =
					active.coordinator && invocation
						? {
								toolCallId: event.toolCallId,
								toolName: event.toolName,
								path: `run:evidence/tools/${sureHash(event.toolCallId)}.json`,
								batchId: invocation.batchId,
							}
						: undefined;
				if (action)
					writeSureJson(actionPath, {
						...invocation,
						toolCallId: event.toolCallId,
						input: event.input,
						completedAt: new Date().toISOString(),
						execution: "returned",
						duringHold: active.coordinator?.state.status !== "executing",
						content: event.content.filter((block) => block.type === "text"),
						isError: event.isError || rejectedControl,
					});
				const runManager = new SureRunManager(active.record.cwd);
				active.record = runManager.updateRun(active.record, {}, "tool_result", {
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					isError: event.isError,
					content: active.coordinator
						? event.content
								.filter((block) => block.type === "text")
								.map((block) => block.text)
								.join("\n")
								.slice(-16_000)
						: undefined,
				});
				if (active.coordinator && active.coordinator.state.status !== "executing") return undefined;
				if (control) {
					const rejection = isRecord(event.details) ? event.details.rejection : undefined;
					const manifestPhase =
						rejection === "manifest_path" || rejection === "manifest_json" || rejection === "manifest_envelope"
							? rejection
							: undefined;
					const target =
						typeof event.input.manifest_path === "string"
							? runManager.resolveRunPath(active.record, event.input.manifest_path)
							: undefined;
					const previous = active.coordinator?.state.lastFailure?.condition;
					const localProgress =
						target !== undefined &&
						previous?.target === target &&
						((previous.id === "manifest_path" &&
							(manifestPhase === "manifest_json" || manifestPhase === "manifest_envelope")) ||
							(previous.id === "manifest_json" && manifestPhase === "manifest_envelope"));
					if (
						action &&
						active.coordinator &&
						(active.coordinator.state.lastCheckVersion ?? 0) ===
							active.toolInvocations?.get(event.toolCallId)?.checkVersionAtStart
					)
						observeCoordinatedCheck(active, ctx, {
							unitId: invocation!.unitId,
							outcome: "blocked",
							failureKind: "tool",
							checker: `control:${event.toolName}`,
							summary:
								event.content
									.filter((block) => block.type === "text")
									.map((block) => block.text)
									.join("\n")
									.slice(-2000) || "SURE control rejected the call.",
							artifactPaths: [],
							inputPaths: [],
							action,
							condition: manifestPhase ? { id: manifestPhase, target, localRepair: true } : undefined,
							localProgress,
						});
					return { isError: true };
				}
				const gate = await active.hooks.run("post_tool_result", {
					run: active.record,
					skill: active.skillPackage.manifest,
					cwd: ctx.cwd,
					packageDir: active.skillPackage.packageDir,
					runDir: active.record.runDir,
					args: active.record.args,
					event,
				});
				// Cancellation or new constraints can arrive while a previously started hook awaits.
				if (active.coordinator && active.coordinator.state.status !== "executing") return undefined;
				applyStatePatch(pi, ctx, active, gate.state_patch, "post_tool_result_state", gate.statePatchHookId);
				observeCoordinatedCheck(
					active,
					ctx,
					(gate.checks ?? (gate.check ? [gate.check] : [])).map((check) =>
						check.failureKind === "tool"
							? {
									...check,
									action,
									checker: `tool:${event.toolName}`,
									summary: `${check.summary}\n${event.content
										.filter((block) => block.type === "text")
										.map((block) => block.text)
										.join("\n")
										.slice(-2000)}`,
								}
							: { ...check, action },
					),
					gate.state_patch,
				);
				if (!gate.ok) {
					const repair = gate.repair ?? gate.message ?? "Repair the tool result issue and retry.";
					active.record = runManager.updateRun(active.record, { lastRepair: repair }, "tool_result_repair", gate);
					return {
						content: active.coordinator
							? [...event.content, ...toolText(`SURE gate feedback: ${repair}`)]
							: toolText(repair),
						details: { repair, diagnostics: gate.diagnostics },
						isError: true,
					};
				}
				return undefined;
			} finally {
				release?.();
			}
		});

		pi.on("agent_end", async (event) => {
			const active = activeRun;
			if (!active) {
				return;
			}
			if (active.record.status !== "running") {
				return;
			}
			// A retry, a compaction or a queued message can still continue this run, so
			// judge it abandoned only on agent_settled. That event carries no payload.
			active.lastAgentMessages = event.messages;
		});

		pi.on("input", (event) => {
			if (activeRun?.coordinator && event.source !== "extension")
				syncSureUserContext(
					activeRun.coordinator,
					[
						{
							role: "user",
							timestamp: Date.now(),
							content: [{ type: "text", text: event.text }, ...(event.images ?? [])],
						},
					],
					true,
				);
		});

		pi.on("message_end", (event, ctx) => {
			if (activeRun?.coordinator && event.message.role === "user") {
				syncSureUserContext(activeRun.coordinator, [event.message]);
				if (activeRun.coordinator.state.status !== "executing") ctx.setExecutionHold?.(true);
			}
		});

		pi.on("agent_settled", async (_event, ctx) => {
			const active = activeRun;
			if (!active) {
				return;
			}
			if (active.record.status !== "running") {
				if (active.coordinator && active.terminalizing) {
					ctx.setContextProjection?.(undefined);
					ctx.setExecutionHold?.(false);
					clearActiveRun(pi, active, setActiveRun);
				}
				return;
			}
			if (active.shuttingDown) return;
			const messages = active.lastAgentMessages;
			const last = messages ? [...messages].reverse().find((message) => message.role === "assistant") : undefined;
			if (
				active.coordinator?.state.status === "executing" &&
				last?.role === "assistant" &&
				last.stopReason === "error"
			) {
				observeCoordinatedCheck(active, ctx, {
					unitId: sureCurrentUnit(
						active.skillPackage,
						new SureRunManager(active.record.cwd).readState(active.record),
					),
					outcome: "blocked",
					failureKind: "execution",
					summary: last.errorMessage ?? "Executor model request failed.",
					artifactPaths: [],
					inputPaths: [],
				});
			}
			active.lastAgentMessages = undefined;
			if (
				active.coordinator &&
				messages?.some((message) => message.role === "assistant" && message.stopReason === "aborted")
			)
				active.coordinator.stop("User cancelled execution.", true);
			if (active.coordinator && (active.coordinator.state.status !== "executing" || ctx.signal?.aborted)) {
				await settleCoordinatedRun(pi, ctx, active, setActiveRun);
				return;
			}
			if (!messages) {
				// Nothing ran since the last settle; there is no turn to call abandoned.
				return;
			}
			const runManager = new SureRunManager(active.record.cwd);
			const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
			// A provider that gave up leaves its reason only on the assistant message.
			// Recording the reminder over it makes the run read as agent negligence.
			const providerError =
				lastAssistant !== undefined && "stopReason" in lastAssistant && lastAssistant.stopReason === "error"
					? lastAssistant.errorMessage
					: undefined;
			// Without the state snapshot the event cannot tell "every unit done, only
			// sure_finish missing" from "stalled on the third unit" after the fact.
			const stalledState = runManager.readState(active.record);
			active.record = runManager.updateRun(
				active.record,
				{
					lastRepair:
						providerError ??
						`The Sure run is still active. Call ${FINISH_TOOL_NAME} after producing the required manifest.`,
					// "running" on its own is a lie once the agent has stopped. Stamp the
					// first stall so a reader can age the record without a live session.
					staleSince: active.record.staleSince ?? new Date().toISOString(),
				},
				"finish_missing",
				{
					reason: providerError ? "provider_ended_turn" : "agent_turn_ended_without_finish",
					nudges: active.finishNudges ?? 0,
					phase: stalledState?.phase,
					counters: stalledState?.counters,
					checkpoint: stalledState?.checkpoint,
				},
			);
			const headless = ctx.mode === "print" || ctx.mode === "json";
			const nudgeLimit = active.coordinator?.limits.finishNudges ?? MAX_FINISH_NUDGES;
			// Headless gets a continuation prompt below. An interactive operator gets
			// only this line, and until it named the command there was nothing to act
			// on: one run sat at "running" for 58 hours with every unit already done.
			ctx.ui.notify(
				headless
					? `Sure run ${active.record.runId} is still waiting for ${FINISH_TOOL_NAME}.`
					: `Sure run ${active.record.runId} is still waiting for ${FINISH_TOOL_NAME}. Run /sure_resume to continue it.`,
				"warning",
			);
			const aborted =
				lastAssistant !== undefined && "stopReason" in lastAssistant && lastAssistant.stopReason === "aborted";
			if (aborted) {
				// A deliberate interrupt keeps its cancel semantics on shutdown.
				return;
			}
			active.finishMissing = true;
			if (headless && (active.finishNudges ?? 0) < nudgeLimit) {
				active.finishNudges = (active.finishNudges ?? 0) + 1;
				if (active.coordinator) {
					active.coordinator.state.finishNudges = (active.coordinator.state.finishNudges ?? 0) + 1;
					active.coordinator.save();
				}
				await pi.sendUserMessage(buildFinishNudge(active.record));
			}
		});

		pi.on("session_shutdown", async (_event, ctx) => {
			const active = activeRun;
			if (!active || active.shuttingDown) {
				return;
			}
			if (active.coordinator) {
				active.shuttingDown = true;
				ctx.setExecutionHold?.(true);
				active.coordinator.stop("Session shut down before sure_finish.", !active.finishMissing);
				ctx.abort();
				await active.diagnosis;
				await Promise.all([...(active.toolInvocations?.values() ?? [])].map((call) => call.settled));
				await active.resultQueue;
				active.coordinator.barrier(coordinatedScope(active));
			}
			const runManager = new SureRunManager(active.record.cwd);
			// A run abandoned by the agent (turn ended, no sure_finish) failed;
			// "cancelled" is reserved for runs interrupted mid-work.
			active.record = runManager.setStatus(
				active.record,
				active.finishMissing ? "failed" : "cancelled",
				"session_shutdown",
			);
			pi.appendEntry("sure.run", active.record);
			const onError = await active.hooks.run("on_error", {
				run: active.record,
				skill: active.skillPackage.manifest,
				cwd: ctx.cwd,
				packageDir: active.skillPackage.packageDir,
				runDir: active.record.runDir,
				args: active.record.args,
				event: { reason: "session_shutdown" },
			});
			applyStatePatch(pi, ctx, active, onError.state_patch, "on_error_state", onError.statePatchHookId);
			if (active.coordinator) {
				const report = buildSureFailureReport(
					active.record,
					active.coordinator,
					runManager.readState(active.record),
				);
				persistSureFailureReport(active.record, report);
				pi.appendEntry("sure.failure_report", report);
				pi.appendEntry(SESSION_OUTCOME_ENTRY, {
					exitCode: active.record.status === "cancelled" ? 130 : 1,
					summary: report.stopReason,
				});
				active.record = runManager.updateRun(active.record, {}, "terminal_export");
				active.terminalizing = true;
				if (!ctx.isIdle()) return;
				ctx.setContextProjection?.(undefined);
				ctx.setExecutionHold?.(false);
			}
			ctx.ui.setStatus(STATUS_KEY, undefined);
			clearActiveRun(pi, active, setActiveRun);
		});

		pi.registerCommand("sure", {
			description: "Show Sure skill discovery status",
			handler: async (_args, ctx) => {
				const discovered = discoverSureSkillPackages(ctx.cwd);
				const commandList = discovered.packages.map((pkg) => `/${pkg.manifest.command}`).join(", ");
				const diagnostics =
					discovered.diagnostics.length > 0 ? `\n${formatDiagnostics(discovered.diagnostics)}` : "";
				ctx.ui.notify(
					commandList ? `Sure skills: ${commandList}${diagnostics}` : `No Sure skills found.${diagnostics}`,
				);
			},
		});
	};
}

export const sureExtension = createSureExtension();
