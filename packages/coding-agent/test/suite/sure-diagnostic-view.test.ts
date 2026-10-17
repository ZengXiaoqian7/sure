import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SureCoordinator } from "../../src/core/sure/coordinator.ts";
import {
	loadSureCheckpointTimeline,
	loadSureDiagnosticIndex,
	packSureDiffIndex,
	pageSureDiagnosticValue,
	sureDiffIndex,
	sureSnapshotForPath,
} from "../../src/core/sure/diagnostic-view.ts";
import { captureSureSnapshot, diffSureSnapshots } from "../../src/core/sure/evidence.ts";
import { SureRunManager } from "../../src/core/sure/run-manager.ts";
import type { SureRunRecord } from "../../src/core/sure/types.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

it("derives shallow checkpoint changes from applied states and preserves exact log offsets after reload", async () => {
	const coordinator = await setup();
	const { run } = coordinator;
	const manager = new SureRunManager(run.cwd);
	const log = join(run.runDir, "events.jsonl");
	writeFileSync(log, `${JSON.stringify({ type: "note", data: "中文🌍" })}\n`);
	const checkpoint = { id: "custom", data: { position: "prepare", attempts: { prepare: 0 }, memo: "x".repeat(700) } };
	manager.updateState(run, { checkpoint });
	manager.updateState(run, { message: "display only" });
	manager.updateState(run, {
		checkpoint: { id: "custom", data: { memo: checkpoint.data.memo, attempts: { prepare: 0 }, position: "prepare" } },
	});
	manager.updateState(run, {
		checkpoint: { id: "custom", data: { ...checkpoint.data, position: "execute", attempts: { prepare: 1 } } },
	});
	const index = loadSureDiagnosticIndex(coordinator);
	const timeline = loadSureCheckpointTimeline(run, index);
	expect(timeline.transitions).toHaveLength(2);
	expect(timeline.transitions[0].changes.find((change) => change.field.join(".") === "data.memo")?.after).toContain(
		"[truncated; see log]",
	);
	expect(timeline.transitions[1].changes).toHaveLength(2);
	expect(timeline.transitions[1].changes).toEqual(
		expect.arrayContaining([
			{ field: ["data", "position"], before: '"prepare"', after: '"execute"' },
			{ field: ["data", "attempts"], before: '{"prepare":0}', after: '{"prepare":1}' },
		]),
	);
	expect(timeline.transitions[1]).toMatchObject({ hookId: null, checkVersion: null, snapshotId: null });
	const text = readFileSync(log, "utf8");
	const entry = JSON.parse(pageSureDiagnosticValue(text, timeline.transitions[1].logOffset).text.split("\n")[0]);
	expect(entry.data.state.checkpoint.data.position).toBe("execute");
	expect(
		JSON.parse(text.slice(timeline.transitions[1].previousLogOffset!).split("\n")[0]).data.state.checkpoint.data
			.position,
	).toBe("prepare");
	const restored = new SureCoordinator(run, "stage", []);
	expect(loadSureCheckpointTimeline(run, loadSureDiagnosticIndex(restored))).toEqual(timeline);
	appendFileSync(log, '{"interrupted":\n');
	manager.updateState(run, { checkpoint: { id: "custom", data: { position: "recover" } } });
	const afterGap = loadSureCheckpointTimeline(run, index);
	expect(afterGap.unreadableOffsets).toEqual([text.length]);
	expect(afterGap.transitions.at(-1)?.previousLogOffset).toBeNull();
	expect(afterGap.transitions.at(-1)?.changes.every((change) => change.before === "[not recorded]")).toBe(true);
});
it.each([
	{ name: "Unicode lines", text: "行🌍\n".repeat(5001) },
	{ name: "single long line", text: "中🌍".repeat(50_000) },
	{ name: "surrogate at byte boundary", text: `${"A".repeat(51_199)}🌍${"B".repeat(100)}` },
	{ name: "line limit", text: `${"short\n".repeat(2100)}tail` },
])("reconstructs $name within baseline byte/line limits", ({ text }) => {
	let offset = 0;
	let assembled = "";
	do {
		const page = pageSureDiagnosticValue(text, offset);
		expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(50 * 1024);
		expect(page.text.split("\n").length - Number(page.text.endsWith("\n"))).toBeLessThanOrEqual(2000);
		expect(page.text).not.toContain("�");
		expect(page.nextOffset).toBeGreaterThan(offset);
		assembled += page.text;
		offset = page.nextOffset;
	} while (offset < text.length);
	expect(assembled).toBe(text);
});
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});
async function setup() {
	const harness = await createHarness();
	harnesses.push(harness);
	const run: SureRunRecord = {
		runId: "index-test",
		skillName: "demo",
		command: "sure_feed",
		status: "running",
		cwd: harness.tempDir,
		packageDir: harness.tempDir,
		runDir: join(harness.tempDir, ".sure/runs/index-test"),
		args: "",
		startedAt: "now",
		updatedAt: "now",
	};
	mkdirSync(join(run.runDir, "artifacts"), { recursive: true });
	return new SureCoordinator(run, "stage", ["run:artifacts"]);
}
it("ignores interrupted hook writes without hiding corrupt published records", async () => {
	const coordinator = await setup();
	const hooks = join(coordinator.run.runDir, "evidence/hooks");
	mkdirSync(hooks, { recursive: true });
	const record = {
		id: "invocation-0",
		invocationId: "invocation",
		invocationAttempt: 1,
		index: 0,
		point: "post_tool_result",
		module: "hooks.ts",
		handler: "check",
		status: "completed",
		startedAt: "2026-10-17T00:00:00Z",
		finishedAt: "2026-10-17T00:00:00Z",
		result: { ok: true },
	};
	writeFileSync(join(hooks, "invocation-0.json"), JSON.stringify(record));
	const before = loadSureDiagnosticIndex(coordinator);
	expect(before.hooks).toEqual([record]);
	writeFileSync(join(hooks, "invocation-0.json.interrupted.tmp"), '{"id":');
	writeFileSync(join(hooks, "invocation-1.json.unpublished.tmp"), JSON.stringify(record));
	expect(loadSureDiagnosticIndex(new SureCoordinator(coordinator.run, "stage", []))).toEqual(before);
	writeFileSync(join(hooks, "corrupt.json"), '{"id":');
	expect(() => loadSureDiagnosticIndex(coordinator)).toThrow(SyntaxError);
});
it("indexes every stage and check beyond the former 1024-record cutoff", async () => {
	const coordinator = await setup();
	const evidence = join(coordinator.run.runDir, "evidence");
	mkdirSync(evidence, { recursive: true });
	for (let version = 1; version <= 1100; version++)
		writeFileSync(
			join(evidence, `${version}.json`),
			JSON.stringify({
				check: {
					unitId: `stage-${Math.floor((version - 1) / 40)}`,
					outcome: "pending",
					summary: `CHECK_${version}`,
					inputPaths: [`run:artifacts/input-${version}.json`],
					artifactPaths: [],
				},
				snapshotId: coordinator.state.latestSnapshot,
				timestamp: "now",
			}),
		);
	const index = loadSureDiagnosticIndex(coordinator);
	expect(index.checks).toHaveLength(1100);
	expect(index.stages).toHaveLength(28);
	expect(index.stages[0]).toMatchObject({ firstCheck: 1, lastCheck: 40, checks: 40 });
	let assembled = "",
		offset = 0;
	while (true) {
		const page = pageSureDiagnosticValue(index.checks, offset);
		expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(50 * 1024);
		assembled += page.text;
		offset = page.nextOffset;
		if (page.complete) break;
	}
	expect(JSON.parse(assembled)).toEqual(index.checks);
	expect(assembled).toContain("CHECK_550");
});
it("round-trips every compact diff identity while preserving unknown capture status", () => {
	const entries = Array.from({ length: 277 }, (_, index) => ({
		path: `run:artifacts/stage-${index % 5}/file-${index}.json`,
		before: index % 2 ? "text" : "not_captured",
		after: index % 2 ? "not_captured" : "missing",
	}));
	const packed = packSureDiffIndex(entries);
	const restored = packed.groups.flatMap(({ before, after, directories }) =>
		Object.entries(directories).flatMap(([directory, names]) =>
			names.map((name) => ({ path: directory + name, before, after })),
		),
	);
	expect(restored.sort((a, b) => a.path.localeCompare(b.path))).toEqual(
		entries.sort((a, b) => a.path.localeCompare(b.path)),
	);
	expect(packed.count).toBe(277);
	expect(JSON.stringify(packed).length).toBeLessThan(JSON.stringify(entries).length);
});

