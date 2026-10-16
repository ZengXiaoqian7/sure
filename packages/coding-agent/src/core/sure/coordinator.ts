import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { allowsSureDirectRepair, parseSureDiagnosisResult } from "./coordination-contracts.ts";
import {
	SURE_COORDINATION_LIMITS,
	type SureCheckEvidence,
	type SureCoordinationLimits,
	type SureCoordinationState,
	type SureDiagnosisResult,
	type SureUnitBudget,
} from "./coordination-types.ts";
import {
	assertSureDiagnosticSourcesCurrent,
	captureSureSnapshot,
	readSureSnapshot,
	resolveSureEvidencePath,
	type SureSnapshot,
	sureHash,
	writeSureJson,
} from "./evidence.ts";
import type { SureRunRecord } from "./types.ts";

/** All state changes publish atomically before the executor is allowed to move on. */
export class SureCoordinator {
	readonly run: SureRunRecord;
	readonly limits: SureCoordinationLimits;
	state: SureCoordinationState;
	/** The active invocation supplies the cross-process ownership check. */
	assertOwner?: () => void;
	supervisorRuntime?: string;
	diagnosisAbortController?: AbortController;

	constructor(
		run: SureRunRecord,
		unitId: string,
		scope: string[],
		budgets: Partial<SureCoordinationLimits> = {},
		assertOwner?: () => void,
	) {
		this.assertOwner = assertOwner;
		this.assertOwner?.();
		this.run = run;
		const invocationPath = join(run.runDir, "evidence/invocation.json");
		if (!existsSync(invocationPath)) {
			const { runId, command, args, cwd, packageDir, runDir } = run;
			writeSureJson(invocationPath, { runId, command, args, cwd, packageDir, runDir });
		}
		const path = join(run.runDir, "coordination.json");
		if (existsSync(path)) {
			const state = JSON.parse(readFileSync(path, "utf8")) as SureCoordinationState;
			if (
				state.version !== 1 ||
				state.runId !== run.runId ||
				!["executing", "yielding", "diagnosing", "stopped"].includes(state.status) ||
				!state.units ||
				typeof state.units !== "object" ||
				Array.isArray(state.units) ||
				!Array.isArray(state.attempts) ||
				!Number.isSafeInteger(state.evidenceVersion) ||
				state.evidenceVersion < 0 ||
				(state.finishNudges !== undefined &&
					(!Number.isSafeInteger(state.finishNudges) || state.finishNudges < 0)) ||
				Object.values(state.units).some(
					(budget) =>
						!budget ||
						(budget.calls !== undefined && !Number.isSafeInteger(budget.calls)) ||
						(budget.directRepairStalledBatches !== undefined &&
							(!Number.isSafeInteger(budget.directRepairStalledBatches) ||
								budget.directRepairStalledBatches < 0)) ||
						(budget.directRepairProgressSinceBatch !== undefined &&
							typeof budget.directRepairProgressSinceBatch !== "boolean") ||
						(budget.directRepairLastBatchId !== undefined &&
							typeof budget.directRepairLastBatchId !== "string") ||
						[
							budget.checks,
							budget.noProgress,
							budget.directRepairs ?? budget.formatRepairs ?? 0,
							budget.supervisorRepairs,
							budget.calls ?? 0,
						].some((value) => !Number.isSafeInteger(value) || value < 0),
				) ||
				state.attempts.some(
					(attempt) =>
						!attempt ||
						!Number.isFinite(Date.parse(attempt.startedAt)) ||
						[attempt.evidenceVersion, attempt.modelTurns, attempt.readCalls, attempt.elapsedMs].some(
							(value) => !Number.isSafeInteger(value) || value < 0,
						),
				)
			)
				throw new Error(`Invalid Sure coordination state: ${path}`);
			this.state = state;
			const lastAttempt = state.attempts.at(-1);
			const needsStopReview =
				state.status === "stopped" &&
				!state.cancelled &&
				state.lastCheck?.outcome !== "exhausted" &&
				lastAttempt?.result?.decision === "stop" &&
				!lastAttempt.stopValidated;
			if (needsStopReview) {
				state.status = "yielding";
				state.yieldReason = "The previous stop lacks the current evidence assessment; reassess before continuing.";
				state.stopReason = undefined;
			}
			// Retain storage/routing settings, but retire the extra investigation caps
			// in old runs as well. Usage and original gate retries remain untouched.
			this.limits = Object.fromEntries(
				Object.entries(SURE_COORDINATION_LIMITS).map(([key, value]) => [
					key,
					state.limits?.[key as keyof SureCoordinationLimits] ?? value,
				]),
			) as SureCoordinationLimits;
			const needsLimits = JSON.stringify(state.limits) !== JSON.stringify(this.limits);
			state.limits = this.limits;
			state.repairs ??= [];
			const needsDirectBudget = Object.values(state.units).some((budget) => budget.directRepairs === undefined);
			const needsDirectRepairBatchState = Object.values(state.units).some(
				(budget) =>
					budget.directRepairStalledBatches === undefined || budget.directRepairProgressSinceBatch === undefined,
			);
			for (const budget of Object.values(state.units)) {
				budget.directRepairs ??= budget.formatRepairs ?? 0;
				budget.directRepairStalledBatches ??= 0;
				budget.directRepairProgressSinceBatch ??= false;
				delete budget.formatRepairs;
			}
			if (state.unitId !== unitId) {
				state.unitId = unitId;
				state.unitLabel = undefined;
				state.evidenceVersion++;
				this.invalidateRepair("The active unit changed.");
				if (state.status === "diagnosing" || state.status === "yielding") state.status = "yielding";
				this.save();
			} else if (needsLimits || needsDirectBudget || needsDirectRepairBatchState || needsStopReview) this.save();
		} else {
			this.limits = { ...SURE_COORDINATION_LIMITS, ...budgets };
			const snapshot = captureSureSnapshot(run, unitId, "initial", scope, this.limits);
			this.state = {
				version: 1,
				runId: run.runId,
				status: "executing",
				unitId,
				evidenceVersion: 0,
				updatedAt: new Date().toISOString(),
				units: {},
				attempts: [],
				repairs: [],
				limits: this.limits,
				initialSnapshot: snapshot.id,
				latestSnapshot: snapshot.id,
			};
			this.save();
		}
	}

