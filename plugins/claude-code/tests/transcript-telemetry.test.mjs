import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  baselineClaudeTranscriptUsage,
  claudeDeliveryDirectory,
  drainClaudeTelemetry,
  projectClaudeTranscriptUsage,
  readPendingDeliveries,
} from "../scripts/transcript-telemetry.mjs";

function transcriptRecord(id, input, cacheWrite, cacheRead, output, timestamp) {
  return JSON.stringify({
    uuid: `outer-${id}-${timestamp}`,
    timestamp,
    message: {
      id,
      role: "assistant",
      model: "claude-opus-4-6",
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: cacheWrite,
        cache_read_input_tokens: cacheRead,
        output_tokens: output,
      },
    },
  });
}

function acceptedTelemetryResponse(options, status = 202) {
  let eventIds = [];
  try {
    eventIds = JSON.parse(options?.body ?? "{}").events?.map((event) => event.event_id) ?? [];
  } catch {}
  return new Response(JSON.stringify({
    accepted: eventIds.length,
    accepted_event_ids: eventIds,
    duplicate_event_ids: [],
  }), { status, headers: { "content-type": "application/json" } });
}

test("projects deduplicated exact Claude transcript usage into the active state epoch", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-claude-telemetry-"));
  const session = "session-1";
  const project = join(home, ".claude", "projects", "-tmp-project");
  const stateFile = join(home, "state.json");
  const runIdFile = join(home, "run-id");
  const epochFile = join(home, "epoch");
  const ledgerFile = join(home, "ledger.json");
  const deliveryDir = join(home, "delivery");
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return acceptedTelemetryResponse(options);
  };
  try {
    await mkdir(project, { recursive: true });
    await writeFile(stateFile, JSON.stringify({
      run_id: "run-1", run_session_id: "gateway-session-1", workflow: "agentic-engineering-default-v1", state: "baseline", context_budget_bytes: 64000,
    }));
    await writeFile(epochFile, "3\n");
    const transcript = join(project, `${session}.jsonl`);
    await writeFile(transcript, [
      transcriptRecord("message-1", 11, 2, 3, 5, "2026-08-04T00:00:00.000Z"),
      transcriptRecord("message-1", 11, 2, 3, 5, "2026-08-04T00:00:01.000Z"),
    ].join("\n") + "\n");

    const options = { home, sessionId: session, threadId: "swc_session", stateFile, runIdFile, epochFile, ledgerFile, deliveryDir, pbUrl: "http://example.test", gatewayUrl: "http://mcp.example.test", apiKey: "key" };
    await writeFile(runIdFile, "run-1\n");
    const first = await projectClaudeTranscriptUsage(options);
    assert.equal(first.projected, true);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, "http://example.test/api/gateway/telemetry/events");
    assert.equal(requests[1].url, "http://mcp.example.test/api/runtime-usage");
    assert.deepEqual(requests[0].body.events[0].token_usage_delta, {
      input_tokens: 11, cache_write_input_tokens: 2, cached_input_tokens: 3, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 21,
    });
    assert.equal(requests[0].body.events[0].state_budget.state_epoch, 3);
    assert.equal(requests[0].body.events[0].thread_id, "swc_session");
    assert.equal(requests[0].body.events[0].run_session_id, "gateway-session-1");
    assert.equal(requests[1].body.run_id, "run-1");
    assert.equal(requests[1].body.run_session_id, "gateway-session-1");
    assert.equal(requests[1].body.usage.precision, "exact");

    assert.equal((await projectClaudeTranscriptUsage(options)).projected, false);
    await writeFile(transcript, `${transcriptRecord("message-2", 7, 0, 1, 2, "2026-08-04T00:01:00.000Z")}\n`, { flag: "a" });
    const second = await projectClaudeTranscriptUsage(options);
    assert.equal(second.projected, true);
    assert.deepEqual(requests[2].body.events[0].state_budget.token_usage, {
      input_tokens: 18, cache_write_input_tokens: 2, cached_input_tokens: 4, output_tokens: 7, reasoning_output_tokens: 0, total_tokens: 31,
    });

    await writeFile(stateFile, JSON.stringify({
      workflow: "agentic-engineering-default-v1", state: "completed", context_budget_bytes: 64000,
    }));
    await writeFile(epochFile, "4\n");
    await writeFile(transcript, `${transcriptRecord("message-3", 2, 0, 0, 1, "2026-08-04T00:02:00.000Z")}\n`, { flag: "a" });
    const terminal = await projectClaudeTranscriptUsage(options);
    assert.equal(terminal.projected, true);
    assert.equal(requests[4].body.events[0].run_id, "run-1");
    assert.equal(requests[4].body.events[0].state, "completed");
    assert.equal(requests[4].body.events[0].state_budget.state_epoch, 4);
    assert.deepEqual(requests[4].body.events[0].token_usage_delta, {
      input_tokens: 2, cache_write_input_tokens: 0, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 3,
    });
    assert.doesNotMatch(await readFile(ledgerFile, "utf8"), /assistant content|tool_result|prompt/i);
    assert.deepEqual(await readdir(claudeDeliveryDirectory(deliveryDir, options.apiKey)), [], "completed deliveries must not accumulate on disk");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(home, { recursive: true, force: true });
  }
});

