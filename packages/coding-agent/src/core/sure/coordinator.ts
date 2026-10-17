import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSureDiagnosisResult } from "./coordination-contracts.ts";
import {
	SURE_COORDINATION_LIMITS,
	type SureCheckEvidence,
	type SureCoordinationLimits,
	type SureCoordinationState,
	type SureDiagnosisResult,
	type SureToolObservation,
} from "./coordination-types.ts";
import {
	assertSureDiagnosticSourcesCurrent,
	captureSureSnapshot,
	readSureSnapshot,
	resolveSureEvidencePath,
	type SureSnapshot,
	writeSureJson,
} from "./evidence.ts";
import type { SureRunRecord } from "./types.ts";

/** Coordination schedules investigation; business checks and finish retain their own authority. */
export class SureCoordinator {
	readonly run: SureRunRecord;
	readonly limits: SureCoordinationLimits;
	state: SureCoordinationState;
	assertOwner?: () => void;
	supervisorRuntime?: string;
	diagnosisAbortController?: AbortController;

	constructor(
		run: SureRunRecord,
		unitId: string,
		scope: string[],
		limits: Partial<SureCoordinationLimits> = {},
		assertOwner?: () => void,
	) {
		this.assertOwner = assertOwner;
		this.assertOwner?.();
		this.run = run;
		const path = join(run.runDir, "coordination.json");
		if (existsSync(path)) {
			const state = JSON.parse(readFileSync(path, "utf8")) as SureCoordinationState;
			if (state.version !== 2)
				throw new Error(
					`Unsupported Sure coordination version in ${path}; historical runs remain read-only. Start a new run.`,
				);
			if (
				state.runId !== run.runId ||
				!["executing", "yielding", "diagnosing", "stopped"].includes(state.status) ||
				!Array.isArray(state.attempts) ||
				!Number.isSafeInteger(state.evidenceVersion) ||
				state.evidenceVersion < 0 ||
				[state.finishNudges, state.unresolvedCheckVersion, state.reviewedFailureVersion].some(
					(value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0),
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
			for (const result of [state.pendingRepair?.result, ...state.attempts.map((attempt) => attempt.result)])
				if (result && parseSureDiagnosisResult(result).runId !== run.runId)
					throw new Error("Restored supervisor result belongs to another run.");
			const pending = state.pendingRepair;
			if (
				pending &&
				(pending.result.decision !== "repair" ||
					!state.repairs?.some(
						(task) =>
							task.id === pending.id &&
							task.unitId === pending.result.unitId &&
							task.task === pending.result.repair,
					))
			)
				throw new Error("Restored handoff does not match its accepted task.");
			this.state = state;
			this.limits = { ...SURE_COORDINATION_LIMITS, ...state.limits };
			for (const value of Object.values(this.limits))
				if (!Number.isSafeInteger(value) || value <= 0)
					throw new Error(`Invalid Sure coordination limits: ${path}`);
			if (state.unitId !== unitId) this.recordAction(unitId);
		} else {
			this.limits = { ...SURE_COORDINATION_LIMITS, ...limits };
			const snapshot = captureSureSnapshot(run, unitId, "initial", scope, this.limits);
			this.state = {
				version: 2,
				runId: run.runId,
				status: "executing",
				unitId,
				evidenceVersion: 0,
				updatedAt: new Date().toISOString(),
				attempts: [],
				repairs: [],
				limits: this.limits,
				initialSnapshot: snapshot.id,
				latestSnapshot: snapshot.id,
			};
			this.save();
		}
		const invocationPath = join(run.runDir, "evidence/invocation.json");
		if (!existsSync(invocationPath)) {
			const { runId, command, args, cwd, packageDir, runDir } = run;
			writeSureJson(invocationPath, { runId, command, args, cwd, packageDir, runDir });
		}
	}

	save(): void {
		this.assertOwner?.();
		this.state.updatedAt = new Date().toISOString();
		writeSureJson(join(this.run.runDir, "coordination.json"), this.state);
	}

	invalidateRepair(reason: string): void {
		const task = [...(this.state.repairs ?? [])].reverse().find((repair) => repair.unitId === this.state.unitId);
		if (task) task.stopReason = reason;
		this.state.pendingRepair = undefined;
	}

	/** Stage synchronization only; reads and control tools never create a workload trigger. */
	recordAction(unitId: string): void {
		this.assertOwner?.();
		if (this.state.unitId === unitId) return;
		this.invalidateRepair("The active unit changed.");
		this.state.unitId = unitId;
		this.state.unitLabel = undefined;
		this.state.unresolvedCheckVersion = undefined;
		this.state.evidenceVersion++;
		this.save();
	}

	private checkAt(version: number): SureCheckEvidence {
		return JSON.parse(readFileSync(join(this.run.runDir, "evidence", `${version}.json`), "utf8")).check;
	}

	private observation(check: SureCheckEvidence): SureToolObservation | undefined {
		const path = check.action && resolveSureEvidencePath(this.run, check.action.path);
		return path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
	}

	observe(check: SureCheckEvidence, scope: string[]): SureSnapshot {
		this.assertOwner?.();
		const eventKey = check.action
			? JSON.stringify([check.unitId, check.action.toolCallId, check.sourceId ?? check.checker])
			: check.checkId
				? JSON.stringify([check.unitId, check.checkId])
				: undefined;
		const observed = eventKey && this.state.observedToolChecks?.[eventKey];
		if (observed) return readSureSnapshot(this.run, observed);
		const snapshot = captureSureSnapshot(
			this.run,
			check.unitId,
			check.outcome === "passed" ? "passed" : "failed",
			scope,
			this.limits,
		);
		const previous =
			this.state.unresolvedCheckVersion === undefined ? undefined : this.checkAt(this.state.unresolvedCheckVersion);
		const observation = this.observation(check);
		const returned = check.action
			? observation?.execution === "returned" && !observation.duringHold
			: check.failureKind !== "tool";
		const rejected =
			observation?.execution === "skipped" && observation.rejection !== undefined && !observation.duringHold;
		this.state.unitId = check.unitId;
		this.state.latestSnapshot = snapshot.id;
		this.state.lastCheck = check;
		const version = ++this.state.evidenceVersion;
		this.state.lastCheckVersion = version;
		const pending = this.state.pendingRepair;
		const task = this.state.repairs?.find((repair) => repair.id === pending?.id);
		if (task && task.unitId === check.unitId) {
			task.checkVersions.push(version);
			task.afterSnapshotId = snapshot.id;
			if (returned && check.failureKind !== "tool" && check.outcome !== "pending" && check.outcome !== "unchanged") {
				task.gateOutcome = check.outcome;
				task.gateCheckVersion = version;
			}
		}
		writeSureJson(join(this.run.runDir, "evidence", `${version}.json`), {
			check,
			repairId: task?.id,
			snapshotId: snapshot.id,
			timestamp: new Date().toISOString(),
		});
		if ((returned || rejected) && (check.outcome === "blocked" || check.outcome === "exhausted")) {
			this.state.originalFailure ??= check;
			this.state.lastFailure = check;
			this.state.lastFailureCheckVersion = version;
			if (task) task.remainingBlocker = check.summary;
			// Exhaustion stays a business observation; it neither starts diagnosis nor removes executor rights.
			if (check.outcome === "blocked") {
				const sameBatch =
					previous?.action?.batchId !== undefined && previous.action.batchId === check.action?.batchId;
				const sameCall = previous?.action && previous.action.toolCallId === check.action?.toolCallId;
				const sameHook =
					previous?.checkId?.includes(":") &&
					check.checkId?.includes(":") &&
					previous.checkId.slice(0, previous.checkId.lastIndexOf(":")) ===
						check.checkId.slice(0, check.checkId.lastIndexOf(":"));
				const clearLocalProgress = check.localProgress === true && check.condition?.localRepair === true;
				if (
					previous?.unitId === check.unitId &&
					!sameBatch &&
					!sameCall &&
					!sameHook &&
					!clearLocalProgress &&
					this.state.status === "executing"
				)
					this.requestDiagnosis(
						`Execution remains blocked after failure feedback (check:${version}): ${check.summary}`,
					);
				if (!previous || previous.unitId !== check.unitId || clearLocalProgress)
					this.state.unresolvedCheckVersion = version;
			}
		} else if (returned && check.outcome === "passed") {
			this.state.unresolvedCheckVersion = undefined;
			this.state.lastSuccessSnapshot = snapshot.id;
			this.state.lastSuccessUnit = check.unitId;
			if (task) {
				task.remainingBlocker = undefined;
				// A still-pending task survived shutdown; passing its gate is not invalidation.
				task.stopReason = undefined;
			}
			this.state.pendingRepair = undefined;
		} else if (
			returned &&
			previous?.unitId === check.unitId &&
			previous.failureKind === "tool" &&
			observation?.execution === "returned" &&
			!observation.isError &&
			previous.action &&
			check.action
		) {
			const original = this.observation(previous);
			if (
				original &&
				previous.action.toolName === check.action.toolName &&
				JSON.stringify(original.input) === JSON.stringify(observation.input)
			)
				this.state.unresolvedCheckVersion = undefined;
		}
		if (eventKey) {
			this.state.observedToolChecks ??= {};
			this.state.observedToolChecks[eventKey] = snapshot.id;
		}
		this.save();
		return snapshot;
	}

	requestDiagnosis(reason: string): void {
		this.assertOwner?.();
		if (this.isStopped) throw new Error("Cannot request diagnosis for a stopped or cancelled run.");
		if (!reason.trim()) throw new Error("A diagnosis request needs a reason.");
		if (this.state.reviewedFailureVersion === (this.state.lastFailureCheckVersion ?? 0)) return;
		this.state.status = "yielding";
		this.state.yieldReason = reason;
		this.save();
	}

	/** Called only after the whole tool batch has settled. */
	barrier(scope: string[]): SureSnapshot {
		this.assertOwner?.();
		const snapshot = captureSureSnapshot(this.run, this.state.unitId, "barrier", scope, this.limits);
		if (
			this.state.latestSnapshot &&
			readSureSnapshot(this.run, this.state.latestSnapshot).fingerprint !== snapshot.fingerprint
		)
			this.state.evidenceVersion++;
		this.state.latestSnapshot = snapshot.id;
		this.save();
		return snapshot;
	}

	acceptDiagnosis(value: unknown): boolean {
		this.assertOwner?.();
		if (this.isStopped) return false;
		if (
			value &&
			typeof value === "object" &&
			"decision" in value &&
			(value.decision === "stop" || value.decision === "checkpoint")
		)
			return false;
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
		const id = `${this.run.runId}:${result.unitId}:${result.evidenceVersion}`;
		if (result.decision === "repair" && this.state.repairs?.some((task) => task.id === id)) return true;
		this.state.reviewedFailureVersion = this.state.lastFailureCheckVersion ?? 0;
		if (result.decision === "repair") {
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
			});
		}
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
		const task = this.state.repairs?.find((repair) => repair.id === this.state.pendingRepair?.id);
		if (task) task.stopReason = reason;
		this.save();
		this.diagnosisAbortController?.abort();
	}

	get isStopped(): boolean {
		return this.state.cancelled === true || this.state.status === "stopped";
	}
	get lastDiagnosis(): SureDiagnosisResult | undefined {
		return this.state.attempts.at(-1)?.result;
	}
	get resumeBlocker(): string | undefined {
		return this.state.cancelled ? "This run was deliberately cancelled." : undefined;
	}
}
