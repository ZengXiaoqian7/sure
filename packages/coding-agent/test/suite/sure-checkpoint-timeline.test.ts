import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it } from "vitest";
import { SureCoordinator } from "../../src/core/sure/coordinator.ts";
import { loadSureCheckpointTimeline, loadSureDiagnosticIndex } from "../../src/core/sure/diagnostic-view.ts";
import { sureExtension } from "../../src/core/sure/index.ts";
import { discoverSureSkillPackages } from "../../src/core/sure/manifest.ts";
import { SureRunManager } from "../../src/core/sure/run-manager.ts";
import { diagnoseSureRun } from "../../src/core/sure/supervisor.ts";
import { createHarness, type Harness } from "./harness.ts";
import { fixtureTranscript, pauseDiagnosis, submitControlFixture } from "./sure-control-fixtures.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

it.each([true, false])(
	"records only applied checkpoint sources and exposes the same supervisor mainline, valid=%s",
	async (valid) => {
		let inspected = false;
		let harness: Harness;
		harness = await createHarness({
			extensionFactories: [sureExtension],
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			isolatedSessionFactory: async (request) => {
				const transcript = fixtureTranscript(request, harness.tempDir);
				return {
					getSessionIdentity: transcript.getSessionIdentity,
					getMessages: () => transcript.manager.buildSessionContext().messages,
					abort: async () => {},
					dispose: () => {},
					prompt: async (prompt) => {
						transcript.manager.appendMessage({ role: "user", content: prompt, timestamp: Date.now() });
						const packet = JSON.parse(prompt.split("\n")[1]);
						const read = request.tools.find((tool) => tool.name === "sure_diagnostic_read")!;
						const ctx = harness.session.extensionRunner.createContext();
						const readValue = async (args: Record<string, unknown>) => {
							const response = await read.execute("read", args, undefined, undefined, ctx);
							return JSON.parse(response.content.find((block) => block.type === "text")!.text);
						};
						const timeline = JSON.parse((await readValue({ operation: "timeline" })).text);
						expect(timeline.checkpointTimeline).toEqual(packet.navigation.checkpointTimeline);
						const transition = timeline.checkpointTimeline.transitions[0];
						const log = await readValue({ operation: "log", offset: transition.logOffset });
						expect(JSON.parse(log.text.split("\n")[0]).data.state.checkpoint.id).toBe("selected");
						const hook = JSON.parse((await readValue({ operation: "hooks", hookId: transition.hookId })).text);
						expect(hook.handler).toBe("last");
						const check = JSON.parse(
							(await readValue({ operation: "check", checkVersion: transition.checkVersion })).text,
						);
						expect(check.check.checkId).toBe(hook.result.check.checkId);
						expect(check.snapshotId).toBe(transition.snapshotId);
						inspected = true;
						await submitControlFixture(
							request,
							transcript.manager,
							ctx,
							pauseDiagnosis("Fixture investigation complete."),
						);
					},
				};
			},
		});
		harnesses.push(harness);
		const dir = join(harness.tempDir, ".sure/skills/demo");
		mkdirSync(dir, { recursive: true });
		for (const name of ["SKILL.md", "common.md", "stage.md"])
			writeFileSync(join(dir, name), "Keep the original business gate.");
		writeFileSync(
			join(dir, "hooks.ts"),
			`
const check=outcome=>({unitId:"stage",outcome,summary:outcome,inputPaths:[],artifactPaths:[]});
export const first=()=>({ok:true,check:check("pending"),state_patch:{checkpoint:{id:"unselected",data:{currentUnit:"stage"}}}});
export const last=()=>({ok:true,check:check("passed"),state_patch:{phase:{id:"stage",status:"running"},checkpoint:{id:${valid ? '"selected"' : "42"},resumable:true,data:{currentUnit:"stage",retries:{stage:0}}}}});
`,
		);
		writeFileSync(
			join(dir, "sure.skill.json"),
			JSON.stringify({
				name: "demo",
				command: "sure_feed",
				prompt: "SKILL.md",
				coordination: {
					version: 1,
					commonPrompt: "common.md",
					stages: [{ id: "stage", prompt: "stage.md", references: [], snapshotPaths: ["run:artifacts"] }],
				},
				hooks: { pre_start: ["first", "last"].map((handler) => ({ module: "hooks.ts", handler })) },
			}),
		);
		await harness.session.bindExtensions({
			mode: "tui",
			onError: (error) => {
				throw new Error(error.error);
			},
		});
		harness.setResponses([fauxAssistantMessage("Waiting.")]);
		await harness.session.prompt("/sure_feed");
		const manager = new SureRunManager(harness.tempDir);
		const run = manager.readRun(manager.listRunIds()[0])!;
		const events = readFileSync(join(run.runDir, "events.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const applied = events.filter((event) => event.type === "pre_start_state");
		expect(applied, JSON.stringify(events)).toHaveLength(valid ? 1 : 0);
		const coordinator = new SureCoordinator(run, "stage", []);
		const timeline = loadSureCheckpointTimeline(run, loadSureDiagnosticIndex(coordinator));
		expect(timeline.transitions).toHaveLength(valid ? 1 : 0);
		if (!valid) {
			expect(manager.readState(run)).toBeUndefined();
			return;
		}
		const records = readdirSync(join(run.runDir, "evidence/hooks")).map((name) =>
			JSON.parse(readFileSync(join(run.runDir, "evidence/hooks", name), "utf8")),
		);
		const selected = records.find((record) => record.handler === "last");
		expect(applied[0].data.hookExecutionId).toBe(selected.id);
		expect(applied[0].data.state.checkpoint).toEqual(manager.readState(run)?.checkpoint);
		expect(timeline.transitions[0]).toMatchObject({ hookId: selected.id, checkVersion: expect.any(Number) });
		const skill = discoverSureSkillPackages(harness.tempDir).packages[0];
		const outcome = await diagnoseSureRun(
			coordinator,
			harness.session.extensionRunner.createContext(),
			[],
			skill.manifest.coordination!.stages[0],
			skill,
		);
		expect(outcome.decision).toBe("checkpoint");
		expect(inspected).toBe(true);
	},
);