	private remainingBudget(unitId: string) {
		const budget = this.budget(unitId);
		return {
			kind: "review_thresholds" as const,
			calls: Math.max(0, this.limits.checksPerUnit - (budget.calls ?? 0)),
			checks: Math.max(0, this.limits.checksPerUnit - budget.checks),
			supervisorRepairs: Math.max(0, this.limits.supervisorRepairsPerUnit - budget.supervisorRepairs),
		};
	}

	invalidateRepair(reason: string): void {
		for (const repair of this.state.repairs ?? []) {
			if (repair.id === this.state.pendingRepair?.id) {
				repair.outcome = "invalidated";
				repair.stopReason = reason;
			}
		}
		this.state.pendingRepair = undefined;
		this.state.pendingDirectRepairId = this.directRepair?.id;
		this.resetDirectRepairBatchState(this.state.unitId);
	}

	private resetDirectRepairBatchState(unitId: string): void {
		const budget = this.budget(unitId);
		budget.directRepairStalledBatches = 0;
		budget.directRepairProgressSinceBatch = false;
		budget.directRepairLastBatchId = undefined;
	}

	get directRepair() {
		return this.directRepairs.at(-1);
	}

	get directRepairs() {
		return (this.state.repairs ?? []).filter(
			(repair) =>
				repair.source === "executor" &&
				repair.unitId === this.state.unitId &&
				repair.verificationCheckVersion === undefined &&
				!repair.stopReason &&
				repair.outcome !== "passed" &&
				repair.outcome !== "skipped" &&
				repair.outcome !== "invalidated" &&
				repair.outcome !== "stopped",
		);
	}

