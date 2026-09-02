import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  appServerHomePrefixForClient,
  codexAppServerTransportEnabled,
  routeConfigEdits,
  startCodexAppServerRuntime,
} from "../lib/codex-app-server-transport.mjs";
import { ensureCodexAppServerResident, nextCodexResidentRouteRequest, residentControlDir, residentMatchesRuntime, residentRoot, residentRuntimeRevision } from "../lib/codex-app-server-resident.mjs";
import { applyCompactResumeRequest, applyRouteToTurnStart, applyThreadListCwd, hydrateBoundedResumeTurns, settingsConfirmRoute, startCodexAppServerRouteProxy } from "../lib/codex-app-server-route-proxy.mjs";

function once(socket, event) {
  return new Promise((resolveEvent) => socket.once(event, resolveEvent));
}

test("Codex App Server transport remains opt-in and supports an explicit environment override", () => {
  assert.equal(codexAppServerTransportEnabled({ environment: {} }), false);
  assert.equal(codexAppServerTransportEnabled({
    config: { routing: { managed_clients: { codex_transport: "app-server" } } },
  }), true);
  assert.equal(codexAppServerTransportEnabled({
    environment: { STATEWRIGHT_CODEX_TRANSPORT: "restart" },
    config: { routing: { managed_clients: { codex_transport: "app-server" } } },
  }), false);
  assert.equal(codexAppServerTransportEnabled({
    environment: { STATEWRIGHT_CODEX_TRANSPORT: "app-server" },
  }), true);
});

test("App Server transport creates bounded, filesystem-safe temporary home names", () => {
  assert.equal(appServerHomePrefixForClient("swc_abc:unsafe/path"), "statewright-swc_abc-unsafe-path");
  assert.match(appServerHomePrefixForClient("x".repeat(100)), /^statewright-x{60}$/);
});

test("App Server runtime confirms its owned child exits before close completes", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-app-server-close-"));
  const codexHome = join(home, ".codex");
  const fake = join(home, "fake-codex.mjs");
  const pidPath = join(home, "app-server.pid");
  try {
    await mkdir(codexHome, { recursive: true });
    await writeFile(fake, `#!/usr/bin/env node\nimport { createServer } from "node:http";\nimport { writeFileSync } from "node:fs";\nconst target = new URL(process.argv.at(-1));\nprocess.on("SIGTERM", () => {});\nwriteFileSync(${JSON.stringify(pidPath)}, String(process.pid));\ncreateServer((_request, response) => { response.writeHead(200); response.end("ok\\n"); }).listen(Number(target.port), target.hostname);\n`);
    await chmod(fake, 0o755);
    const runtime = await startCodexAppServerRuntime({
      command: fake,
      environment: { ...process.env, CODEX_HOME: codexHome, STATEWRIGHT_SENTRY_DISABLED: "true" },
      cwd: home,
      home,
      clientId: "swc_shutdown_test",
      shutdownGraceMs: 20,
      reporter: { async report() {} },
    });
    const pid = Number(await readFile(pidPath, "utf8"));
    await runtime.close();
    assert.throws(() => process.kill(pid, 0));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("resident App Server state is stable per managed client and keeps routes outside the transient launcher", () => {
  const home = "/tmp/statewright-home";
  const root = residentRoot(home, "swc_abc:unsafe/path");
  assert.equal(root, "/tmp/statewright-home/.statewright/codex-app-server/swc_abc-unsafe-path");
  assert.equal(residentControlDir(home, "swc_abc:unsafe/path"), `${root}/routes`);
});

test("resident App Server accepts routes only for the attached root session", async () => {
  const control = await mkdtemp(join(tmpdir(), "statewright-resident-routes-"));
  const clientId = "swc_0123456789abcdef0123456789abcdef";
  try {
    await writeFile(join(control, "codex-root-session.json"), JSON.stringify({ version: 1, session_id: "root-thread", client_id: clientId }));
    await writeFile(join(control, "01-root.route.json"), JSON.stringify({ session_id: "root-thread", root_session_id: "root-thread", client_id: clientId, model: "gpt-5.6-terra" }));
    assert.equal(await nextCodexResidentRouteRequest(control, clientId, "child-thread"), null);
    assert.deepEqual(await nextCodexResidentRouteRequest(control, clientId, "root-thread"), {
      session_id: "root-thread", root_session_id: "root-thread", client_id: clientId, model: "gpt-5.6-terra",
    });
  } finally { await rm(control, { recursive: true, force: true }); }
});

test("resident runtime revision changes reuse only when the loaded transport bundle matches", async () => {
  const revision = await residentRuntimeRevision();
  assert.match(revision, /^[a-f0-9]{16}$/);
  assert.equal(residentMatchesRuntime({ runtimeRevision: revision }, revision), true);
  assert.equal(residentMatchesRuntime({ runtimeRevision: revision, threadListCwd: "/repo" }, revision, "/repo"), true);
  assert.equal(residentMatchesRuntime({ runtimeRevision: revision, threadListCwd: "/repo" }, revision, null), false);
  assert.equal(residentMatchesRuntime({ runtimeRevision: revision, threadListCwd: null }, revision, "/repo"), false);
  assert.equal(residentMatchesRuntime({ runtimeRevision: "stale" }, revision), false);
  assert.equal(residentMatchesRuntime({}, revision), false);
});

test("a mismatched launch never retires a live resident that may own detached work", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-resident-mismatch-"));
  const clientId = "swc_scope_mismatch";
  const root = residentRoot(home, clientId);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "manifest.json"), JSON.stringify({
      pid: child.pid,
      proxyUrl: "ws://127.0.0.1:1",
      runtimeRevision: await residentRuntimeRevision(),
      threadListCwd: "/repo-a",
    }));
    await assert.rejects(
      ensureCodexAppServerResident({ command: "codex", cwd: "/repo-b", home, clientId, threadListCwd: "/repo-b" }),
      /may be preserving detached work/i,
    );
    assert.doesNotThrow(() => process.kill(child.pid, 0));
  } finally {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    await rm(home, { recursive: true, force: true });
  }
});

