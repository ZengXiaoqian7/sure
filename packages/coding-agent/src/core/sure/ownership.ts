import { type ExecFileSyncOptionsWithStringEncoding, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export interface SureRunOwnership {
	assertCurrent(): void;
	release(): void;
}

interface Owner {
	pid: number;
	host: string;
	nonce: string;
	processIdentity?: string;
}

interface Reclaim {
	owner: Owner;
	previousOwner: string | null;
}

/** A PID alone is not a process identity. Unverifiable identities fail closed. */
function processIdentity(pid: number): string | undefined {
	try {
		process.kill(pid, 0);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return undefined;
		throw error;
	}
	try {
		if (process.platform === "linux") {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const start = stat
				.slice(stat.lastIndexOf(")") + 2)
				.trim()
				.split(/\s+/)[19];
			if (!start || !/^\d+$/.test(start)) throw new Error("Missing process start time");
			return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${start}`;
		}
		if (process.platform === "darwin") {
			const options: ExecFileSyncOptionsWithStringEncoding = {
				encoding: "utf8",
				env: { LC_ALL: "C", TZ: "UTC" },
				stdio: ["ignore", "pipe", "ignore"],
			};
			const start = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], options).trim();
			const boot = execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], options).trim();
			if (!start || !boot) throw new Error("Missing process start time");
			return `${boot}:${start}`;
		}
		throw new Error(`Process start identity unavailable on ${process.platform}`);
	} catch (error) {
		try {
			process.kill(pid, 0);
		} catch (probe) {
			if (probe instanceof Error && "code" in probe && probe.code === "ESRCH") return undefined;
		}
		throw error;
	}
}

/** Publish complete records with exclusive creation, never a partially written lock. */
function publishOwnerRecord(path: string, text: string): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporary, text, { flag: "wx" });
	try {
		linkSync(temporary, path);
	} finally {
		unlinkSync(temporary);
	}
}

/** Local invocation ownership survives executor/supervisor handoffs, without a takeover timer. */
export function acquireSureRunOwnership(runDir: string): SureRunOwnership {
	const path = join(runDir, ".coordination-owner.json");
	const reclaimPath = `${path}.reclaim`;
	const manual = (reason: string): Error =>
		new Error(
			`SURE run ownership cannot be safely recovered: ${reason}. Inspect ${path} and ${reclaimPath}; verify the recorded host, PID and process start identity. Only after confirming all recorded invocations have exited and the owner record has not been replaced, move the stale records aside and retry.`,
		);
	const readOwner = (text: string): Owner => {
		const value = JSON.parse(text) as Owner;
		if (
			!value ||
			!Number.isSafeInteger(value.pid) ||
			value.pid <= 0 ||
			value.host !== hostname() ||
			typeof value.nonce !== "string" ||
			!/^[a-f0-9-]{36}$/.test(value.nonce)
		)
			throw manual("invalid identity or another host");
		return value;
	};
	const isActive = (value: Owner): boolean => {
		const current = processIdentity(value.pid);
		if (!current) return false;
		if (typeof value.processIdentity !== "string" || !value.processIdentity)
			throw manual("live PID has no verifiable recorded start identity");
		return current === value.processIdentity;
	};
	const readCurrent = (): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null);
	try {
		const owner: Owner = {
			pid: process.pid,
			host: hostname(),
			nonce: randomUUID(),
			processIdentity: processIdentity(process.pid),
		};
		if (!owner.processIdentity) throw manual("current process start identity unavailable");
		const ownerText = JSON.stringify(owner);
		if (existsSync(reclaimPath)) {
			const staleText = readFileSync(reclaimPath, "utf8");
			const stale = JSON.parse(staleText) as Reclaim;
			if (!stale || !(stale.previousOwner === null || typeof stale.previousOwner === "string"))
				throw manual("unverifiable reclaim record");
			const restoring = readOwner(JSON.stringify(stale.owner));
			if (isActive(restoring)) throw new Error("SURE run is already active in another recovery invocation.");
			// Serialize removal of this particular dead marker as well. A second
			// cleaner must never unlink a freshly published recovery marker (ABA).
			const recoveryPath = `${reclaimPath}.${restoring.nonce}.recovering`;
			try {
				publishOwnerRecord(recoveryPath, ownerText);
			} catch {
				throw manual(`reclaim cleanup is already claimed; inspect ${recoveryPath} as well`);
			}
			try {
				const current = readCurrent();
				if (current !== null && current !== stale.previousOwner && current !== JSON.stringify(restoring))
					throw manual("owner changed after the interrupted recovery");
				if (readFileSync(reclaimPath, "utf8") !== staleText || readCurrent() !== current)
					throw manual("records changed while recovering the reclaim marker");
				unlinkSync(reclaimPath);
			} finally {
				if (readFileSync(recoveryPath, "utf8") === ownerText) unlinkSync(recoveryPath);
			}
		}
		const previousText = readCurrent();
		if (previousText !== null && isActive(readOwner(previousText)))
			throw new Error("SURE run is already active in another invocation.");
		const reclaimText = JSON.stringify({ owner, previousOwner: previousText } satisfies Reclaim);
		publishOwnerRecord(reclaimPath, reclaimText);
		try {
			if (readFileSync(reclaimPath, "utf8") !== reclaimText || readCurrent() !== previousText)
				throw manual("owner changed during recovery");
			if (previousText !== null) unlinkSync(path);
			publishOwnerRecord(path, ownerText);
		} finally {
			if (existsSync(reclaimPath) && readFileSync(reclaimPath, "utf8") === reclaimText) unlinkSync(reclaimPath);
		}
		return {
			assertCurrent: () => {
				if (readCurrent() !== ownerText) throw new Error("SURE invocation ownership is stale.");
			},
			release: () => {
				if (readCurrent() === ownerText) unlinkSync(path);
			},
		};
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("SURE ")) throw error;
		throw manual(error instanceof Error ? error.message : String(error));
	}
}
