import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SureCoordinationState } from "./coordination-types.ts";
import type { SureCoordinator } from "./coordinator.ts";
import { writeSureJson } from "./evidence.ts";
import type { SureDisplayState, SureRunRecord } from "./types.ts";

export interface SureFailureReport {
	version: 1;
	runId: string;
	outcome: "failed" | "incomplete" | "cancelled";
	impact: string;
	stage: string;
	stageLabel?: string;
	diagnosisStatus: "complete" | "unavailable" | "incomplete" | "not_attempted";
	reference: string;
	facts: string[];
	hypotheses: string[];
	unknowns: string[];
	attempted: string[];
	stopReason: string;
	nextActions: string[];
	resumable: boolean;
	resumeCommand?: string;
	evidencePaths: string[];
	diagnosisEvidence: string[];
}

export function buildSureFailureReport(
	run: SureRunRecord,
	coordinator: SureCoordinator | undefined,
	display?: SureDisplayState,
): SureFailureReport {
	const state: SureCoordinationState = coordinator?.state ?? {
		version: 1,
		runId: run.runId,
		status: "stopped",
		unitId: display?.phase?.id ?? "startup",
		evidenceVersion: 0,
		updatedAt: run.updatedAt,
		units: {},
		attempts: [],
		stopReason: run.lastRepair ?? run.errorSummary,
	};
	const resumeBlocker = coordinator?.resumeBlocker;
	const attempt = state.attempts.at(-1);
	const currentAttempt =
		attempt?.unitId === state.unitId && attempt.evidenceVersion === state.evidenceVersion ? attempt : undefined;
	const diagnosis = currentAttempt?.error ? undefined : currentAttempt?.result;
	const stageLabel = state.unitLabel ?? (display?.phase?.id === state.unitId ? display.phase.label : undefined);
	const resumable =
		coordinator !== undefined &&
		(run.status === "running" || run.status === "failed") &&
		!resumeBlocker &&
		display?.checkpoint?.resumable === true;
	return {
		version: 1,
		runId: run.runId,
		outcome: state.cancelled
			? "cancelled"
			: run.status === "incomplete" || (state.status === "diagnosing" && currentAttempt?.checkpoint)
				? "incomplete"
				: "failed",
		impact: state.cancelled
			? "The user cancelled execution. Existing evidence is retained."
			: `/${run.command} did not complete at ${stageLabel ?? state.unitId}; no validated success is claimed.`,
		stage: state.unitId,
		stageLabel,
		diagnosisStatus: currentAttempt?.error
			? "unavailable"
			: diagnosis
				? "complete"
				: currentAttempt?.checkpoint
					? "incomplete"
					: "not_attempted",
		reference: state.lastSuccessSnapshot
			? `Last successful check: ${state.lastSuccessUnit}; snapshot ${state.lastSuccessSnapshot}`
			: `Initial snapshot ${state.initialSnapshot ?? "unavailable"}; no successful check is recorded.`,
		facts: [
			...new Set(
				[
					state.originalFailure?.summary,
					state.lastFailure?.summary,
					run.errorSummary,
					state.lastCheck?.summary,
				].filter((value): value is string => Boolean(value)),
			),
		],
		hypotheses: [
			...(diagnosis?.facts.map((fact) => `Supervisor observation (not independently verified): ${fact}`) ?? []),
			...(diagnosis?.hypotheses ?? []),
		],
		unknowns: diagnosis?.unknowns ?? [
			"The underlying cause has not been established for the current evidence version.",
		],
		attempted: [
			...state.attempts.map(
				(attempt) =>
					`${attempt.id}: ${attempt.trigger ? `Triggered by ${attempt.trigger}. ` : ""}${attempt.error ?? attempt.result?.repair ?? attempt.result?.stopReason ?? "interrupted diagnosis"}`,
			),
			...(state.repairs ?? []).map(
				(repair) =>
					`Repair ${repair.id}: ${repair.task}; outcome ${repair.outcome}; checks ${repair.checkVersions.map((version) => `check:${version}`).join(", ") || "not yet executed"}; snapshots ${repair.beforeSnapshotId ?? "unavailable"} -> ${repair.afterSnapshotId ?? "unavailable"}; remaining blocker: ${repair.remainingBlocker ?? "none recorded"}${repair.stopReason ? `; ${repair.stopReason}` : ""}`,
			),
		],
		stopReason:
			state.stopReason ??
			(currentAttempt?.checkpoint
				? `Diagnosis paused, not a business stop: ${currentAttempt.checkpoint.checkpoint}`
				: "Execution stopped."),
		nextActions: [
			...(resumable
				? (diagnosis?.nextActions ?? ["Inspect the saved evidence and resolve the recorded blocker."])
				: [
						"Inspect the retained evidence and diagnosis for the recorded blocker.",
						"Resolve the blocker before starting a new run; this run cannot be resumed directly.",
					]),
			...(resumeBlocker ? [resumeBlocker] : []),
		],
		resumable,
		resumeCommand: resumable ? `/sure_resume ${run.runId}` : undefined,
		diagnosisEvidence: diagnosis?.evidenceReferences ?? [],
		evidencePaths: [
			"coordination.json",
			"state.json",
			"events.jsonl",
			"evidence",
			"snapshots",
			"diagnoses",
			"supervisor",
		].map((path) => join(run.runDir, path)),
	};
}

export function renderSureFailureReport(report: SureFailureReport, expanded = true): string {
	const diagnosis =
		report.diagnosisStatus === "unavailable"
			? "unavailable. No validated supervisor task was issued for the current evidence version."
			: report.diagnosisStatus;
	if (!expanded)
		return [
			`SURE ${report.outcome}: ${report.runId}\n${report.impact}`,
			`Execution: ${
				report.facts
					.slice(0, 2)
					.map((fact) => fact.slice(0, 1000))
					.join("\n") || "No execution error was recorded."
			}`,
			`Diagnosis: ${diagnosis}`,
			`Stopped: ${report.stopReason.slice(0, 500)}`,
			`Next: ${report.nextActions.join(" ").slice(0, 1000)}`,
			report.resumable ? `Resume: ${report.resumeCommand}` : "Direct resume is unavailable.",
			`Details: ${join(report.evidencePaths[0], "..", "failure-report.md")}`,
		].join("\n\n");
	return [
		`SURE ${report.outcome}: ${report.runId}\n${report.impact}`,
		`Stage: ${report.stageLabel ?? report.stage} (${report.stage})\nReference: ${report.reference}\nDiagnosis: ${diagnosis}`,
		`Confirmed facts:\n${report.facts.join("\n") || "None recorded."}\nHypotheses:\n${report.hypotheses.join("\n") || "None."}\nUnknowns:\n${report.unknowns.join("\n") || "None recorded."}`,
		`Attempted fixes/diagnoses:\n${report.attempted.join("\n") || "None."}\nStop reason: ${report.stopReason}`,
		`Next actions:\n${report.nextActions.join("\n")}\n${report.resumable ? `Saved checkpoint: ${report.resumeCommand}; budgets and history remain in effect.` : "No resumable checkpoint is available."}`,
		`Diagnosis references (existence checked; not proof of cause):\n${report.diagnosisEvidence.join("\n") || "No validated model diagnosis."}\nEvidence:\n${report.evidencePaths.join("\n")}`,
	].join("\n\n");
}

export function persistSureFailureReport(run: SureRunRecord, report: SureFailureReport): void {
	writeSureJson(join(run.runDir, "failure-report.json"), report);
	writeFileSync(join(run.runDir, "failure-report.md"), `${renderSureFailureReport(report)}\n`, "utf8");
}
