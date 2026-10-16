import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { noOpUIContext } from "../../src/core/extensions/index.ts";
import type { SureCoordinationState } from "../../src/core/sure/coordination-types.ts";
import { sureExtension } from "../../src/core/sure/index.ts";
import { discoverSureSkillPackages } from "../../src/core/sure/manifest.ts";
import { SureRunManager } from "../../src/core/sure/run-manager.ts";
import { createHarness, type Harness } from "./harness.ts";
import { fixtureTranscript, repairHandoff, submitControlFixture, toolReply } from "./sure-control-fixtures.ts";

const harnesses: Harness[] = [];
const repository = resolve(import.meta.dirname, "../../../..");
const source = join(repository, "sure/skills/sure_onboard");

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("onboard command recovery through the original helper and gate", () => {
	it.each([
		{ failures: 1, partial: false },
		{ failures: 2, partial: false },
		{ failures: 1, partial: true },
	])("recovers after $failures bad path calls, partial=$partial", async ({ failures, partial }) => {
		let harness: Harness;
		let diagnoses = 0;
		const notifications: string[] = [];
		harness = await createHarness({
			initialActiveToolNames: ["bash", "read"],
			extensionFactories: [sureExtension],
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			isolatedSessionFactory: async (request) => {
				diagnoses++;
				const transcript = fixtureTranscript(request, harness.tempDir);
				return {
					getSessionIdentity: transcript.getSessionIdentity,
					disableTools: () => {},
					prompt: async () => {
						const ctx = harness.session.extensionRunner.createContext();
						let macro = "";
						let offset = 0;
						while (true) {
							const response = await request.tools[0].execute(
								"timeline",
								{ operation: "timeline", offset },
								undefined,
								undefined,
								ctx,
							);
							const page = JSON.parse(response.content.find((block) => block.type === "text")!.text);
							macro += page.text;
							if (page.complete) break;
							offset = page.nextOffset;
						}
						const timeline = JSON.parse(macro);
						expect(timeline.repairs[0]).toMatchObject({ source: "executor", outcome: "blocked" });

						const actionResponse = await request.tools[0].execute(
							"action",
							{ operation: "actions", toolCallId: timeline.lastFailure.action.toolCallId },
							undefined,
							undefined,
							ctx,
						);
						const actionPage = JSON.parse(actionResponse.content.find((block) => block.type === "text")!.text);
						expect(actionPage.text).toContain("--repo-root ../..");
						await request.tools[0].execute(
							"helper",
							{ operation: "file", path: "package:scripts/materialize_onboard_inputs.py" },
							undefined,
							undefined,
							ctx,
						);
						request.onTurn();
						await submitControlFixture(
							request,
							transcript.manager,
							ctx,
							repairHandoff(
								"Correct this helper invocation to use the current run and project root; preserve none and CPU.",
							),
						);
					},
					abort: async () => {},
					dispose: () => {},
					getMessages: () => transcript.manager.buildSessionContext().messages,
				};
			},
		});
		harnesses.push(harness);
		const skillDir = join(harness.tempDir, "sure/skills/sure_onboard");
		cpSync(source, skillDir, { recursive: true });
		for (const name of ["index", "stop"])
			writeFileSync(
				join(skillDir, `hooks/${name}.ts`),
				`export * from ${JSON.stringify(join(source, `hooks/${name}.ts`).replaceAll("\\", "/"))};`,
			);
		// Reuse the installed runtime and unmodified shared modules; never bootstrap a new environment.
		for (const directory of ["runtime", "site"])
			symlinkSync(join(repository, "sure", directory), join(harness.tempDir, "sure", directory), "junction");
		mkdirSync(join(harness.tempDir, "config"));
		cpSync(join(repository, "config/site.default.yaml"), join(harness.tempDir, "config/site.default.yaml"));
		const input = join(harness.tempDir, "sure/handoffs/demo/model_input.yaml");
		mkdirSync(join(input, ".."), { recursive: true });
		writeFileSync(
			input,
			"model_id: example/demo\nmodel_name: example__demo\ntask_type: asr\ndeployment_type: local\nrepo:\n  url: https://example.invalid/demo\n",
		);
		const skill = discoverSureSkillPackages(harness.tempDir).packages.find(
			(skill) => skill.manifest.command === "sure_onboard",
		)!;
		const manager = new SureRunManager(harness.tempDir);
		const run = manager.createRun(skill, "model=demo package=none device=cpu");
		manager.setStatus(run, "running");
		manager.updateState(run, {
			message: "STALE_SKILL_LOADED_NOTICE",
			phase: { id: "load_model_input", status: "running" },
			checkpoint: { resumable: true, data: { currentUnit: "load_model_input", completedUnits: [], retries: {} } },
		});
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: {
				...noOpUIContext,
				notify: (message) => {
					notifications.push(message);
				},
			},
			onError: (error) => {
				throw new Error(error.error);
			},
		});
		const python = process.env.SURE_HARNESS_BOOTSTRAP_PYTHON!;
		const command = (parents: string) =>
			`cd sure/skills/sure_onboard && SURE_SITE_POLICY="${join(harness.tempDir, "config/site.default.yaml")}" "${python}" scripts/materialize_onboard_inputs.py --model-input-path ../../handoffs/demo/model_input.yaml --run-dir ${parents}/.sure/runs/${run.runId} --repo-root ${parents}`;
		harness.setResponses([
			...Array.from({ length: failures }, () => toolReply(fauxToolCall("bash", { command: command("../..") }))),
			...(partial
				? [
						toolReply(
							fauxToolCall("bash", { command: `${command("../..")} --package-profile none --device cpu` }),
						),
						toolReply(fauxToolCall("read", { path: join(run.runDir, "artifacts/model_input_resolved.json") })),
					]
				: []),
			toolReply(fauxToolCall("bash", { command: command("../../..") })),
			fauxAssistantMessage("Fixture stops after the load gate; this is not a complete onboard acceptance."),
		]);
		await harness.session.prompt(`/sure_resume ${run.runId}`);
		const state: SureCoordinationState = JSON.parse(readFileSync(join(run.runDir, "coordination.json"), "utf8"));
		const guidedRepairs = failures - 1;
		expect(diagnoses).toBe(guidedRepairs);
		if (guidedRepairs) expect(state.attempts[0].error).toBeUndefined();
		const notice = notifications.find((message) => message.startsWith("Inspecting tool result:"));
		expect(notice).toContain("A tool call returned an error");
		expect(notice).not.toContain("STALE_SKILL_LOADED_NOTICE");
		expect(state.units.load_model_input).toMatchObject({
			directRepairs: partial ? 2 : 1,
			supervisorRepairs: guidedRepairs,
		});
		expect(manager.readState(run)?.checkpoint?.data).toMatchObject({
			currentUnit: "context_selection",
			completedUnits: ["load_model_input"],
		});
		const resolved = JSON.parse(readFileSync(join(run.runDir, "artifacts/model_input_resolved.json"), "utf8"));
		expect(resolved).toMatchObject({ package_profile: "none", device: "cpu" });
		const last = state.lastCheck!;
		expect(last).toMatchObject({ outcome: "passed", checker: "check_model_input.py", exitCode: 0 });
		expect(state.repairs?.at(-1)?.outcome).toBe("passed");
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
