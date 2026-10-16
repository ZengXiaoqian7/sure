import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { defineTool } from "../extensions/index.ts";
import type { ExtensionContext } from "../extensions/types.ts";
import type { IsolatedSession } from "../session-controls.ts";
import { createUsageTotals } from "../usage-totals.ts";
import { parseSureDiagnosisResult } from "./coordination-contracts.ts";
import type {
	SureDiagnosisCheckpoint,
	SureDiagnosisOutcome,
	SureDiagnosisResult,
	SureStageDeclaration,
} from "./coordination-types.ts";
import type { SureCoordinator } from "./coordinator.ts";
import {
	loadSureDiagnosticIndex,
	packSureDiffIndex,
	pageSureDiagnosticValue,
	searchSureDiagnosticText,
	sureActionDetails,
	sureActionIndex,
	sureCurrentRepairAttempt,
	sureDiagnosticRange,
	sureDiffIndex,
	sureSnapshotForPath,
} from "./diagnostic-view.ts";
import {
	assertSureDiagnosticSourcesCurrent,
	diffSureSnapshots,
	evidencePathName,
	readSureSnapshot,
	resolveSureEvidencePath,
	sureEvidenceTextAllowed,
	sureHash,
	writeSureJson,
} from "./evidence.ts";
import { resolveSurePackagePath } from "./manifest.ts";
import { prepareSureSupervisorSession } from "./supervisor-session.ts";
import type { SureSkillPackage } from "./types.ts";
import { readSureUserContext, syncSureUserContext } from "./user-context.ts";

