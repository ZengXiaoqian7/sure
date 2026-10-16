import { Type } from "typebox";
import { Compile } from "typebox/compile";
import {
	SURE_COORDINATION_LIMITS,
	type SureCheckEvidence,
	type SureCoordinationLimits,
	type SureCoordinationPolicy,
	type SureDiagnosisCheckpoint,
	type SureDiagnosisResult,
} from "./coordination-types.ts";

const diagnosisText = Type.String({ minLength: 1, maxLength: 32_000, pattern: "\\S" });
const diagnosisTexts = Type.Array(diagnosisText, { maxItems: 256 });

const diagnosisProperties = {
	runId: diagnosisText,
	unitId: diagnosisText,
	evidenceVersion: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	facts: diagnosisTexts,
	hypotheses: diagnosisTexts,
	unknowns: diagnosisTexts,
	nextActions: diagnosisTexts,
	evidenceReferences: Type.Array(diagnosisText, { minItems: 1, maxItems: 256 }),
	repair: Type.Optional(diagnosisText),
	stopReason: Type.Optional(diagnosisText),
	targetFiles: Type.Optional(diagnosisTexts),
	focusPaths: Type.Optional(diagnosisTexts),
	validation: Type.Optional(diagnosisText),
	stopBoundary: Type.Optional(diagnosisText),
};

/** The model sees the same flat structures that the harness checks, without coercion. */
export const SURE_DIAGNOSIS_SCHEMA = Type.Union([
	Type.Object({
		...diagnosisProperties,
		decision: Type.Literal("repair"),
		repair: diagnosisText,
		targetFiles: diagnosisTexts,
		validation: diagnosisText,
		stopBoundary: diagnosisText,
	}),
	Type.Object({
		...diagnosisProperties,
		decision: Type.Literal("stop"),
		stopReason: diagnosisText,
		stopAssessment: Type.Object({
			basis: Type.Union([
				Type.Literal("external_blocker"),
				Type.Literal("constraint_conflict"),
				Type.Literal("no_viable_route"),
			]),
			blockingCondition: diagnosisText,
			evidenceReferences: Type.Array(
				Type.Object({
					reference: diagnosisText,
					kind: Type.Union([
						Type.Literal("source"),
						Type.Literal("gate_failure"),
						Type.Literal("tool_result"),
						Type.Literal("user_constraint"),
					]),
				}),
				{ minItems: 1, maxItems: 256 },
			),
			continuationAssessment: diagnosisText,
			blockingUnknowns: diagnosisTexts,
		}),
	}),
]);
const diagnosisValidator = Compile(SURE_DIAGNOSIS_SCHEMA);
const repairValidator = Compile(SURE_DIAGNOSIS_SCHEMA.anyOf[0]);
const stopValidator = Compile(SURE_DIAGNOSIS_SCHEMA.anyOf[1]);

// Retained for historical records and internal checkpoints, not the model's control interface.
export const SURE_INVESTIGATION_SCHEMA = Type.Union([
	SURE_DIAGNOSIS_SCHEMA,
	Type.Object({
		runId: diagnosisText,
		unitId: diagnosisText,
		evidenceVersion: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		decision: Type.Literal("checkpoint"),
		checkpoint: Type.String({ minLength: 1, maxLength: 4000, pattern: "\\S" }),
		facts: diagnosisTexts,
		hypotheses: diagnosisTexts,
		unknowns: diagnosisTexts,
		nextActions: diagnosisTexts,
		evidenceReferences: Type.Array(diagnosisText, { minItems: 1, maxItems: 256 }),
		nextReads: Type.Array(Type.Record(Type.String(), Type.Unknown()), { minItems: 1, maxItems: 4 }),
		candidateRange: Type.Union([Type.Object({ startBatch: diagnosisText, endBatch: diagnosisText }), Type.Null()]),
		supportingEvidence: diagnosisTexts,
		opposingEvidence: diagnosisTexts,
	}),
]);
const checkpointValidator = Compile(SURE_INVESTIGATION_SCHEMA.anyOf[1]);

export function parseSureDiagnosisCheckpoint(value: unknown): SureDiagnosisCheckpoint {
	if (JSON.stringify(value).length > 32_000 || !checkpointValidator.Check(value))
		throw new Error("Invalid bounded investigation checkpoint.");
	return { ...value, automatic: false };
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
	return value as Record<string, unknown>;
}

function string(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 32_000) throw new Error("Expected bounded text.");
	return value;
}

function strings(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 256) throw new Error("Expected a bounded text array.");
	return value.map(string);
}

export function parseSureCoordinationPolicy(value: unknown): SureCoordinationPolicy | undefined {
	if (value === undefined) return undefined;
	const raw = record(value);
	if (raw.version !== 1 || !Array.isArray(raw.stages) || raw.stages.length === 0) {
		throw new Error("Invalid Sure coordination policy: expected version 1 and nonempty stages.");
	}
	const ids = new Set<string>();
	const stages = raw.stages.map((value) => {
		const stage = record(value);
		const id = string(stage.id);
		if (ids.has(id)) throw new Error(`Duplicate Sure coordination stage: ${id}`);
		ids.add(id);
		return {
			id,
			prompt: string(stage.prompt),
			references: strings(stage.references),
			snapshotPaths: strings(stage.snapshotPaths),
			diagnosticPaths: stage.diagnosticPaths === undefined ? undefined : strings(stage.diagnosticPaths),
		};
	});
	const budgets: Partial<SureCoordinationLimits> = {};
	if (raw.budgets !== undefined) {
		for (const [key, value] of Object.entries(record(raw.budgets))) {
			if (!Object.hasOwn(SURE_COORDINATION_LIMITS, key)) throw new Error(`Unknown Sure coordination budget: ${key}`);
			if (!Number.isSafeInteger(value) || Number(value) <= 0)
				throw new Error(`Sure coordination budget ${key} must be a positive bounded integer.`);
			budgets[key as keyof SureCoordinationLimits] = Number(value);
		}
	}
	return {
		version: 1,
		commonPrompt: string(raw.commonPrompt),
		stages,
		budgets: raw.budgets === undefined ? undefined : budgets,
	};
}