	private checkAt(version: number): SureCheckEvidence {
		if (!Number.isSafeInteger(version) || version < 1) throw new Error("Invalid repair check version.");
		return JSON.parse(readFileSync(join(this.run.runDir, "evidence", `${version}.json`), "utf8")).check;
	}

	/** Link intent to a retained result; a model statement never supplies the result itself. */
	verifyRepair(repairId: string, checkVersion: number, relation: "recheck" | "independent" | "related"): void {
		this.assertOwner?.();
		if (this.isStopped) throw new Error("Cannot verify a stopped or cancelled repair.");
		const repair = this.state.repairs?.find((repair) => repair.id === repairId);
		if (
			!repair ||
			repair.unitId !== this.state.unitId ||
			repair.triggerCheckVersion === undefined ||
			repair.outcome === "invalidated" ||
			repair.outcome === "stopped"
		)
			throw new Error("Unknown current repair source.");
		const check = this.checkAt(checkVersion);
		if (
			checkVersion > this.state.evidenceVersion ||
			check.unitId !== repair.unitId ||
			checkVersion <= repair.triggerCheckVersion ||
			(check.action?.batchId !== undefined && check.action.batchId === repair.triggerBatchId)
		)
			throw new Error("Verification must follow the original failure feedback, outside its trigger batch.");
		if (relation !== "recheck") {
			if (check.outcome !== "blocked") throw new Error("A new error requires an actual blocked check.");
			const existing = this.state.repairs?.find(
				(item) => item.source === "executor" && item.triggerCheckVersion === checkVersion,
			);
			if (existing?.parentRepairId && (existing.parentRepairId !== repair.id || existing.relation !== relation))
				throw new Error("This check already has a different correction association.");
			this.openDirectRepair(check, checkVersion, repair.id);
			const independent = this.state.repairs!.find(
				(item) => item.triggerCheckVersion === checkVersion && item.source === "executor",
			)!;
			independent.parentRepairId = repair.id;
			independent.relation = relation;
		} else {
			if (repair.verificationCheckVersion !== undefined) {
				if (repair.verificationCheckVersion === checkVersion) return;
				throw new Error("This repair already has a verification result.");
			}
			let outcome = check.outcome;
			const original = this.checkAt(repair.triggerCheckVersion);
			if (original.failureKind === "tool") {
				if (!check.action) throw new Error("A tool correction requires a retained returned tool observation.");
				const observation = JSON.parse(
					readFileSync(resolveSureEvidencePath(this.run, check.action.path) ?? "", "utf8"),
				);
				if (observation.execution !== "returned" || observation.duringHold)
					throw new Error("Skipped or held tools cannot verify a correction.");
				outcome = observation.isError ? "blocked" : "passed";
			} else {
				if (original.sourceId !== check.sourceId || original.checker !== check.checker)
					throw new Error("A business correction requires its original checker, not an unrelated tool/check.");
				if (outcome !== "passed" && outcome !== "blocked" && outcome !== "exhausted" && outcome !== "skipped")
					throw new Error("Pending or unchanged evidence is not an original-condition verification.");
			}
			repair.verificationCheckVersion = checkVersion;
			repair.checkVersions = [...new Set([...repair.checkVersions, checkVersion])];
			repair.outcome = outcome;
			repair.remainingBlocker = outcome === "passed" || outcome === "skipped" ? undefined : check.summary;
			if (outcome === "blocked" || outcome === "exhausted") {
				this.state.status = "yielding";
				this.state.yieldReason = `Original condition still failed after correction (${repair.id}, check:${checkVersion}): ${check.summary}`;
			}
		}
		const evidencePath = join(this.run.runDir, "evidence", `${checkVersion}.json`);
		writeSureJson(evidencePath, {
			...JSON.parse(readFileSync(evidencePath, "utf8")),
			repairId: relation === "recheck" ? repair.id : `direct:${check.unitId}:${checkVersion}`,
		});
		this.state.pendingDirectRepairId = this.directRepair?.id;
		this.save();
	}

