// Read-only manual acceptance aid. Recorded statuses do not revalidate a gate.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];

function readJson(path) {
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}

function reportedUsage(paths, start, end) {
	const totals = Object.fromEntries(TOKEN_FIELDS.map((key) => [key, 0]));
	let responses = 0;
	let missingUsage = 0;
	let compactions = 0;
	let branchSummaries = 0;
	const models = new Set();
	const seen = new Set();
	const files = new Set(paths.map((path) => realpathSync(path)));
	for (const path of files) {
		for (const line of readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean)) {
			const entry = JSON.parse(line);
			const time = Date.parse(entry.timestamp);
			if (!Number.isFinite(time) || time < start || time > end) continue;
			const assistant = entry.type === "message" && entry.message?.role === "assistant";
			if (!assistant && entry.type !== "compaction" && entry.type !== "branch_summary") continue;
			// Copied/forked transcripts can contain the same physical response.
			const identity = JSON.stringify([entry.id, entry.timestamp]);
			if (seen.has(identity)) continue;
			seen.add(identity);
			responses++;
			if (entry.type === "compaction") compactions++;
			if (entry.type === "branch_summary") branchSummaries++;
			const usage = assistant ? entry.message.usage : entry.usage;
			if (assistant) models.add(`${entry.message.provider}/${entry.message.model}`);
			if (!usage || TOKEN_FIELDS.some((key) => !Number.isFinite(usage[key]) || usage[key] < 0)) {
				missingUsage++;
				continue;
			}
			for (const key of TOKEN_FIELDS) totals[key] += usage[key];
		}
	}
	return { files: files.size, responses, compactions, branchSummaries, missingUsage, models: [...models].sort(), reportedTokens: totals };
}

