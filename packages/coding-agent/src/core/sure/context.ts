import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SureCoordinationState } from "./coordination-types.ts";
import type { SureCheckRecord } from "./diagnostic-view.ts";
import { sureHash, writeSureJson } from "./evidence.ts";
import { resolveSurePackagePath } from "./manifest.ts";
import type { SureDisplayState, SureRunRecord, SureSkillPackage } from "./types.ts";

export function sureCurrentUnit(skill: SureSkillPackage, state?: SureDisplayState): string {
	const data = state?.checkpoint?.data;
	if (data && typeof data === "object" && "currentUnit" in data && typeof data.currentUnit === "string")
		return data.currentUnit;
	return skill.manifest.coordination?.stages[0]?.id ?? state?.phase?.id ?? "unknown";
}

export function surePromptPaths(skill: SureSkillPackage, unit: string): string[] {
	const policy = skill.manifest.coordination;
	const stage = policy?.stages.find((stage) => stage.id === unit);
	return [skill.manifest.prompt, policy?.commonPrompt, stage?.prompt]
		.filter((path): path is string => Boolean(path))
		.map((path) => `package:${path}`)
		.concat("run:evidence/executor-progress.json", ...(stage?.diagnosticPaths ?? []));
}

export function captureSureExecutorProgress(
	run: SureRunRecord,
	unitId: string,
	messages: AgentMessage[],
	checkpoint: SureDisplayState["checkpoint"],
	sessionFile?: string,
	sourceMessageIds?: Map<AgentMessage, string>,
	stageStartedAt?: number,
	toolUnits?: Map<string, string>,
): void {
	const publicMessages = messages.filter((message) => message.role === "assistant");
	const claims = publicMessages.flatMap((message) => {
		if (message.role !== "assistant") return [];
		const text = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		if (!text) return [];
		const units = new Set(
			message.content.flatMap((block) =>
				block.type === "toolCall" && toolUnits?.has(block.id) ? [toolUnits.get(block.id)!] : [],
			),
		);
		const originUnit =
			units.size === 1
				? units.values().next().value
				: units.size === 0 && stageStartedAt !== undefined && message.timestamp > stageStartedAt
					? unitId
					: null;
		const source = {
			unitId: originUnit ?? null,
			timestamp: message.timestamp,
			sourceMessageId: sourceMessageIds?.get(message),
			sourceHash: sureHash(text),
		};
		const sourcePath = `evidence/executor-progress/${sureHash(JSON.stringify({ ...source, sessionFile }))}.json`;
		if (!existsSync(join(run.runDir, sourcePath)))
			writeSureJson(join(run.runDir, sourcePath), { ...source, sessionFile, text });
		return [
			{
				...source,
				sourcePath: `run:${sourcePath}`,
				text: text.slice(0, 1000),
				totalCharacters: text.length,
				toolCallIds: message.content.filter((block) => block.type === "toolCall").map((block) => block.id),
				truncated: text.length > 1000,
			},
		];
	});
	const totalClaims = claims.length;
	const path = join(run.runDir, "evidence/executor-progress.json");
	// An absent packet already means no public intent; do not invalidate a cached task by creating one.
	if (!totalClaims && !existsSync(path)) return;
	const current = [...claims].reverse().find((claim) => claim.unitId === unitId);
	const packet = {
		unitId: unitId.slice(0, 256),
		sessionFile: sessionFile?.slice(0, 1000),
		checkpoint,
		attribution: "Executor public statements are claims, not verified progress or gate results.",
		// Keep the latest attributable intent last so trimming older claims cannot evict it first.
		claims: [...claims.filter((claim) => claim !== current).slice(current ? -5 : -6), ...(current ? [current] : [])],
		currentIntentAvailable: false,
		omitted: 0,
	};
	// Precise gate state is already durable; do not let a large checkpoint crowd out public intent.
	const data = checkpoint?.data;
	const retryState = data && typeof data === "object" && "retries" in data ? data.retries : undefined;
	const retry =
		retryState && typeof retryState === "object" ? (retryState as Record<string, unknown>)[unitId] : undefined;
	const retries = typeof retry === "number" && Number.isFinite(retry) ? { [unitId.slice(0, 256)]: retry } : undefined;
	const value = {
		...packet,
		checkpoint: { id: checkpoint?.id?.slice(0, 256), retries },
		omitted: totalClaims - packet.claims.length,
	};
	while (JSON.stringify(value).length > 4000 && value.claims.length) {
		value.claims.shift();
		value.omitted++;
	}
	value.currentIntentAvailable = value.claims.some((claim) => claim.unitId === unitId);
	if (!existsSync(path) || JSON.stringify(JSON.parse(readFileSync(path, "utf8"))) !== JSON.stringify(value))
		writeSureJson(path, value);
}

