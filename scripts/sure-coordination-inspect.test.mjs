import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { captureComparisonSource, inspectCoordinationRun } from "./sure-coordination-inspect.mjs";

test("indexes one persistent supervisor transcript across multiple attempts", () => {
	const dir = mkdtempSync(join(tmpdir(), "sure-inspect-persistent-"));
	try {
		const file = join(dir, "supervisor.jsonl");
		writeFileSync(join(dir, "run.json"), JSON.stringify({
			startedAt: "2026-10-14T00:00:00Z", finishedAt: "2026-10-14T00:00:10Z",
		}));
		writeFileSync(join(dir, "coordination.json"), JSON.stringify({
			supervisorSession: { id: "persistent", file },
			attempts: ["first", "second"].map((id) => ({ id, supervisorSessionId: "persistent" })),
		}));
		writeFileSync(file, JSON.stringify({
			id: "response", type: "message", timestamp: "2026-10-14T00:00:05Z",
			message: { role: "assistant", provider: "faux", model: "demo",
				usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 } },
		}));
		const summary = inspectCoordinationRun(dir);
		assert.equal(summary.usage.supervisor.files, 1);
		assert.equal(summary.usage.supervisor.responses, 1);
		assert.deepEqual(summary.usage.missingSupervisorSessions, []);
		rmSync(file);
		assert.deepEqual(inspectCoordinationRun(dir).usage.missingSupervisorSessions, ["first", "second"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("counts both roles and compaction within the run, deduplicating copied responses", () => {
	const dir = mkdtempSync(join(tmpdir(), "sure-inspect-"));
	const save = (path, value) => {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), JSON.stringify(value));
	};
	const timestamp = "2026-10-13T00:00:05Z";
	const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18 };
	const response = {
		id: "response",
		type: "message",
		timestamp,
		message: { role: "assistant", provider: "faux", model: "demo", usage },
	};
	try {
		save("run.json", {
			runId: "test",
			status: "failed",
			startedAt: "2026-10-13T00:00:00Z",
			finishedAt: "2026-10-13T00:00:10Z",
		});
		save("coordination.json", {
			attempts: [{ id: "diagnosis", modelTurns: 8, readCalls: 12, readRequests: 13, segments: [{ modelTurns: 4, readCalls: 8 }, { modelTurns: 4, readCalls: 4 }], checkpoint: { decision: "checkpoint", automatic: false }, compactionCalls: 1 }],
			repairs: [
				{
					id: "repair",
					unitId: "stage",
					outcome: "passed",
					beforeSnapshotId: "missing",
					checkVersions: [1, 2],
				},
				{
					id: "current-repair", source: "supervisor", unitId: "stage", task: "Repair the original condition.",
					outcome: "passed", beforeSnapshotId: "before", afterSnapshotId: "after", checkVersions: [3],
				},
			],
		});
		save("evidence/1.json", { repairId: "different", check: { unitId: "stage", outcome: "passed" } });
		save("snapshots/before.json", { id: "before", files: [] });
		save("snapshots/after.json", { id: "after", files: [] });
		save("evidence/3.json", { version: 3, repairId: "current-repair", snapshotId: "after", check: { unitId: "stage", outcome: "passed", inputPaths: [], artifactPaths: [], summary: "Original gate passed" } });
		const executor = join(dir, "executor.jsonl");
		writeFileSync(
			executor,
			[
				response,
				{ ...response, id: "before", timestamp: "2026-10-12T23:59:59Z" },
				{ ...response, id: "after", timestamp: "2026-10-13T00:00:11Z" },
				{ id: "compact", type: "compaction", timestamp, usage },
				{ id: "branch", type: "branch_summary", timestamp, usage },
			]
				.map(JSON.stringify)
				.join("\n"),
		);
		save("diagnoses/diagnosis/session/supervisor.jsonl", { ...response, id: "supervisor" });
		const summary = inspectCoordinationRun(dir, [executor, executor]);
		assert.equal(summary.elapsedMs, 10_000);
		assert.equal(summary.usage.executor.files, 1);
		assert.equal(summary.usage.executor.responses, 3);
		assert.equal(summary.usage.executor.compactions, 1);
		assert.equal(summary.usage.executor.branchSummaries, 1);
		assert.equal(summary.usage.supervisor.responses, 1);
		assert.equal(summary.coordination.attempts[0].segments.length, 2);
		assert.equal(summary.coordination.attempts[0].readRequests, 13);
		assert.equal(summary.coordination.attempts[0].checkpoint.decision, "checkpoint");
		assert.equal(summary.usage.combinedReportedTokens.totalTokens, 72);
		const copy = join(dir, "copied-executor.jsonl");
		writeFileSync(copy, JSON.stringify(response));
		assert.equal(inspectCoordinationRun(dir, [executor, copy]).usage.combinedReportedTokens.totalTokens, 72);
		assert.deepEqual(summary.coordination.repairs[1].issues, []);
		assert.deepEqual(summary.coordination.repairs[1].checks, [{ version: 3, outcome: "passed", snapshotId: "after" }]);
		assert.deepEqual(summary.coordination.repairs[0].issues, [
			"Missing before snapshot: missing",
			"Mismatched repair identity at check:1",
			"Missing check:2",
		]);
		assert.equal(inspectCoordinationRun(dir).usage.combinedReportedTokens, null);
		save("diagnoses/diagnosis/session/supervisor.jsonl", { ...response, message: { role: "assistant" } });
		assert.equal(inspectCoordinationRun(dir, [executor]).usage.combinedReportedTokens, null);
		rmSync(join(dir, "diagnoses"), { recursive: true });
		assert.deepEqual(inspectCoordinationRun(dir, [executor]).usage.missingSupervisorSessions, ["diagnosis"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("keeps missing or invalid recorded usage unknown while accepting an explicit zero", () => {
	const dir = mkdtempSync(join(tmpdir(), "sure-inspect-usage-"));
	try {
		writeFileSync(join(dir, "run.json"), JSON.stringify({ startedAt: "2026-10-15T00:00:00Z", finishedAt: "2026-10-15T00:00:10Z" }));
		const file = join(dir, "executor.jsonl");
		const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
		for (const usage of [undefined, { ...zero, cacheRead: undefined }, { ...zero, cacheRead: "0" }, { ...zero, cacheRead: null }, { ...zero, cacheRead: -1 }, zero]) {
			writeFileSync(file, JSON.stringify({ id: "response", type: "message", timestamp: "2026-10-15T00:00:05Z", message: { role: "assistant", provider: "faux", model: "fixture", usage } }));
			const summary = inspectCoordinationRun(dir, [file]);
			assert.equal(summary.usage.executor.missingUsage, usage === zero ? 0 : 1);
			assert.deepEqual(summary.usage.combinedReportedTokens, usage === zero ? zero : null);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reads version 2 gate observations without claiming supervisor task completion", () => {
	const dir = mkdtempSync(join(tmpdir(), "sure-inspect-v2-"));
	try {
		writeFileSync(join(dir, "run.json"), JSON.stringify({ startedAt: "2026-10-15T00:00:00Z" }));
		mkdirSync(join(dir, "evidence"));
		writeFileSync(join(dir, "coordination.json"), JSON.stringify({
			version: 2, status: "executing", unresolvedCheckVersion: 1, reviewedFailureVersion: 1,
			repairs: [{ id: "task", unitId: "unit", kind: "evidence", checkVersions: [2], gateOutcome: "passed", gateCheckVersion: 2 }],
		}));
		writeFileSync(join(dir, "evidence/2.json"), JSON.stringify({ repairId: "task", check: { unitId: "unit", outcome: "passed" } }));
		const result = inspectCoordinationRun(dir).coordination;
		assert.equal(result.version, 2);
		assert.equal(result.reviewedFailureVersion, 1);
		assert.equal(result.repairs[0].gateOutcome, "passed");
		assert.equal(result.repairs[0].outcome, undefined);
		assert.deepEqual(result.repairs[0].issues, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("audits a standalone output export without its original run or transcript paths", () => {
	const dir = mkdtempSync(join(tmpdir(), "sure-inspect-export-"));
	try {
		const original = join(dir, "removed-run");
		const output = join(dir, "output");
		mkdirSync(join(output, "supervisor/session"), { recursive: true });
		writeFileSync(join(output, "result.json"), JSON.stringify({ schema: "sure.run_result.v1", run_id: "export", run_dir: original, status: "failed", started_at: "2026-10-15T00:00:00Z", finished_at: "2026-10-15T00:00:10Z" }));
		writeFileSync(join(output, "coordination.json"), JSON.stringify({ supervisorSession: { id: "session", file: join(original, "supervisor/session/run.jsonl") }, attempts: [{ id: "attempt", supervisorSessionId: "session" }] }));
		const text = JSON.stringify({ id: "response", type: "message", timestamp: "2026-10-15T00:00:05Z", message: { role: "assistant", provider: "faux", model: "fixture", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 } } });
		writeFileSync(join(output, "supervisor/session/run.jsonl"), text);
		const summary = inspectCoordinationRun(output);
		assert.equal(summary.runId, "export");
		assert.deepEqual(summary.usage.missingSupervisorSessions, []);
		assert.equal(summary.usage.supervisor.reportedTokens.totalTokens, 3);
		assert.deepEqual(summary.storage.supervisor, { files: 1, bytes: Buffer.byteLength(text) });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("captures exact source and explicitly supplied input identities without changing them", () => {
	const dir = mkdtempSync(join(tmpdir(), "sure-comparison-source-"));
	try {
		const repo = resolve(import.meta.dirname, "..");
		const input = join(dir, "wrapper.py");
		writeFileSync(input, "original fixture");
		writeFileSync(join(dir, "auth.json"), "Do not capture credentials");
		const before = captureComparisonSource(repo, [input, join(dir, "missing"), join(dir, "auth.json")]);
		const diff = execFileSync("git", ["-c", "core.fsmonitor=false", "--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--"], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
		assert.equal(before.dirtyDiffSha256, createHash("sha256").update(diff).digest("hex"));
		assert.match(before.commit, /^[a-f0-9]{40}$/);
		assert.equal(before.files.find((file) => file.path.endsWith("missing")).sha256, null);
		assert.equal(before.files.find((file) => file.path.endsWith("auth.json")).sha256, null);
		writeFileSync(input, "changed fixture");
		const after = captureComparisonSource(repo, [input]);
		assert.equal(before.dirtyDiffSha256, after.dirtyDiffSha256);
		assert.notEqual(before.files.find((file) => file.path === input).sha256, after.files.find((file) => file.path === input).sha256);
		assert.equal(after.untrackedSourcesSha256, createHash("sha256").update(JSON.stringify(after.untrackedSources)).digest("hex"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
