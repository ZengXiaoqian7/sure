import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import { SURE_COORDINATION_LIMITS, type SureCoordinationLimits } from "./coordination-types.ts";
import type { SureRunRecord } from "./types.ts";

export function writeSureJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	try {
		renameSync(temporary, path);
	} finally {
		if (existsSync(temporary)) rmSync(temporary);
	}
}

export function sureHash(text: string | Buffer): string {
	return createHash("sha256").update(text).digest("hex");
}

export interface SureSnapshotFile {
	path: string;
	status: "text" | "missing" | "binary" | "over_limit" | "unreadable" | "excluded";
	size?: number;
	modifiedAt?: number;
	sha256?: string;
	text?: string;
	reason?: string;
}

export interface SureSnapshot {
	version: 1;
	id: string;
	unitId: string;
	checkScope: string[];
	kind: "initial" | "passed" | "failed" | "barrier";
	createdAt: string;
	files: SureSnapshotFile[];
	fingerprint: string;
	truncated: boolean;
}

/** Resolve declared evidence only within the run, project, or skill; reject symlink escapes. */
export function resolveSureEvidencePath(run: SureRunRecord, value: string): string | undefined {
	const prefixes = { "project:": run.cwd, "run:": run.runDir, "package:": run.packageDir };
	const prefix = Object.keys(prefixes).find((prefix) => value.startsWith(prefix)) as keyof typeof prefixes | undefined;
	const candidate = prefix ? resolve(prefixes[prefix], value.slice(prefix.length)) : resolve(run.cwd, value);
	const roots = [run.cwd, run.runDir, run.packageDir].map((root) => realpathSync(root));
	let existing = candidate;
	while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
	const physical = resolve(realpathSync(existing), relative(existing, candidate));
	return roots.some((root) => {
		const rel = relative(root, physical);
		return rel === "" || (rel !== ".." && !rel.startsWith(`..\\`) && !rel.startsWith("../") && !isAbsolute(rel));
	})
		? candidate
		: undefined;
}

const EXCLUDED_NAMES = new Set([".git", ".venv", "node_modules", "__pycache__", "auth.json", ".env"]);
const IDENTITY_ONLY_EXTENSIONS = new Set([
	".safetensors",
	".bin",
	".pt",
	".pth",
	".onnx",
	".wav",
	".mp3",
	".flac",
	".mp4",
]);

export function sureEvidenceTextAllowed(path: string): boolean {
	let existing = path;
	while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
	const physical = resolve(realpathSync(existing), relative(existing, path));
	return [path, physical].every(
		(candidate) =>
			!candidate.split(/[\\/]/).some((part) => EXCLUDED_NAMES.has(part) || part.startsWith(".env.")) &&
			!IDENTITY_ONLY_EXTENSIONS.has(extname(candidate).toLowerCase()),
	);
}

export function evidencePathName(run: SureRunRecord, path: string): string {
	for (const [prefix, root] of [
		["run:", run.runDir],
		["package:", run.packageDir],
		["project:", run.cwd],
	]) {
		const rel = relative(root, path);
		if (rel === "" || (rel !== ".." && !rel.startsWith(`..\\`) && !rel.startsWith("../") && !isAbsolute(rel)))
			return `${prefix}${rel.split(/[\\/]/).join("/")}`;
	}
	return path;
}

/** A newer receipt supersedes an older live version, including across resumed segments. */
export function assertSureDiagnosticSourcesCurrent(run: SureRunRecord, readKeys: string[] = []): void {
	const latest = new Map<string, Record<string, unknown>>();
	for (const key of readKeys) {
		const read = JSON.parse(key) as Record<string, unknown>;
		if (typeof read.path === "string" && typeof read.sha256 === "string") latest.set(read.path, read);
	}
	for (const [value, read] of latest) {
		if (read.source !== "file") continue;
		const path = resolveSureEvidencePath(run, value);
		if (!path || !sureEvidenceTextAllowed(path) || !existsSync(path) || sureHash(readFileSync(path)) !== read.sha256)
			throw new Error(
				`Live diagnostic source changed or became unavailable: ${evidencePathName(run, value)}; reassess current evidence.`,
			);
	}
}