function readSurePrompt(skill: SureSkillPackage, path: string): string {
	const resolved = resolveSurePackagePath(skill.packageDir, path);
	if (!resolved) throw new Error(`Sure context path escapes skill package: ${path}`);
	return readFileSync(resolved, "utf8");
}

export function buildSureCommonPrompt(skill: SureSkillPackage, run: SureRunRecord): string {
	const policy = skill.manifest.coordination;
	if (!policy) return skill.prompt;
	return [
		readSurePrompt(skill, policy.commonPrompt),
		`Run inputs and global constraints: ${run.args}`,
		`Runtime paths (absolute): ${JSON.stringify({ projectRoot: run.cwd, packageDir: run.packageDir, runDir: run.runDir })}`,
		"Historical passed checks identify prior outputs, not current existence. Pending, skipped and tool success are not validation; use recorded paths, never infer filenames from unit IDs.",
		"Preserve the supervisor task's complete goal, original permissions and required runtime dependencies. focusPaths are investigation hints, not a write allowlist. Related objects remain within the original goal; the unchanged original gate determines business progression.",
		"Correct clear local problems directly. The harness requests supervision when actual correction remains blocked without verified local progress. Changed error wording or commands alone do not prove progress; original check results remain authoritative.",
		"Follow the supervisor guidance as one complete goal, including supporting probes and corrections. A successful probe is not a business gate pass. Continue normally after the original gate passes; no return for supervisor approval is required.",
	].join("\n\n");
}

export function buildSureStagePrompt(skill: SureSkillPackage, _run: SureRunRecord, state?: SureDisplayState): string {
	const policy = skill.manifest.coordination;
	if (!policy) return skill.prompt;
	const unit = sureCurrentUnit(skill, state);
	const stage = policy.stages.find((stage) => stage.id === unit);
	if (!stage) throw new Error(`No declared Sure context for unit ${unit}.`);
	return [
		`Current unit: ${unit} (${policy.stages.findIndex((stage) => stage.id === unit) + 1}/${policy.stages.length})`,
		readSurePrompt(skill, stage.prompt),
		`Full operating manual entry point: ${join(skill.packageDir, skill.manifest.prompt)}. Read relevant cross-stage rules when needed; the supervisor holds the complete global manual.`,
		`Reference entry points (read only when relevant):\n${stage.references.join("\n")}`,
	].join("\n\n");
}

/** Choose a fixed batch only at native compaction boundaries; ordinary requests never reclassify history. */
export function planSureContextTrim(
	messages: AgentMessage[],
	stageStartedAt: number,
	coordination: SureCoordinationState,
	checks: Array<SureCheckRecord & { version: number }> = [],
): string[] {
	const required = new Set<string>();
	const paths = new Set<string>();
	for (const { check, version } of checks) {
		if (
			check.unitId === (coordination.stageUnitId ?? coordination.unitId) ||
			coordination.unresolvedCheckVersion === version
		) {
			if (check.action) required.add(check.action.toolCallId);
			for (const path of [...check.inputPaths, ...check.artifactPaths])
				paths.add(path.replace(/^(?:project|package|run):/, ""));
		}
	}
	for (const check of [coordination.originalFailure, coordination.lastFailure])
		if (check?.action) required.add(check.action.toolCallId);
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const args = JSON.stringify(block.arguments);
			if ([...paths].some((path) => path && args.includes(path))) required.add(block.id);
		}
	}
	return messages.flatMap((message) =>
		message.role === "toolResult" &&
		!message.isError &&
		message.timestamp < stageStartedAt &&
		!required.has(message.toolCallId) &&
		message.content.every((block) => block.type === "text") &&
		JSON.stringify(message.content).length > 2000
			? [message.toolCallId]
			: [],
	);
}

/** Pure, stable view. Original tool results and provider-native blocks remain in the transcript. */
export function projectSureContext(messages: AgentMessage[], trimmedCalls: readonly string[]): AgentMessage[] {
	const trimmed = new Set(trimmedCalls);
	return messages.map((message): AgentMessage => {
		if (
			message.role !== "toolResult" ||
			!trimmed.has(message.toolCallId) ||
			message.isError ||
			message.content.some((block) => block.type !== "text")
		)
			return message;
		const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		if (text.startsWith("[Historical success excerpt;")) return message;
		return {
			...message,
			content: [
				{
					type: "text",
					text: `[Historical success excerpt; not current fact. Full: run:evidence/tools/${sureHash(message.toolCallId)}.json]\n${text.slice(0, 160)}\n[... ${text.length} characters ...]\n${text.slice(-32)}`,
				},
			],
		};
	});
}