test("concurrent Claude projectors serialize cursor, cumulative totals, and sequence", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-claude-concurrent-"));
  const session = "session-concurrent";
  const project = join(home, ".claude", "projects", "-tmp-project");
  const options = {
    home,
    sessionId: session,
    threadId: "swc_concurrent",
    stateFile: join(home, "state.json"),
    runIdFile: join(home, "run-id"),
    epochFile: join(home, "epoch"),
    ledgerFile: join(home, "ledger.json"),
    deliveryDir: join(home, "delivery"),
    pbUrl: "http://pb.example.test",
    gatewayUrl: "http://mcp.example.test",
    apiKey: "key",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => acceptedTelemetryResponse(options);
  try {
    await mkdir(project, { recursive: true });
    await writeFile(options.stateFile, JSON.stringify({
      run_id: "run-1",
      workflow: "workflow",
      state: "implement",
    }));
    await writeFile(options.runIdFile, "run-1\n");
    await writeFile(options.epochFile, "1\n");
    await writeFile(
      join(project, `${session}.jsonl`),
      `${transcriptRecord("message-1", 9, 2, 3, 4, "2026-08-04T00:00:00.000Z")}\n`,
    );

    const results = await Promise.all([
      projectClaudeTranscriptUsage(options),
      projectClaudeTranscriptUsage(options),
    ]);
    assert.equal(results.filter((result) => result.projected).length, 1);
    assert.equal(results.filter((result) => result.reason === "no_new_usage").length, 1);
    const ledger = JSON.parse(await readFile(options.ledgerFile, "utf8"));
    assert.equal(ledger.sequence, 1);
    assert.equal(ledger.epochs["1"].usage.total_tokens, 18);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(home, { recursive: true, force: true });
  }
});

test("retries each Claude telemetry destination independently after restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-claude-delivery-"));
  const session = "session-retry";
  const project = join(home, ".claude", "projects", "-tmp-project");
  const stateFile = join(home, "state.json");
  const runIdFile = join(home, "run-id");
  const epochFile = join(home, "epoch");
  const ledgerFile = join(home, "ledger.json");
  const deliveryDir = join(home, "delivery");
  const options = {
    home,
    sessionId: session,
    threadId: "swc_retry",
    stateFile,
    runIdFile,
    epochFile,
    ledgerFile,
    deliveryDir,
    pbUrl: "http://pb.example.test",
    gatewayUrl: "http://mcp.example.test",
    apiKey: "key",
  };
  const originalFetch = globalThis.fetch;
  try {
    await mkdir(project, { recursive: true });
    await writeFile(stateFile, JSON.stringify({
      run_id: "run-1", run_session_id: "gateway-session-1", workflow: "workflow", state: "implement",
    }));
    await writeFile(runIdFile, "run-1\n");
    await writeFile(epochFile, "1\n");
    await writeFile(
      join(project, `${session}.jsonl`),
      `${transcriptRecord("message-1", 4, 0, 0, 2, "2026-08-04T00:00:00.000Z")}\n`,
    );

    const firstRequests = [];
    globalThis.fetch = async (url, request) => {
      firstRequests.push(String(url));
      if (String(url).includes("runtime-usage")) throw new Error("gateway unavailable");
      return acceptedTelemetryResponse(request);
    };
    await assert.rejects(projectClaudeTranscriptUsage(options), /gateway unavailable/);
    assert.deepEqual(firstRequests, [
      "http://pb.example.test/api/gateway/telemetry/events",
      "http://mcp.example.test/api/runtime-usage",
    ]);
    const scopedDeliveryDir = claudeDeliveryDirectory(deliveryDir, options.apiKey);
    const pending = await readPendingDeliveries(scopedDeliveryDir);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].pocketbase_delivered, true);
    assert.equal(pending[0].gateway_delivered, false);

    // Session/workflow cleanup may remove every cursor and active-state file;
    // the delivery outbox must still drain on the next hook invocation.
    await rm(stateFile, { force: true });
    await rm(epochFile, { force: true });
    await rm(ledgerFile, { force: true });
    const retryRequests = [];
    globalThis.fetch = async (url) => {
      retryRequests.push(String(url));
      return new Response(JSON.stringify({ error: "inactive_session" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    };
    assert.deepEqual(await drainClaudeTelemetry(options), {
      projected: false,
      reason: "delivery_only",
    });
    assert.deepEqual(retryRequests, ["http://mcp.example.test/api/runtime-usage"]);
    assert.deepEqual(await readPendingDeliveries(scopedDeliveryDir), []);
    assert.deepEqual(await readdir(scopedDeliveryDir), []);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(home, { recursive: true, force: true });
  }
});

