import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "jiti/static";
import { parseSureCheckEvidence } from "./coordination-contracts.ts";
import type { SureCoordinationState } from "./coordination-types.ts";
import { writeSureJson } from "./evidence.ts";
import { resolveSurePackagePath } from "./manifest.ts";
import { getSureHookAliases } from "./module-loader.ts";
import type { SureHookContext, SureHookDeclaration, SureHookPoint, SureHookResult, SureSkillPackage } from "./types.ts";

type HookFunction = (context: SureHookContext) => SureHookResult | Promise<SureHookResult | undefined> | undefined;

export interface SureGateResult {
	check?: SureHookResult["check"];
	checks?: NonNullable<SureHookResult["check"]>[];
	ok: boolean;
	message?: string;
	repair?: string;
	diagnostics?: unknown;
	state_patch?: unknown;
}

export interface SureHookExecution {
	id: string;
	invocationId: string;
	invocationAttempt: number;
	index: number;
	point: SureHookPoint;
	module: string;
	handler: string;
	status: "completed" | "rejected" | "exception" | "not_executed";
	startedAt: string;
	finishedAt: string;
	toolCallId?: string;
	inputEvidenceVersion?: number;
	inputSnapshotId?: string;
	result?: SureHookResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function normalizeHookResult(value: unknown): SureHookResult {
	if (!isRecord(value)) {
		return {};
	}
	return {
		check: parseSureCheckEvidence(value.check),
		ok: typeof value.ok === "boolean" ? value.ok : undefined,
		message: typeof value.message === "string" ? value.message : undefined,
		repair: typeof value.repair === "string" ? value.repair : undefined,
		patch: value.patch,
		artifacts: value.artifacts,
		diagnostics: value.diagnostics,
		state_patch: value.state_patch,
	};
}

function toGateFailure(result: SureHookResult, fallbackMessage: string): SureGateResult | undefined {
	if (result.ok !== false && !result.repair) {
		return undefined;
	}
	return {
		check: result.check,
		ok: false,
		message: result.message ?? fallbackMessage,
		repair: result.repair ?? result.message ?? fallbackMessage,
		diagnostics: result.diagnostics,
		state_patch: result.state_patch,
	};
}

export class SureHookRunner {
	private skillPackage: SureSkillPackage;
	private jiti = createJiti(import.meta.url, {
		moduleCache: false,
		alias: getSureHookAliases(),
	});

	constructor(skillPackage: SureSkillPackage) {
		this.skillPackage = skillPackage;
	}

	async run(point: SureHookPoint, context: Omit<SureHookContext, "point">): Promise<SureGateResult> {
		const declarations = this.skillPackage.manifest.hooks?.[point] ?? [];
		let statePatch: unknown;
		let check: SureHookResult["check"];
		const checks: NonNullable<SureHookResult["check"]>[] = [];
		const invocationId = randomUUID();
		let invocationAttempt = 0;
		if (this.skillPackage.manifest.coordination && declarations.length) {
			const path = join(context.runDir, "evidence/hook-attempts.json");
			const attempts = existsSync(path)
				? (JSON.parse(readFileSync(path, "utf8")) as Partial<Record<SureHookPoint, number>>)
				: {};
			invocationAttempt = (attempts[point] ?? 0) + 1;
			attempts[point] = invocationAttempt;
			writeSureJson(path, attempts);
		}
		let failure: SureGateResult | undefined;
		for (const [index, declaration] of declarations.entries()) {
			const startedAt = new Date().toISOString();
			const statePath = join(context.runDir, "coordination.json");
			const state =
				this.skillPackage.manifest.coordination && existsSync(statePath)
					? (JSON.parse(readFileSync(statePath, "utf8")) as SureCoordinationState)
					: undefined;
			const result = failure ? undefined : await this.runHook(point, declaration, context);
			if (result?.check && this.skillPackage.manifest.coordination) {
				result.check.sourceId = `${point}:${declaration.module}:${declaration.handler ?? point}:${index}`;
				result.check.checkId = `${invocationId}:${index}`;
			}
			if (this.skillPackage.manifest.coordination) {
				const event = isRecord(context.event) ? context.event : {};
				const execution: SureHookExecution = {
					id: `${invocationId}-${index}`,
					invocationId,
					invocationAttempt,
					index,
					point,
					module: declaration.module,
					handler: declaration.handler ?? point,
					status: !result
						? "not_executed"
						: result.threw
							? "exception"
							: result.ok === false || result.repair
								? "rejected"
								: "completed",
					startedAt,
					finishedAt: new Date().toISOString(),
					toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
					inputEvidenceVersion: state?.evidenceVersion,
					inputSnapshotId: state?.latestSnapshot,
					result,
				};
				writeSureJson(join(context.runDir, "evidence/hooks", `${execution.id}.json`), execution);
			}
			if (!result) continue;
			if (result.check) checks.push(result.check);
			check = result.check ?? check;
			if (result.state_patch !== undefined) {
				statePatch = result.state_patch;
			}
			failure = toGateFailure(result, `Sure ${point} hook rejected the action.`);
		}
		const gate = failure
			? { ...failure, state_patch: failure.state_patch ?? statePatch }
			: { ok: true, state_patch: statePatch, check };
		return this.skillPackage.manifest.coordination ? { ...gate, checks } : gate;
	}

	private async runHook(
		point: SureHookPoint,
		declaration: SureHookDeclaration,
		context: Omit<SureHookContext, "point">,
	): Promise<SureHookResult & { threw?: boolean }> {
		const hookPath = resolveSurePackagePath(this.skillPackage.packageDir, declaration.module);
		if (!hookPath) {
			return {
				ok: false,
				message: `Hook module path escapes skill package: ${declaration.module}`,
				repair: "Fix sure.skill.json so hook module paths stay inside the skill package.",
			};
		}

		try {
			const loaded = await this.jiti.import(hookPath);
			const moduleValue = loaded as Record<string, unknown>;
			const handlerName = declaration.handler ?? point;
			const handler =
				(typeof moduleValue[handlerName] === "function" ? moduleValue[handlerName] : undefined) ??
				(typeof moduleValue.default === "function" ? moduleValue.default : undefined);
			if (!handler) {
				return {
					ok: false,
					message: `Hook handler not found: ${handlerName}`,
					repair: `Export a function named "${handlerName}" from ${declaration.module}, or provide a default export.`,
				};
			}

			const value = await (handler as HookFunction)({
				...context,
				point,
			});
			return normalizeHookResult(value);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				threw: true,
				ok: false,
				message: `Sure ${point} hook failed: ${message}`,
				check: {
					unitId: "unknown",
					outcome: "blocked",
					failureKind: "checker_exception",
					summary: message,
					artifactPaths: [],
					inputPaths: [],
					checker: declaration.module,
				},
				repair: `Fix the hook failure in ${declaration.module} and retry the action.`,
			};
		}
	}
}
