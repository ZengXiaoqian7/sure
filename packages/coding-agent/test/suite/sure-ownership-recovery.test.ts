import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acquireSureRunOwnership } from "../../src/core/sure/ownership.ts";

const directories: string[] = [];
const moduleUrl = pathToFileURL(resolve(import.meta.dirname, "../../src/core/sure/ownership.ts")).href;

afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const tempDir = mkdtempSync(join(tmpdir(), "sure-ownership-"));
	directories.push(tempDir);
	const path = join(tempDir, ".coordination-owner.json");
	return { tempDir, path, reclaim: `${path}.reclaim` };
}

describe("SURE process ownership recovery", () => {
	it.each(["reclaim", "removed", "published"])("recovers a real exited reclaimer at %s", async (point) => {
		const { tempDir, path, reclaim } = fixture();
		const helper = join(tempDir, "crash.mjs");
		writeFileSync(
			helper,
			`
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { acquireSureRunOwnership } from ${JSON.stringify(moduleUrl)};
const owner = acquireSureRunOwnership(${JSON.stringify(tempDir)});
const next = readFileSync(${JSON.stringify(path)}, "utf8");
const old = JSON.stringify({...JSON.parse(next), processIdentity:"previous-process"});
writeFileSync(${JSON.stringify(path)}, old);
writeFileSync(${JSON.stringify(reclaim)}, JSON.stringify({owner:JSON.parse(next), previousOwner:old}));
if (${JSON.stringify(point)} !== "reclaim") unlinkSync(${JSON.stringify(path)});
if (${JSON.stringify(point)} === "published") writeFileSync(${JSON.stringify(path)}, next);
process.exit(0);
`,
		);
		const child = spawnSync(process.execPath, [helper], { encoding: "utf8", timeout: 10_000 });
		expect(child.status, child.stderr).toBe(0);
		const replacement = acquireSureRunOwnership(tempDir);
		replacement.assertCurrent();
		expect(existsSync(reclaim)).toBe(false);
		replacement.release();
	});

	it("distinguishes a reused live PID and rejects the old instance after replacement", async () => {
		const { tempDir, path } = fixture();
		const old = acquireSureRunOwnership(tempDir);
		const record = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(path, JSON.stringify({ ...record, processIdentity: "different-process-start" }));
		const current = acquireSureRunOwnership(tempDir);
		expect(() => old.assertCurrent()).toThrow("stale");
		old.release();
		current.assertCurrent();
		current.release();
	});

	it("preserves live reclaimers, ambiguous markers and replaced owners with concrete recovery paths", async () => {
		const { tempDir, path, reclaim } = fixture();
		const live = acquireSureRunOwnership(tempDir);
		const text = readFileSync(path, "utf8");
		const owner = JSON.parse(text);
		writeFileSync(reclaim, JSON.stringify({ owner, previousOwner: text }));
		expect(() => acquireSureRunOwnership(tempDir)).toThrow("already active");
		writeFileSync(reclaim, "");
		expect(() => acquireSureRunOwnership(tempDir)).toThrow(reclaim);
		expect(readFileSync(path, "utf8")).toBe(text);
		writeFileSync(
			reclaim,
			JSON.stringify({ owner: { ...owner, processIdentity: "exited" }, previousOwner: "old owner" }),
		);
		expect(() => acquireSureRunOwnership(tempDir)).toThrow("owner changed");
		expect(readFileSync(path, "utf8")).toBe(text);
		rmSync(reclaim);
		live.release();
		writeFileSync(path, JSON.stringify({ ...owner, processIdentity: undefined }));
		expect(() => acquireSureRunOwnership(tempDir)).toThrow("no verifiable recorded start identity");
		writeFileSync(path, "");
		expect(() => acquireSureRunOwnership(tempDir)).toThrow("cannot be safely recovered");
	});

	it("serializes two processes recovering the same dead marker without removing the winner", async () => {
		const { tempDir, path, reclaim } = fixture();
		const original = acquireSureRunOwnership(tempDir);
		const dead = { ...JSON.parse(readFileSync(path, "utf8")), processIdentity: "previous-process" };
		const text = JSON.stringify(dead);
		writeFileSync(path, text);
		writeFileSync(reclaim, JSON.stringify({ owner: dead, previousOwner: text }));
		const helper = join(tempDir, "competing.mjs");
		writeFileSync(
			helper,
			`
import { acquireSureRunOwnership } from ${JSON.stringify(moduleUrl)};
try {
  acquireSureRunOwnership(${JSON.stringify(tempDir)});
  process.stdout.write("ready");
  setInterval(() => {}, 1000);
} catch { process.stdout.write("blocked"); }
`,
		);
		const children = [0, 1].map(() => {
			const child = spawn(process.execPath, [helper], { stdio: ["ignore", "pipe", "pipe"] });
			return { child, exited: once(child, "exit") };
		});
		try {
			const states = await Promise.all(
				children.map(({ child, exited }) =>
					Promise.race([
						once(child.stdout, "data").then(([data]) => String(data)),
						exited.then(() => {
							throw new Error("Recovery helper exited before reporting");
						}),
					]),
				),
			);
			expect(states.sort()).toEqual(["blocked", "ready"]);
			expect(children.some(({ child }) => child.pid === JSON.parse(readFileSync(path, "utf8")).pid)).toBe(true);
			expect(() => original.assertCurrent()).toThrow("stale");
			original.release();
			expect(existsSync(path)).toBe(true);
		} finally {
			for (const { child } of children) child.kill("SIGKILL");
			await Promise.all(children.map(({ exited }) => exited));
		}
		acquireSureRunOwnership(tempDir).release();
	});

	it("excludes a second real process, then recovers after its exit", async () => {
		const { tempDir } = fixture();
		const helper = join(tempDir, "owner.mjs");
		writeFileSync(
			helper,
			`
import { acquireSureRunOwnership } from ${JSON.stringify(moduleUrl)};
acquireSureRunOwnership(${JSON.stringify(tempDir)});
process.stdout.write("ready");
setInterval(() => {}, 1000);
`,
		);
		const child = spawn(process.execPath, [helper], { stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		const exited = once(child, "exit");
		try {
			await Promise.race([
				once(child.stdout, "data"),
				exited.then(() => {
					throw new Error(`Owner process exited before readiness: ${stderr}`);
				}),
			]);
			expect(() => acquireSureRunOwnership(tempDir)).toThrow("already active");
		} finally {
			child.kill("SIGKILL");
			await exited;
		}
		const replacement = acquireSureRunOwnership(tempDir);
		replacement.assertCurrent();
		replacement.release();
	});
});
