import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";

const proxies = [
  ["codex", resolve("plugins/codex/mcp-proxy.sh")],
  ["claude", resolve("plugins/claude-code/mcp-proxy.sh")],
  ["cursor", resolve("plugins/cursor/mcp-proxy.sh")],
];

function runProxy(proxy, environment) {
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "statewright_get_state", arguments: {} } },
  ].map(JSON.stringify).join("\n") + "\n";
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn("bash", [proxy], { env: environment, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectResult);
    child.once("close", (code) => resolveResult({ code, stdout, stderr }));
    child.stdin.end(requests);
  });
}

async function waitForOutput(readOutput, pattern, timeoutMs = 2_000) {
  const started = Date.now();
  while (!pattern.test(readOutput())) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for proxy output matching ${pattern}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

for (const [name, proxy] of proxies) {
  test(`${name} opens Windows signup once when no API key is configured`, async () => {
    const root = await mkdtemp(join(tmpdir(), `statewright-${name}-browser-test-`));
    const home = join(root, "home");
    const bin = join(root, "bin");
    const capture = join(root, "browser-command.txt");
    try {
      await mkdir(bin, { recursive: true });
      const fakePowerShell = join(bin, "powershell.exe");
      await writeFile(fakePowerShell, "#!/usr/bin/env bash\nexit 99\n");
      await chmod(fakePowerShell, 0o755);
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("statewright_")),
      );
      Object.assign(environment, {
        HOME: home,
        OS: "Windows_NT",
        PATH: `${bin}${delimiter}${environment.PATH ?? ""}`,
        STATEWRIGHT_BROWSER_OPEN_CAPTURE_PATH: capture,
        STATEWRIGHT_NO_UPDATE_CHECK: "1",
        STATEWRIGHT_SENTRY_DISABLED: "true",
      });

      const disabled = await runProxy(proxy, { ...environment, STATEWRIGHT_NO_BROWSER: "true" });
      assert.equal(disabled.code, 0, disabled.stderr);
      await assert.rejects(readFile(join(home, ".statewright", "missing_api_key_prompted")));

      const result = await runProxy(proxy, environment);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Statewright API key not configured/);
      assert.deepEqual((await readFile(capture, "utf8")).trim().split(/\r?\n/), [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Start-Process -FilePath 'https://statewright.ai/signup?redirect=/keys'",
      ]);
      assert.equal(await readFile(join(home, ".statewright", "missing_api_key_prompted"), "utf8"), "");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("cursor adopts a newly saved API key without restarting its MCP process", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-cursor-key-adoption-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const browserCapture = join(root, "browser-command.txt");
  const curlCapture = join(root, "curl-command.txt");
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("statewright_")),
  );
  try {
    await mkdir(bin, { recursive: true });
    const fakeCurl = join(bin, "curl");
    await writeFile(
      fakeCurl,
      "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" >> \"$STATEWRIGHT_CURL_CAPTURE\"\nprintf '%s\\n' '{\"jsonrpc\":\"2.0\",\"result\":{\"tools\":[]},\"id\":2}'\n",
    );
    await chmod(fakeCurl, 0o755);
    Object.assign(environment, {
      HOME: home,
      PATH: `${bin}${delimiter}${environment.PATH ?? ""}`,
      STATEWRIGHT_BROWSER_OPEN_CAPTURE_PATH: browserCapture,
      STATEWRIGHT_CURL_CAPTURE: curlCapture,
      STATEWRIGHT_NO_UPDATE_CHECK: "1",
      STATEWRIGHT_SENTRY_DISABLED: "true",
    });

    const child = spawn("bash", [resolve("plugins/cursor/mcp-proxy.sh")], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    await waitForOutput(() => stdout, /\"id\":1/);
    await writeFile(join(home, ".statewright", "api_key"), "sw_live_new_key\n", { mode: 0o600 });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    child.stdin.end();
    const code = await new Promise((resolveClose, rejectClose) => {
      child.once("error", rejectClose);
      child.once("close", resolveClose);
    });

    assert.equal(code, 0, stderr);
    assert.match(stdout, /\"id\":2/);
    assert.match(await readFile(curlCapture, "utf8"), /Authorization: Bearer sw_live_new_key/);
    await assert.rejects(readFile(join(home, ".statewright", "missing_api_key_prompted")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
