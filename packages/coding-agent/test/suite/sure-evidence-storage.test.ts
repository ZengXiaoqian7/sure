import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SureCoordinator } from "../../src/core/sure/coordinator.ts";
import { captureSureSnapshot, readSureSnapshot } from "../../src/core/sure/evidence.ts";
import { SureRunManager } from "../../src/core/sure/run-manager.ts";
import type { SureSkillPackage } from "../../src/core/sure/types.ts";

const directories: string[] = [];

afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const tempDir = mkdtempSync(join(tmpdir(), "sure-evidence-"));
	directories.push(tempDir);
	const manager = new SureRunManager(tempDir);
	const skill = { manifest: { name: "fixture", command: "fixture" }, packageDir: tempDir } as SureSkillPackage;
	const run = manager.createRun(skill, "", join(tempDir, "output"));
	const artifact = join(run.runDir, "artifacts/draft.json");
	writeFileSync(artifact, JSON.stringify({ draft: "normal partial work".repeat(2000) }));
	const scope = ["run:artifacts"];
	const coordinator = new SureCoordinator(run, "work", scope);
	return { manager, run, artifact, scope, coordinator };
}

describe("SURE coordination evidence storage", () => {
	it("reuses full bodies across pending checks, barriers and reload while retaining every check version", () => {
		const { run, scope, coordinator } = fixture();
		for (let index = 0; index < 20; index++) {
			coordinator.observe(
				{ unitId: "work", outcome: "pending", summary: "Draft in progress", inputPaths: [], artifactPaths: scope },
				scope,
			);
			coordinator.barrier(scope);
		}
		expect(readdirSync(join(run.runDir, "snapshots"))).toHaveLength(3);
		expect(coordinator.state.evidenceVersion).toBe(20);
		expect(coordinator.state.units.work.checks).toBe(20);
		expect(readdirSync(join(run.runDir, "evidence")).filter((name) => /^\d+\.json$/.test(name))).toHaveLength(20);
		const reloaded = new SureCoordinator(run, "work", scope);
		expect(reloaded.barrier(scope).id).toBe(coordinator.state.latestSnapshot);
		expect(readdirSync(join(run.runDir, "snapshots"))).toHaveLength(3);
	});

	it("keeps changed content, omitted identities, scope, unit and kind separate", () => {
		const { run, artifact, scope } = fixture();
		const initial = captureSureSnapshot(run, "work", "barrier", scope);
		utimesSync(artifact, 100, 100);
		expect(captureSureSnapshot(run, "work", "barrier", scope).id).toBe(initial.id);
		writeFileSync(artifact, '{"draft":"changed"}');
		const changed = captureSureSnapshot(run, "work", "barrier", scope);
		expect(changed.id).not.toBe(initial.id);
		expect(captureSureSnapshot(run, "other", "barrier", scope).id).not.toBe(changed.id);
		expect(captureSureSnapshot(run, "work", "passed", scope).id).not.toBe(changed.id);
		expect(captureSureSnapshot(run, "work", "barrier", ["run:artifacts/draft.json"]).id).not.toBe(changed.id);
		const binary = join(run.runDir, "artifacts/data.wav");
		writeFileSync(binary, "identity only");
		const before = captureSureSnapshot(run, "work", "barrier", scope);
		utimesSync(binary, 101, 101);
		expect(captureSureSnapshot(run, "work", "barrier", scope).id).not.toBe(before.id);
		expect(readSureSnapshot(run, initial.id).files[0].text).toContain("normal partial work");
	});

	it("skips identical coordination exports, copies changed bodies, and leaves a standalone export", () => {
		const { run, manager, coordinator, scope } = fixture();
		coordinator.observe(
			{ unitId: "work", outcome: "passed", summary: "Original gate passed", inputPaths: [], artifactPaths: scope },
			scope,
		);
		const stopped = manager.setStatus(run, "success");
		const exported = join(run.outputDir!, "snapshots", `${coordinator.state.latestSnapshot}.json`);
		const artifactCopy = join(run.outputDir!, "artifacts/draft.json");
		utimesSync(exported, 100, 100);
		utimesSync(artifactCopy, 100, 100);
		manager.updateRun(stopped, { lastRepair: "Updated display" }, "display");
		expect(statSync(exported).mtimeMs).toBe(100_000);
		expect(statSync(artifactCopy).mtimeMs).not.toBe(100_000);
		expect(JSON.parse(readFileSync(join(run.outputDir!, "result.json"), "utf8")).error).toBe("Updated display");
		mkdirSync(join(run.runDir, "supervisor"));
		writeFileSync(join(run.runDir, "supervisor/session.jsonl"), "first");
		manager.setStatus(stopped, "success");
		writeFileSync(join(run.runDir, "supervisor/session.jsonl"), "later");
		manager.setStatus(stopped, "success");
		expect(readFileSync(join(run.outputDir!, "supervisor/session.jsonl"), "utf8")).toBe("later");
		rmSync(run.runDir, { recursive: true });
		expect(existsSync(run.runDir)).toBe(false);
		const savedRun = { ...run, runDir: run.outputDir! };
		const saved = new SureCoordinator(savedRun, "work", scope);
		expect(readSureSnapshot(savedRun, saved.state.lastSuccessSnapshot!).files[0].text).toContain(
			"normal partial work",
		);
	});
});