test("App Server transport writes only next-turn model and effort config overrides", () => {
  assert.deepEqual(routeConfigEdits({
    model: "openai-codex/gpt-5.6-sol",
    effort: "high",
  }), [
    { keyPath: "model", mergeStrategy: "upsert", value: "gpt-5.6-sol" },
    { keyPath: "model_reasoning_effort", mergeStrategy: "upsert", value: "high" },
  ]);
  assert.deepEqual(routeConfigEdits({ model: "gpt-5.6-terra" }), [
    { keyPath: "model", mergeStrategy: "upsert", value: "gpt-5.6-terra" },
  ]);
  assert.throws(() => routeConfigEdits({ effort: "high" }), /missing a model/);
});

test("App Server routing overrides the native next turn and requires a settings receipt", () => {
  const { message, receipt } = applyRouteToTurnStart({
    id: 12,
    method: "turn/start",
    params: { threadId: "thread-1", input: [] },
  }, { session_id: "thread-1", model: "openai-codex/gpt-5.6-sol", effort: "high" });
  assert.equal(message.params.model, "gpt-5.6-sol");
  assert.equal(message.params.effort, "high");
  assert.deepEqual(settingsConfirmRoute(receipt, {
    method: "thread/settings/updated",
    params: { threadId: "thread-1", threadSettings: { model: "gpt-5.6-sol", effort: "high" } },
  }), {
    ...receipt,
    actualModel: "gpt-5.6-sol",
    actualEffort: "high",
    confirmed: true,
  });
  assert.equal(settingsConfirmRoute(receipt, {
    method: "thread/settings/updated",
    params: { threadId: "thread-1", threadSettings: { model: "gpt-5.6-terra", effort: "high" } },
  }).confirmed, false);
  assert.deepEqual(applyRouteToTurnStart({
    method: "turn/start", params: { threadId: "different-thread" },
  }, { session_id: "thread-1", model: "gpt-5.6-sol" }), {
    message: { method: "turn/start", params: { threadId: "different-thread" } }, receipt: null,
  });
});

