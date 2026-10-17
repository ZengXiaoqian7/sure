import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { postToolResult } from "../../../../sure/skills/sure_onboard/hooks/index.ts";
import { SureCoordinator } from "../../src/core/sure/coordinator.ts";
import { discoverSureSkillPackages } from "../../src/core/sure/manifest.ts";
import { SureRunManager } from "../../src/core/sure/run-manager.ts";
import type { SureDisplayState, SureHookContext } from "../../src/core/sure/types.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

it("keeps successive missing-field corrections local only when the previous condition is actually resolved", async () => {
	const harness = await createHarness();
	harnesses.push(harness);
	const skill = discoverSureSkillPackages(resolve(import.meta.dirname, "../../../..")).packages.find(
		(skill) => skill.manifest.command === "sure_onboard",
	)!;
	const manager = new SureRunManager(harness.tempDir);
	const run = manager.createRun(skill, "max_retries=5");
	manager.updateState(run, {
		checkpoint: { data: { currentUnit: "load_model_input", completedUnits: [], retries: {} } },
	});
	const coordinator = new SureCoordinator(run, "load_model_input", ["run:artifacts"]);
	const ctx: SureHookContext = {
		point: "post_tool_result",
		run,
		skill: skill.manifest,
		cwd: run.cwd,
		packageDir: skill.packageDir,
		runDir: run.runDir,
		args: run.args,
		event: { toolName: "write", isError: false },
	};
	const check = (artifact: unknown) => {
		writeFileSync(join(run.runDir, "artifacts/model_input_resolved.json"), JSON.stringify(artifact));
		const result = postToolResult(ctx);
		manager.updateState(run, result.state_patch as SureDisplayState);
		coordinator.observe(result.check!, ["run:artifacts"]);
		return result.check!;
	};
	const first = check({});
	expect(first.condition).toMatchObject({ id: "required_field", localRepair: true });
	const second = check({ [first.condition!.target!]: "recorded" });
	expect(second.condition?.target).not.toBe(first.condition?.target);
	expect(second.localProgress).toBe(true);
	expect(coordinator.state.status).toBe("executing");
	// Changing unrelated content while leaving the required field absent is no progress.
	const third = check({ [first.condition!.target!]: "recorded", unrelated: "changed" });
	expect(third.localProgress).toBe(false);
	expect(coordinator.state.status).toBe("yielding");
	expect(manager.readState(run)?.checkpoint?.data).toMatchObject({
		retries: { load_model_input: 3 },
		completedUnits: [],
	});
});

it("uses the real finalizer's structured directory condition and verifies the previous directory was materialized", async () => {
	const harness = await createHarness();
	harnesses.push(harness);
	const skill = discoverSureSkillPackages(resolve(import.meta.dirname, "../../../..")).packages.find(
		(skill) => skill.manifest.command === "sure_onboard",
	)!;
	const manager = new SureRunManager(harness.tempDir);
	const run = manager.createRun(skill, "");
	manager.updateState(run, {
		checkpoint: { data: { currentUnit: "finalize_model_bundle", completedUnits: [], retries: {} } },
	});
	const model = join(harness.tempDir, "model");
	mkdirSync(join(model, "runtime"), { recursive: true });
	writeFileSync(join(model, "runtime/required.py"), "PRESERVE_RUNTIME");
	writeFileSync(join(run.runDir, "artifacts/model_input_resolved.json"), JSON.stringify({ model_dir: model }));
	symlinkSync("runtime", join(model, "alias-a"));
	const ctx: SureHookContext = {
		point: "post_tool_result",
		run,
		skill: skill.manifest,
		cwd: run.cwd,
		packageDir: skill.packageDir,
		runDir: run.runDir,
		args: "",
		event: undefined,
	};
	const invoke = () => {
		const result = spawnSync(
			process.env.SURE_HARNESS_BOOTSTRAP_PYTHON ?? "python3",
			[
				join(skill.packageDir, "scripts/finalize_model_bundle.py"),
				"--run-dir",
				run.runDir,
				"--produces",
				join(run.runDir, "artifacts/deployment_ready.json"),
			],
			{ encoding: "utf8" },
		);
		expect(result.status, result.stderr).toBe(1);
		expect(result.stderr).toContain("SURE_FAILURE_OBSERVATION=");
		return {
			toolName: "bash",
			input: { command: "python scripts/finalize_model_bundle.py --run-dir fixture" },
			isError: true,
			content: [{ type: "text", text: result.stderr }],
		};
	};
	const first = postToolResult({ ...ctx, event: invoke() }).check!;
	expect(first.condition).toEqual({ id: "directory_symlink", target: join(model, "alias-a"), localRepair: true });
	writeFileSync(join(run.runDir, "coordination.json"), JSON.stringify({ lastFailure: first }));
	const original = { ...ctx, event: { ...invoke(), input: { command: "cat scripts/finalize_model_bundle.py" } } };
	expect(postToolResult(original).check?.condition).toBeUndefined();
	unlinkSync(join(model, "alias-a"));
	mkdirSync(join(model, "alias-a"));
	symlinkSync("runtime", join(model, "alias-b"));
	const second = postToolResult({ ...ctx, event: invoke() }).check!;
	expect(second).toMatchObject({
		outcome: "blocked",
		localProgress: true,
		condition: { target: join(model, "alias-b") },
	});
	// Removing the previous blocker without a materialized replacement is not verified progress.
	unlinkSync(join(model, "alias-b"));
	symlinkSync("runtime", join(model, "alias-c"));
	writeFileSync(join(run.runDir, "coordination.json"), JSON.stringify({ lastFailure: second }));
	expect(postToolResult({ ...ctx, event: invoke() }).check?.localProgress).not.toBe(true);
	expect(readFileSync(join(model, "runtime/required.py"), "utf8")).toBe("PRESERVE_RUNTIME");
	expect(manager.readState(run)?.checkpoint?.data).toMatchObject({ retries: {}, completedUnits: [] });
});
