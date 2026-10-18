import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../tools/truncate.ts";
import { isSureBusinessCheck, type SureCheckEvidence, type SureToolObservation } from "./coordination-types.ts";
import type { SureCoordinator } from "./coordinator.ts";
import { readSureSnapshot, type SureSnapshot } from "./evidence.ts";
import type { SureHookExecution } from "./hooks.ts";
import type { SureRunRecord } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read-time view of applied checkpoints; log offsets use the diagnostic tool's character units. */
export function loadSureCheckpointTimeline(run: SureRunRecord, index: ReturnType<typeof loadSureDiagnosticIndex>) {
	const path = join(run.runDir, "events.jsonl");
	const hooks = new Map(index.hooks.map((hook) => [hook.id, hook]));
	const checks = new Map(
		index.checks.flatMap((record) => (record.check.checkId ? [[record.check.checkId, record]] : [])),
	);
	const transitions: {
		logOffset: number;
		previousLogOffset: number | null;
		type: unknown;
		timestamp: unknown;
		hookId: string | null;
		checkVersion: number | null;
		snapshotId: string | null;
		changes: { field: string[]; before: string; after: string }[];
	}[] = [];
	const unreadableOffsets: number[] = [];
	if (!existsSync(path)) return { source: "run:events.jsonl", available: false, transitions, unreadableOffsets };
	let previous: Record<string, unknown> | undefined;
	let previousLogOffset: number | null = null;
	let offset = 0;
	const compact = (value: unknown): string => {
		const text = JSON.stringify(value) ?? "[not recorded]";
		return text.length > 160 ? `${text.slice(0, 160)} [truncated; see log]` : text;
	};
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const logOffset = offset;
		offset += line.length + 1;
		if (!line.trim()) continue;
		let event: unknown;
		try {
			event = JSON.parse(line);
			if (!isRecord(event)) throw new Error("Invalid event.");
		} catch {
			unreadableOffsets.push(logOffset);
			previous = undefined;
			previousLogOffset = null;
			continue;
		}
		if (!isRecord(event) || !isRecord(event.data) || !isRecord(event.data.state)) continue;
		const checkpoint = event.data.state.checkpoint;
		if (!isRecord(checkpoint)) continue;
		const changes: (typeof transitions)[number]["changes"] = [];
		for (const key of new Set([...Object.keys(previous ?? {}), ...Object.keys(checkpoint)])) {
			const before = previous?.[key];
			const after = checkpoint[key];
			// Shallow data fields keep the mainline useful without interpreting a skill's state machine.
			if (key === "data" && (before === undefined || isRecord(before)) && isRecord(after)) {
				for (const field of new Set([...Object.keys(before ?? {}), ...Object.keys(after)]))
					if (!isDeepStrictEqual(before?.[field], after[field]))
						changes.push({ field: [key, field], before: compact(before?.[field]), after: compact(after[field]) });
			} else if (!isDeepStrictEqual(before, after))
				changes.push({ field: [key], before: compact(before), after: compact(after) });
		}
		if (changes.length) {
			const hookId = typeof event.data.hookExecutionId === "string" ? event.data.hookExecutionId : null;
			const checkId = hookId ? hooks.get(hookId)?.result?.check?.checkId : undefined;
			const check = checkId ? checks.get(checkId) : undefined;
			transitions.push({
				logOffset,
				previousLogOffset,
				type: event.type,
				timestamp: event.timestamp,
				hookId,
				checkVersion: check?.version ?? null,
				snapshotId: check?.snapshotId ?? null,
				changes,
			});
		}
		previous = checkpoint;
		previousLogOffset = logOffset;
	}
	return { source: "run:events.jsonl", available: true, transitions, unreadableOffsets };
}

export interface SureCheckRecord {
	check: SureCheckEvidence;
	snapshotId: string;
	timestamp: string;
	repairId?: string;
}

interface SureDiagnosticAction extends SureToolObservation {
	path: string;
	checkVersion?: number;
	checkUnitId?: string;
	outcome?: SureCheckEvidence["outcome"];
	snapshotId?: string;
	checker?: string;
	exitCode?: number | null;
	summary?: string;
}

interface SureDiagnosticStage {
	unitId: string;
	checks: number;
	firstCheck: number;
	lastCheck: number;
	outcomes: Record<string, number>;
	/** Historical check result, not a claim that these files still exist. */
	lastPassed?: { checkVersion: number; artifactPaths: string[] };
}

function preview(text: string) {
	return { text: text.slice(0, 1000), complete: text.length <= 1000, totalCharacters: text.length };
}

export function sureActionDetails(action: SureDiagnosticAction) {
	const { input, content, ...identity } = action;
	const result =
		typeof content === "string"
			? content
			: content
					.filter((block) => block.type === "text")
					.map((block) => block.text ?? "")
					.join("\n");
	return { ...identity, inputPreview: preview(JSON.stringify(input) ?? "undefined"), resultPreview: preview(result) };
}

