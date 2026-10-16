import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSureCheckEvidence, parseSureCoordinationPolicy } from "../../src/core/sure/coordination-contracts.ts";
import { SureCoordinator } from "../../src/core/sure/coordinator.ts";
import {
	captureSureSnapshot,
	diffSureSnapshots,
	readSureSnapshot,
	resolveSureEvidencePath,
} from "../../src/core/sure/evidence.ts";
import type { SureCheckEvidence, SureRunRecord } from "../../src/core/sure/types.ts";
import { syncSureUserContext } from "../../src/core/sure/user-context.ts";

const directories: string[] = [];
function setup(): SureRunRecord {
	const cwd = mkdtempSync(join(tmpdir(), "sure-coordination-"));
	directories.push(cwd);
	const runDir = join(cwd, ".sure", "runs", "test-run");
	mkdirSync(join(runDir, "artifacts"), { recursive: true });
	return {
		runId: "test-run",
		skillName: "sure_onboard",
		command: "sure_onboard",
		status: "running",
		cwd,
		packageDir: cwd,
		runDir,
		args: "",
		startedAt: "2026-10-10T00:00:00Z",
		updatedAt: "2026-10-10T00:00:00Z",
	};
}

function check(
	outcome: SureCheckEvidence["outcome"] = "blocked",
	failureKind: SureCheckEvidence["failureKind"] = "semantic",
): SureCheckEvidence {
	return {
		unitId: "build_env",
		outcome,
		failureKind,
		summary: "Environment check",
		artifactPaths: ["run:artifacts/env.json"],
		inputPaths: [],
	};
}

afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Sure coordinator persistence and evidence", () => {
	it("reassesses legacy stops without altering historical diagnosis files or counters", () => {
		const run = setup();
		const coordinator = new SureCoordinator(run, "build_env", []);
		coordinator.observe(check(), []);
		coordinator.beginDiagnosis();
		const attempt = coordinator.state.attempts.at(-1)!;
		attempt.result = {
			runId: run.runId,
			unitId: "build_env",
			evidenceVersion: 1,
			decision: "stop",
			facts: [],
			hypotheses: [],
			unknowns: ["Effective policy unknown"],
			evidenceReferences: ["check:1"],
			nextActions: [],
			stopReason: "Policy absent",
		};
		const dir = join(run.runDir, "diagnoses", attempt.id);
		mkdirSync(dir, { recursive: true });
		const raw = JSON.stringify(attempt.result);
		writeFileSync(join(dir, "result.json"), raw);
		coordinator.stop("Policy absent");
		const restored = new SureCoordinator(run, "build_env", []);
		expect(restored.state.status).toBe("yielding");
		expect(restored.state.stopReason).toBeUndefined();
		expect(restored.state.units.build_env).toMatchObject({ checks: 1, directRepairs: 1, supervisorRepairs: 0 });
		expect(restored.state.attempts[0].result).toEqual(attempt.result);
		expect(readFileSync(join(dir, "result.json"), "utf8")).toBe(raw);
	});

	it("preserves a correction identity on new user constraints without renewing its opportunity", () => {
		const run = setup();
		const coordinator = new SureCoordinator(run, "build_env", []);
		coordinator.observe({ ...check("blocked", "tool"), recovery: "local_once" }, []);
		syncSureUserContext(coordinator, [{ role: "user", timestamp: 1, content: "Do not alter the input file." }]);
		expect(coordinator.state.pendingDirectRepairId).toBeDefined();
		expect(coordinator.state.status).toBe("yielding");
		expect(coordinator.state.units.build_env.directRepairs).toBe(1);
		expect(coordinator.state.repairs?.[0].outcome).toBe("blocked");
	});
	it("deduplicates a tool-result check across restart before granting or charging another repair", () => {
		const run = setup();
		let coordinator = new SureCoordinator(run, "build_env", []);
		const evidence: SureCheckEvidence = {
			...check("blocked", "tool"),
			recovery: "local_once",
			action: { toolCallId: "same", toolName: "bash", path: "run:evidence/tools/same.json" },
		};
		coordinator.observe(evidence, []);
		coordinator = new SureCoordinator(run, "build_env", []);
		coordinator.observe(evidence, []);
		expect(coordinator.state.units.build_env).toMatchObject({ directRepairs: 1, checks: 1 });
		expect(coordinator.state.status).toBe("executing");
		coordinator.observe({ ...evidence, action: { ...evidence.action!, toolCallId: "new" } }, []);
		expect(coordinator.state.status).toBe("executing");
		expect(coordinator.state.units.build_env.directRepairs).toBe(1);
	});

	it("retains legacy counters while a distinct later error still receives a correction", () => {
		const run = setup();
		const coordinator = new SureCoordinator(run, "build_env", []);
		coordinator.observe(check("blocked", "format"), []);
		const path = join(run.runDir, "coordination.json");
		const saved = JSON.parse(readFileSync(path, "utf8"));
		saved.units.build_env.formatRepairs = 1;
		delete saved.units.build_env.directRepairs;
		writeFileSync(path, JSON.stringify(saved));
		const restored = new SureCoordinator(run, "build_env", []);
		expect(restored.state.units.build_env.directRepairs).toBe(1);
		restored.observe({ ...check("blocked", "tool"), recovery: "local_once" }, []);
		expect(restored.state.status).toBe("executing");
		expect(restored.state.units.build_env.directRepairs).toBe(2);
	});
	it("gives an explicitly recoverable tool failure one direct repair, preserves reads and records original-gate validation", () => {
		const run = setup();
		const coordinator = new SureCoordinator(run, "build_env", ["run:artifacts"]);
		coordinator.observe(
			{ ...check("blocked", "tool"), recovery: "local_once", repair: "Inspect and correct the call." },
			[],
		);
		expect(coordinator.state.status).toBe("executing");
		expect(coordinator.state.units.build_env.directRepairs).toBe(1);
		expect(coordinator.directRepair?.source).toBe("executor");
		coordinator.observe(check("pending"), []);
		coordinator.observe(check("unchanged", "no_progress"), []);
		expect(coordinator.state.status).toBe("executing");
		expect(coordinator.directRepair?.outcome).not.toBe("passed");
		writeFileSync(join(run.runDir, "artifacts/env.json"), '{"ready":true}');
		coordinator.observe(check("passed"), ["run:artifacts"]);
		expect(coordinator.directRepair).toBeUndefined();
		expect(coordinator.state.repairs?.[0]).toMatchObject({
			source: "executor",
			outcome: "passed",
			checkVersions: [1, 4],
		});
		expect(new SureCoordinator(run, "build_env", []).state.units.build_env.directRepairs).toBe(1);
	});
	it.each(["format", "tool", "semantic", "execution", "checker_exception", undefined] as const)(
		"gives a first %s error a correction regardless of recovery hints or past supervision",
		(kind) => {
			const coordinator = new SureCoordinator(setup(), "build_env", []);
			coordinator.state.units.build_env = { checks: 50, noProgress: 0, directRepairs: 9, supervisorRepairs: 7 };
			coordinator.observe({ ...check("blocked", kind), failureKind: kind, recovery: "diagnose" }, []);
			expect(coordinator.state.status).toBe("executing");
			expect(coordinator.state.units.build_env.directRepairs).toBe(10);
		},
	);
	it("does not renew an unresolved correction just because feedback or inputs change", () => {
		const run = setup();
		let coordinator = new SureCoordinator(run, "build_env", []);
		coordinator.observe(check(), []);
		const repair = coordinator.directRepair!;
		coordinator.observe({ ...check(), summary: "Reworded failure", inputPaths: ["run:artifacts/new.json"] }, []);
		coordinator = new SureCoordinator(run, "build_env", []);
		expect(coordinator.state.units.build_env.directRepairs).toBe(1);
		coordinator.verifyRepair(repair.id, 2, "recheck");
		expect(coordinator.state.status).toBe("yielding");
		expect(coordinator.state.repairs![0].verificationCheckVersion).toBe(2);
	});
	it("gives distinct checks their own corrections and keeps same-batch errors unattempted", () => {
		const coordinator = new SureCoordinator(setup(), "build_env", []);
		for (const toolCallId of ["one", "two"])
			coordinator.observe(
				{
					...check("blocked", "tool"),
					action: {
						toolCallId,
						toolName: "bash",
						path: `run:evidence/tools/${toolCallId}.json`,
						batchId: "batch",
					},
				},
				[],
			);
		expect(coordinator.directRepairs).toHaveLength(2);
		expect(coordinator.state.status).toBe("executing");
		expect(() => coordinator.verifyRepair(coordinator.directRepairs[0].id, 2, "recheck")).toThrow("trigger batch");
	});
	it("retains a later source's first correction when an earlier recheck in the batch already yielded", () => {
		const coordinator = new SureCoordinator(setup(), "build_env", []);
		coordinator.observe({ ...check(), sourceId: "original", checkId: "first" }, []);
		coordinator.observe({ ...check(), sourceId: "original", checkId: "recheck" }, []);
		expect(coordinator.state.status).toBe("yielding");
		coordinator.observe({ ...check(), sourceId: "other", checkId: "later-result" }, []);
		coordinator.beginDiagnosis();
		expect(coordinator.directRepairs).toHaveLength(1);
		expect(coordinator.directRepairs[0].triggerCheckVersion).toBe(3);
	});
	it("requires retained original-condition evidence and keeps verification idempotent", () => {
		const run = setup();
		const coordinator = new SureCoordinator(run, "build_env", []);
		coordinator.observe({ ...check(), sourceId: "original", checker: "gate" }, []);
		const repair = coordinator.directRepair!;
		coordinator.observe({ ...check("pending"), sourceId: "original", checker: "gate" }, []);
		expect(() => coordinator.verifyRepair(repair.id, 2, "recheck")).toThrow("Pending or unchanged");
		expect(() => coordinator.verifyRepair(repair.id, 2, "independent")).toThrow("actual blocked");
		coordinator.observe({ ...check(), sourceId: "other", checker: "other" }, []);
		expect(() => coordinator.verifyRepair(repair.id, 3, "recheck")).toThrow("original checker");
		expect(repair.verificationCheckVersion).toBeUndefined();
		coordinator.observe({ ...check(), sourceId: "original", checker: "gate", summary: "Still failed" }, []);
		coordinator.verifyRepair(repair.id, 4, "recheck");
		coordinator.verifyRepair(repair.id, 4, "recheck");
		expect(repair.verificationCheckVersion).toBe(4);
		expect(JSON.parse(readFileSync(join(run.runDir, "evidence/4.json"), "utf8")).repairId).toBe(repair.id);
		expect(coordinator.state.status).toBe("yielding");
		expect(() => coordinator.verifyRepair(repair.id, 3, "recheck")).toThrow("already has a verification");
	});
	it.each(["skipped", "held", "returned"])(
		"verifies a tool correction only from a returned observation: %s",
		(kind) => {
			const run = setup();
			const coordinator = new SureCoordinator(run, "build_env", []);
			coordinator.observe(check("blocked", "tool"), []);
			const repair = coordinator.directRepair!;
			mkdirSync(join(run.runDir, "evidence/tools"), { recursive: true });
			writeFileSync(
				join(run.runDir, "evidence/tools/next.json"),
				JSON.stringify({
					execution: kind === "skipped" ? "skipped" : "returned",
					duringHold: kind === "held",
					isError: false,
				}),
			);
			coordinator.observe(
				{
					...check("pending"),
					action: {
						toolCallId: "next",
						toolName: "bash",
						path: "run:evidence/tools/next.json",
					},
				},
				[],
			);
			if (kind === "returned") {
				coordinator.verifyRepair(repair.id, 2, "recheck");
				expect(repair).toMatchObject({ verificationCheckVersion: 2, outcome: "passed" });
			} else {
				expect(() => coordinator.verifyRepair(repair.id, 2, "recheck")).toThrow("Skipped or held");
				expect(repair.verificationCheckVersion).toBeUndefined();
			}
			expect(coordinator.state.status).toBe("executing");
		},
	);
	it("does not let work-volume thresholds preempt a pending local correction", () => {
		const coordinator = new SureCoordinator(setup(), "build_env", []);
		coordinator.observe(check(), []);
		for (let index = 0; index < 40; index++) {
			coordinator.recordAction("build_env", "read", { path: "changing-input" });
			coordinator.observe(check("pending"), []);
			coordinator.recordToolBatch("build_env", `batch:${index}`);
		}
		expect(coordinator.state.status).toBe("executing");
		expect(coordinator.directRepairs).toHaveLength(1);
		expect(coordinator.state.units.build_env).toMatchObject({ calls: 40, checks: 41, directRepairs: 1 });
	});
	it("validates declared budgets and retains the original limits and spent counters on resume", () => {
		const policy = {
			version: 1,
			commonPrompt: "common.md",
			stages: [{ id: "build_env", prompt: "stage.md", references: [], snapshotPaths: [] }],
			budgets: { checksPerUnit: 2, supervisorRepairsPerUnit: 1 },
		};
		const parsed = parseSureCoordinationPolicy(policy)!;
		expect(parsed.budgets).toEqual(policy.budgets);
		for (const budgets of [
			{ unknown: 2 },
			{ checksPerUnit: 0 },
			{ snapshotFiles: 1.5 },
			{ diagnosisElapsedMs: 120000 },
			{ diagnosisReadCalls: 8 },
			{ diagnosisModelTurns: 4 },
		])
			expect(() => parseSureCoordinationPolicy({ ...policy, budgets })).toThrow();
		const run = setup();
		const coordinator = new SureCoordinator(run, "build_env", [], parsed.budgets);
		coordinator.recordAction("build_env", "read", { path: "a" });
		const restored = new SureCoordinator(run, "build_env", [], { checksPerUnit: 100 });
		expect(restored.limits.checksPerUnit).toBe(2);
		expect(restored.state.units.build_env.calls).toBe(1);
		restored.recordAction("build_env", "read", { path: "b" });
		expect(restored.state.status).toBe("yielding");
		expect(restored.resumeBlocker).toBeUndefined();
		// An e3 run without saved limits keeps its original fixed allowance.
		delete restored.state.limits;
		restored.save();
		const oldRun = new SureCoordinator(run, "build_env", [], { checksPerUnit: 100 });
		expect(oldRun.limits.checksPerUnit).toBe(40);
		expect(JSON.parse(readFileSync(join(run.runDir, "coordination.json"), "utf8")).limits.checksPerUnit).toBe(40);
	});
	it("resets only soft stalls on skill-verified progress and preserves high-water marks and hard budgets on restart", () => {
		const run = setup();
		let coordinator = new SureCoordinator(run, "build_env", ["run:artifacts"]);
		const path = join(run.runDir, "artifacts/env.json");
		writeFileSync(path, '{"completed":0}');
		coordinator.observe({ ...check("pending"), progress: { key: "validated_parts", completed: 0 } }, [
			"run:artifacts",
		]);
		coordinator.state.units.build_env.noProgress = 2;
		coordinator.observe({ ...check("pending"), progress: { key: "validated_parts", completed: 1 } }, [
			"run:artifacts",
		]);
		expect(coordinator.state.units.build_env.noProgress).toBe(2);
		for (let completed = 1; completed <= 2; completed++) {
			coordinator.recordAction("build_env", "read", { path: "env.json" });
			writeFileSync(path, JSON.stringify({ completed }));
			coordinator.observe({ ...check("pending"), progress: { key: "validated_parts", completed } }, [
				"run:artifacts",
			]);
		}
		coordinator = new SureCoordinator(run, "build_env", []);
		coordinator.recordAction("build_env", "read", { path: "env.json" });
		expect(coordinator.state.status).toBe("executing");
		expect(coordinator.state.units.build_env).toMatchObject({
			calls: 3,
			checks: 4,
			noProgress: 0,
			progress: { completed: 2 },
		});
		// A changed irrelevant field, a new milestone key and a regressed counter
		// must not renew the allowance, even when declared files changed.
		writeFileSync(path, '{"completed":2,"irrelevant":"changed"}');
		coordinator.observe({ ...check("pending"), progress: { key: "validated_parts", completed: 2 } }, [
			"run:artifacts",
		]);
		coordinator.recordAction("build_env", "read", { path: "env.json" });
		writeFileSync(path, '{"completed":0}');
		coordinator.observe({ ...check("pending"), progress: { key: "renamed", completed: 99 } }, ["run:artifacts"]);
		coordinator.observe({ ...check("pending"), progress: { key: "validated_parts", completed: 0 } }, [
			"run:artifacts",
		]);
		coordinator.recordAction("build_env", "read", { path: "env.json" });
		expect(coordinator.state.status).toBe("executing");
		expect(coordinator.state.units.build_env.progress?.completed).toBe(2);
		expect(coordinator.state.units.build_env.calls).toBe(5);
	});

	it("requires explicit versioned opt-in and rejects ambiguous outcomes", () => {
		expect(parseSureCoordinationPolicy(undefined)).toBeUndefined();
		expect(() => parseSureCoordinationPolicy({ version: 2, stages: [] })).toThrow();
		expect(() => parseSureCheckEvidence({ ...check(), outcome: "maybe" })).toThrow();
		expect(() => parseSureCheckEvidence({ ...check(), progress: { key: "verified", completed: -1 } })).toThrow();
	});

	it("retains original historical text and reports additions, deletion and opaque content", () => {
		const run = setup();
		const path = join(run.runDir, "artifacts", "env.json");
		writeFileSync(path, '{"ready":false}\n');
		const before = captureSureSnapshot(run, "build_env", "initial", ["run:artifacts"]);
		writeFileSync(path, '{"ready":true}\n');
		writeFileSync(join(run.runDir, "artifacts", "new.py"), "print('new')\n");
		writeFileSync(join(run.runDir, "artifacts", "opaque.bin"), Buffer.from([0, 1, 2]));
		writeFileSync(join(run.runDir, "artifacts", "large.txt"), Buffer.alloc(300_000));
		const after = captureSureSnapshot(run, "build_env", "failed", ["run:artifacts"]);
		const diff = diffSureSnapshots(readSureSnapshot(run, before.id), after);
		expect(diff).toContain('-{"ready":false}');
		expect(diff).toContain('+{"ready":true}');
		expect(diff).toContain("print('new')");
		expect(after.files.find((file) => file.path.endsWith("opaque.bin"))?.status).toBe("binary");
		expect(after.files.find((file) => file.path.endsWith("large.txt"))?.status).toBe("over_limit");
		rmSync(path);
		expect(diffSureSnapshots(after, captureSureSnapshot(run, "build_env", "failed", ["run:artifacts"]))).toContain(
			'-{"ready":true}',
		);
		expect(resolveSureEvidencePath(run, "project:../../outside")).toBeUndefined();
	});

	it("keeps a diagnosis current when the same evidence is declared with overlapping paths", () => {
		const run = setup();
		writeFileSync(join(run.runDir, "artifacts/a.json"), '{"ready":false}');
		writeFileSync(join(run.runDir, "artifacts/z.json"), '{"ready":false}');
		const coordinator = new SureCoordinator(run, "build_env", ["run:artifacts"]);
		coordinator.observe(check(), ["run:artifacts"]);
		const version = coordinator.state.evidenceVersion;
		const before = readSureSnapshot(run, coordinator.state.latestSnapshot!);
		const after = coordinator.barrier([
			"run:artifacts",
			"run:artifacts/z.json",
			join(run.runDir, "artifacts/a.json"),
		]);
		expect(after.files).toHaveLength(before.files.length);
		expect(diffSureSnapshots(before, after)).toBe("");
		expect(coordinator.state.evidenceVersion).toBe(version);
		const restored = new SureCoordinator(run, "build_env", []);
		restored.barrier(["run:artifacts"]);
		expect(restored.state.evidenceVersion).toBe(version);
		writeFileSync(join(run.runDir, "artifacts/a.json"), '{"ready":true}');
		restored.barrier(["run:artifacts"]);
		expect(restored.state.evidenceVersion).toBe(version + 1);
	});

	it("distinguishes changed capture scopes and omitted content from actual file deletion", () => {
		const run = setup();
		writeFileSync(join(run.cwd, "schema.json"), '{"type":"object"}\n');
		const artifact = join(run.runDir, "artifacts/env.json");
		writeFileSync(artifact, '{"ready":false}\n');
		const before = captureSureSnapshot(run, "plan", "passed", ["project:schema.json", "run:artifacts"]);
		const after = captureSureSnapshot(run, "build_env", "failed", ["run:artifacts"]);
		const changedScope = diffSureSnapshots(before, after);
		expect(changedScope).toContain("not captured in current scope");
		expect(changedScope).not.toContain('-{"type":"object"}');
		writeFileSync(artifact, Buffer.from([0, 1, 2]));
		const opaque = diffSureSnapshots(after, captureSureSnapshot(run, "build_env", "failed", ["run:artifacts"]));
		expect(opaque).toContain("text -> binary");
		expect(opaque).not.toContain('-{"ready":false}');
	});

	it("records an optional skipped check without promoting it to a successful baseline", () => {
		const run = setup();
		const coordinator = new SureCoordinator(run, "build_env", ["run:artifacts"]);
		coordinator.observe(check("passed"), ["run:artifacts"]);
		const lastSuccess = coordinator.state.lastSuccessSnapshot;
		const skipped = parseSureCheckEvidence({
			...check("skipped", "checker_exception"),
			unitId: "extract_lessons",
			summary: "Optional extraction checker was unavailable; no lesson was accepted.",
		})!;
		coordinator.observe(skipped, ["run:artifacts"]);
		expect(coordinator.state.status).toBe("executing");
		expect(coordinator.state.lastSuccessSnapshot).toBe(lastSuccess);
		expect(coordinator.state.lastSuccessUnit).toBe("build_env");
		expect(coordinator.state.units.extract_lessons.noProgress).toBe(0);
		expect(JSON.parse(readFileSync(join(run.runDir, "evidence/2.json"), "utf8")).check).toEqual(skipped);
	});

	it("rejects stale diagnosis, delivers idempotently and keeps budgets on restart", () => {
		const run = setup();
		let coordinator = new SureCoordinator(run, "build_env", ["run:artifacts"]);
		coordinator.observe(check(), ["run:artifacts"]);
		const result = {
			runId: run.runId,
			unitId: "build_env",
			evidenceVersion: coordinator.state.evidenceVersion,
			decision: "repair",
			facts: ["Env check failed"],
			hypotheses: [],
			unknowns: [],
			repair: "Fix the declared environment and rerun its gate.",
			evidenceReferences: ["check:1"],
			targetFiles: ["run:artifacts/env.json"],
			validation: "Rerun the original environment gate.",
			stopBoundary: "Stop after one repair attempt.",
			nextActions: [],
		};
		expect(coordinator.acceptDiagnosis({ ...result, evidenceVersion: 0 })).toBe(false);
		expect(coordinator.acceptDiagnosis(result)).toBe(true);
		expect(coordinator.acceptDiagnosis(result)).toBe(true);
		expect(coordinator.state.units.build_env.supervisorRepairs).toBe(1);
		coordinator = new SureCoordinator(run, "build_env", []);
		expect(coordinator.state.units.build_env.supervisorRepairs).toBe(1);
		coordinator.observe(check(), ["run:artifacts"]);
		coordinator.verifyRepair(
			`${result.unitId}:${result.evidenceVersion}`,
			coordinator.state.evidenceVersion,
			"recheck",
		);
		expect(coordinator.state.repairs?.find((repair) => repair.source === "supervisor")).toMatchObject({
			id: `${result.unitId}:${result.evidenceVersion}`,
			outcome: "blocked",
			checkVersions: [2],
			remainingBlocker: "Environment check",
		});
		expect(JSON.parse(readFileSync(join(run.runDir, "evidence/2.json"), "utf8")).repairId).toBe(
			coordinator.state.repairs?.find((repair) => repair.source === "supervisor")?.id,
		);
		coordinator.acceptDiagnosis({ ...result, evidenceVersion: coordinator.state.evidenceVersion });
		coordinator.observe(check(), ["run:artifacts"]);
		coordinator.acceptDiagnosis({ ...result, evidenceVersion: coordinator.state.evidenceVersion });
		expect(coordinator.state.status).toBe("executing");
		expect(coordinator.state.stopReason).toBeUndefined();
		expect(
			JSON.parse(readFileSync(join(run.runDir, "coordination.json"), "utf8")).units.build_env.supervisorRepairs,
		).toBe(3);
	});

	it("retains a passed repair's snapshots and gate references after clearing its outbox", () => {
		const run = setup();
		const coordinator = new SureCoordinator(run, "build_env", ["run:artifacts"]);
		writeFileSync(join(run.runDir, "artifacts/env.json"), '{"ready":false}');
		coordinator.observe(check(), ["run:artifacts"]);
		coordinator.acceptDiagnosis({
			runId: run.runId,
			unitId: "build_env",
			evidenceVersion: 1,
			decision: "repair",
			facts: [],
			hypotheses: [],
			unknowns: [],
			repair: "Fix env",
			evidenceReferences: ["check:1"],
			targetFiles: [],
			validation: "Original gate",
			stopBoundary: "One attempt",
			nextActions: [],
		});
		const before = coordinator.state.latestSnapshot;
		writeFileSync(join(run.runDir, "artifacts/env.json"), '{"ready":true}');
		coordinator.observe(check("passed"), ["run:artifacts"]);
		expect(coordinator.state.pendingRepair).toBeUndefined();
		const restored = new SureCoordinator(run, "build_env", []);
		expect(restored.state.repairs?.find((repair) => repair.source === "supervisor")).toMatchObject({
			outcome: "passed",
			beforeSnapshotId: before,
			afterSnapshotId: coordinator.state.latestSnapshot,
			checkVersions: [2],
			remainingBudget: { supervisorRepairs: 1 },
		});
		expect(
			diffSureSnapshots(
				readSureSnapshot(run, before!),
				readSureSnapshot(run, restored.state.repairs![0].afterSnapshotId!),
			),
		).toContain('+{"ready":true}');
	});

	it("keeps cancellation distinct and stops at the original gate cap", () => {
		const run = setup();
		const coordinator = new SureCoordinator(run, "build_env", []);
		coordinator.observe(check("exhausted"), []);
		expect(coordinator.state.status).toBe("stopped");
		coordinator.stop("User cancelled", true);
		expect(new SureCoordinator(run, "build_env", []).state.cancelled).toBe(true);
	});
	it("routes forty pending checks to assessment without consuming or exhausting a business retry", () => {
		const coordinator = new SureCoordinator(setup(), "build_env", []);
		for (let index = 0; index < 40; index++) coordinator.observe(check("pending"), []);
		expect(coordinator.state.status).toBe("yielding");
		expect(coordinator.state.lastCheck?.outcome).toBe("pending");
		expect(coordinator.resumeBlocker).toBeUndefined();
		expect(coordinator.state.units.build_env.noProgress).toBe(0);
	});
});
