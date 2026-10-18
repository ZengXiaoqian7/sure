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
import {
	isSureBusinessCheck,
	type SureDiagnosisCheckpoint,
	type SureDiagnosisOutcome,
	type SureDiagnosisResult,
	type SureStageDeclaration,
} from "./coordination-types.ts";
import type { SureCoordinator } from "./coordinator.ts";
import {
	loadSureCheckpointTimeline,
	loadSureDiagnosticIndex,
	packSureDiffIndex,
	pageSureDiagnosticValue,
	searchSureDiagnosticText,
	sureActionDetails,
	sureActionIndex,
	sureCurrentRepairAttempt,
	sureDiffIndex,
	sureSnapshotForPath,
} from "./diagnostic-view.ts";
import {
	assertSureDiagnosticSourcesCurrent,
	diffSureSnapshots,
	evidencePathName,
	readSureSnapshot,
	resolveSureDiagnosticPath,
	resolveSureEvidencePath,
	sureDiagnosticTextAllowed,
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
			if (attempt.result) return parseSureDiagnosisResult(attempt.result);
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
	let endActivity: (() => void) | undefined;
	let requestsBeforeTurn = activeAttempt.readRequests ?? activeAttempt.readCalls;
	const userContext = readSureUserContext(coordinator);
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
		reason += ` Diagnosis segment usage: model turns ${activeAttempt.modelTurns - turnsBefore}, reads ${activeAttempt.readCalls - readsBefore}.`;
		activeAttempt.error = reason;
		segment.error = reason;
		const checkpoint: SureDiagnosisCheckpoint = {
			runId: state.runId,
			unitId: state.unitId,
			evidenceVersion: state.evidenceVersion,
			decision: "checkpoint",
			checkpoint: reason,
			automatic: false,
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
	const protocolCalls = new Set<string>();
	const usefulReadKeys = new Set(activeAttempt.readKeys ?? []);
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
				return `<sure_global_task source=${JSON.stringify({ path: saved.path, sha256: saved.sha256 })}>\n${saved.text}\n</sure_global_task>`;
			})
			.join("\n\n");
		const index = loadSureDiagnosticIndex(coordinator);
		const currentCheck = index.checks.filter(({ check }) => check.unitId === state.unitId).at(-1);
		const businessCheck = index.checks
			.filter(({ check }) => check.unitId === state.unitId && isSureBusinessCheck(check))
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
			hints: scope.filter(
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
			hints: repairScope.hints.filter((value, index, paths) => {
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
					"Read relevant project and runtime source text, including absolute paths under existing filesystem permissions. Capture roots and snapshot coverage are not a live read whitelist. Sensitive files and binary payloads are excluded. Repair permissions remain separate.",
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
			checkpointTimeline: loadSureCheckpointTimeline(coordinator.run, index),
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
			previousDiagnoses: state.attempts
				.filter((attempt) => attempt.id !== activeAttempt.id)
				.map(({ id, unitId, evidenceVersion, result, error }) => ({
					id,
					unitId,
					evidenceVersion,
					decision: result?.decision,
					error: error ? true : undefined,
				})),
			repairs: (state.repairs ?? []).map(({ id, unitId, gateOutcome }) => ({ id, unitId, gateOutcome })),
			actionIndex: sureActionIndex(index.actions),
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
		const operationParameters = {
			timeline: ["offset"],
			actions: ["offset", "unitId", "toolCallId", "toolCallIds"],
			user_context: ["offset"],
			checks: ["offset", "unitId"],
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
				"Inspect relevant evidence as needed from the initial navigation and current failure. Use checkVersion for one exact check; actions/checks accept unitId to filter before paging. actions accepts one to four toolCallIds. snapshot/diff without path return indexes; with path they return saved content/diff. file/search read ONE TEXT FILE, not a directory; use list(path) first to discover filenames. search returns sourceOffset and line for file continuation. offset is a UTF-16 CHARACTER position, never a line number, check version or action index. Continue with the exact returned nextOffset. Text pages contain at most 2,000 lines or 50 KiB, without a total read allowance. Partial text is not complete inspection. No writes or process execution.",
			parameters: Type.Object({
				operation: StringEnum([
					"timeline",
					"actions",
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
				offset: Type.Optional(
					Type.Integer({
						minimum: 0,
						description:
							"UTF-16 character offset; use nextOffset or search.sourceOffset, not a line/check number.",
					}),
				),
				unitId: Type.Optional(Type.String({ minLength: 1 })),
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
				let value: unknown;
				const offset = params.offset ?? 0;
				let fileIdentity:
					| { path: string; source: "snapshot" | "file"; snapshotId?: string; sha256: string }
					| undefined;
				if (params.operation === "timeline") {
					value = timeline;
				} else if (params.operation === "actions") {
					const actions = params.unitId
						? index.actions.filter(
								(action) => action.unitId === params.unitId || action.checkUnitId === params.unitId,
							)
						: index.actions;
					if (params.toolCallIds) {
						if (
							params.toolCallId ||
							params.toolCallIds.length < 1 ||
							params.toolCallIds.length > 4 ||
							new Set(params.toolCallIds).size !== params.toolCallIds.length
						)
							throw new Error("Use one to four unique action IDs, without toolCallId.");
						value = params.toolCallIds.map((id) => {
							const action = actions.find((action) => action.toolCallId === id);
							if (!action) throw new Error("Unknown tool action identity.");
							return sureActionDetails(action);
						});
					} else if (params.toolCallId) {
						const action = actions.find((action) => action.toolCallId === params.toolCallId);
						if (!action) throw new Error("Unknown tool action identity.");
						value = sureActionDetails(action);
					} else value = sureActionIndex(actions);
				} else if (params.operation === "user_context") {
					value = userContext;
				} else if (params.operation === "checks") {
					value = index.checks
						.filter(({ check }) => !params.unitId || check.unitId === params.unitId)
						.map(({ version, check, snapshotId, timestamp, repairId }) => ({
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
					const path = resolveSureDiagnosticPath(coordinator.run, params.path);
					if (!sureDiagnosticTextAllowed(path)) throw new Error("Directory is excluded diagnostic evidence.");
					if (!statSync(path).isDirectory()) throw new Error("Diagnostic listing requires a directory.");
					value = {
						path: evidencePathName(coordinator.run, path),
						source: "directory",
						entries: readdirSync(path)
							.sort()
							.flatMap((name) => {
								const child = resolveSureDiagnosticPath(coordinator.run, join(path, name));
								if (!sureDiagnosticTextAllowed(child)) return [];
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
					const path = resolveSureDiagnosticPath(coordinator.run, params.path);
					if (!sureDiagnosticTextAllowed(path))
						throw new Error("This file is identity-only or excluded evidence.");
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
						if (!statSync(path).isFile())
							throw new Error(
								"file/search requires one text file. Use list(path) to discover directory entries, then read or search a file.",
							);
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
				const page = pageSureDiagnosticValue(value, offset);
				const response = {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								...page,
								...fileIdentity,
								...(fileIdentity
									? {
											resolvedPath: evidencePathName(
												coordinator.run,
												resolveSureDiagnosticPath(coordinator.run, fileIdentity.path),
											),
										}
									: {}),
								budget: budget(),
							}),
						},
					],
					details: { operation: params.operation, budget: budget() },
				};
				const readIdentity = {
					...params,
					offset,
					...(fileIdentity
						? {
								path: resolveSureDiagnosticPath(coordinator.run, fileIdentity.path),
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
			"Use sure_handoff_repair for a corrective task, sure_continue_execution for the existing plan, or sure_pause_diagnosis. Business stop is disabled.";
		let readFrontier = new Set(usefulReadKeys);
		const handoffTool = defineTool({
			name: "sure_handoff_repair",
			label: "Hand a repair task to the executor",
			description:
				"Submit one complete natural-language task. Include any required probe, correction and validation in this complete goal; the executor does not return results for supervisor approval. The original gate remains authoritative. Optional focusPaths are suggestions, not write restrictions.",
			parameters: Type.Object(
				{
					task: Type.String({ minLength: 1, maxLength: 32_000, pattern: "\\S" }),
					focusPaths: Type.Optional(
						Type.Array(Type.String({ minLength: 1, maxLength: 32_000 }), { minItems: 1, maxItems: 256 }),
					),
				},
				{ additionalProperties: false },
			),
			execute: async (callId, params) => {
				assertTicket();
				assertSureDiagnosticSourcesCurrent(coordinator.run, activeAttempt.readKeys);
				for (const target of params.focusPaths ?? []) {
					const path = resolveSureEvidencePath(coordinator.run, target);
					if (!path || !sureEvidenceTextAllowed(path) || isDeclared(path, repairScope.readOnly))
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
						"Continue clear local corrections. The harness investigates later actual failures linked to the same unresolved condition; independent or uncertain errors are not automatically related. A passed original gate does not require routine reassessment. Supporting probes belong to the complete correction; there is no evidence-return or approval workflow. Supervisor business stop is disabled.",
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
				"Save a resumable diagnostic checkpoint only when the investigation itself cannot proceed, for user recovery. Missing evidence in the initial packet requires autonomous investigation. Do not dispatch executor work or request results for later approval. Does not terminate the business task or consume gate retries.",
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
					},
				});
				return { content: [{ type: "text", text: "Diagnostic pause candidate recorded." }], details: {} };
			},
		});
		const continueTool = defineTool({
			name: "sure_continue_execution",
			label: "Continue the executor's existing plan",
			description:
				"Return execution to the unchanged current task with concrete guidance, without inventing a correction.",
			parameters: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 4000, pattern: "\\S" }) }),
			execute: async (callId, params) => {
				assertTicket();
				assertSureDiagnosticSourcesCurrent(coordinator.run, activeAttempt.readKeys);
				candidates.push({
					callId,
					result: {
						runId: state.runId,
						unitId: ticket.unitId,
						evidenceVersion: ticket.evidenceVersion,
						decision: "continue",
						reason: params.reason,
						facts: [],
						hypotheses: [],
						unknowns: [],
						nextActions: [],
						evidenceReferences: latestId ? [`snapshot:${latestId}`] : [],
					},
				});
				return { content: [{ type: "text", text: "Continue candidate recorded." }], details: {} };
			},
		});
		const definitions = [readTool, handoffTool, pauseTool, continueTool];
		const showActivity = (event: Parameters<NonNullable<typeof ctx.ui.showAgentActivity>>[0]["event"]) => {
			if (finished || coordinator.supervisorRuntime !== runtimeId) return;
			try {
				if (event.type === "end") assertRuntime();
				else assertTicket();
				ctx.ui.showAgentActivity?.({
					role: "supervisor",
					runId: state.runId,
					attemptId: activeAttempt.id,
					runtimeId,
					event,
					tool: "toolName" in event ? definitions.find((tool) => tool.name === event.toolName) : undefined,
				});
			} catch {
				// Display failures and stale callbacks must not affect investigation control.
			}
		};
		showActivity({ type: "start" });
		endActivity = () => showActivity({ type: "end" });
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
					systemPrompt: `You are SURE's independent read-only debugger. Investigate relevant state, code and evidence using your tools. Hand back a complete corrective task, continue the existing executor plan, or pause with a recoverable reason. Do not return a final report JSON. Never modify business files, invoke shell commands, approve success, change user constraints or reset original retries. Keep evidence references, hypotheses and counterevidence in your public notes when useful.\n${globalContext}`,
					...creation,
					tools: definitions,
					onActivity: showActivity,
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
								calls.filter((call) =>
									[handoffTool.name, pauseTool.name, continueTool.name].includes(call.name),
								).length > 1;
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
								if (candidate.result.decision !== "checkpoint") {
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
									"Conflicting control submissions in one batch. Submit exactly one task, continue, or diagnosis pause.";
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
		update();
		const investigationGuide = [
			"timeline provides checkpointTimeline: recorded applied checkpoint changes, not inferred tool progress or a replayable filesystem. Field values are short previews; use log with logOffset/previousLogOffset for complete recorded states, hooks with hookId for the selected patch source, and check with checkVersion for its observed snapshot. Null links and unreadableOffsets are unknown; never infer causality from nearby timestamps. Snapshot coverage does not guarantee all artifacts from that point were retained, and live files are not historical versions.",
			"Investigate one complete current condition, not one task per object. Read global instructions, current task, user constraints and actual actions together. Preserve executor autonomy and necessary installation/runtime objects; focusPaths are hints, never a new write allowlist. Work-volume and repair counts are observations, not new business retry caps.",
			"The original business checks remain authoritative. Evidence scope is not a prerequisite list: inputPaths/snapshotPaths describe inspection coverage, not required inputs. A guessed read path and its ENOENT do not establish a required artifact or producer. A successful tool result is not a passed gate; a historical pass does not prove current file presence. not_captured or truncated coverage is unknown, not missing.",
			"The initial packet supplies the current failure, correction and navigation entry points. Use actions/checks with unitId or exact identities for relevant details; timeline retains the complete whole-run stage/action/checkpoint indexes. Use hooks/repairs for details and file/search/list to inspect relevant project or runtime sources, including absolute paths. Runtime dependency source text is readable; secrets, weights and binary payloads are excluded. No shell or process execution is available. If a real probe is needed, include it with the resulting corrective steps and original validation in one complete guidance task. Do not ask the executor to collect results and return for approval.",
			"Evidence responses are pages: assemble text using explicit nextOffset until complete when full inspection matters. format=json means assembled JSON; format=text is raw source text. Search offsets use the same character units as file reads. No mandatory navigation reread or binary-search procedure applies. Clear local corrections remain with the executor. Distinguish the same unresolved condition from independent new failures and unknown relationships; a shared unit or changed wording alone proves neither recurrence nor progress. Same-batch results are not post-feedback corrections.",
			"Inspect what the executor actually tried and its current intended next step before attributing the blocker to an earlier failure. Account for recorded side effects of abandoned repair routes, including dependency/lock/runtime mismatches; do not narrow a complete goal to one file when other existing changes need correction. Request a repair only when evidence supports changing the action. Use sure_continue_execution with concrete guidance when the existing plan remains viable; it creates no repair. Missing initial evidence requires autonomous reads; necessary real probes belong in complete corrective guidance, never an evidence-return task. Use the original artifact/gate dispatch route for validation; do not prescribe a redundant manual full validation when the original hook will execute it. A probe never replaces that gate. Use sure_pause_diagnosis only when the investigation itself cannot proceed and needs user recovery. Only the original business lifecycle can end the task.",
			"Snapshot reads preserve historical versions. Uncaptured live files are labeled with their source and hash; changed live sources invalidate a pending conclusion. A missing file itself is not a valid file reference: cite the check or snapshot that records its absence. diff compares the recorded baseline and current snapshot; use snapshotId for another saved version. Public notes should distinguish facts, hypotheses and counterevidence. Do not infer absence from a permission error.",
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
			currentFailure: state.lastFailure ?? null,
			failureCheckVersion: state.lastFailureCheckVersion ?? null,
			latestCheck: currentCheck?.check ?? null,
			previousRepair: state.repairs?.filter((repair) => repair.unitId === ticket.unitId).at(-1),
			checkpoint: activeAttempt.checkpoint ?? null,
			currentAttempt,
			navigation: {
				task: timeline.task,
				currentStage: timeline.currentStage,
				executorProgress: timeline.executorProgress,
				baseline: timeline.baseline,
				captureCoverage: timeline.captureCoverage,
				diffEvidence,
				checkIndex: timeline.checkIndex,
				hookIndex: timeline.hookIndex,
				actionIndex: { count: index.actions.length, operation: "actions", unitId: ticket.unitId },
				checkpointTimeline: { source: "run:events.jsonl", operation: "timeline" },
				repairDetails: timeline.repairDetails,
				instruction:
					"Current condition and correction actions are supplied above. Full whole-run stages, action identities, applied checkpoint transitions and previous diagnoses remain available through timeline; read them when relevant, without substituting live files for historical evidence.",
			},
			lastProtocolFeedback: activeAttempt.protocolLastError ?? null,
			scope: visibleRepairScope,
			usage: budget(),
		};
		let prompt =
			"Current authoritative handoff packet (supersedes older stage state):\n" +
			JSON.stringify(packet) +
			"\n\n" +
			investigationGuide +
			"\nInvestigate relevant evidence using your tools; the navigation is an index, not a root-cause conclusion. No additional investigation read/turn/time cap. Preserve public evidence notes with references across handoffs. Submit one task, continue, or diagnosis pause using its tool; no final report JSON.";
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
			endActivity?.();
			finished = true;
			if (coordinator.supervisorRuntime === runtimeId) coordinator.supervisorRuntime = undefined;
			if (coordinator.diagnosisAbortController === cancellation) coordinator.diagnosisAbortController = undefined;
			signal?.removeEventListener("abort", abort);
			if (rejectCancellation) signal?.removeEventListener("abort", rejectCancellation);
			isolated?.dispose();
		}
	}
}