/** A complete action index, without copying local evidence into the mandatory macro. */
export function sureActionIndex(actions: SureDiagnosticAction[]) {
	return actions.map((action) => {
		const input = JSON.stringify(action.input) ?? "undefined";
		return {
			toolCallId: action.toolCallId,
			toolName: action.toolName,
			unitId: action.unitId ?? null,
			batchId: action.batchId,
			execution: action.execution,
			isError: action.isError,
			checkVersion: action.checkVersion,
			outcome: action.outcome,
			input: input.slice(0, 120),
			inputTruncated: input.length > 120 ? true : undefined,
		};
	});
}

export function sureCurrentRepairAttempt(
	coordinator: SureCoordinator,
	index: ReturnType<typeof loadSureDiagnosticIndex>,
) {
	const repair = coordinator.state.repairs?.filter((repair) => repair.unitId === coordinator.state.unitId).at(-1);
	const failure = index.checks.find(({ version }) => version === coordinator.state.unresolvedCheckVersion);
	const triggerBatchId =
		repair?.triggerBatchId ?? failure?.check.action?.batchId ?? coordinator.state.lastFailure?.action?.batchId;
	if (!repair && !triggerBatchId) return undefined;
	const unitId = repair?.unitId ?? coordinator.state.unitId;
	const versions = new Set(repair?.checkVersions ?? []);
	const actions = index.actions.filter(
		(action) =>
			(action.checkVersion !== undefined && versions.has(action.checkVersion)) ||
			(triggerBatchId !== undefined && action.batchId === triggerBatchId) ||
			(!repair &&
				failure !== undefined &&
				action.checkUnitId === unitId &&
				action.checkVersion !== undefined &&
				action.checkVersion >= failure.version) ||
			(!repair &&
				failure !== undefined &&
				action.unitId === unitId &&
				action.requestedAt !== undefined &&
				action.requestedAt >= failure.timestamp) ||
			(repair !== undefined &&
				action.unitId === unitId &&
				action.requestedAt !== undefined &&
				action.requestedAt >= repair.acceptedAt),
	);
	const batches = [...new Set(actions.map((action) => action.batchId))].map((batchId) => ({
		batchId,
		phase: batchId === undefined ? "unknown" : batchId === triggerBatchId ? "trigger_batch" : "subsequent_batch",
	}));
	return {
		repairId: repair?.id,
		source: repair?.source,
		batches,
		actions: sureActionIndex(actions).map(({ unitId: originUnit, batchId, input, inputTruncated, ...action }) => ({
			...action,
			...(originUnit !== unitId ? { unitId: originUnit } : {}),
			batch: batches.findIndex((batch) => batch.batchId === batchId),
		})),
	};
}

/** Literal search in one already-authorized text. Offsets use the same units as file pages. */
export function searchSureDiagnosticText(text: string, query: string) {
	if (!query) throw new Error("Diagnostic search requires nonempty query text.");
	const matches: { sourceOffset: number; line: number; preview: string }[] = [];
	let previous = 0;
	let line = 1;
	for (let offset = text.indexOf(query); offset !== -1; offset = text.indexOf(query, offset + query.length)) {
		line += text.slice(previous, offset).split("\n").length - 1;
		previous = offset;
		matches.push({
			sourceOffset: offset,
			line,
			preview: text.slice(Math.max(0, offset - 120), offset + query.length + 120),
		});
	}
	return { query, sourceCharacters: text.length, matches };
}

export function loadSureCheckRecords(coordinator: SureCoordinator) {
	const evidenceDir = join(coordinator.run.runDir, "evidence");
	const versions = existsSync(evidenceDir)
		? readdirSync(evidenceDir)
				.filter((name) => /^\d+\.json$/.test(name))
				.sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
		: [];
	return versions.map((name) => ({
		version: Number.parseInt(name, 10),
		...(JSON.parse(readFileSync(join(evidenceDir, name), "utf8")) as SureCheckRecord),
	}));
}