function messageText(message: { content?: unknown }): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter(
			(block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

export async function diagnoseSureRun(
	coordinator: SureCoordinator,
	ctx: ExtensionContext,
	scope: string[],
	stage: SureStageDeclaration | undefined,
	skill?: SureSkillPackage,
): Promise<SureDiagnosisOutcome> {
	coordinator.assertOwner?.();
	if (coordinator.isStopped || ctx.signal?.aborted)
		throw new Error("Cannot diagnose a stopped or cancelled Sure run.");
	syncSureUserContext(
		coordinator,
		ctx.sessionManager.getBranch().flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
	);
	const state = coordinator.state;
	const limits = coordinator.limits;
	let attempt = state.attempts.at(-1);
	if (
		attempt &&
		attempt.evidenceVersion === state.evidenceVersion &&
		attempt.unitId === state.unitId &&
		(attempt.result || attempt.checkpoint)
	) {
		try {
			assertSureDiagnosticSourcesCurrent(coordinator.run, attempt.readKeys);
			if (attempt.result?.decision === "repair") return parseSureDiagnosisResult(attempt.result);
		} catch (error) {
			state.evidenceVersion++;
			state.yieldReason = error instanceof Error ? error.message : String(error);
			coordinator.invalidateRepair(state.yieldReason);
			coordinator.beginDiagnosis();
			attempt = state.attempts.at(-1);
		}
		if (attempt?.result) {
			coordinator.beginDiagnosis();
			attempt = state.attempts.at(-1);
		}
	}
	if (!attempt || attempt.evidenceVersion !== state.evidenceVersion || attempt.unitId !== state.unitId) {
		coordinator.beginDiagnosis();
		attempt = state.attempts.at(-1);
	}
	if (!attempt) throw new Error("Missing diagnosis attempt.");
	const activeAttempt = attempt;
	const runtimeId = randomUUID();
	coordinator.supervisorRuntime = runtimeId;
	const ticket = { unitId: state.unitId, evidenceVersion: state.evidenceVersion };
	const assertRuntime = (): void => {
		coordinator.assertOwner?.();
		if (finished || coordinator.supervisorRuntime !== runtimeId) throw new Error("Stale supervisor runtime.");
	};
	const assertTicket = (): void => {
		assertRuntime();
		if (
			coordinator.isStopped ||
			state.unitId !== ticket.unitId ||
			state.evidenceVersion !== ticket.evidenceVersion ||
			signal?.aborted
		)
			throw new Error("Supervisor investigation identity changed or was cancelled.");
	};
	const started = Date.now();
	const turnsBefore = activeAttempt.modelTurns;
	const readsBefore = activeAttempt.readCalls;
	const resumed = (activeAttempt.segments?.length ?? 0) > 0;
	const segment = {
		startedAt: new Date(started).toISOString(),
		modelTurns: 0,
		readCalls: 0,
		elapsedMs: 0,
		error: undefined as string | undefined,
	};
	activeAttempt.segments ??= [];
	activeAttempt.segments.push(segment);
	let accounted = started;
	const cancellation = new AbortController();
	coordinator.diagnosisAbortController = cancellation;
	const invocationSignal = ctx.signal;
	const signal = invocationSignal ? AbortSignal.any([invocationSignal, cancellation.signal]) : cancellation.signal;
	let isolated: IsolatedSession | undefined;
	let accountedUsage = createUsageTotals();
	let rejectCancellation: (() => void) | undefined;
	let finished = false;
	let requestsBeforeTurn = activeAttempt.readRequests ?? activeAttempt.readCalls;
	let timelineOffset = resumed ? (activeAttempt.timelineOffset ?? 0) : 0;
	let timelineLength: number | undefined;
	const userContext = readSureUserContext(coordinator);
	let userContextRead = resumed ? (activeAttempt.userContextOffset ?? 0) : 0;
	const update = (): void => {
		assertRuntime();
		const usage = isolated?.getUsage?.();
		if (usage) {
			activeAttempt.usage ??= createUsageTotals();
			for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const)
				activeAttempt.usage[key] += Math.max(0, usage[key] - accountedUsage[key]);
			accountedUsage = usage;
		}
		const identity = isolated?.getSessionIdentity?.();
		if (identity?.file) {
			activeAttempt.supervisorSessionId = identity.id;
			state.supervisorSession = {
				id: identity.id,
				file: identity.file,
				leafId: identity.leafId,
				status: existsSync(identity.file) ? "ready" : "initializing",
				accountedUsage,
				accountedAttemptId: activeAttempt.id,
			};
		}
		activeAttempt.elapsedMs += Math.max(0, Date.now() - accounted);
		accounted = Date.now();
		segment.modelTurns = activeAttempt.modelTurns - turnsBefore;
		segment.readCalls = activeAttempt.readCalls - readsBefore;
		segment.elapsedMs = Date.now() - started;
		activeAttempt.timelineOffset = timelineOffset;
		activeAttempt.userContextOffset = userContextRead;
		coordinator.save();
	};
	const abort = (): void => {
		void isolated?.abort();
	};
	const saveResult = (result: SureDiagnosisResult): SureDiagnosisResult => {
		activeAttempt.result = result;
		update();
		writeSureJson(join(coordinator.run.runDir, "diagnoses", activeAttempt.id, "result.json"), result);
		return result;
	};
	const fallback = (reason: string): SureDiagnosisCheckpoint => {
		if (activeAttempt.protocolLastError)
			reason += ` Last rejected protocol action: ${activeAttempt.protocolLastError}`;
		if (reason.length > 3400) {
			writeSureJson(
				join(
					coordinator.run.runDir,
					"diagnoses",
					activeAttempt.id,
					`segment-error-${activeAttempt.segments!.length}.json`,
				),
				{ reason },
			);
			reason = `${reason.slice(0, 3400)} [truncated; full diagnostic error retained in the attempt directory]`;
		}
		reason += ` Diagnosis segment usage: model turns ${activeAttempt.modelTurns - turnsBefore}, reads ${activeAttempt.readCalls - readsBefore}; macro delivered ${timelineOffset}/${timelineLength ?? "unknown"} characters.`;
		activeAttempt.error = reason;
		segment.error = reason;
		const checkpoint: SureDiagnosisCheckpoint = {
			runId: state.runId,
			unitId: state.unitId,
			evidenceVersion: state.evidenceVersion,
			decision: "checkpoint",
			checkpoint: reason,
			automatic: false,
			facts: [state.lastCheck?.summary ?? "No validated completion was recorded."],
			hypotheses: [],
			unknowns: ["Diagnosis remains incomplete; this is not a business stop."],
			evidenceReferences: ["run:coordination.json"],
			nextActions: [],
			nextReads: [],
			candidateRange: activeAttempt.checkpoint?.candidateRange ?? null,
			supportingEvidence: activeAttempt.checkpoint?.supportingEvidence ?? [],
			opposingEvidence: activeAttempt.checkpoint?.opposingEvidence ?? [],
		};
		activeAttempt.checkpoint = checkpoint;
		update();
		writeSureJson(
			join(
				coordinator.run.runDir,
				"diagnoses",
				activeAttempt.id,
				`checkpoint-${activeAttempt.segments!.length}.json`,
			),
			checkpoint,
		);
		return checkpoint;
	};
	if (signal?.aborted) return fallback("User cancelled diagnosis.");
	const baselineId = state.lastSuccessSnapshot ?? state.initialSnapshot;
	const latestId = state.latestSnapshot;
	const budget = () => ({
		scope: "usage_only",
		cumulative: {
			modelTurns: activeAttempt.modelTurns,
			reads: activeAttempt.readCalls,
			readRequests: activeAttempt.readRequests ?? activeAttempt.readCalls,
			elapsedMs: activeAttempt.elapsedMs,
			compactionCalls: activeAttempt.compactionCalls ?? 0,
			usage: activeAttempt.usage ?? "unavailable",
		},
		reads: { used: activeAttempt.readCalls - readsBefore },
		modelTurns: { completed: activeAttempt.modelTurns - turnsBefore },
		time: { elapsedMs: Date.now() - started },
	});
	const timelineProgress = () => ({
		deliveredCharacters: timelineOffset,
		totalCharacters: timelineLength ?? null,
		complete: timelineLength !== undefined && timelineOffset === timelineLength,
	});
	const nextMacroRead = () => ({ operation: "timeline", offset: timelineOffset });
	const protocolCalls = new Set<string>();
	const usefulReadKeys = new Set(activeAttempt.readKeys ?? []);
	const requireMacro = (message: string): never => {
		throw new Error(
			JSON.stringify({
				error: message,
				nextRead: nextMacroRead(),
				timelineProgress: timelineProgress(),
				budget: budget(),
			}),
		);
	};
	try {
		const evidenceDir = join(coordinator.run.runDir, "evidence");
		const stagePath = stage && resolveSurePackagePath(coordinator.run.packageDir, stage.prompt);
		if (!stage || stage.id !== state.unitId || !stagePath)
			throw new Error("Current stage contract is missing or does not match the active unit.");
		const currentSnapshot = latestId ? readSureSnapshot(coordinator.run, latestId) : undefined;
		const stageFile = currentSnapshot?.files.find(
			(file) => resolveSureEvidencePath(coordinator.run, file.path) === stagePath,
		);
		if (stageFile?.status !== "text" || stageFile.text === undefined)
			throw new Error(`Current stage contract was not captured as text: ${stageFile?.status ?? "not_captured"}.`);
		const taskSources = skill
			? [skill.manifest.prompt, skill.manifest.coordination?.commonPrompt].filter((path): path is string =>
					Boolean(path),
				)
			: [];
		const globalContext = taskSources
			.map((path) => {
				const resolved = resolveSurePackagePath(coordinator.run.packageDir, path);
				const saved = currentSnapshot?.files.find(
					(file) => resolveSureEvidencePath(coordinator.run, file.path) === resolved,
				);
				if (saved?.status !== "text" || saved.text === undefined)
					throw new Error(`Global task instructions were not captured as text: ${path}.`);
				return `<sure_global_task source=${JSON.stringify({ path: saved.path, snapshotId: latestId, sha256: saved.sha256 })}>\n${saved.text}\n</sure_global_task>`;
			})
			.join("\n\n");
		const index = loadSureDiagnosticIndex(coordinator);
		const currentCheck = index.checks.filter(({ check }) => check.unitId === state.unitId).at(-1);
		const businessCheck = index.checks
			.filter(
				({ check }) =>
					check.unitId === state.unitId &&
					check.failureKind !== "tool" &&
					!check.checker?.startsWith("tool:") &&
					check.failureKind !== "no_progress",
			)
			.at(-1);
		const currentAttempt = sureCurrentRepairAttempt(coordinator, index);
		const attemptCalls = new Set(currentAttempt?.actions.map((action) => action.toolCallId));
		const diffEvidence = {
			before: baselineId ? `snapshot:${baselineId}` : undefined,
			after: latestId ? `snapshot:${latestId}` : undefined,
		};
		const compactCheck = (check: typeof state.lastCheck) =>
			check
				? {
						unitId: check.unitId,
						outcome: check.outcome,
						failureKind: check.failureKind,
						summary: check.summary.slice(0, 300),
						checker: check.checker,
						action: check.action ? { toolCallId: check.action.toolCallId } : undefined,
					}
				: undefined;
		const isDeclared = (path: string, roots: string[]): boolean =>
			roots.some((value) => {
				const root = resolveSureEvidencePath(coordinator.run, value);
				const rel = root ? relative(root, path) : "..";
				return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
			});
		const repairScope = {
			allowed: scope.filter(
				(value) =>
					!value.startsWith("package:") &&
					!index.readOnlyScope.includes(value) &&
					!stage.diagnosticPaths?.includes(value),
			),
			readOnly: [
				...new Set([
					...index.readOnlyScope,
					...(stage.diagnosticPaths ?? []),
					"run:evidence",
					"run:snapshots",
					"run:diagnoses",
					"run:supervisor",
					"run:.coordination-owner.json",
					"run:.coordination-owner.json.reclaim",
					"run:state.json",
					"run:coordination.json",
					"run:run.json",
					"run:events.jsonl",
					"package:",
				]),
			],
			instruction:
				"Optional focusPaths are execution hints within original task permissions, never a write allowlist. Gates, schemas and harness state cannot be modification suggestions. Supporting probes and original helper outputs remain permitted.",
		};
		const visibleRepairScope = {
			...repairScope,
			allowed: repairScope.allowed.filter((value, index, paths) => {
				const path = resolveSureEvidencePath(coordinator.run, value);
				return !paths.some((other, otherIndex) => {
					const root = resolveSureEvidencePath(coordinator.run, other);
					return root === path ? otherIndex < index : Boolean(path && isDeclared(path, [other]));
				});
			}),
			readOnly: [
				...new Set([
					"run:evidence/tools",
					...repairScope.readOnly.filter((path) => !path.startsWith("run:evidence/tools/")),
				]),
			],
		};
		const timeline = {
			runId: state.runId,
			task: {
				command: coordinator.run.command,
				skillName: coordinator.run.skillName,
				args: coordinator.run.args,
				cwd: coordinator.run.cwd,
				packageDir: coordinator.run.packageDir,
				runDir: coordinator.run.runDir,
				userContext: {
					path: "run:evidence/user-context.json",
					characters: userContext.length,
					preview: userContext.slice(-1000),
				},
			},
			unitId: state.unitId,
			evidenceVersion: state.evidenceVersion,
			currentStage: {
				unitId: stage.id,
				prompt: stageFile.path,
				references: stage.references.map((path) => `package:${path}`),
				checkVersion: currentCheck?.version,
				artifactPaths: currentCheck?.check.artifactPaths ?? [],
				gateOutcome: businessCheck?.check.outcome ?? "not_recorded",
				businessCheckVersion: businessCheck?.version,
				businessGateExecution: businessCheck?.check.exitCode != null ? "recorded" : "unknown",
				latestToolCheck: currentCheck?.check.failureKind === "tool" ? compactCheck(currentCheck.check) : undefined,
				failureKind: currentCheck?.check.failureKind,
			},
			readScope: {
				roots: {
					"project:": coordinator.run.cwd,
					"package:": coordinator.run.packageDir,
					"run:": coordinator.run.runDir,
				},
				instruction:
					"Read relevant text within these roots even when not captured. Snapshot coverage is not a read whitelist. Repair permissions remain separate.",
			},
			executorProgress:
				currentSnapshot?.files.find((file) => file.path === "run:evidence/executor-progress.json")?.text ??
				JSON.stringify({ unitId: state.unitId, claims: [], currentIntentAvailable: false }),
			lastCheck:
				JSON.stringify(state.lastCheck) === JSON.stringify(state.lastFailure)
					? { sameAs: "lastFailure" }
					: compactCheck(state.lastCheck),
			originalFailure: compactCheck(state.originalFailure),
			lastFailure: compactCheck(state.lastFailure),
			yieldReason:
				state.yieldReason === state.lastFailure?.summary ? { sameAs: "lastFailure.summary" } : state.yieldReason,
			repairScope: visibleRepairScope,
			stages: index.stages,
			checkIndex: {
				count: index.checks.length,
				operation: "checks",
			},
			hookIndex: { count: index.hooks.length, operation: "hooks" },
			baseline: {
				id: baselineId,
				kind: state.lastSuccessSnapshot ? "last_success" : "initial_not_success",
				unitId: state.lastSuccessUnit,
			},
			currentSnapshot: latestId,
			captureCoverage: {
				baseline: baselineId
					? {
							files: readSureSnapshot(coordinator.run, baselineId).files.length,
							truncated: readSureSnapshot(coordinator.run, baselineId).truncated,
						}
					: null,
				current: { files: currentSnapshot?.files.length ?? 0, truncated: currentSnapshot?.truncated },
				limit: limits.snapshotFiles,
			},
			diffEvidence,
			diffIndex:
				baselineId && latestId
					? packSureDiffIndex(
							sureDiffIndex(
								readSureSnapshot(coordinator.run, baselineId),
								readSureSnapshot(coordinator.run, latestId),
							).filter((file) => !file.path.startsWith("run:evidence/tools/")),
						)
					: [],
			units: Object.fromEntries(
				Object.entries(state.units).map(([id, { calls, checks, noProgress, directRepairs, supervisorRepairs }]) => [
					id,
					{ calls, checks, noProgress, directRepairs, supervisorRepairs },
				]),
			),
			previousDiagnoses: state.attempts
				.filter((attempt) => attempt.id !== activeAttempt.id)
				.map(({ id, unitId, evidenceVersion, result, error }) => ({
					id,
					unitId,
					evidenceVersion,
					decision: result?.decision,
					error: error ? true : undefined,
				})),
			repairs: (state.repairs ?? []).map(({ id, source, unitId, outcome }) => ({ id, source, unitId, outcome })),
			currentAttempt,
			priorUnitActions: sureActionIndex(
				index.actions.filter(
					(action) =>
						(action.unitId === state.unitId || action.checkUnitId === state.unitId) &&
						!attemptCalls.has(action.toolCallId),
				),
			),
			actionDetails: {
				operation: "actions",
				key: "toolCallId",
			},
			repairDetails: { operation: "repairs", key: "repairId" },
		};
		const serializedTimeline = JSON.stringify(timeline);
		const timelineHash = sureHash(serializedTimeline);
		if (activeAttempt.timelineHash !== timelineHash) timelineOffset = 0;
		activeAttempt.timelineHash = timelineHash;
		timelineLength = serializedTimeline.length;
		const operationParameters = {
			timeline: ["offset"],
			actions: ["offset", "toolCallId", "toolCallIds"],
			range: ["offset", "startBatch", "endBatch"],
			user_context: ["offset"],
			checks: ["offset"],
			hooks: ["offset", "hookId"],
			repairs: ["offset", "repairId"],
			snapshot: ["offset", "path", "snapshotId"],
			diff: ["offset", "path"],
			file: ["offset", "path", "snapshotId"],
			search: ["offset", "path", "snapshotId", "query"],
			list: ["offset", "path"],
			check: ["offset", "checkVersion"],
			log: ["offset"],
		};
		const readTool = defineTool({
			name: "sure_diagnostic_read",
			label: "Read SURE diagnostic evidence",
			description:
				"Read timeline first, including currentAttempt and priorUnitActions. snapshot/diff without path return indexes; with path they return saved content/diff. file/search inspect relevant text within project/package/run roots, independently of capture scope. search returns sourceOffset and line for file continuation. list(path) lists one directory level, never recursively. All evidence pages use nextOffset; text pages contain at most 2,000 lines or 50 KiB, without a total read allowance. Partial text is not complete inspection. No writes or process execution.",
			parameters: Type.Object({
				operation: StringEnum([
					"timeline",
					"actions",
					"range",
					"user_context",
					"checks",
					"hooks",
					"repairs",
					"snapshot",
					"diff",
					"file",
					"search",
					"list",
					"check",
					"log",
				] as const),
				offset: Type.Optional(Type.Integer({ minimum: 0 })),
				path: Type.Optional(Type.String()),
				query: Type.Optional(Type.String({ minLength: 1, maxLength: 32_000 })),
				snapshotId: Type.Optional(Type.String()),
				checkVersion: Type.Optional(Type.Integer({ minimum: 1 })),
				hookId: Type.Optional(Type.String()),
				repairId: Type.Optional(Type.String()),
				toolCallId: Type.Optional(Type.String()),
				toolCallIds: Type.Optional(
					Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 4, uniqueItems: true }),
				),
				startBatch: Type.Optional(Type.String()),
				endBatch: Type.Optional(Type.String()),
			}),
			execute: async (_id, params) => {
				if (finished) throw new Error("Diagnosis segment has ended.");
				assertTicket();
				activeAttempt.readRequests = (activeAttempt.readRequests ?? activeAttempt.readCalls) + 1;
				update();
				activeAttempt.readCalls++;
				update();
				if (signal?.aborted) throw new Error("User cancelled diagnosis.");
				const unsupported = Object.keys(params).find(
					(key) => key !== "operation" && !operationParameters[params.operation].includes(key),
				);
				if (unsupported) protocolCalls.add(_id);
				if (unsupported)
					throw new Error(
						`Unsupported parameter ${unsupported} for ${params.operation}.${params.operation === "diff" ? " diff always compares the recorded baseline to the current snapshot; use snapshot to inspect a specific snapshotId." : ""}`,
					);
				if (!timelineProgress().complete && params.operation !== "timeline") {
					protocolCalls.add(_id);
					requireMacro("Read the complete macro timeline before inspecting local evidence.");
				}
				let value: unknown;
				let offset = params.offset ?? 0;
				let fileIdentity:
					| { path: string; source: "snapshot" | "file"; snapshotId?: string; sha256: string }
					| undefined;
				if (params.operation === "timeline") {
					offset = params.offset ?? timelineOffset;
					if (offset > timelineOffset) {
						protocolCalls.add(_id);
						requireMacro("Read the macro timeline sequentially; do not skip undelivered text.");
					}
					value = timeline;
				} else if (params.operation === "actions") {
					if (params.toolCallIds) {
						if (
							params.toolCallId ||
							params.toolCallIds.length < 1 ||
							params.toolCallIds.length > 4 ||
							new Set(params.toolCallIds).size !== params.toolCallIds.length
						)
							throw new Error("Use one to four unique action IDs, without toolCallId.");
						value = params.toolCallIds.map((id) => {
							const action = index.actions.find((action) => action.toolCallId === id);
							if (!action) throw new Error("Unknown tool action identity.");
							return sureActionDetails(action);
						});
					} else if (params.toolCallId) {
						const action = index.actions.find((action) => action.toolCallId === params.toolCallId);
						if (!action) throw new Error("Unknown tool action identity.");
						value = sureActionDetails(action);
					} else value = sureActionIndex(index.actions);
				} else if (params.operation === "range") {
					value = sureDiagnosticRange(index, params.startBatch, params.endBatch);
				} else if (params.operation === "user_context") {
					const offset = params.offset ?? 0;
					if (!Number.isSafeInteger(offset) || offset !== userContextRead)
						throw new Error("Read user_context sequentially from its next offset.");
					value = pageSureDiagnosticValue(userContext, offset);
					userContextRead = (value as ReturnType<typeof pageSureDiagnosticValue>).nextOffset;
				} else if (params.operation === "checks") {
					value = index.checks.map(({ version, check, snapshotId, timestamp, repairId }) => ({
						version,
						unitId: check.unitId,
						outcome: check.outcome,
						summary: check.summary,
						checker: check.checker,
						action: check.action,
						snapshotId,
						timestamp,
						repairId,
					}));
				} else if (params.operation === "hooks") {
					value = params.hookId
						? index.hooks.find((hook) => hook.id === params.hookId)
						: index.hooks.map(
								({
									id,
									point,
									module,
									handler,
									status,
									toolCallId,
									inputEvidenceVersion,
									inputSnapshotId,
								}) => ({
									id,
									point,
									module,
									handler,
									status,
									toolCallId,
									inputEvidenceVersion,
									inputSnapshotId,
								}),
							);
					if (!value) throw new Error("Unknown hook evidence identity.");
				} else if (params.operation === "repairs") {
					value = params.repairId
						? state.repairs?.find((repair) => repair.id === params.repairId)
						: (state.repairs ?? []);
					if (!value) throw new Error("Unknown repair identity.");
				} else if (params.operation === "check") {
					if (!Number.isSafeInteger(params.checkVersion) || (params.checkVersion ?? 0) < 1)
						throw new Error("Invalid check version.");
					value = JSON.parse(readFileSync(join(evidenceDir, `${params.checkVersion}.json`), "utf8"));
				} else if (params.operation === "log") {
					const path = join(coordinator.run.runDir, "events.jsonl");
					value = readFileSync(path, "utf8");
				} else if (params.operation === "snapshot") {
					const snapshot = sureSnapshotForPath(coordinator, params.snapshotId ?? latestId ?? "", params.path);
					value = params.path ? snapshot : { ...snapshot, files: snapshot.files.map(({ text, ...file }) => file) };
				} else if (params.operation === "diff") {
					if (!baselineId || !latestId) throw new Error("No snapshot baseline is available.");
					value = {
						baselineKind: state.lastSuccessSnapshot ? "last_success" : "initial_not_success",
						baselineUnit: state.lastSuccessUnit,
						snapshotReferences: diffEvidence,
						...(params.path
							? {
									diff: diffSureSnapshots(
										sureSnapshotForPath(coordinator, baselineId, params.path),
										sureSnapshotForPath(coordinator, latestId, params.path),
									),
								}
							: {
									index: sureDiffIndex(
										readSureSnapshot(coordinator.run, baselineId),
										readSureSnapshot(coordinator.run, latestId),
									).filter((file) => !file.path.startsWith("run:evidence/tools/")),
								}),
					};
				} else if (params.operation === "list") {
					if (!params.path) throw new Error("Directory listing requires an explicit path.");
					const path = resolveSureEvidencePath(coordinator.run, params.path);
					if (!path)
						throw new Error(
							"Directory is outside authorized roots or resolves through a symlink escape; existence is unknown.",
						);
					if (!sureEvidenceTextAllowed(path)) throw new Error("Directory is excluded diagnostic evidence.");
					if (!statSync(path).isDirectory()) throw new Error("Diagnostic listing requires a directory.");
					value = {
						path: evidencePathName(coordinator.run, path),
						source: "directory",
						entries: readdirSync(path)
							.sort()
							.flatMap((name) => {
								const child = resolveSureEvidencePath(coordinator.run, join(path, name));
								if (!child || !sureEvidenceTextAllowed(child)) return [];
								const stat = lstatSync(child);
								return [
									{
										name,
										path: evidencePathName(coordinator.run, child),
										type: stat.isSymbolicLink()
											? "symlink"
											: stat.isDirectory()
												? "directory"
												: stat.isFile()
													? "file"
													: "other",
									},
								];
							}),
					};
				} else {
					if (!params.path) throw new Error("File evidence requires an explicit path.");
					const path = resolveSureEvidencePath(coordinator.run, params.path ?? "");
					if (!path)
						throw new Error(
							"File is outside authorized diagnostic roots or resolves through a symlink escape; existence is unknown.",
						);
					if (!sureEvidenceTextAllowed(path)) throw new Error("This file is identity-only or excluded evidence.");
					// Prefer the retained version when captured; an uncaptured read is explicitly live.
					const snapshot = params.snapshotId
						? readSureSnapshot(coordinator.run, params.snapshotId)
						: latestId
							? readSureSnapshot(coordinator.run, latestId)
							: undefined;
					const saved = snapshot?.files.find(
						(file) => resolveSureEvidencePath(coordinator.run, file.path) === path,
					);
					let text: string;
					const captured = saved?.status === "text" && saved.text !== undefined;
					if (captured) {
						text = saved.text!;
					} else {
						if (params.snapshotId)
							throw new Error(`Saved diagnostic content unavailable: ${saved?.status ?? "not_captured"}.`);
						if (saved && saved.status !== "over_limit")
							throw new Error(`Saved diagnostic content unavailable: ${saved.status}.`);
						if (!statSync(path).isFile()) throw new Error("Diagnostic evidence is not a text file.");
						const content = readFileSync(path);
						if (content.includes(0) || !Buffer.from(content.toString("utf8"), "utf8").equals(content))
							throw new Error("Binary content is not diagnostic text.");
						text = content.toString("utf8");
					}
					fileIdentity = {
						path: params.path ?? "",
						source: captured ? "snapshot" : "file",
						snapshotId: captured ? snapshot?.id : undefined,
						sha256: sureHash(text),
					};
					value = params.operation === "search" ? searchSureDiagnosticText(text, params.query ?? "") : text;
				}
				let page = value;
				if (params.operation !== "user_context") {
					const evidencePage = pageSureDiagnosticValue(value, offset);
					page = evidencePage;
				}
				const nextTimelineOffset =
					params.operation === "timeline"
						? Math.max(timelineOffset, (page as ReturnType<typeof pageSureDiagnosticValue>).nextOffset)
						: timelineOffset;
				const progress = {
					deliveredCharacters: nextTimelineOffset,
					totalCharacters: timelineLength,
					complete: nextTimelineOffset === timelineLength,
				};
				const response = {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								...(page as object),
								...fileIdentity,
								...(fileIdentity
									? {
											resolvedPath: evidencePathName(
												coordinator.run,
												resolveSureEvidencePath(coordinator.run, fileIdentity.path)!,
											),
										}
									: {}),
								timelineProgress: progress,
								...(!progress.complete
									? { nextRead: { operation: "timeline", offset: nextTimelineOffset } }
									: {}),
								budget: budget(),
							}),
						},
					],
					details: { operation: params.operation, budget: budget() },
				};
				// No await between cursor validation, response serialization and commit:
				// parallel execute() calls cannot interleave this delivery transaction.
				timelineOffset = nextTimelineOffset;
				const readIdentity = {
					...params,
					offset,
					...(fileIdentity
						? {
								path: resolveSureEvidencePath(coordinator.run, fileIdentity.path),
								sha256: fileIdentity.sha256,
								source: fileIdentity.source,
								snapshotId: fileIdentity.snapshotId,
							}
						: {}),
					...(params.toolCallIds ? { toolCallIds: [...params.toolCallIds].sort() } : {}),
				};
				const key = JSON.stringify(
					Object.fromEntries(Object.entries(readIdentity).sort(([a], [b]) => a.localeCompare(b))),
				);
				assertTicket();
				activeAttempt.readKeys = [...(activeAttempt.readKeys ?? []).filter((previous) => previous !== key), key];
				if ((page as ReturnType<typeof pageSureDiagnosticValue>).text.length) usefulReadKeys.add(key);
				update();
				return response;
			},
		});

		if (!ctx.createIsolatedSession) throw new Error("Isolated session factory unavailable.");
		const candidates: { callId: string; result: SureDiagnosisOutcome }[] = [];
		let submitted: SureDiagnosisOutcome | undefined;
		let turnError: Error | undefined;
		let feedback =
			"Use sure_handoff_repair with a nonempty task, or sure_pause_diagnosis with a reason. Business stop is disabled.";
		let readFrontier = new Set(usefulReadKeys);
		const handoffTool = defineTool({
			name: "sure_handoff_repair",
			label: "Hand a repair task to the executor",
			description:
				"Submit one natural-language repair or evidence task. The harness attaches identity and validates the original gate. Optional focusPaths are suggestions, not write restrictions. No report JSON or business stop.",
			parameters: Type.Object({
				task: Type.String({ minLength: 1, maxLength: 32_000, pattern: "\\S" }),
				focusPaths: Type.Optional(
					Type.Array(Type.String({ minLength: 1, maxLength: 32_000 }), { minItems: 1, maxItems: 256 }),
				),
			}),
			execute: async (callId, params) => {
				assertTicket();
				if (!timelineProgress().complete) requireMacro("Read the complete macro timeline before handing off.");
				if (userContextRead !== userContext.length)
					throw new Error("Read complete user_context before handing off.");
				assertSureDiagnosticSourcesCurrent(coordinator.run, activeAttempt.readKeys);
				for (const target of params.focusPaths ?? []) {
					const path = resolveSureEvidencePath(coordinator.run, target);
					if (
						!path ||
						!sureEvidenceTextAllowed(path) ||
						isDeclared(path, repairScope.readOnly) ||
						!isDeclared(path, repairScope.allowed)
					)
						throw new Error("Focus path is outside original task permissions.");
				}
				const result: SureDiagnosisResult = {
					runId: state.runId,
					unitId: ticket.unitId,
					evidenceVersion: ticket.evidenceVersion,
					decision: "repair",
					repair: params.task,
					focusPaths: params.focusPaths,
					facts: [],
					hypotheses: [],
					unknowns: [],
					nextActions: [],
					evidenceReferences: latestId ? [`snapshot:${latestId}`] : [],
					targetFiles: [],
					validation: "The unchanged original unit gate validates the actual result.",
					stopBoundary:
						"Return an actual failed recheck of the original condition for reassessment. Independent errors have their own local correction; related objects remain within the complete goal. Supervisor business stop is disabled.",
				};
				candidates.push({ callId, result });
				return {
					content: [
						{ type: "text", text: "Repair candidate recorded; acceptance follows the complete tool batch." },
					],
					details: {},
				};
			},
		});
		const pauseTool = defineTool({
			name: "sure_pause_diagnosis",
			label: "Pause this investigation",
			description:
				"Save a resumable diagnostic checkpoint. Does not terminate the business task or consume gate retries.",
			parameters: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 4000, pattern: "\\S" }) }),
			execute: async (callId, params) => {
				assertTicket();
				candidates.push({
					callId,
					result: {
						runId: state.runId,
						unitId: ticket.unitId,
						evidenceVersion: ticket.evidenceVersion,
						decision: "checkpoint",
						checkpoint: params.reason,
						automatic: false,
						facts: [],
						hypotheses: [],
						unknowns: ["Investigation paused; no business stop."],
						nextActions: [],
						evidenceReferences: [],
						nextReads: [],
						candidateRange: null,
						supportingEvidence: [],
						opposingEvidence: [],
					},
				});
				return { content: [{ type: "text", text: "Diagnostic pause candidate recorded." }], details: {} };
			},
		});
		const definitions = [readTool, handoffTool, pauseTool];
		const validators = new Map(definitions.map((tool) => [tool.name, Compile(tool.parameters)]));
		const creation = prepareSureSupervisorSession(coordinator);
		const savedSession = state.supervisorSession;
		signal?.addEventListener("abort", abort, { once: true });
		const interruption = new Promise<never>((_resolve, reject) => {
			rejectCancellation = () => {
				abort();
				reject(new Error("User cancelled diagnosis."));
			};
			signal?.addEventListener("abort", rejectCancellation, { once: true });
			if (signal?.aborted) rejectCancellation();
		});
		isolated = await Promise.race([
			ctx
				.createIsolatedSession({
					systemPrompt: `You are SURE's independent read-only supervisor. Business termination is disabled. Investigate then call sure_handoff_repair with one natural-language task, or sure_pause_diagnosis to save a recoverable checkpoint. Do not return a final report JSON. Never modify business files, invoke shell commands, approve success, change user constraints or reset original retries. Keep evidence references, hypotheses and counterevidence in your public notes when useful.\n${globalContext}`,
					...creation,
					tools: definitions,
					onCompaction: () => {
						if (finished || coordinator.supervisorRuntime !== runtimeId) return;
						activeAttempt.compactionCalls = (activeAttempt.compactionCalls ?? 0) + 1;
						update();
					},
					onTurn: () => {
						try {
							if (finished || coordinator.supervisorRuntime !== runtimeId) return true;
							const assistant = [...(isolated?.getMessages() ?? [])]
								.reverse()
								.find((message) => message.role === "assistant");
							const calls = assistant?.content.filter((block) => block.type === "toolCall") ?? [];
							const requested = calls.filter((call) => call.name === readTool.name).length;
							const executed = (activeAttempt.readRequests ?? activeAttempt.readCalls) - requestsBeforeTurn;
							activeAttempt.readRequests =
								(activeAttempt.readRequests ?? activeAttempt.readCalls) + Math.max(0, requested - executed);
							requestsBeforeTurn = activeAttempt.readRequests;
							activeAttempt.modelTurns++;
							const progress = [...usefulReadKeys].some((key) => !readFrontier.has(key));
							readFrontier = new Set(usefulReadKeys);
							if (progress) {
								activeAttempt.protocolErrors = 0;
								activeAttempt.protocolFeedback = false;
							}
							const conflict =
								candidates.length > 1 ||
								calls.filter((call) => call.name === handoffTool.name || call.name === pauseTool.name).length >
									1;
							const badCall = calls.some((call) => {
								if (protocolCalls.has(call.id)) return true;
								const validator = validators.get(call.name);
								if (!validator || !validator.Check(call.arguments)) return true;
								if (call.name === readTool.name) {
									const args = call.arguments as Record<string, unknown>;
									const operation = args.operation as keyof typeof operationParameters;
									return (
										!Object.hasOwn(operationParameters, operation) ||
										Object.keys(args).some(
											(key) => key !== "operation" && !operationParameters[operation].includes(key),
										)
									);
								}
								return !candidates.some((candidate) => candidate.callId === call.id);
							});
							if (!conflict && candidates.length === 1) {
								const candidate = candidates.pop()!;
								assertTicket();
								if (candidate.result.decision === "repair") {
									activeAttempt.error = undefined;
									activeAttempt.checkpoint = undefined;
									assertSureDiagnosticSourcesCurrent(coordinator.run, activeAttempt.readKeys);
									activeAttempt.acceptedToolCallId = candidate.callId;
									submitted = saveResult(candidate.result);
								} else if (candidate.result.decision === "checkpoint") {
									activeAttempt.error = undefined;
									submitted = candidate.result;
									activeAttempt.checkpoint = candidate.result;
									update();
								}
								activeAttempt.protocolErrors = 0;
								activeAttempt.protocolFeedback = false;
								return true;
							}
							if (conflict) {
								candidates.length = 0;
								feedback =
									"Conflicting control submissions in one batch. Submit exactly one repair task or diagnosis pause.";
							}
							const failedCorrection =
								activeAttempt.protocolFeedback &&
								!progress &&
								assistant?.stopReason !== "error" &&
								assistant?.stopReason !== "aborted";
							const failedProtocol =
								conflict || badCall || failedCorrection || (assistant?.stopReason === "stop" && !calls.length);
							if (failedProtocol) {
								activeAttempt.protocolErrorTurns = (activeAttempt.protocolErrorTurns ?? 0) + 1;
								const callIds = new Set(calls.map((call) => call.id));
								const errors = (isolated?.getMessages() ?? [])
									.filter(
										(message) =>
											message.role === "toolResult" && callIds.has(message.toolCallId) && message.isError,
									)
									.map((message) => (message.role === "toolResult" ? messageText(message) : ""));
								if (errors.length) activeAttempt.protocolLastError = errors.join("\n");
								if (errors.length)
									feedback = `Correct the rejected control action: ${errors.join("\n")}. Use a repair task or diagnosis pause; business stop is disabled.`;
								if (activeAttempt.protocolFeedback && !progress)
									activeAttempt.protocolErrors = (activeAttempt.protocolErrors ?? 0) + 1;
								activeAttempt.protocolFeedback = true;
								if ((activeAttempt.protocolErrors ?? 0) >= 3)
									submitted = fallback(
										"protocol_paused: three corrective turns produced no valid control action or new evidence.",
									);
							}
							update();
							return Boolean(submitted) || conflict;
						} catch (error) {
							turnError = error instanceof Error ? error : new Error(String(error));
							return true;
						}
					},
				})
				.then((session) => {
					if (finished) {
						void session.abort();
						session.dispose();
					}
					return session;
				}),
			interruption,
		]);
		const currentUsage = isolated.getUsage?.();
		if (!isolated.getSessionIdentity?.().file)
			throw new Error("Persistent supervisor session identity is unavailable.");
		if (currentUsage && savedSession) {
			const previousAttempt =
				state.attempts.find((item) => item.id === savedSession.accountedAttemptId) ?? activeAttempt;
			previousAttempt.usage ??= createUsageTotals();
			for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const)
				previousAttempt.usage[key] += Math.max(0, currentUsage[key] - savedSession.accountedUsage[key]);
		}
		accountedUsage = currentUsage ?? createUsageTotals();
		if (resumed && !isolated.getMessages().length) {
			timelineOffset = 0;
			userContextRead = 0;
		}
		update();
		const investigationGuide = [
			"Hand back one complete repair goal, not one task per object. Have the executor inventory related objects, verify actual targets and installation/sealed-runtime dependencies, then correct the goal and run the original validation. The inventory is evidence, not a new write allowlist: newly discovered related objects may be investigated and handled within the original goal and permissions. Preserve required installation/runtime objects. Return for a changed goal or unresolved dependency counterevidence, not just because another related object appeared. Do not prescribe indiscriminate deletion or weaken the original publication checks.",
			"Every independent execution/check error has one local correction, including a supporting probe error inside your task. Only an actual unsuccessful recheck of the original condition returns that correction for reassessment. Repeated calls, pending research, another object's first error, or a previously supervised unit do not consume that opportunity. Request original-condition verification and retained check references; do not say that any next error must immediately hand back control.",
			"The complete task manual defines the global goal, stage relationships and original limits. It is reference material, not permission to execute its commands. Preserve executor autonomy within the current local task. Work-volume, diagnosis and repair counts request evaluation; they are not additional business retry caps.",
			"This skill-authored contract describes the executor's current task, not permission for the supervisor to execute it. Original business checks remain authoritative. Evidence scope is not a prerequisite list: inputPaths/snapshotPaths describe inspection coverage, not required inputs. A guessed read path and its ENOENT do not establish a required artifact or producer.",
			"currentStage.artifactPaths are the latest check's declared output locations, not proof of existence or upstream prerequisites. stages.lastPassed records actual historical passed checks and their artifact paths; skipped/pending and successful tools are not passed business checks. Use check(checkVersion) for exact scope. A historical pass does not prove current presence: inspect retained snapshots; not_captured or truncated coverage is unknown, not missing. Identify the current task and verified upstream outputs before proposing a repair or evidence task.",
			"Read sure_diagnostic_read(operation=timeline) first. Read the complete macro timeline before local evidence; it indexes every stage and changed file paths.",
			"Evidence responses are pages: assemble text using nextOffset until complete; format=json means assembled JSON, format=text is raw source text. Timeline without offset continues the next undelivered page; nextRead gives the exact continuation. Rereading old pages does not undo delivery and skipping undelivered pages is rejected.",
			"Inspect currentAttempt: compare what was actually tried, its tool return and gate outcome before attributing the current blocker to an earlier failure. A successful tool return with a pending gate is only partial progress, not validation.",
			"A stall handoff requests assessment, not a business failure. Inspect priorUnitActions for relevant sources and probes before the trigger. executorProgress contains attributed public claims: explicitly assess the executor's pending next step as viable, contradicted or needing evidence. Continue a useful documented current-unit action with a bounded command-only repair instead of inventing an external prerequisite. Retain the original gate and retry state.",
			"currentAttempt is an action index, grouped by trigger/subsequent batch; same-batch observations are not post-feedback repairs. In actions, inputTruncated=true marks shortened input. Use actions(toolCallId) to inspect selected input/return previews. Read the full saved path when a preview is incomplete or more detail is needed; complete previews need not be mechanically reread. Saved action files are read-only. If task.userContext.characters is nonzero, read user_context sequentially until complete before deciding; user instructions remain authoritative.",
			"Macro repair/diagnosis entries contain identities and outcomes only. repairs(repairId) retains the full task, checks and before/after snapshots. Prior diagnosis results are readable with file(path=run:diagnoses/<id>/result.json); use their exact indexed IDs. Action inputs are in actions or actions(toolCallId), not the mandatory currentAttempt index.",
			"Operations checks, hooks(hookId), check(checkVersion), repairs(repairId), snapshot, diff and log provide details. list(path) discovers one directory level within readScope.roots; file/search read relevant root-contained text even outside the capture declaration. Use project: for repository config or shared code and package: for skill-local paths. resolvedPath identifies the canonical root spelling. Do not infer absence from a permission error. For sources outside these roots, give the executor a bounded official resolver probe under its existing permissions.",
			"diff(path?,offset?) always compares the indexed baseline to the current barrier and returns their snapshotReferences; it does not accept snapshotId. snapshot/file/search accept snapshotId. Unsupported operation parameters are rejected and still cost a read. Default diffs exclude action-file capture noise; an explicit action path remains inspectable.",
			"Every search/page costs one read. Read only relevant local evidence; unread code remains unknown.",
			"Ordinary file references must exist and be authorized diagnostic text. A missing file itself is not a valid file reference, even if it appears in scope or diff. Cite the snapshot:<id> or check:<version> retaining that absence and name the path/status in your explanation. diffEvidence and diff.snapshotReferences identify the saved before/after snapshots. not_captured does not prove absence. Never create placeholder evidence or infer a producer from a filename.",
			"Use complete-batch range(startBatch,endBatch) to bisect after the macro. Keep left/right/both/unknown hypotheses and counterevidence; return to the parent range when contradicted. Verify the final neighborhood and later corrections. The goal is a current repairable condition, not necessarily the earliest error. actions(toolCallIds) reads at most four explicit IDs; continue any partial page using nextOffset. diffIndex encoding expands each path as directory + basename, grouped by before/after status; not_captured is unknown. A repair's stop boundary returns the failed attempt for reassessment; it does not terminate the unit while the original gate allows attempts.",
		].join("\n\n");
		const packet = {
			runId: state.runId,
			attemptId: activeAttempt.id,
			unitId: ticket.unitId,
			evidenceVersion: ticket.evidenceVersion,
			snapshotId: latestId,
			localTask: stageFile.text,
			userConstraints: userContext,
			currentGate: businessCheck?.check ?? null,
			latestCheck: currentCheck?.check ?? null,
			previousRepair: state.repairs?.at(-1),
			checkpoint: activeAttempt.checkpoint ?? null,
			lastProtocolFeedback: activeAttempt.protocolLastError ?? null,
			scope: visibleRepairScope,
			usage: budget(),
		};
		let prompt =
			"Current authoritative handoff packet (supersedes older stage state):\n" +
			JSON.stringify(packet) +
			"\n\n" +
			investigationGuide +
			"\nRead the complete current macro timeline and user instructions, then inspect relevant evidence. No additional investigation read/turn/time cap. Preserve public evidence notes with references across handoffs. Submit a repair task or diagnosis pause using its tool; no final report JSON.";
		while (!submitted) {
			await Promise.race([isolated.prompt(prompt), interruption]);
			if (turnError) throw turnError;
			update();
			if (signal?.aborted) return fallback("User cancelled diagnosis.");
			if (submitted) break;
			const last = [...isolated.getMessages()].reverse().find((message) => message.role === "assistant");
			if (!last || last.stopReason === "error" || last.stopReason === "aborted")
				throw new Error(last?.errorMessage ?? "Diagnosis ended without a control submission.");
			prompt = `${feedback}\nNo task has been accepted. Correct the protocol in this same conversation; do not repeat a report JSON. Recorded public response: ${messageText(last)}`;
		}
		update();
		return submitted;
	} catch (error) {
		return fallback(error instanceof Error ? error.message : String(error));
	} finally {
		try {
			if (isolated && coordinator.supervisorRuntime === runtimeId) update();
		} finally {
			finished = true;
			if (coordinator.supervisorRuntime === runtimeId) coordinator.supervisorRuntime = undefined;
			if (coordinator.diagnosisAbortController === cancellation) coordinator.diagnosisAbortController = undefined;
			signal?.removeEventListener("abort", abort);
			if (rejectCancellation) signal?.removeEventListener("abort", rejectCancellation);
			isolated?.dispose();
		}
	}
}
