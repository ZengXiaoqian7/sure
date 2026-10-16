import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { sureHash, writeSureJson } from "./evidence.ts";

export interface SureDiagnosticTarget {
	runId: string;
	runDir: string;
	role: "executor" | "supervisor";
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function fingerprint(value: unknown): { bytes: number; sha256: string } {
	const serialized = JSON.stringify(value) ?? "";
	return { bytes: Buffer.byteLength(serialized), sha256: sureHash(serialized) };
}

function cacheValue(value: unknown): unknown {
	const allowed = new Set(["24h", "1h", "30m", "5m", "in-memory", "short", "long", "none", "ephemeral"]);
	if (typeof value === "string") return allowed.has(value) ? value : undefined;
	const fields = Object.entries(record(value)).filter(
		([key, item]) => ["type", "ttl"].includes(key) && typeof item === "string" && allowed.has(item),
	);
	return fields.length ? Object.fromEntries(fields) : undefined;
}

/** An allowlist, never a raw usage/body dump. Cumulative chunks are recorded separately, not summed. */
export function sureUsageFields(raw: unknown): Record<string, unknown> {
	const usage = record(raw);
	return Object.fromEntries(
		[
			"prompt_tokens",
			"completion_tokens",
			"cached_tokens",
			"prompt_cache_hit_tokens",
			"prompt_tokens_details.cached_tokens",
			"prompt_tokens_details.cache_write_tokens",
		].map((path) => {
			const parts = path.split(".");
			const parent = parts.length === 1 ? usage : record(usage[parts[0]]);
			const key = parts.at(-1)!;
			const value = parent[key];
			return [
				path,
				{
					present: Object.hasOwn(parent, key),
					...(value === null ||
					typeof value === "number" ||
					(typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value))
						? { value }
						: value === undefined
							? {}
							: { type: typeof value }),
				},
			];
		}),
	);
}

/** Per-session, coordinated runs only. The observer never changes requests or normalized usage. */
export class SureProviderDiagnostics {
	private sequence = 0;
	private instanceId = randomUUID();
	private previous: { payload: Buffer; messages: string[]; system: string; tools: string } | undefined;
	private target: SureDiagnosticTarget;
	constructor(target: SureDiagnosticTarget) {
		this.target = target;
	}