export function parseSureCheckEvidence(value: unknown): SureCheckEvidence | undefined {
	if (value === undefined) return undefined;
	const raw = record(value);
	const outcome = raw.outcome;
	if (
		outcome !== "pending" &&
		outcome !== "passed" &&
		outcome !== "blocked" &&
		outcome !== "unchanged" &&
		outcome !== "exhausted" &&
		outcome !== "skipped"
	) {
		throw new Error("Invalid Sure check outcome.");
	}
	const failureKind = raw.failureKind;
	if (
		failureKind !== undefined &&
		failureKind !== "format" &&
		failureKind !== "semantic" &&
		failureKind !== "tool" &&
		failureKind !== "execution" &&
		failureKind !== "checker_exception" &&
		failureKind !== "no_progress"
	) {
		throw new Error("Invalid Sure check failure kind.");
	}
	const progress = raw.progress === undefined ? undefined : record(raw.progress);
	if (raw.recovery !== undefined && raw.recovery !== "local_once" && raw.recovery !== "diagnose")
		throw new Error("Invalid Sure recovery disposition.");
	if (progress && (!Number.isSafeInteger(progress.completed) || Number(progress.completed) < 0))
		throw new Error("Invalid verified progress milestone.");
	return {
		unitId: string(raw.unitId),
		outcome,
		failureKind,
		recovery: raw.recovery,
		summary: string(raw.summary),
		repair: raw.repair === undefined ? undefined : string(raw.repair),
		artifactPaths: strings(raw.artifactPaths),
		inputPaths: strings(raw.inputPaths),
		diagnosticPaths: raw.diagnosticPaths === undefined ? undefined : strings(raw.diagnosticPaths),
		checker: raw.checker === undefined ? undefined : string(raw.checker),
		exitCode: typeof raw.exitCode === "number" || raw.exitCode === null ? raw.exitCode : undefined,
		stdout: typeof raw.stdout === "string" ? raw.stdout.slice(0, 16_000) : undefined,
		stderr: typeof raw.stderr === "string" ? raw.stderr.slice(0, 16_000) : undefined,
		progress: progress ? { key: string(progress.key), completed: Number(progress.completed) } : undefined,
	};
}

export function allowsSureDirectRepair(check: SureCheckEvidence): boolean {
	return check.outcome === "blocked";
}

export function parseSureDiagnosisResult(value: unknown): SureDiagnosisResult {
	const decision = value && typeof value === "object" && "decision" in value ? value.decision : undefined;
	// Inspect the selected branch so a missing repair field is not obscured by stop-branch errors.
	const validator = decision === "repair" ? repairValidator : decision === "stop" ? stopValidator : diagnosisValidator;
	if (!validator.Check(value)) {
		const errors = validator.Errors(value);
		const error =
			errors.find((error) => error.keyword === "type") ??
			errors.find((error) => error.instancePath === "/decision") ??
			errors.find((error) => error.keyword === "required") ??
			errors[0];
		const parts = error.instancePath.split("/").filter(Boolean);
		if (error.keyword === "required") parts.push(error.params.requiredProperties[0]);
		let received: unknown = value;
		for (const part of parts)
			received = received && typeof received === "object" ? (received as Record<string, unknown>)[part] : undefined;
		const actual = received === null ? "null" : Array.isArray(received) ? "array" : typeof received;
		const expected = error.keyword === "type" ? `must be ${error.params.type}` : error.message;
		throw new Error(`Invalid diagnosis: ${parts.join(".") || "root"} ${expected}; received ${actual}.`);
	}
	if (value.decision === "stop") {
		if (value.stopAssessment.blockingUnknowns.length)
			throw new Error("Stop has unresolved blockingUnknowns; continue investigation or return a checkpoint.");
		if (
			value.stopAssessment.evidenceReferences.some(({ reference }) => !value.evidenceReferences.includes(reference))
		)
			throw new Error("Stop assessment references must also appear in evidenceReferences.");
	}
	return {
		runId: value.runId,
		unitId: value.unitId,
		evidenceVersion: value.evidenceVersion,
		decision: value.decision,
		facts: value.facts,
		hypotheses: value.hypotheses,
		unknowns: value.unknowns,
		evidenceReferences: value.evidenceReferences,
		targetFiles: value.targetFiles,
		focusPaths: value.focusPaths,
		validation: value.validation,
		stopBoundary: value.stopBoundary,
		nextActions: value.nextActions,
		repair: value.repair,
		stopReason: value.stopReason,
		stopAssessment: value.decision === "stop" ? value.stopAssessment : undefined,
	};
}
