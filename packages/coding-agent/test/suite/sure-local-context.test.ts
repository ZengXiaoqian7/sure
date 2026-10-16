import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSureCommonPrompt, buildSureStagePrompt, surePromptPaths } from "../../src/core/sure/context.ts";
import { parseSureCoordinationPolicy } from "../../src/core/sure/coordination-contracts.ts";
import type { SureRunRecord, SureSkillPackage } from "../../src/core/sure/types.ts";

const packageDir = fileURLToPath(new URL("../../../../sure/skills/sure_onboard/", import.meta.url));
const manifest = JSON.parse(readFileSync(`${packageDir}/sure.skill.json`, "utf8"));
manifest.coordination = parseSureCoordinationPolicy(manifest.coordination);
const skill: SureSkillPackage = {
	manifest,
	packageDir,
	manifestPath: `${packageDir}/sure.skill.json`,
	promptPath: `${packageDir}/SKILL.md`,
	prompt: readFileSync(`${packageDir}/SKILL.md`, "utf8"),
	source: "project",
	sourceRoot: packageDir,
};
const run: SureRunRecord = {
	runId: "local-context",
	skillName: "sure_onboard",
	command: "sure_onboard",
	status: "running",
	cwd: packageDir,
	packageDir,
	runDir: `${packageDir}/.sure/test-only`,
	args: "device=cpu max_retries=5",
	startedAt: "now",
	updatedAt: "now",
};
const clauses = new Map([...skill.prompt.matchAll(/^- \*\*([^*]+)\*\*: (.+)$/gm)].map((match) => [match[1], match[2]]));
const sharedSections = [
	["### Command Boundaries", "### Local-first discovery"],
	["### Environment Boundary", "For explicit local `package=none`"],
	["### Device Policy", "Recommended command at `save_artifacts`"],
	["## Parameters", "Preferred handoff:"],
	["## Model-Local Checkpoint Rule", "## Product Layout"],
	["## Product Layout", "## Backend\n"],
	["## Backend\n", "## Failure Handling"],
	["## Memory (advisory)", "## Success Criteria"],
].map(([start, end]) => {
	const from = skill.prompt.indexOf(start);
	const to = skill.prompt.indexOf(end, from);
	if (from < 0 || to <= from) throw new Error(`Missing manual section: ${start}`);
	return skill.prompt.slice(from, to).trim();
});

describe("onboard stage instruction boundaries", () => {
	it("keeps original consumer sources available for failure-specific read-only diagnosis", () => {
		for (const unit of ["generate_wrapper", "validate_contract", "finalize_model_bundle"]) {
			const stage = skill.manifest.coordination!.stages.find((stage) => stage.id === unit)!;
			expect(stage.diagnosticPaths).toContain("project:sure/skills/sure_infer/scripts/server_protocol.py");
			expect(stage.diagnosticPaths).toContain(
				"project:sure/skills/sure_infer/scripts/generate_predictions_via_server.py",
			);
		}
	});
	it.each(skill.manifest.coordination!.stages)(
		"retains the full manual's clause and shared rules for $id",
		(stage) => {
			const prompt =
				buildSureCommonPrompt(skill, run) +
				"\n" +
				buildSureStagePrompt(skill, run, {
					checkpoint: { id: "main_flow", data: { currentUnit: stage.id } },
				});
			const key = ["validate_import", "validate_load", "validate_infer", "validate_contract"].includes(stage.id)
				? "validate_import/load/infer/contract"
				: stage.id;
			expect(clauses.get(key)).toBeTruthy();
			expect(prompt).toContain(`Full operating manual entry point: ${join(packageDir, "SKILL.md")}`);
			expect(prompt).toContain(clauses.get(key));
			for (const section of sharedSections) expect(prompt).toContain(section);
			expect(prompt).toContain(
				"after two consecutive gate failures (`max_retries=` can raise that number, never lower it)",
			);
			const authored = readFileSync(join(packageDir, stage.prompt), "utf8");
			const stageClauses = [...authored.matchAll(/^- \*\*([^*]+)\*\*: (.+)$/gm)];
			expect(stageClauses.map((match) => match[2])).toEqual([clauses.get(key)]);
			expect(prompt).toContain("max_retries=5");
			expect(surePromptPaths(skill, stage.id)).toContain("package:SKILL.md");
		},
	);
});
