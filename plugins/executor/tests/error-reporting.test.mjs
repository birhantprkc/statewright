import assert from "node:assert/strict";
import test from "node:test";
import { createErrorReporter, formatEnvelope, isExpectedExit, isExpectedPluginError, isExpectedTransportClose, sanitizeContext, sanitizeError, sentryEndpoint } from "../lib/error-reporting.mjs";

test("error reporter redacts credentials and excludes arbitrary payload context", () => {
  const error = sanitizeError(new Error('Authorization: Bearer secret-token sw_live_abc123 token=also-secret payload={"prompt":"world-domination-plan"}'));
  assert.doesNotMatch(error.value, /secret-token|sw_live_abc123|also-secret|world-domination-plan/);
  assert.equal(error.value, "Unexpected plugin failure (message withheld).");
  assert.equal(error.stacktrace, undefined);
  assert.deepEqual(sanitizeContext({ mechanism: "test", prompt: "do not upload this", token: "secret", exit_code: 2 }), {
    mechanism: "test", exit_code: 2,
  });
});

test("error reporter sends one scrubbed envelope and deduplicates repeated failure", async () => {
  const sent = [];
  const reporter = createErrorReporter({
    plugin: "codex",
    version: "0.3.0",
    environment: { NODE_ENV: "test" },
    send: async (payload) => { sent.push(payload); },
  });
  assert.equal(await reporter.report(new Error("api_key=secret"), { mechanism: "child_exit", exit_code: 2, prompt: "hidden" }), true);
  assert.equal(await reporter.report(new Error("api_key=other-secret"), { mechanism: "child_exit", exit_code: 2 }), false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event.tags.plugin, "codex");
  assert.equal(sent[0].event.tags.exit_code, 2);
  assert.doesNotMatch(JSON.stringify(sent[0].event), /secret|hidden/);
});

test("Sentry endpoint preserves a self-hosted path prefix and failed delivery remains retryable", async () => {
  assert.equal(
    sentryEndpoint("https://public@example.test/sentry/12"),
    "https://example.test/sentry/api/12/envelope/?sentry_version=7&sentry_key=public",
  );
  let attempts = 0;
  const reporter = createErrorReporter({
    plugin: "codex",
    environment: { NODE_ENV: "test" },
    send: async () => { attempts += 1; if (attempts === 1) throw new Error("offline"); },
  });
  assert.equal(await reporter.report(new Error("same failure"), { mechanism: "child_exit" }), false);
  assert.equal(await reporter.report(new Error("same failure"), { mechanism: "child_exit" }), true);
  assert.equal(attempts, 2);
  const envelope = formatEnvelope({ dsn: "https://public@example.test/12", event: { event_id: "event", timestamp: "2026-08-25T00:00:00.000Z", tags: {}, exception: { values: [{ value: "Unexpected plugin failure (message withheld)." }] } } });
  assert.doesNotMatch(envelope, /same failure|secret/);
});

test("normal exits and normal websocket closes are not error conditions", () => {
  assert.equal(isExpectedExit({ code: 0 }), true);
  assert.equal(isExpectedExit({ signal: "SIGINT" }), true);
  assert.equal(isExpectedExit({ code: 130 }), true);
  assert.equal(isExpectedExit({ code: 3_221_225_786 }), true);
  assert.equal(isExpectedExit({ code: 2 }), false);
  assert.equal(isExpectedTransportClose({ side: "native_close", code: 1000 }), true);
  assert.equal(isExpectedTransportClose({ side: "upstream_close", code: 1006 }), false);
  assert.equal(isExpectedPluginError(new Error("--host must be codex or claude.")), true);
  assert.equal(isExpectedPluginError(new Error("Unknown option: --typo")), true);
  assert.equal(isExpectedPluginError(new Error("[statewright] BLOCKED: command is not allowed")), true);
  assert.equal(isExpectedPluginError(new Error("unexpected internal failure")), false);
});
