import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  throw new Error("The Windows browser onboarding canary must run on a Windows runner.");
}

function msysPath(path) {
  return path.replace(/^([A-Za-z]):[\\/]/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll("\\", "/");
}

function secretlessEnvironment(home, probePath, resultPath) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("statewright_")),
  );
  return {
    ...environment,
    HOME: msysPath(home),
    USERPROFILE: home,
    OS: "Windows_NT",
    STATEWRIGHT_BROWSER_OPEN_PROBE: probePath,
    STATEWRIGHT_BROWSER_PROBE_RESULT: resultPath,
    STATEWRIGHT_NO_UPDATE_CHECK: "1",
    STATEWRIGHT_SENTRY_DISABLED: "true",
  };
}

function runProxy(proxyPath, environment) {
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "statewright_get_state", arguments: {} } },
  ].map((value) => JSON.stringify(value)).join("\n") + "\n";
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [proxyPath], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

const plugins = [
  ["codex", new URL("../../codex/mcp-proxy.sh", import.meta.url)],
  ["claude", new URL("../../claude-code/mcp-proxy.sh", import.meta.url)],
  ["cursor", new URL("../../cursor/mcp-proxy.sh", import.meta.url)],
];

for (const [name, proxyUrl] of plugins) {
  const root = await mkdtemp(join(tmpdir(), `statewright-${name}-browser-onboarding-`));
  const home = join(root, "home");
  const probePath = join(root, "browser-probe.cmd");
  const resultPath = join(root, "browser-probe-result.txt");
  try {
    await writeFile(
      probePath,
      '@echo off\r\n>> "%STATEWRIGHT_BROWSER_PROBE_RESULT%" echo %~1\r\n',
    );
    const environment = secretlessEnvironment(home, probePath, resultPath);
    assert.equal(
      Object.keys(environment).some((key) => key.toLowerCase() === "statewright_api_key"),
      false,
      `${name} canary must not inherit an API key`,
    );
    const result = await runProxy(msysPath(fileURLToPath(proxyUrl)), environment);
    assert.equal(result.code, 0, `${name} proxy failed: ${result.stderr}`);
    assert.match(result.stdout, /Statewright API key not configured/);

    assert.deepEqual(
      (await readFile(resultPath, "utf8")).trim().split(/\r?\n/),
      ["https://statewright.ai/signup?redirect=/keys"],
      `${name} must launch exactly once with the signup URL through real PowerShell Start-Process`,
    );
    assert.equal(
      await readFile(join(home, ".statewright", "missing_api_key_prompted"), "utf8"),
      "",
    );
    console.log(`[windows-browser-onboarding] ${name}: secretless PowerShell browser path verified`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