test("App Server resume history is scoped to the managed project unless the client supplied a cwd", () => {
  assert.deepEqual(applyThreadListCwd({ id: 1, method: "thread/list", params: { limit: 20 } }, "/repo"), {
    id: 1,
    method: "thread/list",
    params: { limit: 20, cwd: "/repo" },
  });
  assert.deepEqual(applyThreadListCwd({ id: 2, method: "thread/list", params: { cwd: ["/other"] } }, "/repo"), {
    id: 2,
    method: "thread/list",
    params: { cwd: ["/other"] },
  });
  assert.deepEqual(applyThreadListCwd({ id: 3, method: "model/list", params: {} }, "/repo"), {
    id: 3,
    method: "model/list",
    params: {},
  });
});

test("resident proxy retires after its last idle TUI disconnects", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  let idleCalls = 0;
  let resolveIdle;
  const idle = new Promise((resolve) => { resolveIdle = resolve; });
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    takePendingRoute: async () => null,
    idleMs: 10,
    onIdle: async () => { idleCalls += 1; resolveIdle(); },
  });
  const client = new WebSocket(proxy.url);
  await once(client, "open");
  client.close();
  await idle;
  assert.equal(idleCalls, 1);
  await proxy.close();
  await new Promise((resolveClose) => upstream.close(resolveClose));
});

test("resident proxy preserves a detached active turn until it completes", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  let upstreamSocket;
  const upstreamConnection = new Promise((resolveConnection) => upstream.once("connection", (socket) => {
    upstreamSocket = socket;
    resolveConnection();
  }));
  let idleCalls = 0;
  let resolveIdle;
  const idle = new Promise((resolve) => { resolveIdle = resolve; });
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    takePendingRoute: async () => null,
    idleMs: 10,
    onIdle: async () => { idleCalls += 1; resolveIdle(); },
  });
  const client = new WebSocket(proxy.url);
  await once(client, "open");
  await upstreamConnection;
  const active = once(client, "message");
  upstreamSocket.send(JSON.stringify({ method: "thread/status/changed", params: { threadId: "thread-1", status: { type: "active" } } }));
  await active;
  client.close();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
  assert.equal(idleCalls, 0);
  upstreamSocket.send(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1" } }));
  await idle;
  assert.equal(idleCalls, 1);
  await proxy.close();
  await new Promise((resolveClose) => upstream.close(resolveClose));
});

test("resident proxy preserves a submitted turn before its activity acknowledgement", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  let upstreamSocket;
  const upstreamConnection = new Promise((resolveConnection) => upstream.once("connection", (socket) => {
    upstreamSocket = socket;
    resolveConnection();
  }));
  let idleCalls = 0;
  let resolveIdle;
  const idle = new Promise((resolve) => { resolveIdle = resolve; });
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    takePendingRoute: async () => null,
    idleMs: 10,
    onIdle: async () => { idleCalls += 1; resolveIdle(); },
  });
  const client = new WebSocket(proxy.url);
  await once(client, "open");
  await upstreamConnection;
  const submitted = once(upstreamSocket, "message");
  client.send(JSON.stringify({ id: 1, method: "turn/start", params: { threadId: "thread-1", input: [] } }));
  await submitted;
  client.terminate();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
  assert.equal(idleCalls, 0);
  assert.equal(upstreamSocket.readyState, WebSocket.OPEN);
  upstreamSocket.send(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1" } }));
  await idle;
  assert.equal(idleCalls, 1);
  await proxy.close();
  await new Promise((resolveClose) => upstream.close(resolveClose));
});

test("resident proxy clears provisional activity when turn submission is rejected", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  let upstreamSocket;
  const upstreamConnection = new Promise((resolveConnection) => upstream.once("connection", (socket) => {
    upstreamSocket = socket;
    resolveConnection();
  }));
  let resolveIdle;
  const idle = new Promise((resolve) => { resolveIdle = resolve; });
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    takePendingRoute: async () => null,
    idleMs: 10,
    onIdle: async () => resolveIdle(),
  });
  const client = new WebSocket(proxy.url);
  await once(client, "open");
  await upstreamConnection;
  const submitted = once(upstreamSocket, "message");
  client.send(JSON.stringify({ id: 1, method: "turn/start", params: { threadId: "thread-1", input: [] } }));
  await submitted;
  const rejected = once(client, "message");
  upstreamSocket.send(JSON.stringify({ id: 1, error: { code: -32600, message: "rejected" } }));
  await rejected;
  client.close();
  await idle;
  await proxy.close();
  await new Promise((resolveClose) => upstream.close(resolveClose));
});

