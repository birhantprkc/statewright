import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bindManagedClientIdentity, resolveManagedClientIdentity, resumedSessionId } from "../lib/managed-client-identity.mjs";
import { bootstrapManagedClients, buildRoutedArgs, codexOneShotInvocation, managedClientChildEnvironment, managedClientEnabled, resolveRealBinary, routeClaudeModel, runManagedClient, setManagedClientEnabled, uninstallManagedClients } from "../lib/managed-client-supervisor.mjs";

function fakeBridgeFactory() {
  return {
    url: "http://127.0.0.1:9999",
    token: "test-bridge-token",
    async start() { return this; },
    async close() {},
  };
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitFor(condition, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await condition()) return true;
    await delay(25);
  }
  return false;
}

test("managed identity persists a fresh session for a later Codex resume", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-managed-identity-"));
  try {
    const fresh = await resolveManagedClientIdentity({ host: "codex", args: [], home });
    assert.match(fresh.clientId, /^swc_[a-f0-9]{32}$/);
    await bindManagedClientIdentity({ host: "codex", sessionId: "durable-thread", clientId: fresh.clientId, home });
    const resumed = await resolveManagedClientIdentity({ host: "codex", args: ["resume", "durable-thread"], home });
    assert.equal(resumed.clientId, fresh.clientId);
    assert.equal(resumed.restored, true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Codex resume selectors are not mistaken for durable session IDs", () => {
  assert.equal(resumedSessionId("codex", ["resume", "--last"]), null);
  assert.equal(resumedSessionId("codex", ["resume", "--all"]), null);
  assert.equal(resumedSessionId("codex", ["resume", "--include-non-interactive", "--last"]), null);
  assert.equal(resumedSessionId("codex", ["resume", "--all", "durable-thread"]), "durable-thread");
  assert.equal(resumedSessionId("codex", ["resume", "-m", "gpt-5.6-sol", "durable-thread"]), "durable-thread");
  assert.equal(resumedSessionId("codex", ["-C", "resume", "fix-it"]), null);
  assert.equal(resumedSessionId("codex", ["--profile", "resume", "fix-it"]), null);
  assert.equal(resumedSessionId("codex", ["-m", "resume", "fix-it"]), null);
  assert.equal(resumedSessionId("codex", ["-m", "gpt-5.6-sol", "resume", "durable-thread"]), "durable-thread");
});

test("nested Codex launches discard parent thread and managed-control identities", () => {
  const child = managedClientChildEnvironment({
    host: "codex",
    environment: {
      PATH: "/usr/bin",
      STATEWRIGHT_API_KEY: "keep-auth-config",
      STATEWRIGHT_GATEWAY_URL: "https://mcp.statewright.ai",
      CODEX_SESSION_ID: "parent-session",
      CODEX_THREAD_ID: "parent-thread",
      STATEWRIGHT_CLIENT_ID: "swc_parent",
      STATEWRIGHT_MCP_SESSION_ID: "parent-mcp-session",
      STATEWRIGHT_ROUTE_CONTROL_DIR: "/tmp/parent-control",
      STATEWRIGHT_MANAGED_CLIENT_HOST: "codex",
      STATEWRIGHT_MANAGED_MCP_URL: "http://127.0.0.1:1000",
      STATEWRIGHT_MANAGED_MCP_SESSION_ID: "parent-managed-session",
      STATEWRIGHT_MANAGED_MCP_TOKEN: "parent-bridge-token",
      STATEWRIGHT_MANAGED_CODEX_ROOT_SESSION_ID: "parent-root",
      STATEWRIGHT_MANAGED_TELEMETRY_OWNER: "supervisor",
    },
    overrides: {
      STATEWRIGHT_CLIENT_ID: "swc_child",
      STATEWRIGHT_ROUTE_CONTROL_DIR: "/tmp/child-control",
    },
  });
  assert.equal(child.CODEX_SESSION_ID, undefined);
  assert.equal(child.CODEX_THREAD_ID, undefined);
  assert.equal(child.STATEWRIGHT_MCP_SESSION_ID, undefined);
  assert.equal(child.STATEWRIGHT_MANAGED_MCP_URL, undefined);
  assert.equal(child.STATEWRIGHT_MANAGED_MCP_SESSION_ID, undefined);
  assert.equal(child.STATEWRIGHT_MANAGED_MCP_TOKEN, undefined);
  assert.equal(child.STATEWRIGHT_MANAGED_TELEMETRY_OWNER, undefined);
  assert.equal(child.STATEWRIGHT_MANAGED_CODEX_ROOT_SESSION_ID, undefined);
  assert.equal(child.STATEWRIGHT_CLIENT_ID, "swc_child");
  assert.equal(child.STATEWRIGHT_ROUTE_CONTROL_DIR, "/tmp/child-control");
  assert.equal(child.STATEWRIGHT_API_KEY, "keep-auth-config");
  assert.equal(child.STATEWRIGHT_GATEWAY_URL, "https://mcp.statewright.ai");
  assert.equal(child.PATH, "/usr/bin");
});

test("Codex one-shot classification follows the top-level command grammar", () => {
  for (const args of [
    ["exec", "review this diff"],
    ["e", "review this diff"],
    ["review", "--uncommitted"],
    ["--search", "exec", "review this diff"],
    ["--image", "one.png", "two.png", "exec", "review this diff"],
    ["-m", "gpt-5.6-sol", "-c", "model_reasoning_effort=high", "exec", "review this diff"],
  ]) assert.equal(codexOneShotInvocation("codex", args), true, args.join(" "));

  for (const args of [
    ["resume", "thread-1", "exec"],
    ["--", "exec"],
    ["-m", "exec", "resume", "thread-1"],
    ["--enable", "exec", "resume", "thread-1"],
    ["--disable", "review", "resume", "thread-1"],
    ["-i", "one.png", "two.png", "resume", "thread-1"],
    ["continue with the review"],
  ]) assert.equal(codexOneShotInvocation("codex", args), false, args.join(" "));
  assert.equal(codexOneShotInvocation("claude", ["exec", "review this diff"]), false);
});

test("managed Codex child receives a fresh identity instead of the parent writer identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-managed-nested-codex-"));
  const fake = join(root, "fake-codex.mjs");
  const captured = join(root, "environment.json");
  try {
    await writeFile(fake, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(captured)}, JSON.stringify({ codex_session_id: process.env.CODEX_SESSION_ID ?? null, codex_thread_id: process.env.CODEX_THREAD_ID ?? null, statewright_client_id: process.env.STATEWRIGHT_CLIENT_ID ?? null, statewright_control_dir: process.env.STATEWRIGHT_ROUTE_CONTROL_DIR ?? null, managed_mcp_url: process.env.STATEWRIGHT_MANAGED_MCP_URL ?? null }));\n`);
    await chmod(fake, 0o755);
    assert.equal(await runManagedClient({
      host: "codex",
      command: fake,
      args: ["exec", "review this diff"],
      environment: {
        PATH: process.env.PATH,
        STATEWRIGHT_API_KEY: "test",
        CODEX_SESSION_ID: "parent-session",
        CODEX_THREAD_ID: "parent-thread",
        STATEWRIGHT_CLIENT_ID: "swc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        STATEWRIGHT_ROUTE_CONTROL_DIR: "/tmp/parent-control",
        STATEWRIGHT_MANAGED_MCP_URL: "http://127.0.0.1:1000",
      },
      home: root,
      pollMs: 5,
      bridgeFactory: fakeBridgeFactory,
    }), 0);
    const environment = JSON.parse(await readFile(captured, "utf8"));
    assert.equal(environment.codex_session_id, null);
    assert.equal(environment.codex_thread_id, null);
    assert.match(environment.statewright_client_id, /^swc_[a-f0-9]{32}$/);
    assert.notEqual(environment.statewright_client_id, "swc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.notEqual(environment.statewright_control_dir, "/tmp/parent-control");
    assert.equal(environment.managed_mcp_url, "http://127.0.0.1:9999");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("managed codex exec remains one-shot when its hook requests a model route", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-managed-codex-exec-"));
  const fake = join(root, "fake-codex.mjs");
  const calls = join(root, "calls.log");
  try {
    await writeFile(fake, `#!/usr/bin/env node\nimport { appendFileSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nappendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");\nwriteFileSync(join(process.env.STATEWRIGHT_ROUTE_CONTROL_DIR, "route.json"), JSON.stringify({ session_id: "review-thread", client_id: process.env.STATEWRIGHT_CLIENT_ID, model: "openai-codex/gpt-5.6-sol", effort: "high" }));\nsetTimeout(() => process.exit(0), 80);\n`);
    await chmod(fake, 0o755);
    assert.equal(await runManagedClient({
      host: "codex",
      command: fake,
      args: ["exec", "review this diff"],
      environment: { PATH: process.env.PATH, STATEWRIGHT_API_KEY: "test" },
      home: root,
      pollMs: 5,
      bridgeFactory: fakeBridgeFactory,
    }), 0);
    assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n"), ["exec review this diff"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("terminating a managed codex exec stops its child and removes its control directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-managed-codex-cancel-"));
  const fake = join(root, "fake-codex.mjs");
  const harness = join(root, "harness.mjs");
  const captured = join(root, "child.json");
  const supervisor = fileURLToPath(new URL("../lib/managed-client-supervisor.mjs", import.meta.url));
  const waitUntil = async (predicate, timeoutMs = 3_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    return false;
  };
  try {
    await writeFile(fake, `#!/usr/bin/env node\nimport { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });\nwriteFileSync(${JSON.stringify(captured)}, JSON.stringify({ pid: process.pid, grandchild_pid: grandchild.pid, control: process.env.STATEWRIGHT_ROUTE_CONTROL_DIR }));\nsetInterval(() => {}, 1000);\n`);
    await chmod(fake, 0o755);
    await writeFile(harness, `import { runManagedClient } from ${JSON.stringify(new URL(`file://${supervisor}`).href)};\nconst bridgeFactory = () => ({ async start() { this.url = "http://127.0.0.1:9999"; this.token = "test-token"; }, async close() {} });\nprocess.exitCode = await runManagedClient({ host: "codex", command: ${JSON.stringify(fake)}, args: ["exec", "review"], environment: { ...process.env, STATEWRIGHT_API_KEY: "test", STATEWRIGHT_SENTRY_DISABLED: "true" }, home: ${JSON.stringify(root)}, pollMs: 5, bridgeFactory });\n`);
    const wrapper = spawn(process.execPath, [harness], { stdio: "ignore" });
    assert.equal(await waitUntil(async () => access(captured).then(() => true, () => false)), true);
    const child = JSON.parse(await readFile(captured, "utf8"));
    wrapper.kill("SIGTERM");
    const result = await new Promise((resolveResult, rejectResult) => {
      wrapper.once("error", rejectResult);
      wrapper.once("exit", (code, signal) => resolveResult({ code, signal }));
    });
    assert.deepEqual(result, { code: 1, signal: null });
    for (const pid of [child.pid, child.grandchild_pid]) {
      assert.equal(await waitUntil(async () => {
        try { process.kill(pid, 0); return false; } catch { return true; }
      }), true, `process ${pid} survived managed cancellation`);
    }
    assert.equal(await access(child.control).then(() => true, () => false), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("disabled managed-client wrapper does not leak its parent Codex writer identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-unmanaged-nested-codex-"));
  const fake = join(root, "fake-codex.mjs");
  const captured = join(root, "environment.json");
  const launcher = fileURLToPath(new URL("../statewright-managed-client.mjs", import.meta.url));
  try {
    await writeFile(fake, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(captured)}, JSON.stringify({ codex_session_id: process.env.CODEX_SESSION_ID ?? null, codex_thread_id: process.env.CODEX_THREAD_ID ?? null, statewright_client_id: process.env.STATEWRIGHT_CLIENT_ID ?? null, statewright_control_dir: process.env.STATEWRIGHT_ROUTE_CONTROL_DIR ?? null }));\n`);
    await chmod(fake, 0o755);
    const result = await new Promise((resolveResult, rejectResult) => {
      const child = spawn(process.execPath, [launcher, "--host", "codex", "--real-bin", fake, "--", "exec", "review this diff"], {
        env: {
          ...process.env,
          HOME: root,
          STATEWRIGHT_ERROR_DSN: "",
          CODEX_SESSION_ID: "parent-session",
          CODEX_THREAD_ID: "parent-thread",
          STATEWRIGHT_CLIENT_ID: "swc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          STATEWRIGHT_ROUTE_CONTROL_DIR: "/tmp/parent-control",
        },
        stdio: "ignore",
      });
      child.once("error", rejectResult);
      child.once("exit", (code, signal) => resolveResult({ code, signal }));
    });
    assert.deepEqual(result, { code: 0, signal: null });
    assert.deepEqual(JSON.parse(await readFile(captured, "utf8")), {
      codex_session_id: null,
      codex_thread_id: null,
      statewright_client_id: null,
      statewright_control_dir: null,
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Codex restart preserves non-route args and applies the requested route", () => {
  assert.deepEqual(buildRoutedArgs({ host: "codex", originalArgs: ["--full-auto", "-m", "gpt-5.6-terra", "-c", 'model_reasoning_effort="low"'], request: { session_id: "session-1", model: "openai-codex/gpt-5.6-sol", effort: "high" } }), ["-m", "gpt-5.6-sol", "-c", 'model_reasoning_effort="high"', "--full-auto", "resume", "session-1", "Continue the active Statewright workflow in its current state. Use statewright_get_state first."]);
});

test("Codex restart replaces an existing resume invocation", () => {
  const args = buildRoutedArgs({
    host: "codex",
    originalArgs: ["--full-auto", "resume", "old-session", "continue from yesterday"],
    request: { session_id: "new-session", model: "openai-codex/gpt-5.6-terra", effort: "medium" },
  });
  assert.deepEqual(args, [
    "-m", "gpt-5.6-terra", "-c", 'model_reasoning_effort="medium"', "--full-auto",
    "resume", "new-session", "Continue the active Statewright workflow in its current state. Use statewright_get_state first.",
  ]);
});

test("Claude restart resumes the session with the requested model", () => {
  const args = buildRoutedArgs({ host: "claude", originalArgs: ["--permission-mode", "auto", "--model", "sonnet"], request: { session_id: "session-2", model: "anthropic/claude-opus-4-6", effort: "high" } });
  assert.deepEqual(args.slice(0, 7), ["--permission-mode", "auto", "--resume", "session-2", "--model", "claude-opus-4-6", "Continue the active Statewright workflow in its current state. Use statewright_get_state first."]);
  assert.ok(!args.includes("--effort"));
});

test("Claude translates semantic OpenAI routes to native Claude aliases", () => {
  assert.equal(routeClaudeModel("openai/gpt-5.6-sol"), "opus");
  assert.equal(routeClaudeModel("openai-codex/gpt-5.6-terra"), "sonnet");
  assert.equal(routeClaudeModel("openai/gpt-5.6-luna"), "haiku");
  assert.equal(routeClaudeModel("anthropic/claude-opus-4-6"), "claude-opus-4-6");
  assert.throws(() => routeClaudeModel("openai/gpt-5.7"), /cannot translate OpenAI model/);
});

test("managed supervisor consumes Claude route requests and restarts the same child only", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-managed-claude-"));
  const fake = join(root, "fake-claude.mjs");
  const calls = join(root, "calls.log");
  try {
    await writeFile(fake, `#!/usr/bin/env node\nimport { appendFileSync, existsSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nappendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");\nconst marker = join(process.env.STATEWRIGHT_ROUTE_CONTROL_DIR, "once");\nif (!existsSync(marker)) { writeFileSync(marker, ""); writeFileSync(join(process.env.STATEWRIGHT_ROUTE_CONTROL_DIR, "claude.route.json"), JSON.stringify({session_id:"claude-session-3",client_id:process.env.STATEWRIGHT_CLIENT_ID,model:"anthropic/claude-opus-4-6",effort:"high"})); process.on("SIGINT", () => process.exit(0)); setInterval(() => {}, 1000); }\n`);
    await chmod(fake, 0o755);
    assert.equal(await runManagedClient({
      host: "claude", command: fake, args: ["--permission-mode", "auto"], environment: { PATH: process.env.PATH, STATEWRIGHT_API_KEY: "test" }, home: root, pollMs: 5, bridgeFactory: fakeBridgeFactory,
    }), 0);
    const callsText = await readFile(calls, "utf8");
    assert.match(callsText, /^--permission-mode auto/m);
    assert.match(callsText, /--permission-mode auto --resume claude-session-3 --model claude-opus-4-6/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("managed Claude supervisor defers a native child route instead of replacing the parent session", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-managed-claude-fork-"));
  const fake = join(root, "fake-claude.mjs");
  const calls = join(root, "calls.log");
  try {
    await writeFile(fake, `#!/usr/bin/env node\nimport { appendFileSync, existsSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nappendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");\nconst control = process.env.STATEWRIGHT_ROUTE_CONTROL_DIR;\nconst rootMarker = join(control, "root");\nif (!existsSync(rootMarker)) { writeFileSync(rootMarker, ""); writeFileSync(join(control, "root.route.json"), JSON.stringify({session_id:"claude-root",client_id:process.env.STATEWRIGHT_CLIENT_ID,model:"anthropic/claude-sonnet-4-6",effort:"medium"})); process.on("SIGINT", () => process.exit(0)); setInterval(() => {}, 1000); } else { writeFileSync(join(control, "child.route.json"), JSON.stringify({session_id:"claude-child",root_session_id:"claude-root",client_id:process.env.STATEWRIGHT_CLIENT_ID,model:"anthropic/claude-opus-4-6",effort:"high"})); setTimeout(() => process.exit(0), 40); }\n`);
    await chmod(fake, 0o755);
    assert.equal(await runManagedClient({
      host: "claude", command: fake, args: ["--permission-mode", "auto"], environment: { PATH: process.env.PATH, STATEWRIGHT_API_KEY: "test" }, home: root, pollMs: 5, bridgeFactory: fakeBridgeFactory,
    }), 0);
    const callsText = await readFile(calls, "utf8");
    const callLines = callsText.trim().split("\n");
    assert.equal(callLines.length, 2);
    assert.match(callLines[1], /--resume claude-root --model claude-sonnet-4-6/);
    assert.doesNotMatch(callsText, /claude-child/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("managed supervisor only restarts its own child after a route request", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-managed-client-"));
  const fake = join(root, "fake-codex.mjs");
  const calls = join(root, "calls.log");
  try {
    await writeFile(fake, `#!/usr/bin/env node\nimport { appendFileSync, existsSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nappendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + " " + process.env.STATEWRIGHT_MANAGED_MCP_URL + "\\n");\nconst marker = join(process.env.STATEWRIGHT_ROUTE_CONTROL_DIR, "once");\nif (!existsSync(marker)) { writeFileSync(marker, ""); writeFileSync(join(process.env.STATEWRIGHT_ROUTE_CONTROL_DIR, "codex-root-session.json"), JSON.stringify({version:1,session_id:"session-3",client_id:process.env.STATEWRIGHT_CLIENT_ID})); writeFileSync(join(process.env.STATEWRIGHT_ROUTE_CONTROL_DIR, "route.json"), JSON.stringify({session_id:"session-3",root_session_id:"session-3",client_id:process.env.STATEWRIGHT_CLIENT_ID,model:"openai-codex/gpt-5.6-sol",effort:"high"})); process.on("SIGINT", () => process.exit(0)); setInterval(() => {}, 1000); }\n`);
    await chmod(fake, 0o755);
    assert.equal(await runManagedClient({ host: "codex", command: fake, args: ["--full-auto"], environment: { PATH: process.env.PATH, STATEWRIGHT_API_KEY: "test" }, home: root, pollMs: 5, bridgeFactory: fakeBridgeFactory }), 0);
    const callsText = await readFile(calls, "utf8");
    assert.match(callsText, /^--full-auto/m);
    assert.match(callsText, /-m gpt-5\.6-sol -c model_reasoning_effort="high" --full-auto resume session-3/);
    assert.match(callsText, /http:\/\/127\.0\.0\.1:9999/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a fresh managed Codex does not let the first child route elect itself as root", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-managed-codex-fresh-child-"));
  const fake = join(root, "fake-codex.mjs");
  const calls = join(root, "calls.log");
  try {
    await writeFile(fake, `#!/usr/bin/env node\nimport { appendFileSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nappendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");\nwriteFileSync(join(process.env.STATEWRIGHT_ROUTE_CONTROL_DIR, "child.route.json"), JSON.stringify({session_id:"child-first",root_session_id:"child-first",client_id:process.env.STATEWRIGHT_CLIENT_ID,model:"openai-codex/gpt-5.6-sol",effort:"high"}));\nsetTimeout(() => process.exit(0), 100);\n`);
    await chmod(fake, 0o755);
    assert.equal(await runManagedClient({ host: "codex", command: fake, args: [], environment: { PATH: process.env.PATH, STATEWRIGHT_API_KEY: "test" }, home: root, pollMs: 5, bridgeFactory: fakeBridgeFactory }), 0);
    assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n"), [""]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("managed Codex discovers the actual root thread behind resume --last", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-managed-codex-resume-last-"));
  const fake = join(root, "fake-codex.mjs");
  const calls = join(root, "calls.log");
  try {
    await writeFile(fake, `#!/usr/bin/env node\nimport { appendFileSync, existsSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nappendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");\nconst marker = join(process.env.STATEWRIGHT_ROUTE_CONTROL_DIR, "once");\nif (!existsSync(marker)) { writeFileSync(marker, ""); writeFileSync(join(process.env.STATEWRIGHT_ROUTE_CONTROL_DIR, "codex-root-session.json"), JSON.stringify({version:1,session_id:"actual-last-thread",client_id:process.env.STATEWRIGHT_CLIENT_ID})); writeFileSync(join(process.env.STATEWRIGHT_ROUTE_CONTROL_DIR, "route.json"), JSON.stringify({session_id:"actual-last-thread",root_session_id:"actual-last-thread",client_id:process.env.STATEWRIGHT_CLIENT_ID,model:"openai-codex/gpt-5.6-sol",effort:"high"})); process.on("SIGINT", () => process.exit(0)); setInterval(() => {}, 1000); }\n`);
    await chmod(fake, 0o755);
    assert.equal(await runManagedClient({ host: "codex", command: fake, args: ["resume", "--last"], environment: { PATH: process.env.PATH, STATEWRIGHT_API_KEY: "test" }, home: root, pollMs: 5, bridgeFactory: fakeBridgeFactory }), 0);
    const callLines = (await readFile(calls, "utf8")).trim().split("\n");
    assert.equal(callLines.length, 2);
    assert.equal(callLines[0], "resume --last");
    assert.match(callLines[1], /resume actual-last-thread/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("managed Codex ignores an ephemeral child route emitted through a zsh login-shell bypass", async (t) => {
  if (process.platform === "win32") return t.skip("zsh regression is POSIX-only");
  const root = await mkdtemp(join(tmpdir(), "statewright-managed-codex-zsh-"));
  const parent = join(root, "parent-codex.mjs");
  const directBin = join(root, "direct-bin");
  const shimBin = join(root, "shim-bin");
  const zdotdir = join(root, "zdotdir");
  const calls = join(root, "calls.log");
  const selected = join(root, "direct-selected");
  try {
    await mkdir(directBin, { recursive: true });
    await mkdir(shimBin, { recursive: true });
    await mkdir(zdotdir, { recursive: true });
    await writeFile(join(zdotdir, ".zprofile"), `export PATH=${JSON.stringify(directBin)}:$PATH\n`);
    await writeFile(join(shimBin, "codex"), `#!/usr/bin/env bash\nexit 97\n`);
    await writeFile(join(directBin, "codex"), `#!/usr/bin/env bash\nprintf selected > ${JSON.stringify(selected)}\nprintf '{"session_id":"ephemeral-child","client_id":"%s","model":"openai-codex/gpt-5.6-sol","effort":"high"}' "$STATEWRIGHT_CLIENT_ID" > "$STATEWRIGHT_ROUTE_CONTROL_DIR/child.route.json"\n`);
    await writeFile(parent, `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nimport { spawnSync } from "node:child_process";\nappendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");\nspawnSync("/bin/zsh", ["-lc", "codex exec --ephemeral review-this-diff"], { env: process.env, stdio: "inherit" });\nsetTimeout(() => process.exit(0), 100);\n`);
    await chmod(join(shimBin, "codex"), 0o755);
    await chmod(join(directBin, "codex"), 0o755);
    await chmod(parent, 0o755);
    assert.equal(await runManagedClient({
      host: "codex",
      command: parent,
      args: ["resume", "durable-parent"],
      environment: {
        PATH: `${shimBin}:${process.env.PATH}`,
        ZDOTDIR: zdotdir,
        STATEWRIGHT_API_KEY: "test",
      },
      home: root,
      pollMs: 5,
      bridgeFactory: fakeBridgeFactory,
    }), 0);
    await access(selected);
    const callLines = (await readFile(calls, "utf8")).trim().split("\n");
    assert.deepEqual(callLines, ["resume durable-parent"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("managed supervisor preserves its own identity across a routed restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-managed-client-identity-"));
  const fake = join(root, "fake-codex.mjs");
  const calls = join(root, "calls.log");
  try {
    await writeFile(fake, `#!/usr/bin/env node\nimport { appendFileSync, existsSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nappendFileSync(${JSON.stringify(calls)}, process.env.STATEWRIGHT_CLIENT_ID + "\\n");\nconst marker = join(process.env.STATEWRIGHT_ROUTE_CONTROL_DIR, "once");\nif (!existsSync(marker)) { writeFileSync(marker, ""); writeFileSync(join(process.env.STATEWRIGHT_ROUTE_CONTROL_DIR, "codex-root-session.json"), JSON.stringify({version:1,session_id:"session-4",client_id:process.env.STATEWRIGHT_CLIENT_ID})); writeFileSync(join(process.env.STATEWRIGHT_ROUTE_CONTROL_DIR, "route.json"), JSON.stringify({session_id:"session-4",root_session_id:"session-4",client_id:process.env.STATEWRIGHT_CLIENT_ID,model:"openai-codex/gpt-5.6-sol",effort:"high"})); process.on("SIGINT", () => process.exit(0)); setInterval(() => {}, 1000); }\n`);
    await chmod(fake, 0o755);
    assert.equal(await runManagedClient({
      host: "codex", command: fake, args: [], environment: { PATH: process.env.PATH, STATEWRIGHT_API_KEY: "test" }, home: root, pollMs: 5, bridgeFactory: fakeBridgeFactory,
    }), 0);
    const identities = (await readFile(calls, "utf8")).trim().split("\n");
    assert.equal(identities.length, 2);
    assert.equal(identities[0], identities[1]);
    assert.match(identities[0], /^swc_[a-f0-9]{32}$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("managed Codex telemetry survives a routed child restart and stops after its supervisor exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-managed-telemetry-lifecycle-"));
  const fake = join(root, "fake-codex.mjs");
  const calls = join(root, "calls.log");
  const port = 32000 + (process.pid % 10000);
  const telemetryDir = join(root, "telemetry");
  try {
    await writeFile(fake, `#!/usr/bin/env node\nimport { appendFileSync, existsSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nappendFileSync(${JSON.stringify(calls)}, process.argv.join(" ") + "\\n");\nconst marker = join(process.env.STATEWRIGHT_ROUTE_CONTROL_DIR, "once");\nif (!existsSync(marker)) { writeFileSync(marker, ""); writeFileSync(join(process.env.STATEWRIGHT_ROUTE_CONTROL_DIR, "codex-root-session.json"), JSON.stringify({version:1,session_id:"telemetry-session",client_id:process.env.STATEWRIGHT_CLIENT_ID})); writeFileSync(join(process.env.STATEWRIGHT_ROUTE_CONTROL_DIR, "route.json"), JSON.stringify({session_id:"telemetry-session",root_session_id:"telemetry-session",client_id:process.env.STATEWRIGHT_CLIENT_ID,model:"openai-codex/gpt-5.6-sol",effort:"high"})); process.on("SIGINT", () => process.exit(0)); setInterval(() => {}, 1000); }\nsetTimeout(() => process.exit(0), 500);\n`);
    await chmod(fake, 0o755);
    const running = runManagedClient({
      host: "codex",
      command: fake,
      args: [],
      environment: {
        PATH: process.env.PATH,
        STATEWRIGHT_API_KEY: "test",
        STATEWRIGHT_NATIVE_TOKEN_TELEMETRY: "true",
        STATEWRIGHT_TELEMETRY_PORT: String(port),
        STATEWRIGHT_TELEMETRY_DIR: telemetryDir,
      },
      home: root,
      cwd: root,
      pollMs: 5,
      bridgeFactory: fakeBridgeFactory,
    });
    assert.equal(await waitFor(async () => {
      try { return (await readFile(calls, "utf8")).trim().split("\n").length === 2; } catch { return false; }
    }), true);
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
    assert.equal(health.listener_status, "healthy");
    const marker = JSON.parse(await readFile(join(telemetryDir, "managed-service.json"), "utf8"));
    assert.match(String(marker.pid), /^\d+$/);
    assert.equal(await running, 0);
    assert.equal(await waitFor(async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(100) });
        return false;
      } catch { return true; }
    }), true);
    await assert.rejects(readFile(join(telemetryDir, "managed-service.json"), "utf8"));
  } finally {
    await unlink(join(telemetryDir, "managed-service.json")).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("managed supervisor rejects a route that attempts to rebind its identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-managed-client-mismatch-"));
  const fake = join(root, "fake-codex.mjs");
  const calls = join(root, "calls.log");
  try {
    await writeFile(fake, `#!/usr/bin/env node\nimport { appendFileSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nappendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");\nwriteFileSync(join(process.env.STATEWRIGHT_ROUTE_CONTROL_DIR, "mismatch.route.json"), JSON.stringify({session_id:"session-5",client_id:"swc_ffffffffffffffffffffffffffffffff",model:"openai-codex/gpt-5.6-sol",effort:"high"}));\nsetTimeout(() => process.exit(0), 80);\n`);
    await chmod(fake, 0o755);
    assert.equal(await runManagedClient({
      host: "codex", command: fake, args: [], environment: { PATH: process.env.PATH, STATEWRIGHT_API_KEY: "test" }, home: root, pollMs: 5, bridgeFactory: fakeBridgeFactory,
    }), 0);
    assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent managed supervisors allocate isolated bridge identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-managed-client-isolation-"));
  const fake = join(root, "fake-codex.mjs");
  const bridgeOptions = [];
  let bridgeNumber = 0;
  const recordingFactory = (options) => {
    bridgeOptions.push(options);
    bridgeNumber += 1;
    return {
      url: `http://127.0.0.1:${9000 + bridgeNumber}`,
      token: `token-${bridgeNumber}`,
      async start() { return this; },
      async close() {},
    };
  };
  try {
    await writeFile(fake, "#!/usr/bin/env node\nprocess.exit(0)\n");
    await chmod(fake, 0o755);
    await Promise.all(["first", "second"].map((name) => runManagedClient({
      host: "codex", command: fake, args: [name], environment: { PATH: process.env.PATH, STATEWRIGHT_API_KEY: "test" }, home: root, pollMs: 5, bridgeFactory: recordingFactory,
    })));
    assert.equal(bridgeOptions.length, 2);
    assert.notEqual(bridgeOptions[0].clientId, bridgeOptions[1].clientId);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("managed clients are explicitly opt-in", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-managed-config-"));
  try {
    assert.equal(await managedClientEnabled("codex", home), false);
    await setManagedClientEnabled("codex", true, home);
    assert.equal(await managedClientEnabled("codex", home), true);
    assert.equal(await managedClientEnabled("claude", home), false);
    await setManagedClientEnabled("claude", true, home);
    assert.equal(await managedClientEnabled("codex", home), true);
    assert.equal(await managedClientEnabled("claude", home), true);
    await setManagedClientEnabled("codex", false, home);
    assert.equal(await managedClientEnabled("codex", home), false);
    assert.equal(await managedClientEnabled("claude", home), true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("plugin bootstrap installs available shims and one marked shell path block", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-managed-bootstrap-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const launcher = join(root, "launcher.mjs");
  try {
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "codex"), "#!/usr/bin/env sh\nexit 0\n");
    await chmod(join(bin, "codex"), 0o755);
    await writeFile(launcher, "");
    const first = await bootstrapManagedClients({ launcherPath: launcher, home, path: bin, shell: "/bin/zsh" });
    assert.equal(first.installed.length, 1);
    assert.equal(await managedClientEnabled("codex", home), true);
    assert.equal(await managedClientEnabled("claude", home), false);
    const profile = await readFile(join(home, ".zshrc"), "utf8");
    assert.equal((profile.match(/statewright managed clients/g) ?? []).length, 2);
    const second = await bootstrapManagedClients({ launcherPath: launcher, home, path: bin, shell: "/bin/zsh" });
    assert.equal(second.profile, null);
    const removed = await uninstallManagedClients({ home, shell: "/bin/zsh" });
    assert.equal(removed.removed.length, 1);
    assert.equal(removed.profile, join(home, ".zshrc"));
    assert.doesNotMatch(await readFile(join(home, ".zshrc"), "utf8"), /statewright managed clients/);
    assert.equal(await managedClientEnabled("codex", home), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Windows bootstrap resolves cmd launchers and installs reversible cmd shims", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-managed-windows-bootstrap-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const launcher = join(root, "launcher.mjs");
  try {
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "codex"), "#!/usr/bin/env sh\nexit 0\n");
    await writeFile(join(bin, "codex.cmd"), "@echo off\r\n");
    await writeFile(join(bin, "claude.cmd"), "@echo off\r\n");
    await writeFile(launcher, "");
    // A Windows package install can leave an extensionless launcher behind.
    // The native .cmd command must still win.
    assert.equal(resolveRealBinary("codex", { path: bin, platform: "win32", pathSeparator: ";" }), join(bin, "codex.cmd"));
    const first = await bootstrapManagedClients({ launcherPath: launcher, home, path: bin, platform: "win32", pathSeparator: ";" });
    assert.equal(first.installed.length, 2);
    assert.equal(first.restart_required, true);
    for (const host of ["codex", "claude"]) {
      const shimPath = join(home, ".statewright", "bin", `${host}.cmd`);
      assert.match(await readFile(shimPath, "utf8"), /statewright-managed-client|launcher\.mjs/i);
    }
    const profilePath = join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
    assert.match(await readFile(profilePath, "utf8"), /statewright managed clients/);
    const removed = await uninstallManagedClients({ home, platform: "win32" });
    assert.equal(removed.removed.length, 2);
    assert.equal(removed.profile, profilePath);
  } finally { await rm(root, { recursive: true, force: true }); }
});
