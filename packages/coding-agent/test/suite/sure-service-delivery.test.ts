import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveHarnessPython } from "../../../../sure/runtime/harness/resolve.ts";
import { discoverSureSkillPackages } from "../../src/core/sure/manifest.ts";
import { createHarness, type Harness } from "./harness.ts";

const repository = resolve(import.meta.dirname, "../../../..");
const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("onboard delivery through the unchanged infer consumer", () => {
	it("makes original consumer sources available to service repair diagnosis", () => {
		const skill = discoverSureSkillPackages(repository).packages.find(
			(item) => item.manifest.name === "sure_onboard",
		)!;
		for (const unit of ["generate_wrapper", "validate_contract", "finalize_model_bundle"]) {
			const stage = skill.manifest.coordination!.stages.find((stage) => stage.id === unit)!;
			expect(stage.diagnosticPaths).toContain("project:sure/skills/sure_infer/scripts/server_protocol.py");
			expect(stage.diagnosticPaths).toContain(
				"project:sure/skills/sure_infer/scripts/generate_predictions_via_server.py",
			);
		}
	});

	it("round-trips stub success and errors, checks runtime identity and detects the historical framing/envelope defects", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const runtime = resolveHarnessPython(join(repository, "sure/skills/sure_infer"));
		expect(runtime.ok, runtime.error).toBe(true);
		const script = join(harness.tempDir, "service-probe.py");
		writeFileSync(
			script,
			`
import json, os, sys
from pathlib import Path
import generate_predictions_via_server as consumer

root = Path(__file__).parent
server = root / "server.py"
server.write_text('''import json, os, sys
from pathlib import Path
for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    args = request.get("params", {}).get("arguments", request)
    if os.environ.get("BAD_FRAMING"):
        print(json.dumps({"ok":True,"output":{"text":"stub"}}), flush=True)
        break
    if method == "initialize":
        result = {"protocolVersion":"2024-11-05", "capabilities":{"tools":{}}}
    elif method == "tools/list":
        result = {"tools":[{"name":"transcribe"}]}
    elif not args.get("audio_path"):
        print(json.dumps({"jsonrpc":"2.0","id":request.get("id"),"error":{"code":-32602,"message":"audio_path required"}}), flush=True)
        continue
    else:
        assert Path.cwd() == Path(__file__).parent
        assert os.environ["DEVICE"] == "cpu"
        result = {"content":[{"type":"text", "text":json.dumps({"prediction":{"text":"可用 stub 文本"}})}]}
    print(json.dumps({"jsonrpc":"2.0", "id":request.get("id"), "result":result}), flush=True)
''', encoding="utf-8")
inventory = {"schema":"sure.onboard.runtime_inventory.v2", "status":"ready", "policy":{"eval_runtime":"python","host_python_fallback":False,"image_override_allowed":False}, "model_runtime":{"required":True,"runtime_id":"stub-runtime", "server_command":["runtime-python","server.py"],"tool_names":["transcribe"]}}
os.environ.update(MODEL_PYTHON=sys.executable, SURE_EVAL_MODEL_RUNTIME_ID="stub-runtime", SURE_EVAL_MODEL_WORKING_DIR=str(root))
command = consumer._resolve_server_command(root, inventory)
assert command == [sys.executable, "server.py"]
cwd = consumer._resolve_working_dir(root, inventory)
os.environ["SURE_EVAL_MODEL_RUNTIME_ID"] = "wrong-runtime"
try:
    consumer._resolve_server_command(root, inventory)
    raise AssertionError("wrong runtime was accepted")
except ValueError as error:
    assert "runtime identity" in str(error)
os.environ["SURE_EVAL_MODEL_RUNTIME_ID"] = "stub-runtime"
assert consumer.resolve_server_protocol({"transport":"stdio"}) == consumer.MCP_SERVER_PROTOCOL
cfg = {"tools":[{"name":"transcribe","input_schema":{"properties":{"audio_path":{"type":"string"}},"required":["audio_path"]}}]}
allowed, required = consumer._tool_argument_contract(cfg, "transcribe")
args = consumer._filter_tool_arguments({"audio_path":"fixture.wav", "unused":True}, allowed, required)
assert args == {"audio_path":"fixture.wav"}
with (root / "server.log").open("w") as log:
    process = consumer._start_model_server(command, working_dir=cwd, env={**os.environ,"DEVICE":"cpu"}, log_handle=log)
    try:
        for id, method in [(1,"initialize"),(2,"tools/list")]:
            response = consumer._send_request(process,{"jsonrpc":"2.0","id":id,"method":method,"params":{}})
            assert "error" not in response
        response = consumer._send_request(process,{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"transcribe","arguments":args}})
        text, normalized = consumer._normalize_prediction_payload(consumer._extract_response_payload(response), task="ASR")
        assert text == "可用 stub 文本" and normalized["text"] == text
        response = consumer._send_request(process,{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"transcribe","arguments":{}}})
        try:
            consumer._extract_response_payload(response)
            raise AssertionError("server error lost")
        except RuntimeError as error:
            assert "audio_path required" in str(error)
    finally:
        process.stdin.close()
        try: process.wait(timeout=3)
        finally:
            if process.poll() is None: process.kill(); process.wait()
    assert process.returncode == 0
    bad = consumer._start_model_server(command, working_dir=cwd, env={**os.environ,"BAD_FRAMING":"1"}, log_handle=log)
    try:
        try:
            consumer._send_request(bad,{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}})
            raise AssertionError("flat response satisfied JSON-RPC request")
        except RuntimeError as error:
            assert "Server exited before returning a response" in str(error)
    finally:
        bad.stdin.close()
        bad.wait(timeout=3)
assert consumer.resolve_server_protocol({"protocol":"jsonl"}) == consumer.JSONL_SERVER_PROTOCOL
for envelope in [{"ok":True,"output":{"text":"hidden"}},{"ok":False,"error":"lost"}]:
    assert consumer._normalize_prediction_payload(envelope, task="ASR")[0] == ""
assert consumer._normalize_prediction_payload({"text":"explicit jsonl payload"}, task="ASR")[0] == "explicit jsonl payload"
print("original consumer: runtime/framing/args/success/error/exit checked; stub only")
`,
		);
		const probe = spawnSync(runtime.contract!.python_executable, [script], {
			cwd: repository,
			encoding: "utf8",
			timeout: 15_000,
			env: {
				...process.env,
				PYTHONPATH: [
					join(repository, "sure/skills/sure_infer/scripts"),
					join(repository, "sure/external/sure-evaluation/src"),
				].join(delimiter),
			},
		});
		expect(probe.status, probe.stderr || probe.error?.message).toBe(0);
		expect(probe.stdout).toContain("stub only");
	});
});