	private openDirectRepair(check: SureCheckEvidence, version: number, parentRepairId?: string): void {
		this.state.repairs ??= [];
		const id = `direct:${check.unitId}:${version}`;
		if (this.state.repairs.some((repair) => repair.id === id)) return;
		this.budget(check.unitId).directRepairs++;
		this.state.repairs.push({
			id,
			source: "executor",
			unitId: check.unitId,
			parentRepairId,
			task: check.repair ?? "Inspect the actual feedback, correct this error, and verify the original condition.",
			acceptedAt: new Date().toISOString(),
			triggerCheckVersion: version,
			triggerBatchId: check.action?.batchId,
			beforeSnapshotId: this.state.latestSnapshot,
			checkVersions: [version],
			outcome: "blocked",
			remainingBlocker: check.summary,
			remainingBudget: this.remainingBudget(check.unitId),
		});
		this.state.pendingDirectRepairId = id;
	}

	private budget(unitId: string): SureUnitBudget {
		if (!Object.hasOwn(this.state.units, unitId))
			Object.defineProperty(this.state.units, unitId, {
				value: { checks: 0, noProgress: 0, directRepairs: 0, supervisorRepairs: 0 },
				enumerable: true,
				writable: true,
				configurable: true,
			});
		return this.state.units[unitId];
	}

	save(): void {
		this.assertOwner?.();
		this.state.updatedAt = new Date().toISOString();
		writeSureJson(join(this.run.runDir, "coordination.json"), this.state);
	}

	recordAction(unitId: string, toolName: string, input: unknown): void {
		this.assertOwner?.();
		if (
			(this.state.pendingRepair && this.state.pendingRepair.result.unitId !== unitId) ||
			(this.directRepair && this.directRepair.unitId !== unitId)
		)
			this.invalidateRepair("The executor moved to another unit.");
		const budget = this.budget(unitId);
		budget.calls = (budget.calls ?? 0) + 1;
		budget.actions ??= {};
		const action = sureHash(JSON.stringify({ toolName, input }));
		budget.actions[action] = (budget.actions[action] ?? 0) + 1;
		this.state.unitId = unitId;
		if (budget.calls % this.limits.checksPerUnit === 0 && !this.directRepair && !this.state.pendingRepair) {
			this.state.status = "yielding";
			this.state.yieldReason = "Executor work-volume threshold reached; assess progress and the next useful action.";
			this.state.evidenceVersion++;
		}
		this.save();
	}

	recordToolBatch(unitId: string, batchId: string): void {
		this.assertOwner?.();
		const repair = this.directRepair;
		if (this.state.status !== "executing" || repair?.unitId !== unitId) return;
		const budget = this.budget(unitId);
		if (budget.directRepairLastBatchId === batchId) return;
		budget.directRepairLastBatchId = batchId;
		if (batchId === repair.triggerBatchId) {
			budget.directRepairStalledBatches = 0;
			budget.directRepairProgressSinceBatch = false;
			this.save();
			return;
		}
		if (budget.directRepairProgressSinceBatch) budget.directRepairStalledBatches = 0;
		else budget.directRepairStalledBatches = (budget.directRepairStalledBatches ?? 0) + 1;
		budget.directRepairProgressSinceBatch = false;
		this.save();
	}