it("pages a large historical diff and focuses on an indexed path without losing its middle", async () => {
	const coordinator = await setup(),
		run = coordinator.run;
	const path = join(run.runDir, "artifacts/code.py");
	writeFileSync(path, `${"old line\n".repeat(1800)}OLD_MIDDLE\n${"old line\n".repeat(1800)}`);
	const before = captureSureSnapshot(run, "stage", "passed", ["run:artifacts"]);
	writeFileSync(path, `${"new line\n".repeat(1800)}NEW_MIDDLE\n${"new line\n".repeat(1800)}`);
	writeFileSync(join(run.runDir, "artifacts/other.py"), "other");
	const after = captureSureSnapshot(run, "stage", "failed", ["run:artifacts"]);
	expect(sureDiffIndex(before, after).map((file) => file.path)).toContain("run:artifacts/code.py");
	const selected = sureSnapshotForPath(coordinator, after.id, "run:artifacts/code.py");
	expect(selected.files).toHaveLength(1);
	const diff = diffSureSnapshots(sureSnapshotForPath(coordinator, before.id, "run:artifacts/code.py"), selected);
	let assembled = "",
		offset = 0;
	while (true) {
		const page = pageSureDiagnosticValue(diff, offset);
		assembled += page.text;
		offset = page.nextOffset;
		if (page.complete) break;
	}
	expect(assembled).toBe(diff);
	expect(assembled).toContain("-OLD_MIDDLE");
	expect(assembled).toContain("+NEW_MIDDLE");
	expect(assembled).not.toContain("other.py");
});

