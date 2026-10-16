import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { noOpUIContext } from "../../src/core/extensions/index.ts";
import type { SureCoordinationState } from "../../src/core/sure/coordination-types.ts";
import { sureExtension } from "../../src/core/sure/index.ts";
import { discoverSureSkillPackages } from "../../src/core/sure/manifest.ts";
import { SureRunManager } from "../../src/core/sure/run-manager.ts";
import { createHarness, type Harness } from "./harness.ts";
import { fixtureTranscript, repairHandoff, submitControlFixture } from "./sure-control-fixtures.ts";

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
		const parameters = Type.Object({ command: Type.String() });
		const tool: AgentTool<typeof parameters> = {
			name: "bash",
			label: "Fixture shell",
			description: "Execute the fixture's local helper command",
			parameters,
			execute: async (_id, { command }) => {
				const result = spawnSync("bash", ["-c", command], {
					cwd: harness.tempDir,
					encoding: "utf8",
					timeout: 30_000,
					env: { ...process.env, SURE_SITE_POLICY: join(harness.tempDir, "config/site.default.yaml") },
				});
				if (result.status !== 0) throw new Error(result.stderr || result.error?.message || result.stdout);
				return { content: [{ type: "text", text: result.stdout }], details: {} };
			},
		};
		const readParameters = Type.Object({ path: Type.String() });
		const readTool: AgentTool<typeof readParameters> = {
			name: "read",
			label: "Fixture read",
			description: "Read a local fixture artifact",
			parameters: readParameters,
			execute: async (_id, { path }) => ({
				content: [{ type: "text", text: readFileSync(resolve(harness.tempDir, path), "utf8") }],
				details: {},
			}),
		};
		harness = await createHarness({
			tools: [tool, readTool],
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
						if (partial) {
							expect(timeline.currentAttempt.actions).toHaveLength(3);
							expect(timeline.currentAttempt.actions[1]).toMatchObject({ isError: false, outcome: "pending" });
							const partialResponse = await request.tools[0].execute(
								"partial",
								{ operation: "actions", toolCallId: timeline.currentAttempt.actions[1].toolCallId },
								undefined,
								undefined,
								ctx,
							);
							const partialPage = JSON.parse(
								partialResponse.content.find((block) => block.type === "text")!.text,
							);
							expect(JSON.parse(partialPage.text).resultPreview.text).toContain("/sure/.sure/runs/");
							expect(timeline.currentAttempt.actions[2]).toMatchObject({
								toolName: "read",
								isError: true,
								outcome: "blocked",
							});
						}
						const actionResponse = await request.tools[0].execute(
							"action",
							{ operation: "actions", toolCallId: timeline.lastFailure.action.toolCallId },
							undefined,
							undefined,
							ctx,
						);
						const actionPage = JSON.parse(actionResponse.content.find((block) => block.type === "text")!.text);
						expect(actionPage.text).toContain(partial ? "ENOENT" : "--repo-root ../..");
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
			`cd sure/skills/sure_onboard && "${python}" scripts/materialize_onboard_inputs.py --model-input-path ../../handoffs/demo/model_input.yaml --run-dir ${parents}/.sure/runs/${run.runId} --repo-root ${parents}`;
		harness.setResponses([
			...Array.from({ length: failures }, () =>
				fauxAssistantMessage([fauxToolCall("bash", { command: command("../..") })], { stopReason: "toolUse" }),
			),
			...(partial
				? [
						fauxAssistantMessage(
							[fauxToolCall("bash", { command: `${command("../..")} --package-profile none --device cpu` })],
							{ stopReason: "toolUse" },
						),
						fauxAssistantMessage(
							[fauxToolCall("read", { path: join(run.runDir, "artifacts/model_input_resolved.json") })],
							{ stopReason: "toolUse" },
						),
					]
				: []),
			fauxAssistantMessage([fauxToolCall("bash", { command: command("../../..") })], { stopReason: "toolUse" }),
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
	it("recovers independent errors and newly discovered bundle objects within one complete supervisor goal", async () => {
		let harness: Harness;
		let diagnoses = 0;
		let directory = "";
		const parameters = Type.Object({ action: Type.String() });
		const shell: AgentTool<typeof parameters> = {
			name: "bash",
			label: "Bundle fixture",
			description: "Operate on the temporary bundle",
			parameters,
			execute: async (_id, { action }) => {
				if (action === "probe-error") throw new Error("SyntaxError in a supporting probe");
				if (action === "fix-inventory") {
					for (const name of ["alias-a", "alias-b"]) unlinkSync(join(directory, "model", name));
					symlinkSync("runtime", join(directory, "model", "later-alias"));
				} else if (action === "fix-related") unlinkSync(join(directory, "model/later-alias"));
				if (action === "gate") {
					const result = spawnSync(process.env.SURE_HARNESS_BOOTSTRAP_PYTHON!, [join(directory, "gate.py")], {
						encoding: "utf8",
					});
					if (result.status !== 0) throw new Error(result.stderr || result.error?.message || "Gate failed");
				}
				expect(readFileSync(join(directory, "model/runtime/required.py"), "utf8")).toBe("RUNTIME_DEPENDENCY");
				return { content: [{ type: "text", text: `Executed ${action}` }], details: {} };
			},
		};
		const readParameters = Type.Object({ path: Type.String() });
		const read: AgentTool<typeof readParameters> = {
			name: "read",
			label: "Read",
			description: "Read fixture evidence",
			parameters: readParameters,
			execute: async (_id, { path }) => ({
				content: [{ type: "text", text: readFileSync(join(directory, path), "utf8") }],
				details: {},
			}),
		};
		harness = await createHarness({
			tools: [shell, read],
			extensionFactories: [sureExtension],
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			isolatedSessionFactory: async (request) => {
				diagnoses++;
				expect(`${request.systemPrompt}\n${request}`).toContain("read-only supervisor");
				const transcript = fixtureTranscript(request, harness.tempDir);
				return {
					getSessionIdentity: transcript.getSessionIdentity,
					disableTools: () => {},
					abort: async () => {},
					dispose: () => {},
					getMessages: () => transcript.manager.buildSessionContext().messages,
					prompt: async (prompt) => {
						expect(prompt).toContain("one complete repair goal");
						const ctx = harness.session.extensionRunner.createContext();
						let offset = 0;
						while (true) {
							const response = await request.tools[0].execute(
								"macro",
								{ operation: "timeline", offset },
								undefined,
								undefined,
								ctx,
							);
							const page = JSON.parse(response.content.find((block) => block.type === "text")!.text);
							if (page.complete) break;
							offset = page.nextOffset;
						}
						await submitControlFixture(
							request,
							transcript.manager,
							ctx,
							fauxAssistantMessage(
								[
									fauxToolCall("sure_handoff_repair", {
										task: "Verify all related directory aliases and their actual targets, preserve the required runtime, repair the complete bundle topology, and rerun the unchanged original check. Continue investigating newly discovered related objects within that goal.",
									}),
								],
								{ stopReason: "toolUse" },
							),
						);
					},
				};
			},
		});
		harnesses.push(harness);
		directory = harness.tempDir;
		mkdirSync(join(directory, "model/runtime"), { recursive: true });
		writeFileSync(join(directory, "model/runtime/required.py"), "RUNTIME_DEPENDENCY");
		for (const name of ["alias-a", "alias-b"]) symlinkSync("runtime", join(directory, "model", name));
		writeFileSync(
			join(directory, "gate.py"),
			`from pathlib import Path\nimport sys\nsys.path.insert(0, ${JSON.stringify(join(source, "scripts"))})\nfrom finalize_model_bundle import ensure_safe_bundle_targets\nmodel = Path(${JSON.stringify(join(directory, "model"))})\nensure_safe_bundle_targets(model, {"model_dir": str(model)})\nassert (model / "runtime/required.py").read_text() == "RUNTIME_DEPENDENCY"\n`,
		);
		const skillDir = join(directory, ".sure/skills/bundle");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			"Repair a model bundle without deleting required runtime dependencies.",
		);
		writeFileSync(
			join(skillDir, "stage.md"),
			"Make the bundle pass its original topology check. Inventory is evidence; continue related objects within the goal.",
		);
		writeFileSync(
			join(skillDir, "hooks.ts"),
			`
export function preStart(){return {ok:true,state_patch:{checkpoint:{resumable:true,data:{currentUnit:"bundle",completedUnits:[]}}}};}
export function postToolResult(ctx){
 const pass=!ctx.event.isError && ctx.event.input.action==="gate";
 return {ok:true,check:{unitId:"bundle",outcome:ctx.event.isError?"blocked":pass?"passed":"pending",failureKind:ctx.event.isError?"tool":undefined,checker:pass?"original-topology":undefined,summary:ctx.event.isError?"Tool failed":"Bundle check",inputPaths:[],artifactPaths:[]},state_patch:{checkpoint:{resumable:true,data:{currentUnit:"bundle",completedUnits:pass?["bundle"]:[]}}}};
}`,
		);
		writeFileSync(
			join(skillDir, "sure.skill.json"),
			JSON.stringify({
				name: "bundle",
				command: "sure_feed",
				prompt: "SKILL.md",
				coordination: {
					version: 1,
					commonPrompt: "SKILL.md",
					stages: [
						{
							id: "bundle",
							prompt: "stage.md",
							references: [],
							snapshotPaths: ["project:model", "run:artifacts"],
						},
					],
				},
				hooks: {
					pre_start: [{ module: "hooks.ts", handler: "preStart" }],
					post_tool_result: [{ module: "hooks.ts", handler: "postToolResult" }],
				},
			}),
		);
		await harness.session.bindExtensions({
			mode: "tui",
			onError: (error) => {
				throw new Error(error.error);
			},
		});
		const current = (): SureCoordinationState => {
			const run = readdirSync(join(directory, ".sure/runs"))[0];
			return JSON.parse(readFileSync(join(directory, ".sure/runs", run, "coordination.json"), "utf8"));
		};
		const act = (action: string) =>
			fauxAssistantMessage([fauxToolCall("bash", { action })], { stopReason: "toolUse" });
		const verify =
			(select: (value: SureCoordinationState) => string, relation: "recheck" | "independent" | "related") => () => {
				const value = current();
				return fauxAssistantMessage(
					[
						fauxToolCall("sure_update_state", {
							repair_verification: {
								repair_id: select(value),
								check_version: value.lastCheckVersion,
								relation,
							},
						}),
					],
					{ stopReason: "toolUse" },
				);
			};
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "missing.md" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("read", { path: "gate.py" })], { stopReason: "toolUse" }),
			verify((value) => value.repairs![0].id, "recheck"),
			act("gate"),
			() => {
				expect(current().units.bundle.directRepairs).toBe(2);
				expect(diagnoses).toBe(0);
				return act("inspect");
			},
			act("gate"),
			act("probe-error"),
			verify((value) => value.pendingRepair!.id, "independent"),
			act("inspect"),
			verify(
				(value) => value.repairs!.find((repair) => repair.parentRepairId && repair.relation === "independent")!.id,
				"recheck",
			),
			act("fix-inventory"),
			act("gate"),
			verify((value) => value.pendingRepair!.id, "related"),
			act("fix-related"),
			act("gate"),
			fauxAssistantMessage("Original topology passed; full onboard remains separate."),
		]);
		await harness.session.prompt("/sure_feed model=fixture");
		expect(diagnoses).toBe(1);
		expect(current().pendingRepair).toBeUndefined();
		expect(current().lastCheck).toMatchObject({ outcome: "passed", checker: "original-topology" });
		expect(current().repairs!.find((repair) => repair.source === "supervisor")?.outcome).toBe("passed");
		expect(
			current()
				.repairs!.filter((repair) => repair.parentRepairId)
				.map((repair) => repair.relation),
		).toEqual(["independent", "related"]);
		const runDir = join(directory, ".sure/runs", readdirSync(join(directory, ".sure/runs"))[0]);
		for (const repair of current().repairs!.filter((repair) => repair.parentRepairId)) {
			const evidence = join(runDir, "evidence", `${repair.triggerCheckVersion}.json`);
			expect(JSON.parse(readFileSync(evidence, "utf8")).repairId).toBe(repair.id);
		}
		expect(readFileSync(join(directory, "model/runtime/required.py"), "utf8")).toBe("RUNTIME_DEPENDENCY");
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