/** Keep a complete compact index; detailed records are read separately. */
export function loadSureDiagnosticIndex(coordinator: SureCoordinator) {
	const evidenceDir = join(coordinator.run.runDir, "evidence");
	const checks = loadSureCheckRecords(coordinator);
	const checkByCall = new Map(
		checks.flatMap((record) => (record.check.action ? [[record.check.action.toolCallId, record] as const] : [])),
	);
	const toolsDir = join(evidenceDir, "tools");
	const actions: SureDiagnosticAction[] = existsSync(toolsDir)
		? readdirSync(toolsDir)
				.filter((name) => name.endsWith(".json"))
				.map((name) => {
					const saved = JSON.parse(readFileSync(join(toolsDir, name), "utf8")) as SureToolObservation;
					const record = checkByCall.get(saved.toolCallId);
					return {
						...saved,
						path: `run:evidence/tools/${name}`,
						checkUnitId: record?.check.unitId,
						checkVersion: record?.version,
						outcome: record?.check.outcome,
						snapshotId: record?.snapshotId,
						checker: record?.check.checker,
						exitCode: record?.check.exitCode,
						summary: record?.check.summary,
					};
				})
				.sort(
					(a, b) =>
						(a.requestedAt ?? checkByCall.get(a.toolCallId)?.timestamp ?? "").localeCompare(
							b.requestedAt ?? checkByCall.get(b.toolCallId)?.timestamp ?? "",
						) ||
						(a.order ?? 0) - (b.order ?? 0) ||
						a.toolCallId.localeCompare(b.toolCallId),
				)
		: [];
	const hooksDir = join(evidenceDir, "hooks");
	const hooks = existsSync(hooksDir)
		? readdirSync(hooksDir)
				.filter((name) => name.endsWith(".json"))
				.map((name) => JSON.parse(readFileSync(join(hooksDir, name), "utf8")) as SureHookExecution)
				.sort(
					(a, b) =>
						a.startedAt.localeCompare(b.startedAt) ||
						a.invocationId.localeCompare(b.invocationId) ||
						a.index - b.index,
				)
		: [];
	const stages = new Map<string, SureDiagnosticStage>();
	for (const { version, check } of checks) {
		const stage: SureDiagnosticStage = stages.get(check.unitId) ?? {
			unitId: check.unitId,
			checks: 0,
			firstCheck: version,
			lastCheck: version,
			outcomes: {},
		};
		stage.checks++;
		stage.lastCheck = version;
		stage.outcomes[check.outcome] = (stage.outcomes[check.outcome] ?? 0) + 1;
		if (check.outcome === "passed" && isSureBusinessCheck(check))
			stage.lastPassed = { checkVersion: version, artifactPaths: check.artifactPaths };
		stages.set(check.unitId, stage);
	}
	const evidenceChecks = [
		...checks.map(({ check }) => check),
		...hooks.flatMap(({ result }) => (result?.check ? [result.check] : [])),
	];
	return {
		checks,
		actions,
		hooks,
		stages: [...stages.values()],
		readOnlyScope: [
			...actions.map((action) => action.path),
			...evidenceChecks.flatMap((check) => [
				...(check.diagnosticPaths ?? []),
				...(check.action ? [check.action.path] : []),
			]),
		],
	};
}

export function sureDiffIndex(before: SureSnapshot, after: SureSnapshot) {
	const oldFiles = new Map(before.files.map((file) => [file.path, file]));
	const newFiles = new Map(after.files.map((file) => [file.path, file]));
	return [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort().flatMap((path) => {
		const old = oldFiles.get(path),
			current = newFiles.get(path);
		if (old?.status === "text" && current?.status === "text" && old.sha256 === current.sha256) return [];
		if (JSON.stringify(old) === JSON.stringify(current)) return [];
		return [{ path, before: old?.status ?? "not_captured", after: current?.status ?? "not_captured" }];
	});
}

/** Lossless path/status encoding; unknown coverage remains unknown. */
export function packSureDiffIndex(entries: ReturnType<typeof sureDiffIndex>) {
	const groups = new Map<string, { before: string; after: string; directories: Record<string, string[]> }>();
	for (const entry of entries) {
		const key = JSON.stringify([entry.before, entry.after]);
		const group = groups.get(key) ?? { before: entry.before, after: entry.after, directories: {} };
		const slash = entry.path.lastIndexOf("/");
		const directory = entry.path.slice(0, slash + 1);
		group.directories[directory] ??= [];
		group.directories[directory].push(entry.path.slice(slash + 1));
		groups.set(key, group);
	}
	return { encoding: "status-directory-basenames-v1", count: entries.length, groups: [...groups.values()] };
}

/** Pages remain valid JSON even when the serialized evidence spans several reads. */
export function pageSureDiagnosticValue(value: unknown, offset: number) {
	const format = typeof value === "string" ? "text" : "json";
	const serialized = typeof value === "string" ? value : JSON.stringify(value);
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > serialized.length)
		throw new Error("Diagnostic offset exceeds the evidence length.");
	// Character offsets also support compact JSON and a single oversized line;
	// cut only at UTF-8 boundaries so every source can be reconstructed exactly.
	const bytes = Buffer.from(serialized.slice(offset));
	let end = Math.min(bytes.length, DEFAULT_MAX_BYTES);
	while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
	let text = bytes.subarray(0, end).toString("utf8");
	let lineEnd = -1;
	for (let line = 0; line < DEFAULT_MAX_LINES; line++) {
		lineEnd = text.indexOf("\n", lineEnd + 1);
		if (lineEnd === -1) break;
		if (line === DEFAULT_MAX_LINES - 1) text = text.slice(0, lineEnd + 1);
	}
	return {
		format,
		text,
		offset,
		nextOffset: offset + text.length,
		complete: offset + text.length === serialized.length,
		totalCharacters: serialized.length,
	};
}

export function sureSnapshotForPath(coordinator: SureCoordinator, id: string, path?: string): SureSnapshot {
	const snapshot = readSureSnapshot(coordinator.run, id);
	return path ? { ...snapshot, files: snapshot.files.filter((file) => file.path === path) } : snapshot;
}
