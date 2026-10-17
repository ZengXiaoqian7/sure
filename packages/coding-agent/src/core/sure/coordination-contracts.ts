import { Type } from "typebox";
import { Compile } from "typebox/compile";
import {
	SURE_COORDINATION_LIMITS,
	type SureCheckEvidence,
	type SureCoordinationLimits,
	type SureCoordinationPolicy,
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
	focusPaths: Type.Optional(diagnosisTexts),
	validation: Type.Optional(diagnosisText),
	stopBoundary: Type.Optional(diagnosisText),
};

export const SURE_DIAGNOSIS_SCHEMA = Type.Union([
	Type.Object({
		...diagnosisProperties,
		decision: Type.Literal("repair"),
		repair: diagnosisText,
		targetFiles: Type.Optional(diagnosisTexts),
	}),
	Type.Object({ ...diagnosisProperties, decision: Type.Literal("continue"), reason: diagnosisText }),
]);
const diagnosisValidator = Compile(SURE_DIAGNOSIS_SCHEMA);
const repairValidator = Compile(SURE_DIAGNOSIS_SCHEMA.anyOf[0]);
const continueValidator = Compile(SURE_DIAGNOSIS_SCHEMA.anyOf[1]);

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
	const condition = raw.condition === undefined ? undefined : record(raw.condition);
	if (raw.localProgress !== undefined && typeof raw.localProgress !== "boolean")
		throw new Error("Invalid skill-verified local progress.");
	if (condition?.localRepair !== undefined && typeof condition.localRepair !== "boolean")
		throw new Error("Invalid local repair disposition.");
	if (raw.recovery !== undefined) throw new Error("Legacy recovery quotas are not supported.");
	if (progress && (!Number.isSafeInteger(progress.completed) || Number(progress.completed) < 0))
		throw new Error("Invalid verified progress milestone.");
	return {
		unitId: string(raw.unitId),
		outcome,
		failureKind,
		condition: condition
			? {
					id: string(condition.id),
					target: condition.target === undefined ? undefined : string(condition.target),
					localRepair: condition.localRepair,
				}
			: undefined,
		localProgress: raw.localProgress,
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

export function parseSureDiagnosisResult(value: unknown): SureDiagnosisResult {
	if (value && typeof value === "object" && "kind" in value && value.kind === "evidence")
		throw new Error("Evidence return tasks are retired; supervisor guidance must cover the complete correction.");
	const decision = value && typeof value === "object" && "decision" in value ? value.decision : undefined;
	// Inspect the selected branch so unrelated branch errors do not obscure the feedback.
	const validator =
		decision === "repair" ? repairValidator : decision === "continue" ? continueValidator : diagnosisValidator;
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
	return {
		runId: value.runId,
		unitId: value.unitId,
		evidenceVersion: value.evidenceVersion,
		decision: value.decision,
		facts: value.facts,
		hypotheses: value.hypotheses,
		unknowns: value.unknowns,
		evidenceReferences: value.evidenceReferences,
		targetFiles: value.decision === "repair" ? value.targetFiles : undefined,
		focusPaths: value.focusPaths,
		validation: value.validation,
		stopBoundary: value.stopBoundary,
		nextActions: value.nextActions,
		repair: value.decision === "repair" ? value.repair : undefined,
		reason: value.decision === "continue" ? value.reason : undefined,
	};
}