test("new workflow baseline excludes pre-existing Claude transcript usage", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-claude-baseline-"));
  const session = "session-baseline";
  const project = join(home, ".claude", "projects", "-tmp-project");
  const options = {
    home,
    sessionId: session,
    threadId: "swc_baseline",
    stateFile: join(home, "state.json"),
    runIdFile: join(home, "run-id"),
    epochFile: join(home, "epoch"),
    ledgerFile: join(home, "ledger.json"),
    deliveryDir: join(home, "delivery"),
    pbUrl: "http://pb.example.test",
    gatewayUrl: "http://mcp.example.test",
    apiKey: "key",
  };
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, request) => {
    requests.push(JSON.parse(request.body));
    return acceptedTelemetryResponse(request);
  };
  try {
    await mkdir(project, { recursive: true });
    const transcript = join(project, `${session}.jsonl`);
    await writeFile(transcript, `${transcriptRecord("old", 100, 0, 0, 10, "2026-08-04T00:00:00.000Z")}\n`);
    await baselineClaudeTranscriptUsage(options);
    await writeFile(options.stateFile, JSON.stringify({ run_id: "new-run", run_session_id: "new-session", state: "implement" }));
    await writeFile(options.runIdFile, "new-run\n");
    await writeFile(options.epochFile, "1\n");
    await writeFile(transcript, `${transcriptRecord("new", 7, 1, 2, 3, "2026-08-04T00:01:00.000Z")}\n`, { flag: "a" });
    const result = await projectClaudeTranscriptUsage(options);
    assert.equal(result.projected, true);
    assert.equal(requests[0].events[0].token_usage_delta.total_tokens, 13);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(home, { recursive: true, force: true });
  }
});

test("Claude delivery queues are isolated across API key rotation", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-claude-key-rotation-"));
  const session = "session-key-rotation";
  const project = join(home, ".claude", "projects", "-tmp-project");
  const options = {
    home, sessionId: session, threadId: "swc_rotation",
    stateFile: join(home, "state.json"), runIdFile: join(home, "run-id"),
    epochFile: join(home, "epoch"), ledgerFile: join(home, "ledger.json"),
    deliveryDir: join(home, "delivery"), pbUrl: "http://pb.example.test",
    gatewayUrl: "http://mcp.example.test", apiKey: "old-key",
  };
  const originalFetch = globalThis.fetch;
  try {
    await mkdir(project, { recursive: true });
    await writeFile(options.stateFile, JSON.stringify({ run_id: "run", run_session_id: "session", state: "implement" }));
    await writeFile(options.runIdFile, "run\n");
    await writeFile(options.epochFile, "1\n");
    await writeFile(join(project, `${session}.jsonl`), `${transcriptRecord("usage", 2, 0, 0, 1, "2026-08-04T00:02:00.000Z")}\n`);
    globalThis.fetch = async (url, request) => {
      if (String(url).includes("runtime-usage")) throw new Error("offline");
      return acceptedTelemetryResponse(request);
    };
    await assert.rejects(projectClaudeTranscriptUsage(options), /offline/);
    assert.equal((await readPendingDeliveries(claudeDeliveryDirectory(options.deliveryDir, "old-key"))).length, 1);
    const newRequests = [];
    globalThis.fetch = async (url, request) => {
      newRequests.push(String(url));
      return acceptedTelemetryResponse(request);
    };
    await drainClaudeTelemetry({ ...options, apiKey: "new-key" });
    assert.deepEqual(newRequests, []);
    assert.equal((await readPendingDeliveries(claudeDeliveryDirectory(options.deliveryDir, "old-key"))).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(home, { recursive: true, force: true });
  }
});