/** Read-only source identity; runtime/model settings and cache state are recorded separately. */
export function captureComparisonSource(repoRoot, inputs = []) {
	repoRoot = realpathSync(resolve(repoRoot));
	const git = (...args) => execFileSync("git", ["-c", "core.fsmonitor=false", "--no-pager", ...args], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
	const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
	const sensitive = (path) => path.split(/[\\/]/).some((part) => part === "auth.json" || part === ".env" || part.startsWith(".env."));
	const untrackedSources = git("ls-files", "--others", "--exclude-standard", "-z").toString("utf8").split("\0").filter((path) =>
		path && !sensitive(path) && lstatSync(join(repoRoot, path)).isFile() && /\.(ts|js|mjs|py|json|yaml|yml|md)$/.test(path) &&
		(/^(packages|scripts|sure\/(skills|runtime|site)|config|docs)\//.test(path) || !path.includes("/")),
	).sort().map((path) => ({ path, sha256: hash(readFileSync(join(repoRoot, path))) }));
	const files = [...new Set(["package-lock.json", "config/site.bundled.yaml", "config/site.local.yaml", "config/site.default.yaml", ...inputs])].map((path) => {
		const resolved = resolve(repoRoot, path);
		return { path, sha256: !sensitive(resolved) && existsSync(resolved) && lstatSync(resolved).isFile() ? hash(readFileSync(resolved)) : null };
	});
	return {
		repoRoot,
		commit: git("rev-parse", "HEAD").toString("utf8").trim(),
		dirtyDiffSha256: hash(git("diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--")),
		untrackedSources,
		untrackedSourcesSha256: hash(JSON.stringify(untrackedSources)),
		evaluationGitlink: git("ls-files", "--stage", "--", "sure/external/sure-evaluation").toString("utf8").trim(),
		files,
		host: { platform: process.platform, arch: process.arch, node: process.version },
		note: "Capture before each run. Supply policy/lock/weights-manifest/fixture/wrapper inputs explicitly. This does not establish equal model settings, equal caches or live runtime validity.",
	};
}

export function inspectCoordinationRun(runDir, executorSessions = []) {
	runDir = resolve(runDir);
	const source = readJson(join(runDir, "run.json")) ?? readJson(join(runDir, "result.json"));
	const run = source?.schema === "sure.run_result.v1"
		? { runId: source.run_id, runDir: source.run_dir, args: source.args, status: source.status, startedAt: source.started_at, finishedAt: source.finished_at }
		: source;
	if (!run) throw new Error(`Missing run.json: ${runDir}`);
	const start = Date.parse(run.startedAt);
	const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error("Invalid run time range.");
	const state = readJson(join(runDir, "state.json"));
	const coordination = readJson(join(runDir, "coordination.json"));
	const report = readJson(join(runDir, "failure-report.json"));
	const attempts = coordination?.attempts ?? [];
	const supervisorSessions = [];
	const missingSupervisorSessions = [];
	for (const attempt of attempts) {
		if (attempt.supervisorSessionId) {
			const session = coordination.supervisorSession;
			let file = session?.file;
			if (file && run.runDir) {
				const rel = relative(run.runDir, file);
				if (rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
					file = join(runDir, rel);
			}
			if (session?.id === attempt.supervisorSessionId && file && existsSync(file))
				supervisorSessions.push(file);
			else missingSupervisorSessions.push(attempt.id);
			continue;
		}
		const dir = join(runDir, "diagnoses", attempt.id, "session");
		const paths = existsSync(dir)
			? readdirSync(dir)
					.filter((name) => name.endsWith(".jsonl"))
					.map((name) => join(dir, name))
			: [];
		supervisorSessions.push(...paths);
		if (!paths.length) missingSupervisorSessions.push(attempt.id);
	}
	const executor = reportedUsage(executorSessions, start, end);
	const supervisor = reportedUsage(supervisorSessions, start, end);
	const storage = {};
	for (const name of ["coordination.json", "evidence", "snapshots", "diagnoses", "supervisor", "failure-report.json", "failure-report.md"]) {
		const size = { files: 0, bytes: 0 };
		const walk = (path) => {
			const stat = lstatSync(path);
			if (stat.isDirectory()) for (const entry of readdirSync(path)) walk(join(path, entry));
			else if (stat.isFile()) { size.files++; size.bytes += stat.size; }
		};
		const path = join(runDir, name);
		if (existsSync(path)) walk(path);
		storage[name] = size;
	}
	const recordedUsageComplete =
		run.finishedAt !== undefined &&
		executorSessions.length > 0 &&
		executor.responses > 0 &&
		executor.missingUsage === 0 &&
		supervisor.missingUsage === 0 &&
		missingSupervisorSessions.length === 0;
	const repairs = (coordination?.repairs ?? []).map((repair) => {
		const issues = [];
		for (const [label, id] of [
			["before", repair.beforeSnapshotId],
			["after", repair.afterSnapshotId],
		]) {
			if (id && !existsSync(join(runDir, "snapshots", `${id}.json`)))
				issues.push(`Missing ${label} snapshot: ${id}`);
		}
		const checks = repair.checkVersions.map((version) => {
			const evidence = readJson(join(runDir, "evidence", `${version}.json`));
			if (!evidence) issues.push(`Missing check:${version}`);
			else if (evidence.repairId !== repair.id || evidence.check.unitId !== repair.unitId)
				issues.push(`Mismatched repair identity at check:${version}`);
			return { version, outcome: evidence?.check.outcome, snapshotId: evidence?.snapshotId };
		});
		if (repair.outcome === "passed" && !checks.some((check) => check.outcome === "passed"))
			issues.push("Passed repair has no linked passing check.");
		if (repair.gateOutcome === "passed" && !checks.some((check) => check.version === repair.gateCheckVersion && check.outcome === "passed"))
			issues.push("Recorded gate pass has no linked passing check.");
		return { ...repair, checks, issues };
	});
	return {
		runId: run.runId,
		runDir,
		status: run.status,
		args: run.args,
		elapsedMs: end - start,
		finished: Boolean(run.finishedAt),
		storage,
		recorded: {
			currentUnit: state?.checkpoint?.data?.currentUnit,
			completedUnits: state?.checkpoint?.data?.completedUnits ?? [],
			readiness: readJson(join(runDir, "artifacts/deployment_ready.json"))?.status,
			gates: Object.fromEntries(
				["import", "load", "infer", "contract"].map((stage) => {
					const artifact = readJson(join(runDir, "artifacts", `${stage}_result.json`));
					return [
						stage,
						{ passed: artifact?.[`${stage}_passed`], executed: artifact?.executed, logPath: artifact?.log_path },
					];
				}),
			),
		},
		coordination: coordination
			? {
					version: coordination.version,
					status: coordination.status,
					unresolvedCheckVersion: coordination.unresolvedCheckVersion,
					reviewedFailureVersion: coordination.reviewedFailureVersion,
					limits: coordination.limits,
					units: coordination.units,
					attempts: attempts.map(({ id, unitId, modelTurns, readCalls, readRequests, elapsedMs, error, result, checkpoint, segments, compactionCalls, usage }) => ({
						id,
						unitId,
						modelTurns,
						readCalls,
						readRequests,
						elapsedMs,
						segments,
						compactionCalls,
						usage,
						error,
						decision: result?.decision,
						checkpoint,
					})),
					repairs,
					pendingRepairId: coordination.pendingRepair?.id,
				}
			: null,
		failure: report
			? {
					outcome: report.outcome,
					stage: report.stage,
					diagnosisStatus: report.diagnosisStatus,
					stopReason: report.stopReason,
					resumable: report.resumable,
					resumeCommand: report.resumeCommand,
				}
			: null,
		usage: {
			executor,
			supervisor,
			missingSupervisorSessions,
			recordedUsageComplete,
			combinedReportedTokens: recordedUsageComplete
				? Object.fromEntries(
						TOKEN_FIELDS.map((key) => [key, executor.reportedTokens[key] + supervisor.reportedTokens[key]]),
					)
				: null,
		},
		notes: [
			"Recorded evidence only: inspect original gate logs, products and TUI before accepting the run.",
			"Usage covers supplied executor transcripts and indexed supervisor sessions within the run time range, including compaction/branch summaries. Supply every resumed executor session; provider-internal retries or unrecorded requests cannot be counted here.",
			"Elapsed time includes pauses and resume downtime. Cache conditions and human readability require manual recording.",
			"Storage is logical bytes for coordination records only; symlinks are not followed. Measure run and output export separately. Compaction counts are recorded events; unrecorded provider retries remain unknown. Protocol validity, task usefulness, execution, gate recovery and false handoffs/acceptances require evidence review.",
		],
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		const [runDir, ...sessions] = process.argv.slice(2);
		if (runDir === "--comparison-source") {
			console.log(JSON.stringify(captureComparisonSource(sessions[0] ?? process.cwd(), sessions.slice(1)), null, 2));
		} else {
		if (!runDir)
			throw new Error("Usage: node scripts/sure-coordination-inspect.mjs RUN_DIR [EXECUTOR_SESSION.jsonl ...] | --comparison-source REPO [INPUT ...]");
		console.log(JSON.stringify(inspectCoordinationRun(runDir, sessions), null, 2));
		}
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