export function captureSureSnapshot(
	run: SureRunRecord,
	unitId: string,
	kind: SureSnapshot["kind"],
	scope: string[],
	limits: SureCoordinationLimits = SURE_COORDINATION_LIMITS,
): SureSnapshot {
	const files: SureSnapshotFile[] = [];
	let bytes = 0;
	let truncated = false;
	let directories = 0;
	const visited = new Set<string>();
	const visit = (value: string): void => {
		if (files.length >= limits.snapshotFiles) {
			truncated = true;
			return;
		}
		try {
			const path = resolveSureEvidencePath(run, value);
			const identity = path ?? value;
			if (visited.has(identity)) return;
			visited.add(identity);
			if (!path) {
				files.push({ path: value, status: "excluded", reason: "outside declared roots or symlink escape" });
				return;
			}
			// A file may be declared directly, via its parent, or as an absolute path.
			// Use one stable name so scope spelling cannot invalidate saved advice.
			value = evidencePathName(run, path);
			// Run ownership and the supervisor's own evolving conversation are not business changes.
			if (
				value === "run:supervisor" ||
				value.startsWith("run:supervisor/") ||
				value.startsWith("run:.coordination-owner.json")
			)
				return;
			if (!existsSync(path)) {
				files.push({ path: value, status: "missing" });
				return;
			}
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) {
				files.push({ path: value, status: "excluded", reason: "symbolic link" });
				return;
			}
			if (stat.isDirectory()) {
				directories++;
				if (directories > limits.snapshotFiles) {
					truncated = true;
					return;
				}
				for (const entry of readdirSync(path).sort()) {
					if (files.length >= limits.snapshotFiles) {
						truncated = true;
						break;
					}
					if (EXCLUDED_NAMES.has(entry) || entry.startsWith(".env.")) {
						files.push({
							path: `${value}/${entry}`,
							status: "excluded",
							reason: "runtime, cache or sensitive configuration",
						});
						continue;
					}
					visit(`${value.replace(/[\\/]$/, "")}/${entry}`);
				}
				return;
			}
			const fileIdentity = { path: value, size: stat.size, modifiedAt: stat.mtimeMs };
			if (!sureEvidenceTextAllowed(path)) {
				files.push({
					...fileIdentity,
					status: "binary",
					reason: "weights, data or excluded content: identity only",
				});
				return;
			}
			if (!stat.isFile()) {
				files.push({ ...fileIdentity, status: "excluded", reason: "not a regular file" });
				return;
			}
			if (stat.size > limits.snapshotFileBytes || bytes + stat.size > limits.snapshotTotalBytes) {
				files.push({ ...fileIdentity, status: "over_limit", reason: "content omitted; identity only" });
				return;
			}
			const content = readFileSync(path);
			bytes += content.length;
			const sha256 = sureHash(content);
			const text = content.toString("utf8");
			const binary = content.includes(0) || !Buffer.from(text, "utf8").equals(content);
			files.push({ ...fileIdentity, status: binary ? "binary" : "text", sha256, text: binary ? undefined : text });
		} catch (error) {
			files.push({
				path: value,
				status: "unreadable",
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	};
	const ordered = [...new Set(scope)].sort((a, b) => {
		const file = (value: string): number => {
			try {
				const path = resolveSureEvidencePath(run, value);
				return path && existsSync(path) && lstatSync(path).isDirectory() ? 1 : 0;
			} catch {
				return 0;
			}
		};
		return file(a) - file(b) || a.localeCompare(b);
	});
	for (const value of ordered) visit(value);
	files.sort((a, b) => a.path.localeCompare(b.path));
	const fingerprint = sureHash(
		JSON.stringify(
			files.map(({ path, status, sha256, size, modifiedAt }) => ({
				path,
				status,
				sha256,
				size,
				modifiedAt: sha256 ? undefined : modifiedAt,
			})),
		),
	);
	const snapshot: SureSnapshot = {
		version: 1,
		id: randomUUID(),
		unitId,
		checkScope: [
			...new Set(
				scope.map((value) => {
					try {
						const path = resolveSureEvidencePath(run, value);
						return path ? evidencePathName(run, path) : value;
					} catch {
						return value;
					}
				}),
			),
		].sort(),
		kind,
		createdAt: new Date().toISOString(),
		files,
		fingerprint,
		truncated,
	};
	// Repeated checks/barriers retain their own event/version, but need only one
	// immutable body per unit, kind, scope and observed content. Hashed files may
	// have been touched without changing content; identity-only files retain mtime.
	const identity = sureHash(
		JSON.stringify({
			unitId,
			kind,
			checkScope: snapshot.checkScope,
			truncated,
			files: files.map(({ modifiedAt, ...file }) => ({ ...file, modifiedAt: file.sha256 ? undefined : modifiedAt })),
		}),
	);
	snapshot.id = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-${identity.slice(12, 16)}-${identity.slice(16, 20)}-${identity.slice(20, 32)}`;
	const path = join(run.runDir, "snapshots", `${snapshot.id}.json`);
	if (existsSync(path)) return readSureSnapshot(run, snapshot.id);
	writeSureJson(path, snapshot);
	return snapshot;
}

export function readSureSnapshot(run: SureRunRecord, id: string): SureSnapshot {
	if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid Sure snapshot id.");
	return JSON.parse(readFileSync(join(run.runDir, "snapshots", `${id}.json`), "utf8")) as SureSnapshot;
}

/** The old text comes from the persisted historical snapshot, never the live filesystem. */
export function diffSureSnapshots(before: SureSnapshot, after: SureSnapshot): string {
	const oldFiles = new Map(before.files.map((file) => [file.path, file]));
	const newFiles = new Map(after.files.map((file) => [file.path, file]));
	const changes: string[] = [];
	const covers = (snapshot: SureSnapshot, path: string): boolean =>
		snapshot.checkScope.some((scope) => path === scope || path.startsWith(scope.endsWith(":") ? scope : `${scope}/`));
	for (const path of [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort()) {
		const oldFile = oldFiles.get(path);
		const newFile = newFiles.get(path);
		if (oldFile?.status === "text" && newFile?.status === "text" && oldFile.sha256 === newFile.sha256) continue;
		if (JSON.stringify(oldFile) === JSON.stringify(newFile)) continue;
		if (!oldFile && (before.truncated || !covers(before, path))) {
			changes.push(
				`${path}: not captured in baseline scope${before.truncated ? " (snapshot truncated)" : ""}; no addition inferred.`,
			);
			continue;
		}
		if (!newFile && (after.truncated || !covers(after, path))) {
			changes.push(
				`${path}: not captured in current scope${after.truncated ? " (snapshot truncated)" : ""}; no deletion inferred.`,
			);
			continue;
		}
		if (
			(oldFile?.status === "text" && (!newFile || newFile.status === "text" || newFile.status === "missing")) ||
			(newFile?.status === "text" && (!oldFile || oldFile.status === "missing"))
		) {
			changes.push(createTwoFilesPatch(path, path, oldFile?.text ?? "", newFile?.text ?? ""));
		} else
			changes.push(
				`${path}: ${oldFile?.status ?? "absent"} -> ${newFile?.status ?? "absent"}; ${JSON.stringify({ before: oldFile, after: newFile })}`,
			);
	}
	return changes.join("\n");
}