	observe(check: SureCheckEvidence, scope: string[], directCorrection = true): SureSnapshot {
		this.assertOwner?.();
		const eventKey = check.action
			? JSON.stringify([check.unitId, check.action.toolCallId, check.sourceId ?? check.checker])
			: check.checkId
				? JSON.stringify([check.unitId, null, check.checkId])
				: undefined;
		const observed = eventKey ? this.state.observedToolChecks?.[eventKey] : undefined;
		if (observed) return readSureSnapshot(this.run, observed);
		const snapshot = captureSureSnapshot(
			this.run,
			check.unitId,
			check.outcome === "passed" ? "passed" : "failed",
			scope,
			this.limits,
		);
		const budget = this.budget(check.unitId);
		budget.checks++;
		const fingerprint = sureHash(
			JSON.stringify({
				snapshot: snapshot.fingerprint,
				outcome: check.outcome,
				kind: check.failureKind,
				checker: check.checker,
			}),
		);
		// Only a skill-verified increase with changed declared evidence clears the
		// soft stall counter. Wording, new reads and arbitrary file changes do not.
		const inputs = [...check.inputPaths, ...check.artifactPaths]
			.map((path) => resolveSureEvidencePath(this.run, path))
			.filter((path) => path !== undefined);
		const relevant = snapshot.files.filter((file) => {
			const path = resolveSureEvidencePath(this.run, file.path);
			return (
				path &&
				inputs.some((input) => {
					const rel = relative(input, path);
					return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
				})
			);
		});
		const inputFingerprint = sureHash(
			JSON.stringify(relevant.map(({ path, status, sha256 }) => ({ path, status, sha256 }))),
		);
		const previousProgress = budget.progress;
		let verifiedProgress = false;
		if (check.progress && (!previousProgress || check.progress.key === previousProgress.key)) {
			if (
				previousProgress &&
				check.progress.completed > previousProgress.completed &&
				previousProgress.inputFingerprint !== inputFingerprint &&
				relevant.some((file) => file.status === "text")
			) {
				budget.noProgress = 0;
				budget.actions = {};
				verifiedProgress = true;
			}
			if (!previousProgress || check.progress.completed > previousProgress.completed)
				budget.progress = { ...check.progress, inputFingerprint };
		}
		if (verifiedProgress && this.directRepair?.unitId === check.unitId) {
			budget.directRepairStalledBatches = 0;
			budget.directRepairProgressSinceBatch = true;
		}
		if (check.outcome === "blocked" || check.outcome === "exhausted") budget.noProgress++;
		budget.lastFingerprint = fingerprint;
		this.state.unitId = check.unitId;
		this.state.latestSnapshot = snapshot.id;
		this.state.lastCheck = check;
		if ((check.outcome === "blocked" || check.outcome === "exhausted") && check.failureKind !== "no_progress") {
			this.state.originalFailure ??= check;
			this.state.lastFailure = check;
		}
		this.state.evidenceVersion++;
		const version = this.state.evidenceVersion;
		this.state.lastCheckVersion = version;
		if (check.outcome === "blocked" || check.outcome === "exhausted") this.state.lastFailureCheckVersion = version;
		const pending = this.state.repairs?.find((repair) => repair.id === this.state.pendingRepair?.id);
		const candidates = [...this.directRepairs, ...(pending ? [pending] : [])];
		const repair = [...candidates].reverse().find((repair) => {
			if (repair.triggerCheckVersion === undefined || repair.verificationCheckVersion !== undefined) return false;
			const source = this.checkAt(repair.triggerCheckVersion);
			return (
				source.unitId === check.unitId &&
				source.sourceId === check.sourceId &&
				source.checker === check.checker &&
				(source.failureKind === "tool") === (check.failureKind === "tool") &&
				source.action?.toolName === check.action?.toolName &&
				JSON.stringify([...source.artifactPaths].sort()) === JSON.stringify([...check.artifactPaths].sort()) &&
				!(check.action?.batchId && check.action.batchId === repair.triggerBatchId)
			);
		});
		if (repair) {
			repair.checkVersions.push(version);
			repair.afterSnapshotId = snapshot.id;
			repair.remainingBudget = this.remainingBudget(check.unitId);
		}
		if (
			(this.state.status === "executing" || this.state.status === "yielding") &&
			directCorrection &&
			allowsSureDirectRepair(check) &&
			!repair
		)
			this.openDirectRepair(check, version);
		if (!directCorrection && this.state.status === "executing" && check.outcome === "blocked") {
			this.state.status = "yielding";
			this.state.yieldReason = check.summary;
		}
		writeSureJson(join(this.run.runDir, "evidence", `${version}.json`), {
			check,
			repairId:
				repair?.id ??
				(check.outcome === "passed" || check.outcome === "skipped"
					? pending?.id
					: check.outcome === "blocked"
						? this.directRepair?.id
						: undefined),
			snapshotId: snapshot.id,
			timestamp: new Date().toISOString(),
		});
		if (check.outcome === "exhausted") {
			this.stop("Existing gate retry budget exhausted.");
		} else if (check.outcome === "passed" || check.outcome === "skipped") {
			// A passed unit settles its corrections; successful supporting tools do not.
			for (const completed of candidates) {
				if (completed.unitId !== check.unitId) continue;
				completed.checkVersions = [...new Set([...completed.checkVersions, version])];
				completed.verificationCheckVersion = version;
				completed.afterSnapshotId = snapshot.id;
				completed.outcome = check.outcome;
				completed.remainingBlocker = undefined;
				completed.remainingBudget = this.remainingBudget(check.unitId);
			}
			this.state.pendingRepair = undefined;
			this.state.pendingDirectRepairId = this.directRepair?.id;
			this.resetDirectRepairBatchState(check.unitId);
			if (check.outcome === "passed") {
				this.state.lastSuccessSnapshot = snapshot.id;
				this.state.lastSuccessUnit = check.unitId;
			}
		} else if (repair && check.outcome === "blocked") {
			const source = this.checkAt(repair.triggerCheckVersion!);
			// Unstructured changes are ambiguous, not proof of a new error or a failed recheck.
			// Explicit association through sure_update_state covers corrected calls and new objects.
			let sameAction =
				!source.action && !check.action && source.checkId !== undefined && check.checkId !== undefined;
			if (source.action && check.action) {
				const before = resolveSureEvidencePath(this.run, source.action.path);
				const after = resolveSureEvidencePath(this.run, check.action.path);
				if (before && after && existsSync(before) && existsSync(after)) {
					const original = JSON.parse(readFileSync(before, "utf8"));
					const current = JSON.parse(readFileSync(after, "utf8"));
					sameAction = JSON.stringify(original.input) === JSON.stringify(current.input);
				}
			}
			if (sameAction && source.failureKind === check.failureKind && source.summary === check.summary)
				this.verifyRepair(repair.id, version, "recheck");
		}
		if (
			this.state.status === "executing" &&
			check.outcome !== "passed" &&
			check.outcome !== "skipped" &&
			budget.checks % this.limits.checksPerUnit === 0 &&
			!this.directRepair &&
			!this.state.pendingRepair
		) {
			this.state.status = "yielding";
			this.state.yieldReason = "Check-volume threshold reached; assess the current work before continuing.";
		}
		if (eventKey) {
			this.state.observedToolChecks ??= {};
			this.state.observedToolChecks[eventKey] = snapshot.id;
		}
		this.save();
		return snapshot;
	}