it("indexes only actual passed outputs and keeps their historical meaning after deletion or missing capture", async () => {
	const coordinator = await setup();
	const path = "run:artifacts/research.json";
	writeFileSync(join(coordinator.run.runDir, "artifacts/research.json"), "research");
	for (const [unitId, outcome] of [
		["research", "passed"],
		["optional", "skipped"],
		["prepare", "pending"],
	] as const)
		coordinator.observe({ unitId, outcome, summary: outcome, inputPaths: [], artifactPaths: [path] }, [path]);
	rmSync(join(coordinator.run.runDir, "artifacts/research.json"));
	coordinator.barrier([path]);
	const stages = loadSureDiagnosticIndex(coordinator).stages;
	expect(stages[0]).toMatchObject({ lastPassed: { checkVersion: 1, artifactPaths: [path] } });
	expect(stages[1].lastPassed).toBeUndefined();
	expect(stages[2].lastPassed).toBeUndefined();
	const deleted = sureSnapshotForPath(coordinator, coordinator.state.latestSnapshot!, path);
	expect(deleted.files).toMatchObject([{ path, status: "missing" }]);
	coordinator.barrier([]);
	expect(loadSureDiagnosticIndex(coordinator).stages[0].lastPassed).toEqual(stages[0].lastPassed);
	expect(sureSnapshotForPath(coordinator, coordinator.state.latestSnapshot!, path).files).toEqual([]);
	const replacement = "run:artifacts/replacement.json";
	writeFileSync(join(coordinator.run.runDir, "artifacts/replacement.json"), "new research");
	coordinator.observe(
		{
			unitId: "research",
			outcome: "passed",
			summary: "Updated research verified",
			inputPaths: [],
			artifactPaths: [replacement],
		},
		[replacement],
	);
	const lastPassed = { checkVersion: coordinator.state.evidenceVersion, artifactPaths: [replacement] };
	coordinator.observe(
		{
			unitId: "research",
			outcome: "pending",
			summary: "Another attempt is pending",
			inputPaths: [],
			artifactPaths: [path],
		},
		[path],
	);
	expect(loadSureDiagnosticIndex(coordinator).stages[0].lastPassed).toEqual(lastPassed);
});