test("resident proxy cancels pending idle retirement when a TUI reconnects", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  let idleCalls = 0;
  let resolveIdle;
  const idle = new Promise((resolve) => { resolveIdle = resolve; });
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    takePendingRoute: async () => null,
    idleMs: 30,
    onIdle: async () => { idleCalls += 1; resolveIdle(); },
  });
  const first = new WebSocket(proxy.url);
  await once(first, "open");
  first.close();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  const second = new WebSocket(proxy.url);
  await once(second, "open");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
  assert.equal(idleCalls, 0);
  second.close();
  await idle;
  assert.equal(idleCalls, 1);
  await proxy.close();
  await new Promise((resolveClose) => upstream.close(resolveClose));
});

test("resident proxy keeps JSON-RPC request correlation local to each TUI", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  const upstreamSockets = [];
  upstream.on("connection", (socket) => upstreamSockets.push(socket));
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    takePendingRoute: async () => null,
  });
  const first = new WebSocket(proxy.url);
  await once(first, "open");
  while (upstreamSockets.length < 1) await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
  const second = new WebSocket(proxy.url);
  await once(second, "open");
  while (upstreamSockets.length < 2) await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
  const forwardedRequests = upstreamSockets.map((socket) => once(socket, "message"));
  first.send(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: "thread-a" } }));
  second.send(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: "thread-b" } }));
  await Promise.all(forwardedRequests);
  const firstResponse = once(first, "message");
  const secondResponse = once(second, "message");
  upstreamSockets[0].send(JSON.stringify({ id: 1, result: { thread: { id: "thread-a", turns: [] }, initialTurnsPage: { data: [{ id: "a" }] } } }));
  upstreamSockets[1].send(JSON.stringify({ id: 1, result: { thread: { id: "thread-b", turns: [] }, initialTurnsPage: { data: [{ id: "b" }] } } }));
  assert.deepEqual(JSON.parse(String(await firstResponse)).result.thread.turns, [{ id: "a" }]);
  assert.deepEqual(JSON.parse(String(await secondResponse)).result.thread.turns, [{ id: "b" }]);
  first.close();
  second.close();
  await proxy.close();
  await new Promise((resolveClose) => upstream.close(resolveClose));
});

test("compact resume requests server-supported metadata and bounded recent history", () => {
  const request = { id: 4, method: "thread/resume", params: { threadId: "thread-1", initialTurnsPage: { limit: 200 } } };
  assert.deepEqual(applyCompactResumeRequest(request), {
    id: 4,
    method: "thread/resume",
    params: { threadId: "thread-1", excludeTurns: true, initialTurnsPage: { limit: 4, sortDirection: "desc", itemsView: "summary" } },
  });
  assert.deepEqual(applyCompactResumeRequest(request, true, 2).params.initialTurnsPage, { limit: 2, sortDirection: "desc", itemsView: "summary" });
  assert.equal(applyCompactResumeRequest(request, false), request);
  const readRequest = { id: 4, method: "thread/read", params: {} };
  assert.equal(applyCompactResumeRequest(readRequest), readRequest);
});

test("bounded resume pages are normalized for the native Codex transcript surface", () => {
  const response = {
    id: 4,
    result: {
      thread: { id: "thread-1", turns: [] },
      initialTurnsPage: { data: [{ id: "newest" }, { id: "older" }] },
    },
  };
  assert.deepEqual(hydrateBoundedResumeTurns(response).result.thread.turns, [{ id: "older" }, { id: "newest" }]);
  assert.equal(hydrateBoundedResumeTurns({ result: { thread: { turns: [{ id: "existing" }] } } }).result.thread.turns[0].id, "existing");
});