	start(model: Model<string>, sessionId?: string) {
		const id = randomUUID();
		const path = join(this.target.runDir, "evidence/provider", `${this.target.role}-${id}.json`);
		const data: Record<string, unknown> = {
			version: 1,
			...this.target,
			runDir: undefined,
			id,
			sequence: ++this.sequence,
			instanceId: this.instanceId,
			provider: model.provider,
			model: model.id,
			api: model.api,
			endpointHash: sureHash(model.baseUrl),
			sessionHash: sessionId ? sureHash(sessionId) : null,
			sentAt: null,
			firstDeltaAt: null,
			endedAt: null,
			rawUsage: [],
			dispatches: [],
		};
		const save = () => {
			try {
				writeSureJson(path, data);
			} catch {
				/* Diagnostics must not change provider behavior. */
			}
		};
		return {
			payload: (payload: unknown, wireBody?: string, requestUrl?: string) => {
				if (requestUrl) data.endpointHash = sureHash(requestUrl);
				// JSON round-trip follows the actual serializer's order and omission of undefined values.
				const serialized = wireBody ?? JSON.stringify(payload);
				const body = record(JSON.parse(serialized));
				const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
				const encoded = messages.map((message) => JSON.stringify(message));
				const system = JSON.stringify(
					body.instructions ??
						messages.filter((message) => ["system", "developer"].includes(String(record(message).role))),
				);
				const tools = JSON.stringify(body.tools ?? null);
				const bytes = Buffer.from(serialized);
				const previous = this.previous;
				let commonBytes = 0;
				let commonMessages = 0;
				if (previous) {
					while (
						commonBytes < Math.min(bytes.length, previous.payload.length) &&
						bytes[commonBytes] === previous.payload[commonBytes]
					)
						commonBytes++;
					while (
						commonMessages < Math.min(encoded.length, previous.messages.length) &&
						encoded[commonMessages] === previous.messages[commonMessages]
					)
						commonMessages++;
				}
				const sentAt = Date.now();
				data.sentAt ??= sentAt;
				data.lastSentAt = sentAt;
				data.dispatchCount = Number(data.dispatchCount ?? 0) + 1;
				(data.dispatches as unknown[]).push({
					index: data.dispatchCount,
					sentAt,
					payloadHash: sureHash(serialized),
					commonBytes: previous ? commonBytes : null,
					commonMessages: previous ? commonMessages : null,
				});
				data.payload = {
					bytes: bytes.length,
					sha256: sureHash(serialized),
					systemHash: sureHash(system),
					toolsHash: sureHash(tools),
					messages: messages.map((message, index) => {
						const item = record(message);
						return {
							index,
							role: item.role ?? item.type ?? "unknown",
							identityHash: fingerprint(item.tool_call_id ?? item.call_id ?? item.id ?? index).sha256,
							...fingerprint(message),
						};
					}),
					previous: previous
						? {
								commonBytes,
								commonMessages,
								firstChangedMessage: commonMessages,
								systemUnchanged: previous.system === system,
								toolsUnchanged: previous.tools === tools,
							}
						: null,
				};
				const cache: Record<string, unknown> = {};
				for (const key of ["prompt_cache_key", "prompt_cache_retention", "prompt_cache_options", "cache_control"]) {
					const value = body[key];
					cache[key] = {
						present: Object.hasOwn(body, key),
						...(value === undefined
							? {}
							: key === "prompt_cache_key"
								? { hash: fingerprint(value).sha256 }
								: {
										...fingerprint(value),
										value: cacheValue(value),
									}),
					};
				}
				// Cache markers may live on message content or tool definitions.
				const markers: Array<{ path: string; sha256: string; value: unknown }> = [];
				const walk = (value: unknown, path: string) => {
					if (!value || typeof value !== "object") return;
					for (const [key, child] of Object.entries(value)) {
						if (key === "cache_control")
							markers.push({
								path: `${path}.${key}`,
								sha256: fingerprint(child).sha256,
								value: cacheValue(child),
							});
						else if (typeof child === "object") walk(child, `${path}.${key}`);
					}
				};
				walk(body.messages, "messages");
				walk(body.tools, "tools");
				data.cache = { ...cache, markers };
				this.previous = { payload: bytes, messages: encoded, system, tools };
				save();
			},
			headers: (headers: Record<string, string | null>) => {
				data.affinity = Object.fromEntries(
					["session_id", "x-client-request-id", "x-session-affinity", "x-session-id"].map((key) => {
						const value = Object.entries(headers).find(([name]) => name.toLowerCase() === key)?.[1];
						return [key, { present: value != null, hash: value == null ? undefined : sureHash(value) }];
					}),
				);
				save();
			},
			usage: (event: Parameters<NonNullable<SimpleStreamOptions["onOpenAICompletionsUsage"]>>[0]) => {
				(data.rawUsage as unknown[]).push({
					source: event.source,
					dispatchIndex: data.dispatchCount ?? null,
					chunkIndex: event.chunkIndex,
					applied: event.applied,
					fields: sureUsageFields(event.usage),
					normalized: { ...event.normalized },
				});
				save();
			},
			wrap: (source: AssistantMessageEventStream): AssistantMessageEventStream => {
				const output = createAssistantMessageEventStream();
				void (async () => {
					for await (const event of source) {
						if (
							data.firstDeltaAt === null &&
							(event.type === "text_delta" || event.type === "toolcall_delta") &&
							event.delta.length > 0
						) {
							data.firstDeltaAt = Date.now();
							data.firstDeltaType = event.type;
							save();
						}
						if (event.type === "done" || event.type === "error") {
							const message = event.type === "done" ? event.message : event.error;
							data.endedAt = Date.now();
							data.normalizedUsage = message.usage;
							data.responseIdHash = message.responseId ? sureHash(message.responseId) : null;
							data.stopReason = message.stopReason;
							save();
						}
						output.push(event);
					}
					output.end();
				})();
				return output;
			},
		};
	}
}