	/** Called only after the whole tool batch has settled. */
	barrier(scope: string[]): SureSnapshot {
		this.assertOwner?.();
		const snapshot = captureSureSnapshot(this.run, this.state.unitId, "barrier", scope, this.limits);
		if (this.state.latestSnapshot) {
			const previous = JSON.parse(
				readFileSync(join(this.run.runDir, "snapshots", `${this.state.latestSnapshot}.json`), "utf8"),
			) as SureSnapshot;
			if (previous.fingerprint !== snapshot.fingerprint) this.state.evidenceVersion++;
		}
		this.state.latestSnapshot = snapshot.id;
		this.save();
		return snapshot;
	}

	acceptDiagnosis(value: unknown): boolean {
		this.assertOwner?.();
		if (this.isStopped) return false;
		if (value && typeof value === "object" && "decision" in value && value.decision === "checkpoint") return false;
		// Supervisor business termination is disabled; retain parsing for historical evidence only.
		if (value && typeof value === "object" && "decision" in value && value.decision === "stop") return false;
		const result = parseSureDiagnosisResult(value);
		if (
			result.runId !== this.run.runId ||
			result.unitId !== this.state.unitId ||
			result.evidenceVersion !== this.state.evidenceVersion
		)
			return false;
		const currentAttempt = this.state.attempts.at(-1);
		if (currentAttempt?.evidenceVersion === this.state.evidenceVersion) {
			try {
				assertSureDiagnosticSourcesCurrent(this.run, currentAttempt.readKeys);
			} catch (error) {
				this.state.evidenceVersion++;
				this.state.yieldReason = error instanceof Error ? error.message : String(error);
				this.invalidateRepair(this.state.yieldReason);
				this.save();
				return false;
			}
		}
		const id = `${result.unitId}:${result.evidenceVersion}`;
		if (result.decision === "repair" && this.state.pendingRepair?.id === id) return true;
		if (this.state.status === "stopped") return false;
		if (result.decision === "stop") {
			const attempt = this.state.attempts.at(-1);
			if (!attempt?.stopValidated || attempt.error || JSON.stringify(attempt.result) !== JSON.stringify(result))
				return false;
			this.stop(result.stopReason ?? "Supervisor stopped the run.");
			return true;
		}
		const budget = this.budget(result.unitId);
		budget.supervisorRepairs++;
		// A reviewed task needs an execution window; this is not verified business progress.
		budget.actions = {};
		budget.noProgress = 0;
		this.state.pendingRepair = { id, result, delivered: false };
		this.state.repairs ??= [];
		this.state.repairs.push({
			id,
			source: "supervisor",
			triggerCheckVersion: this.state.lastFailureCheckVersion,
			triggerBatchId: this.state.lastFailure?.action?.batchId,
			unitId: result.unitId,
			task: result.repair!,
			acceptedAt: new Date().toISOString(),
			beforeSnapshotId: this.state.latestSnapshot,
			checkVersions: [],
			outcome: "pending",
			remainingBudget: this.remainingBudget(result.unitId),
		});
		this.state.status = "executing";
		this.state.yieldReason = undefined;
		this.save();
		return true;
	}