test("App Server route proxy injects one pending route and records the server receipt", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  const injected = [];
  const confirmed = [];
  let pending = { session_id: "thread-proxy", model: "openai-codex/gpt-5.6-sol", effort: "high" };
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${upstreamAddress.port}`,
    takePendingRoute: async (threadId) => {
      if (pending?.session_id !== threadId) return null;
      const route = pending;
      pending = null;
      return route;
    },
    onRouteInjected: async (receipt) => injected.push(receipt),
    onRouteConfirmed: async (receipt) => confirmed.push(receipt),
    threadListCwd: "/repo",
  });
  let upstreamSocket;
  const upstreamConnection = new Promise((resolveConnection) => upstream.once("connection", (socket) => {
    upstreamSocket = socket;
    resolveConnection();
  }));
  const client = new WebSocket(proxy.url);
  await once(client, "open");
  await upstreamConnection;
  assert.equal((await fetch(`${proxy.url.replace("ws:", "http:")}/readyz`)).status, 200);
  assert.equal((await fetch(`${proxy.url.replace("ws:", "http:")}/healthz`)).status, 200);
  const listForwarded = new Promise((resolveMessage) => upstreamSocket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  client.send(JSON.stringify({ id: -1, method: "thread/list", params: { limit: 20 } }));
  assert.deepEqual(await listForwarded, { id: -1, method: "thread/list", params: { limit: 20, cwd: "/repo" } });
  const childForwarded = new Promise((resolveMessage) => upstreamSocket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  client.send(JSON.stringify({ id: 0, method: "turn/start", params: { threadId: "child-thread", input: [] } }));
  const childRequest = await childForwarded;
  assert.equal(childRequest.params.model, undefined);
  assert.equal(injected.length, 0);
  const forwarded = new Promise((resolveMessage) => upstreamSocket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  client.send(JSON.stringify({ id: 1, method: "turn/start", params: { threadId: "thread-proxy", input: [] } }));
  const request = await forwarded;
  assert.equal(request.params.model, "gpt-5.6-sol");
  assert.equal(request.params.effort, "high");
  assert.equal(injected.length, 1);
  upstreamSocket.send(JSON.stringify({
    method: "thread/settings/updated",
    params: { threadId: "thread-proxy", threadSettings: { model: "gpt-5.6-sol", effort: "high" } },
  }));
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  assert.deepEqual(confirmed.map(({ confirmed: value }) => value), [true]);
  const nativeResponse = new Promise((resolveMessage) => client.once("message", (raw, isBinary) => {
    resolveMessage({ message: JSON.parse(String(raw)), isBinary });
  }));
  upstreamSocket.send(JSON.stringify({ id: 1, result: { ok: true } }));
  assert.deepEqual(await nativeResponse, { message: { id: 1, result: { ok: true } }, isBinary: false });
  const forwardedResume = new Promise((resolveMessage) => upstreamSocket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  client.send(JSON.stringify({ id: 2, method: "thread/resume", params: { threadId: "thread-proxy", initialTurnsPage: { limit: 100 } } }));
  assert.deepEqual(await forwardedResume, {
    id: 2,
    method: "thread/resume",
    params: { threadId: "thread-proxy", excludeTurns: true, initialTurnsPage: { limit: 4, sortDirection: "desc", itemsView: "summary" } },
  });
  const compactResumeResponse = new Promise((resolveMessage) => client.once("message", (raw, isBinary) => {
    resolveMessage({ message: JSON.parse(String(raw)), isBinary });
  }));
  upstreamSocket.send(JSON.stringify({ id: 2, result: { thread: { id: "thread-proxy", turns: [] }, initialTurnsPage: { data: [{ id: "newest" }, { id: "older" }] } } }));
  assert.deepEqual(await compactResumeResponse, {
    message: { id: 2, result: { thread: { id: "thread-proxy", turns: [{ id: "older" }, { id: "newest" }] }, initialTurnsPage: { data: [{ id: "newest" }, { id: "older" }] } } },
    isBinary: false,
  });
  client.close();
  await proxy.close();
  await new Promise((resolveClose) => upstream.close(resolveClose));
});
