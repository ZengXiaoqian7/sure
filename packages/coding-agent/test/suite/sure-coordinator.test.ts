import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	parseSureCheckEvidence,
	parseSureCoordinationPolicy,
	parseSureDiagnosisResult,
} from "../../src/core/sure/coordination-contracts.ts";
import type { SureCheckEvidence } from "../../src/core/sure/coordination-types.ts";
import { SureCoordinator } from "../../src/core/sure/coordinator.ts";
import {
	captureSureSnapshot,
	diffSureSnapshots,
	readSureSnapshot,
	resolveSureEvidencePath,
} from "../../src/core/sure/evidence.ts";
import type { SureRunRecord } from "../../src/core/sure/types.ts";

const directories: string[] = [];
let serial = 0;
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
function check(outcome: SureCheckEvidence["outcome"] = "blocked"): SureCheckEvidence {
	return {
		unitId: "build_env",
		outcome,
		failureKind: "semantic",
		sourceId: "gate",
		checkId: `invocation-${++serial}:0`,
		checker: "check_env",
		summary: "Environment check",
		artifactPaths: ["run:artifacts/env.json"],
		inputPaths: [],
	};
}
function toolCheck(run: SureRunRecord, id: string, batchId: string, input: unknown, isError = true): SureCheckEvidence {
	const path = `evidence/tools/${id}.json`;
	mkdirSync(join(run.runDir, "evidence/tools"), { recursive: true });
	writeFileSync(
		join(run.runDir, path),
		JSON.stringify({ toolCallId: id, toolName: "read", input, execution: "returned", isError }),
	);
	return {
		...check(isError ? "blocked" : "pending"),
		failureKind: "tool",
		action: { toolCallId: id, toolName: "read", path: `run:${path}`, batchId },
	};
}
function diagnosis(coordinator: SureCoordinator, decision: "repair" | "continue" = "repair") {
	return {
		runId: coordinator.run.runId,
		unitId: coordinator.state.unitId,
		evidenceVersion: coordinator.state.evidenceVersion,
		decision,
		kind: "repair",
		repair: "Correct the environment and rerun its original gate.",
		reason: "Continue the current goal.",
		facts: [],
		hypotheses: [],
		unknowns: [],
		nextActions: [],
		evidenceReferences: [`snapshot:${coordinator.state.latestSnapshot}`],
	};
}
afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Sure minimal investigation routing", () => {
	it("routes a repeated declared gate condition despite changed wording", () => {
		const coordinator = new SureCoordinator(setup(), "build_env", []);
		const condition = { id: "dependency", target: "runtime" };
		coordinator.observe({ ...check(), condition }, []);
		expect(coordinator.state.status).toBe("executing");
		coordinator.observe({ ...check(), condition, summary: "Same runtime condition after correction" }, []);
		expect(coordinator.state.status).toBe("yielding");
		expect(coordinator.state.yieldReason).toContain("check:2");
		expect(coordinator.state.repairs).toEqual([]);
	});
	it("retains separate correction opportunities across batches and reload, then routes a repeated operation", () => {
		const run = setup();
		let coordinator = new SureCoordinator(run, "build_env", []);
		coordinator.observe(toolCheck(run, "one", "batch-1", { path: "A" }), []);
		coordinator.observe(toolCheck(run, "two", "batch-1", { path: "B" }), []);
		expect(coordinator.state.status).toBe("executing");
		coordinator.observe({ ...toolCheck(run, "three", "batch-2", { path: "C" }), summary: "Changed failure" }, []);
		expect(coordinator.state.status).toBe("executing");
		coordinator = new SureCoordinator(run, "build_env", []);
		coordinator.observe(toolCheck(run, "four", "batch-3", { path: "B" }), []);
		expect(coordinator.state.status).toBe("yielding");
	});
	it("does not count separate subchecks from one hook invocation as a corrective attempt", () => {
		const coordinator = new SureCoordinator(setup(), "build_env", []);
		coordinator.observe({ ...check(), checkId: "one-invocation:0" }, []);
		coordinator.observe({ ...check(), checkId: "one-invocation:1", sourceId: "second" }, []);
		expect(coordinator.state.status).toBe("executing");
	});
	it("allows a skill-verified resolved blocker and clear local next step, not arbitrary changed files", () => {
		const run = setup();
		const coordinator = new SureCoordinator(run, "build_env", []);
		coordinator.observe(check(), []);
		coordinator.observe(
			{ ...check(), condition: { id: "new-required-field", localRepair: true }, localProgress: true },
			[],
		);
		expect(coordinator.state.status).toBe("executing");
		writeFileSync(join(run.runDir, "artifacts/env.json"), '{"different":true}');
		coordinator.observe({ ...check(), condition: { id: "other-field", localRepair: true } }, []);
		expect(coordinator.state.status).toBe("executing");
		coordinator.observe({ ...check(), condition: { id: "other-field", localRepair: true } }, []);
		expect(coordinator.state.status).toBe("yielding");
	});
	it("does not equate different gate evidence, checker, target or preflight with an earlier failure", () => {
		const coordinator = new SureCoordinator(setup(), "build_env", []);
		coordinator.observe(check(), []);
		coordinator.observe({ ...check(), summary: "Different missing dependency" }, []);
		coordinator.observe({ ...check(), checker: "another_gate" }, []);
		coordinator.observe({ ...check(), checker: "pre_tool_call", sourceId: "pre_tool_call:gate" }, []);
		coordinator.observe({ ...check(), condition: { id: "field", target: "A" } }, []);
		coordinator.observe({ ...check(), condition: { id: "field", target: "B" } }, []);
		expect(coordinator.state.status).toBe("executing");
	});
	it("keeps an interleaved failed operation after the first operation succeeds", () => {
		const run = setup();
		let coordinator = new SureCoordinator(run, "build_env", []);
		coordinator.observe(toolCheck(run, "a1", "batch-1", { path: "A" }), []);
		coordinator.observe(toolCheck(run, "b1", "batch-1", { path: "B" }), []);
		coordinator.observe(toolCheck(run, "a2", "batch-2", { path: "A" }, false), []);
		expect(coordinator.state.unresolvedCheckVersion).toBe(2);
		coordinator = new SureCoordinator(run, "build_env", []);
		coordinator.observe(toolCheck(run, "b2", "batch-3", { path: "B" }), []);
		expect(coordinator.state.status).toBe("yielding");
	});
	it.each(["A", "B"])("scopes verified local progress to its preceding blocker when %s recurs", (id) => {
		const run = setup();
		let coordinator = new SureCoordinator(run, "build_env", []);
		coordinator.observe({ ...check(), condition: { id: "A" } }, []);
		coordinator.observe({ ...check(), condition: { id: "B" } }, []);
		coordinator.observe({ ...check(), condition: { id: "C", localRepair: true }, localProgress: true }, []);
		expect(coordinator.state.unresolvedCheckVersion).toBe(1);
		coordinator = new SureCoordinator(run, "build_env", []);
		coordinator.observe({ ...check(), condition: { id } }, []);
		expect(coordinator.state.status).toBe(id === "A" ? "yielding" : "executing");
	});
	it("clears a failed read after that exact operation succeeds, preserving a later read's local chance", () => {
		const run = setup();
		const coordinator = new SureCoordinator(run, "build_env", []);
		coordinator.observe(toolCheck(run, "read-A-failed", "batch-1", { path: "A" }), []);
		coordinator.observe(toolCheck(run, "read-A-fixed", "batch-2", { path: "A" }, false), []);
		expect(coordinator.state.unresolvedCheckVersion).toBeUndefined();
		coordinator.observe(toolCheck(run, "read-B-failed", "batch-3", { path: "B" }), []);
		expect(coordinator.state.status).toBe("executing");
	});
	it("does not erase a business blocker whose producing tool succeeded when an earlier read is fixed", () => {
		const run = setup();
		const coordinator = new SureCoordinator(run, "build_env", []);
		coordinator.observe(toolCheck(run, "read-missing", "batch-1", { path: "A" }), []);
		const producing = toolCheck(run, "produce", "batch-2", { path: "B" }, false);
		coordinator.observe({ ...check(), action: producing.action }, []);
		coordinator.observe(toolCheck(run, "read-fixed", "batch-3", { path: "A" }, false), []);
		expect(coordinator.state.unresolvedCheckVersion).toBe(2);
		coordinator.observe(check(), []);
		expect(coordinator.state.status).toBe("yielding");
	});
	it("keeps pending, unchanged, skipped and held observations from becoming failed rechecks", () => {
		const run = setup();
		const coordinator = new SureCoordinator(run, "build_env", []);
		coordinator.observe(check(), []);
		for (const outcome of ["pending", "unchanged", "skipped"] as const) coordinator.observe(check(outcome), []);
		const held = toolCheck(run, "held", "later", { path: "A" });
		writeFileSync(
			join(run.runDir, "evidence/tools/held.json"),
			JSON.stringify({ execution: "returned", duringHold: true, isError: true }),
		);
		coordinator.observe(held, []);
		expect(coordinator.state.status).toBe("executing");
		expect(coordinator.state.unresolvedCheckVersion).toBe(1);
	});
	it("leaves small-budget exhaustion to baseline retry/finish and permits later correction and reload", () => {
		const run = setup();
		const coordinator = new SureCoordinator(run, "build_env", []);
		coordinator.observe(check(), []);
		coordinator.observe(check("exhausted"), []);
		expect(coordinator.state.status).toBe("executing");
		expect(coordinator.resumeBlocker).toBeUndefined();
		const restored = new SureCoordinator(run, "build_env", []);
		restored.observe(check("passed"), []);
		expect(restored.state.status).toBe("executing");
		expect(restored.state.unresolvedCheckVersion).toBeUndefined();
	});
	it.each(["skipped", "missing"])("does not infer a failed execution from a %s action record", (execution) => {
		const run = setup();
		const coordinator = new SureCoordinator(run, "build_env", []);
		coordinator.observe(check(), []);
		const rejected = toolCheck(run, "rejected", "later-batch", { path: "A" });
		const path = join(run.runDir, "evidence/tools/rejected.json");
		if (execution === "missing") rmSync(path);
		else writeFileSync(path, JSON.stringify({ execution: "skipped", isError: true }));
		coordinator.observe(rejected, []);
		expect(coordinator.state.status).toBe("executing");
		expect(coordinator.state.lastFailureCheckVersion).toBe(1);
	});
	it("does not use workload or pending checks as automatic takeover triggers", () => {
		const coordinator = new SureCoordinator(setup(), "build_env", []);
		for (let index = 0; index < 81; index++) {
			coordinator.recordAction("build_env");
			coordinator.observe(check("pending"), []);
		}
		expect(coordinator.state.status).toBe("executing");
	});
	it("deduplicates the same failure and reviewed position across restart; a fresh failure reopens investigation", () => {
		const run = setup();
		let coordinator = new SureCoordinator(run, "build_env", []);
		const failure = toolCheck(run, "failed", "batch-1", { path: "A" });
		coordinator.observe(failure, []);
		coordinator = new SureCoordinator(run, "build_env", []);
		coordinator.observe(failure, []);
		expect(coordinator.state.evidenceVersion).toBe(1);
		coordinator.requestDiagnosis("Please inspect this blocker.");
		coordinator.beginDiagnosis();
		expect(coordinator.acceptDiagnosis(diagnosis(coordinator, "continue"))).toBe(true);
		coordinator = new SureCoordinator(run, "build_env", []);
		coordinator.barrier([]);
		coordinator.requestDiagnosis("Please inspect this blocker again.");
		expect(coordinator.state.status).toBe("executing");
		coordinator.observe(toolCheck(run, "failed-again", "batch-2", { path: "B" }), []);
		expect(coordinator.state.status).toBe("executing");
		coordinator.observe(toolCheck(run, "failed-original", "batch-3", { path: "A" }), []);
		expect(coordinator.state.status).toBe("yielding");
		expect(coordinator.state.repairs).toEqual([]);
	});
	it("never settles a repair or overwrites its gate outcome on successful preflight or tool observation", () => {
		const run = setup();
		const coordinator = new SureCoordinator(run, "build_env", []);
		coordinator.observe(check(), []);
		coordinator.acceptDiagnosis(diagnosis(coordinator));
		const id = coordinator.state.pendingRepair!.id;
		coordinator.observe({ ...check("passed"), checker: "pre_tool_call", sourceId: "pre_tool_call:gate" }, []);
		coordinator.observe(toolCheck(run, "probe", "batch-1", { path: "probe" }, false), []);
		expect(coordinator.state.pendingRepair?.id).toBe(id);
		expect(coordinator.state.unresolvedCheckVersion).toBe(1);
		expect(coordinator.state.repairs![0].gateOutcome).toBeUndefined();
		coordinator.observe(check("passed"), []);
		expect(coordinator.state.pendingRepair).toBeUndefined();
		expect(coordinator.state.repairs![0]).toMatchObject({ gateOutcome: "passed", gateCheckVersion: 4 });
	});
	it("retains supervisor task text and only the original gate result after dispatch clears", () => {
		const run = setup();
		const coordinator = new SureCoordinator(run, "build_env", []);
		coordinator.observe(check(), []);
		const task = diagnosis(coordinator);
		expect(coordinator.acceptDiagnosis(task)).toBe(true);
		expect(coordinator.acceptDiagnosis(task)).toBe(true);
		coordinator.observe(check("passed"), []);
		expect(coordinator.state.pendingRepair).toBeUndefined();
		const restored = new SureCoordinator(run, "build_env", []);
		expect(restored.state.repairs).toHaveLength(1);
		expect(restored.state.repairs?.[0]).toMatchObject({
			task: task.repair,
			gateOutcome: "passed",
			gateCheckVersion: 2,
		});
		expect(restored.state.repairs?.[0]).not.toHaveProperty("outcome");
	});
	it("rejects stale diagnoses, supervisor stop and owner/cancelled late writes", () => {
		const run = setup();
		let currentOwner = true;
		const coordinator = new SureCoordinator(run, "build_env", [], {}, () => {
			if (!currentOwner) throw new Error("Owner changed");
		});
		coordinator.observe(check(), []);
		expect(coordinator.acceptDiagnosis({ ...diagnosis(coordinator), evidenceVersion: 0 })).toBe(false);
		expect(coordinator.acceptDiagnosis({ ...diagnosis(coordinator), decision: "stop" })).toBe(false);
		coordinator.stop("User cancelled", true);
		expect(coordinator.acceptDiagnosis(diagnosis(coordinator))).toBe(false);
		expect(() => coordinator.requestDiagnosis("Late help")).toThrow("stopped or cancelled");
		const saved = readFileSync(join(run.runDir, "coordination.json"), "utf8");
		currentOwner = false;
		expect(() => coordinator.observe(check(), [])).toThrow("Owner changed");
		expect(readFileSync(join(run.runDir, "coordination.json"), "utf8")).toBe(saved);
	});
	it("refuses old active protocol without migrating files or creating new invocation evidence", () => {
		const run = setup();
		mkdirSync(join(run.runDir, "evidence"), { recursive: true });
		const raw = JSON.stringify({ version: 1, runId: run.runId, units: {}, status: "executing" });
		writeFileSync(join(run.runDir, "coordination.json"), raw);
		expect(() => new SureCoordinator(run, "build_env", [])).toThrow("historical runs remain read-only");
		expect(readFileSync(join(run.runDir, "coordination.json"), "utf8")).toBe(raw);
		expect(existsSync(join(run.runDir, "evidence/invocation.json"))).toBe(false);
	});
	it.each(["run", "task"])(
		"rejects a restored handoff with mismatched %s identity without rewriting it",
		(mismatch) => {
			const run = setup();
			const coordinator = new SureCoordinator(run, "build_env", []);
			coordinator.acceptDiagnosis(diagnosis(coordinator));
			const pending = coordinator.state.pendingRepair!;
			if (mismatch === "run") pending.result.runId = "another-run";
			else pending.id = "another-task";
			coordinator.save();
			const before = readFileSync(join(run.runDir, "coordination.json"), "utf8");
			expect(() => new SureCoordinator(run, "build_env", [])).toThrow(
				mismatch === "run" ? "another run" : "accepted task",
			);
			expect(readFileSync(join(run.runDir, "coordination.json"), "utf8")).toBe(before);
		},
	);
	it("validates minimal skill observations and rejects retired quota and stop contracts", () => {
		const policy = {
			version: 1,
			commonPrompt: "common.md",
			stages: [{ id: "build_env", prompt: "stage.md", references: [], snapshotPaths: [] }],
		};
		expect(parseSureCoordinationPolicy(undefined)).toBeUndefined();
		expect(parseSureCoordinationPolicy({ ...policy, budgets: { snapshotFiles: 5 } })?.budgets).toEqual({
			snapshotFiles: 5,
		});
		for (const budgets of [{ checksPerUnit: 40 }, { noProgressChecks: 3 }, { snapshotFiles: 0 }])
			expect(() => parseSureCoordinationPolicy({ ...policy, budgets })).toThrow();
		expect(
			parseSureCheckEvidence({ ...check(), condition: { id: "field", localRepair: true }, localProgress: true }),
		).toMatchObject({ localProgress: true });
		expect(() => parseSureCheckEvidence({ ...check(), localProgress: "true" })).toThrow();
		expect(() => parseSureCheckEvidence({ ...check(), recovery: "local_once" })).toThrow("Legacy");
		const coordinator = new SureCoordinator(setup(), "build_env", []);
		expect(() => parseSureDiagnosisResult({ ...diagnosis(coordinator), decision: "stop" })).toThrow();
	});
});