test("malformed Claude delivery records are quarantined instead of blocking the queue", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-claude-quarantine-"));
  const deliveryDir = join(home, "delivery");
  const eventId = "a".repeat(64);
  const eventDir = join(deliveryDir, eventId);
  const structuralEventId = "b".repeat(64);
  const structuralEventDir = join(deliveryDir, structuralEventId);
  const oversizedEventId = "c".repeat(64);
  const oversizedEventDir = join(deliveryDir, oversizedEventId);
  try {
    await mkdir(eventDir, { recursive: true });
    await writeFile(join(eventDir, "event.json"), "{truncated");
    await mkdir(structuralEventDir, { recursive: true });
    await writeFile(join(structuralEventDir, "event.json"), JSON.stringify({
      event_id: structuralEventId,
      event: "provider_token_usage",
      run_id: "run",
      run_session_id: "session",
      thread_id: "thread",
      state: "implement",
      sequence: 1,
      state_budget: { state: "implement", state_epoch: 1, precision: "exact" },
    }));
    await mkdir(oversizedEventDir, { recursive: true });
    await writeFile(join(oversizedEventDir, "event.json"), "x".repeat(64 * 1024 + 1));
    assert.deepEqual(await readPendingDeliveries(deliveryDir), []);
    assert.equal((await readdir(join(deliveryDir, "quarantine"))).length, 3);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Claude ledger compacts retained message IDs and state epochs", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-claude-ledger-bound-"));
  const sessionId = "bounded-ledger";
  const project = join(home, ".claude", "projects", "-tmp-project");
  const options = {
    home,
    sessionId,
    threadId: "thread",
    stateFile: join(home, "state.json"),
    epochFile: join(home, "epoch"),
    ledgerFile: join(home, "ledger.json"),
    deliveryDir: join(home, "delivery"),
    pbUrl: "http://pb.example.test",
    gatewayUrl: "http://mcp.example.test",
    apiKey: "key",
  };
  try {
    await mkdir(project, { recursive: true });
    await writeFile(join(project, `${sessionId}.jsonl`), "");
    await writeFile(options.stateFile, JSON.stringify({ run_id: "run", state: "implement" }));
    await writeFile(options.epochFile, "1\n");
    const seen = Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => [`message-${index}`, true]));
    const epochs = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [String(index + 1), {
      usage: { total_tokens: index + 1 }, model: "claude", timestamp: "",
    }]));
    await writeFile(options.ledgerFile, JSON.stringify({ cursor: {}, seen, epochs, sequence: 100 }));

    assert.deepEqual(await projectClaudeTranscriptUsage(options), { projected: false, reason: "no_new_usage" });
    const compacted = JSON.parse(await readFile(options.ledgerFile, "utf8"));
    assert.equal(Object.keys(compacted.seen).length, 4_096);
    assert.equal(Object.keys(compacted.epochs).length, 64);
    assert.equal(compacted.epochs["1"].usage.total_tokens, 1);
    assert.equal(compacted.epochs["37"], undefined, "oldest non-active retained epoch should make room for active epoch");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Claude rejects an oversized ledger before reading it", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-claude-ledger-oversized-"));
  const sessionId = "oversized-ledger";
  const project = join(home, ".claude", "projects", "-tmp-project");
  const options = {
    home,
    sessionId,
    threadId: "thread",
    stateFile: join(home, "state.json"),
    epochFile: join(home, "epoch"),
    ledgerFile: join(home, "ledger.json"),
    deliveryDir: join(home, "delivery"),
    pbUrl: "http://pb.example.test",
    gatewayUrl: "http://mcp.example.test",
    apiKey: "key",
  };
  try {
    await mkdir(project, { recursive: true });
    await writeFile(join(project, `${sessionId}.jsonl`), "");
    await writeFile(options.stateFile, JSON.stringify({ run_id: "run", state: "implement" }));
    await writeFile(options.epochFile, "1\n");
    await writeFile(options.ledgerFile, "x".repeat(2 * 1024 * 1024 + 1));

    await assert.rejects(projectClaudeTranscriptUsage(options), /ledger exceeds 2097152 bytes/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Claude delivery recovery materializes only a bounded page", async () => {
  const deliveryDir = await mkdtemp(join(tmpdir(), "statewright-claude-page-"));
  try {
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      const eventId = sequence.toString(16).padStart(64, "0");
      const eventDir = join(deliveryDir, eventId);
      await mkdir(eventDir, { recursive: true });
      await writeFile(join(eventDir, "event.json"), JSON.stringify({
        event_id: eventId,
        event: "provider_token_usage",
        run_id: "run",
        run_session_id: "session",
        thread_id: "thread",
        state: "implement",
        sequence,
        state_budget: {
          state: "implement",
          state_epoch: 1,
          precision: "exact",
          provider: "anthropic",
          token_usage: { total_tokens: sequence },
        },
      }));
    }
    const pending = await readPendingDeliveries(deliveryDir, { maxEvents: 2, maxScanEntries: 2 });
    assert.equal(pending.length, 2);
  } finally {
    await rm(deliveryDir, { recursive: true, force: true });
  }
});