	beginDiagnosis(): string {
		this.assertOwner?.();
		if (this.isStopped) throw new Error("Cannot diagnose a stopped or cancelled Sure run.");
		const id = randomUUID();
		this.state.status = "diagnosing";
		this.state.attempts.push({
			id,
			unitId: this.state.unitId,
			evidenceVersion: this.state.evidenceVersion,
			startedAt: new Date().toISOString(),
			modelTurns: 0,
			readCalls: 0,
			elapsedMs: 0,
			trigger: this.state.yieldReason,
		});
		this.save();
		return id;
	}

	stop(reason: string, cancelled = false): void {
		this.assertOwner?.();
		if (this.state.status === "stopped" && (!cancelled || this.state.cancelled)) return;
		this.state.status = "stopped";
		this.state.stopReason = reason;
		this.state.cancelled = cancelled || this.state.cancelled;
		const repair =
			this.state.repairs?.find((repair) => repair.id === this.state.pendingRepair?.id) ?? this.directRepair;
		if (repair) {
			if (repair.outcome === "pending") repair.outcome = "stopped";
			repair.stopReason = reason;
			repair.remainingBudget = this.remainingBudget(repair.unitId);
		}
		this.save();
		this.diagnosisAbortController?.abort();
	}

	get isStopped(): boolean {
		return this.state.cancelled === true || this.state.status === "stopped";
	}

	get lastDiagnosis(): SureDiagnosisResult | undefined {
		return this.state.attempts.at(-1)?.result;
	}

	/** Only baseline terminal conditions block recovery; coordination counters are telemetry. */
	get resumeBlocker(): string | undefined {
		if (this.state.cancelled) return "This run was deliberately cancelled.";
		if (this.state.lastCheck?.outcome === "exhausted") return "Existing gate retry budget exhausted.";
		return undefined;
	}
}