describe("Sure retained snapshots", () => {
	it("keeps historical text, opaque coverage and path confinement", () => {
		const run = setup();
		const path = join(run.runDir, "artifacts/env.json");
		writeFileSync(path, '{"ready":false}\n');
		const before = captureSureSnapshot(run, "build_env", "initial", ["run:artifacts"]);
		writeFileSync(path, '{"ready":true}\n');
		writeFileSync(join(run.runDir, "artifacts/opaque.bin"), Buffer.from([0, 1, 2]));
		const after = captureSureSnapshot(run, "build_env", "passed", ["run:artifacts"]);
		expect(diffSureSnapshots(readSureSnapshot(run, before.id), after)).toContain('-{"ready":false}');
		expect(after.files.find((file) => file.path.endsWith("opaque.bin"))?.status).toBe("binary");
		expect(resolveSureEvidencePath(run, "project:../../outside")).toBeUndefined();
	});
	it("keeps versions stable for overlapping unchanged capture scopes", () => {
		const run = setup();
		writeFileSync(join(run.runDir, "artifacts/env.json"), '{"ready":false}');
		const coordinator = new SureCoordinator(run, "build_env", ["run:artifacts"]);
		coordinator.observe(check(), ["run:artifacts"]);
		coordinator.barrier(["run:artifacts", "run:artifacts/env.json"]);
		expect(coordinator.state.evidenceVersion).toBe(1);
		writeFileSync(join(run.runDir, "artifacts/env.json"), '{"ready":true}');
		coordinator.barrier(["run:artifacts"]);
		expect(coordinator.state.evidenceVersion).toBe(2);
	});
});