test("Claude keeps a PocketBase delivery until its event ID is acknowledged", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-claude-receipt-"));
  const deliveryDir = join(home, "delivery");
  const apiKey = "key";
  const eventId = "c".repeat(64);
  const eventDir = join(claudeDeliveryDirectory(deliveryDir, apiKey), eventId);
  const originalFetch = globalThis.fetch;
  try {
    await mkdir(eventDir, { recursive: true });
    await writeFile(join(eventDir, "event.json"), JSON.stringify({
      event_id: eventId,
      event: "provider_token_usage",
      run_id: "run",
      run_session_id: "session",
      thread_id: "thread",
      state: "implement",
      provider: "anthropic",
      source: "claude_transcript",
      precision: "exact",
      sequence: 1,
      state_budget: {
        state: "implement", state_epoch: 1, provider: "anthropic", precision: "exact",
        token_usage: { total_tokens: 5 },
      },
    }));
    globalThis.fetch = async (url) => String(url).includes("runtime-usage")
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify({ accepted: 1, accepted_event_ids: ["another-event"], duplicate_event_ids: [] }), { status: 202 });

    await assert.rejects(
      drainClaudeTelemetry({ deliveryDir, pbUrl: "http://pb.test", gatewayUrl: "http://gateway.test", apiKey }),
      /did not acknowledge the submitted event ID/,
    );
    const [pending] = await readPendingDeliveries(claudeDeliveryDirectory(deliveryDir, apiKey));
    assert.equal(pending.event.event_id, eventId);
    assert.equal(pending.pocketbase_delivered, false);
    assert.equal(pending.gateway_delivered, true);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(home, { recursive: true, force: true });
  }
});

test("Claude transcript reader bounds oversized records and reaches later usage", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-claude-bounded-"));
  const session = "session-bounded";
  const project = join(home, ".claude", "projects", "-tmp-project");
  const options = {
    home,
    sessionId: session,
    threadId: "swc_bounded",
    stateFile: join(home, "state.json"),
    runIdFile: join(home, "run-id"),
    epochFile: join(home, "epoch"),
    ledgerFile: join(home, "ledger.json"),
    deliveryDir: join(home, "delivery"),
    pbUrl: "http://pb.example.test",
    gatewayUrl: "http://mcp.example.test",
    apiKey: "key",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => acceptedTelemetryResponse(options);
  try {
    await mkdir(project, { recursive: true });
    await writeFile(options.stateFile, JSON.stringify({ run_id: "run", run_session_id: "session", state: "implement" }));
    await writeFile(options.runIdFile, "run\n");
    await writeFile(options.epochFile, "1\n");
    const transcript = join(project, `${session}.jsonl`);
    await writeFile(transcript, "x".repeat(1024 * 1024 + 64));
    assert.equal((await projectClaudeTranscriptUsage(options)).projected, false);
    const afterOversized = JSON.parse(await readFile(options.ledgerFile, "utf8"));
    assert.equal(afterOversized.cursor.offset, 1024 * 1024);
    await writeFile(transcript, `\n${transcriptRecord("later", 2, 0, 0, 1, "2026-08-04T00:02:00.000Z")}\n`, { flag: "a" });
    assert.equal((await projectClaudeTranscriptUsage(options)).projected, true);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(home, { recursive: true, force: true });
  }
});
