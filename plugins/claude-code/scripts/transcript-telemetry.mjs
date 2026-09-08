#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, opendir, readFile, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";

const EMPTY_USAGE = Object.freeze({
  input_tokens: 0,
  cache_write_input_tokens: 0,
  cached_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
  total_tokens: 0,
});
const MAX_TRANSCRIPT_READ_BYTES = 1024 * 1024;
const MAX_DELIVERY_EVENT_BYTES = 64 * 1024;
const MAX_LEDGER_BYTES = 2 * 1024 * 1024;
const MAX_SEEN_MESSAGE_IDS = 4_096;
const MAX_RETAINED_EPOCHS = 64;

function number(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizedUsage(usage = {}) {
  const input = number(usage.input_tokens);
  const cacheWrite = number(usage.cache_creation_input_tokens);
  const cached = number(usage.cache_read_input_tokens);
  const output = number(usage.output_tokens);
  return {
    input_tokens: input,
    cache_write_input_tokens: cacheWrite,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + cacheWrite + cached + output,
  };
}

function addUsage(total, delta) {
  const result = {};
  for (const key of Object.keys(EMPTY_USAGE)) result[key] = number(total?.[key]) + number(delta?.[key]);
  return result;
}

export function assistantUsageRecord(record) {
  const message = record?.message;
  if (message?.role !== "assistant" || !message.usage || !message.id) return null;
  return {
    id: String(message.id),
    model: typeof message.model === "string" ? message.model : "",
    timestamp: typeof record.timestamp === "string" ? record.timestamp : new Date().toISOString(),
    usage: normalizedUsage(message.usage),
  };
}

export function parseAssistantUsageJsonl(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = assistantUsageRecord(JSON.parse(line));
      if (entry) entries.push(entry);
    } catch {
      // A malformed transcript line is not provider usage and is never projected.
    }
  }
  return entries;
}

async function findTranscript(home, sessionId) {
  const root = join(home, ".claude", "projects");
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, `${sessionId}.jsonl`);
    try {
      await stat(candidate);
      return candidate;
    } catch {}
  }
  return null;
}

async function readNewJsonl(path, cursor) {
  const metadata = await stat(path);
  const offset = cursor.path === path && cursor.offset <= metadata.size ? cursor.offset : 0;
  if (offset === metadata.size) return { text: "", offset, path };
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(metadata.size - offset, MAX_TRANSCRIPT_READ_BYTES));
    await handle.read(buffer, 0, buffer.length, offset);
    const lastNewline = buffer.lastIndexOf(10);
    if (lastNewline < 0) {
      // Never allocate an unbounded transcript record. If the entire bounded
      // window lacks a newline, skip that malformed/oversized fragment so a
      // later well-formed provider record remains observable.
      return {
        text: "",
        offset: buffer.length === MAX_TRANSCRIPT_READ_BYTES ? offset + buffer.length : offset,
        path,
      };
    }
    return {
      text: buffer.subarray(0, lastNewline + 1).toString("utf8"),
      offset: offset + lastNewline + 1,
      path,
    };
  } finally {
    await handle.close();
  }
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

async function readLedger(path, fallback) {
  const metadata = await stat(path).catch(() => null);
  if (!metadata) return fallback;
  if (metadata.size > MAX_LEDGER_BYTES) {
    throw new Error(`Claude telemetry ledger exceeds ${MAX_LEDGER_BYTES} bytes`);
  }
  return JSON.parse(await readFile(path, "utf8"));
}

function compactLedger(ledger, activeEpoch) {
  const seen = Object.entries(ledger.seen ?? {}).slice(-MAX_SEEN_MESSAGE_IDS);
  ledger.seen = Object.fromEntries(seen);
  const epochs = Object.entries(ledger.epochs ?? {})
    .sort(([left], [right]) => Number(left) - Number(right));
  const retained = epochs.slice(-MAX_RETAINED_EPOCHS);
  if (activeEpoch && ledger.epochs?.[activeEpoch] && !retained.some(([key]) => key === activeEpoch)) {
    retained.shift();
    retained.push([activeEpoch, ledger.epochs[activeEpoch]]);
  }
  ledger.epochs = Object.fromEntries(retained);
  return ledger;
}

async function writeLedger(path, ledger, activeEpoch = "") {
  compactLedger(ledger, activeEpoch);
  if (Buffer.byteLength(JSON.stringify(ledger)) > MAX_LEDGER_BYTES) {
    throw new Error(`Claude telemetry ledger exceeds ${MAX_LEDGER_BYTES} bytes after compaction`);
  }
  await writeJson(path, ledger);
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function acquireLedgerLock(path, timeoutMs = 5_000) {
  const lockPath = `${path}.lock`;
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(token);
      await handle.sync();
      await handle.close();
      const heartbeat = setInterval(async () => {
        if ((await readFile(lockPath, "utf8").catch(() => "")) !== token) return;
        const now = new Date();
        await utimes(lockPath, now, now).catch(() => {});
      }, 10_000);
      heartbeat.unref?.();
      return async () => {
        clearInterval(heartbeat);
        if ((await readFile(lockPath, "utf8").catch(() => "")) === token) {
          await rm(lockPath, { force: true });
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const metadata = await stat(lockPath).catch(() => null);
      if (metadata && Date.now() - metadata.mtimeMs > 30_000) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Claude telemetry ledger is busy");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

function eventId(runId, epoch, sequence, usage) {
  return createHash("sha256")
    .update(`${runId}:${epoch}:${sequence}:${JSON.stringify(usage)}`)
    .digest("hex");
}

const TERMINAL_LIVE_REJECTIONS = new Set([
  "duplicate_or_stale",
  "stale_state",
  "inactive_run",
  "inactive_session",
  "superseded",
  "unavailable",
]);

const DELIVERY_TIMEOUT_MS = 3_000;

async function fetchWithTimeout(url, options, timeoutMs = DELIVERY_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`telemetry delivery timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      fetch(url, { ...options, signal: controller.signal }),
      timeout,
    ]);
  } finally {
    controller.abort();
  }
}

function deliveryEventDir(deliveryDir, eventId) {
  if (!/^[a-f0-9]{64}$/.test(eventId)) throw new Error("invalid delivery event id");
  return join(deliveryDir, eventId);
}

export function claudeDeliveryDirectory(deliveryRoot, apiKey) {
  const generation = createHash("sha256")
    .update(`claude-telemetry-owner\0${String(apiKey || "")}`)
    .digest("hex")
    .slice(0, 16);
  return join(deliveryRoot, "generations", generation);
}

function scopedOptions(options) {
  return {
    ...options,
    deliveryDir: claudeDeliveryDirectory(options.deliveryDir, options.apiKey),
  };
}

async function writeExclusive(path, contents) {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    return true;
  } catch (error) {
    if (error?.code === "EEXIST" || error?.code === "ENOENT") return false;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function enqueueDelivery(deliveryDir, event) {
  await mkdir(deliveryDir, { recursive: true, mode: 0o700 });
  const eventDir = deliveryEventDir(deliveryDir, event.event_id);
  if (await pathExists(eventDir)) return;
  const temporary = `${eventDir}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(temporary, { mode: 0o700 });
  try {
    await writeJson(join(temporary, "event.json"), event);
    await rename(temporary, eventDir);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
  }
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function acknowledgeDelivery(options, delivery, destination) {
  const eventDir = deliveryEventDir(options.deliveryDir, delivery.event.event_id);
  await writeExclusive(join(eventDir, `${destination}.ack`), "");
  const pocketbaseDelivered = destination === "pocketbase" ||
    await pathExists(join(eventDir, "pocketbase.ack"));
  const gatewayDelivered = !delivery.event.run_session_id || destination === "gateway" ||
    await pathExists(join(eventDir, "gateway.ack"));
  if (pocketbaseDelivered && gatewayDelivered) {
    await rm(eventDir, { recursive: true, force: true });
  }
}

function validDeliveryEvent(event, expectedId) {
  const budget = event?.state_budget;
  const tokenUsage = budget?.token_usage;
  const tokenFields = Object.keys(EMPTY_USAGE);
  return event && typeof event === "object" &&
    event.event_id === expectedId &&
    typeof event.thread_id === "string" && event.thread_id.length > 0 &&
    typeof event.run_id === "string" && event.run_id.length > 0 &&
    typeof event.run_session_id === "string" &&
    event.event === "provider_token_usage" &&
    typeof event.state === "string" && event.state.length > 0 &&
    Number.isInteger(event.sequence) && event.sequence > 0 &&
    budget && typeof budget === "object" && !Array.isArray(budget) &&
    budget.state === event.state &&
    Number.isInteger(budget.state_epoch) && budget.state_epoch > 0 &&
    budget.precision === "exact" &&
    typeof budget.provider === "string" && budget.provider.length > 0 &&
    tokenUsage && typeof tokenUsage === "object" && !Array.isArray(tokenUsage) &&
    tokenFields.every((field) => tokenUsage[field] === undefined || Number.isSafeInteger(tokenUsage[field]) && tokenUsage[field] >= 0) &&
    Number.isSafeInteger(tokenUsage.total_tokens) && tokenUsage.total_tokens >= 0;
}

async function quarantineDelivery(deliveryDir, eventDir, eventId) {
  const quarantine = join(deliveryDir, "quarantine");
  await mkdir(quarantine, { recursive: true, mode: 0o700 });
  await rename(eventDir, join(quarantine, `${eventId}-${Date.now()}`)).catch(() => {});
}

export async function readPendingDeliveries(deliveryDir, {
  maxEvents = 100,
  maxScanEntries = Math.max(maxEvents * 4, maxEvents),
  deadline = Number.POSITIVE_INFINITY,
} = {}) {
  const pending = [];
  let directory;
  try {
    directory = await opendir(deliveryDir);
  } catch (error) {
    if (error?.code === "ENOENT") return pending;
    throw error;
  }
  let scanned = 0;
  for await (const entry of directory) {
    if (scanned >= maxScanEntries || pending.length >= maxEvents || Date.now() >= deadline) break;
    scanned += 1;
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const eventDir = join(deliveryDir, entry.name);
    try {
      const eventPath = join(eventDir, "event.json");
      const metadata = await stat(eventPath);
      if (metadata.size > MAX_DELIVERY_EVENT_BYTES) {
        await quarantineDelivery(deliveryDir, eventDir, entry.name);
        continue;
      }
      const event = JSON.parse(await readFile(eventPath, "utf8"));
      if (!validDeliveryEvent(event, entry.name)) {
        await quarantineDelivery(deliveryDir, eventDir, entry.name);
        continue;
      }
      const pocketbaseDelivered = await pathExists(join(eventDir, "pocketbase.ack"));
      const gatewayDelivered = !event.run_session_id || await pathExists(join(eventDir, "gateway.ack"));
      if (!pocketbaseDelivered || !gatewayDelivered) {
        pending.push({ event, pocketbase_delivered: pocketbaseDelivered, gateway_delivered: gatewayDelivered });
      } else {
        await rm(eventDir, { recursive: true, force: true });
      }
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (error instanceof SyntaxError) {
        await quarantineDelivery(deliveryDir, eventDir, entry.name);
        continue;
      }
      throw error;
    }
  }
  return pending.sort((left, right) => left.event.sequence - right.event.sequence);
}

async function deliverPending(options) {
  const deadline = Date.now() + (options.maxDrainMs ?? 1_500);
  const maxDrainEvents = options.maxDrainEvents ?? 100;
  const pending = await readPendingDeliveries(options.deliveryDir, {
    maxEvents: maxDrainEvents,
    maxScanEntries: Math.max(maxDrainEvents * 4, maxDrainEvents),
    deadline,
  });
  let firstError = null;
  for (const delivery of pending) {
    if (Date.now() >= deadline) break;
    if (!delivery.pocketbase_delivered) {
      try {
        const response = await fetchWithTimeout(`${options.pbUrl.replace(/\/$/, "")}/api/gateway/telemetry/events`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify({ events: [delivery.event] }),
        });
        if (!response.ok) throw new Error(`telemetry endpoint returned HTTP ${response.status}`);
        const receipt = await response.json().catch(() => ({}));
        const acknowledged = [
          ...(Array.isArray(receipt.accepted_event_ids) ? receipt.accepted_event_ids : []),
          ...(Array.isArray(receipt.duplicate_event_ids) ? receipt.duplicate_event_ids : []),
        ];
        if (!acknowledged.includes(delivery.event.event_id)) {
          throw new Error("telemetry endpoint did not acknowledge the submitted event ID");
        }
        delivery.pocketbase_delivered = true;
        await acknowledgeDelivery(options, delivery, "pocketbase");
      } catch (error) {
        firstError ??= error;
      }
    }

    if (!delivery.gateway_delivered && delivery.event.run_session_id) {
      try {
        const budget = delivery.event.state_budget;
        const response = await fetchWithTimeout(`${options.gatewayUrl.replace(/\/$/, "")}/api/runtime-usage`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify({
            run_id: delivery.event.run_id,
            run_session_id: delivery.event.run_session_id,
            usage: {
              sequence: delivery.event.sequence,
              state: budget.state,
              state_epoch: budget.state_epoch,
              provider: budget.provider,
              model: budget.model,
              effort: budget.effort,
              precision: budget.precision,
              token_usage: budget.token_usage,
            },
          }),
        });
        if (response.status === 409) {
          const detail = await response.json().catch(() => ({}));
          if (!TERMINAL_LIVE_REJECTIONS.has(detail.error)) {
            throw new Error(`gateway runtime usage rejected report: ${detail.error ?? "unknown"}`);
          }
        } else if (!response.ok) {
          throw new Error(`gateway runtime usage endpoint returned HTTP ${response.status}`);
        }
        delivery.gateway_delivered = true;
        await acknowledgeDelivery(options, delivery, "gateway");
      } catch (error) {
        firstError ??= error;
      }
    }
  }
  if (firstError) throw firstError;
}

export async function drainClaudeTelemetry(options) {
  await deliverPending(scopedOptions(options));
  return { projected: false, reason: "delivery_only" };
}

export async function baselineClaudeTranscriptUsage(options) {
  await mkdir(dirname(options.ledgerFile), { recursive: true, mode: 0o700 });
  const release = await acquireLedgerLock(options.ledgerFile);
  try {
    const transcript = await findTranscript(options.home, options.sessionId);
    const cursor = transcript
      ? { path: transcript, offset: (await stat(transcript)).size }
      : {};
    await writeLedger(options.ledgerFile, { cursor, seen: {}, epochs: {}, sequence: 0 });
    return { baselined: true, cursor };
  } finally {
    await release();
  }
}

async function projectClaudeTranscriptUsageLocked(options) {
  const state = await readJson(options.stateFile, null);
  const runId = state?.run_id || (options.runIdFile
    ? (await readFile(options.runIdFile, "utf8").catch(() => "")).trim()
    : "");
  const epoch = Number.parseInt(await readFile(options.epochFile, "utf8").catch(() => "0"), 10);
  if (!runId || !state?.state || !Number.isInteger(epoch) || epoch < 1 || !options.sessionId) {
    return { projected: false, reason: "no_active_state" };
  }
  const transcript = await findTranscript(options.home, options.sessionId);
  if (!transcript) {
    return { projected: false, reason: "transcript_unavailable" };
  }

  const ledger = await readLedger(options.ledgerFile, { cursor: {}, seen: {}, epochs: {}, sequence: 0 });
  const update = await readNewJsonl(transcript, ledger.cursor ?? {});
  ledger.cursor = { path: update.path, offset: update.offset };
  ledger.seen ??= {};
  const newEntries = [];
  for (const entry of parseAssistantUsageJsonl(update.text)) {
    if (ledger.seen[entry.id]) continue;
    ledger.seen[entry.id] = true;
    newEntries.push(entry);
  }
  if (newEntries.length === 0) {
    await writeLedger(options.ledgerFile, ledger, String(epoch));
    return { projected: false, reason: "no_new_usage" };
  }

  const epochKey = String(epoch);
  const prior = ledger.epochs?.[epochKey] ?? { usage: { ...EMPTY_USAGE }, model: "", timestamp: "" };
  const delta = newEntries.reduce((total, entry) => addUsage(total, entry.usage), { ...EMPTY_USAGE });
  const latest = newEntries.at(-1);
  const cumulative = addUsage(prior.usage, delta);
  ledger.epochs[epochKey] = { usage: cumulative, model: latest.model, timestamp: latest.timestamp };
  ledger.sequence = number(ledger.sequence) + 1;
  const budget = {
    run_id: runId,
    state: state.state,
    state_epoch: epoch,
    provider: "anthropic",
    model: latest.model,
    effort: "",
    precision: "exact",
    token_usage: cumulative,
    token_attribution: { reported_reasoning_output_tokens: 0 },
    context_budget_bytes: number(state.context_budget_bytes),
  };
  const event = {
    event_id: eventId(runId, epoch, ledger.sequence, cumulative),
    run_id: runId,
    run_session_id: state.run_session_id ?? "",
    thread_id: options.threadId,
    workflow: state.workflow ?? "",
    event: "provider_token_usage",
    state: state.state,
    provider: "anthropic",
    source: "claude_transcript",
    precision: "exact",
    timestamp: latest.timestamp,
    sequence: ledger.sequence,
    model: latest.model,
    token_usage_delta: delta,
    state_budget: budget,
  };
  await enqueueDelivery(options.deliveryDir, event);
  // Persist the delivery record before advancing the transcript cursor. A
  // crash between these files may replay an idempotent event, but cannot lose
  // one. This outbox lives outside session cleanup.
  await writeLedger(options.ledgerFile, ledger, epochKey);
  return { projected: true, event };
}

export async function projectClaudeTranscriptUsage(options) {
  options = scopedOptions(options);
  await mkdir(dirname(options.ledgerFile), { recursive: true, mode: 0o700 });
  const release = await acquireLedgerLock(options.ledgerFile);
  let result;
  try {
    result = await projectClaudeTranscriptUsageLocked(options);
  } finally {
    await release();
  }
  // Network delivery is deliberately outside the cursor/sequence lock.
  await deliverPending(options);
  return result;
}

function parseArgs(argv) {
  const options = {
    home: process.env.HOME,
    pbUrl: process.env.STATEWRIGHT_PB_URL,
    gatewayUrl: process.env.STATEWRIGHT_GATEWAY_URL,
    apiKey: process.env.STATEWRIGHT_TELEMETRY_API_KEY,
  };
  const flags = new Map([
    ["--session-id", "sessionId"], ["--thread-id", "threadId"], ["--state-file", "stateFile"],
    ["--epoch-file", "epochFile"], ["--ledger-file", "ledgerFile"], ["--delivery-dir", "deliveryDir"], ["--run-id-file", "runIdFile"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--delivery-only" || argv[index] === "--baseline-only") {
      if (argv[index] === "--baseline-only") options.baselineOnly = true;
      options.deliveryOnly = true;
      continue;
    }
    const key = flags.get(argv[index]);
    if (!key || !argv[index + 1]) throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
    options[key] = argv[++index];
  }
  const required = options.baselineOnly
    ? ["sessionId", "ledgerFile", "home"]
    : options.deliveryOnly
    ? ["deliveryDir", "pbUrl", "gatewayUrl", "apiKey"]
    : ["sessionId", "threadId", "stateFile", "epochFile", "ledgerFile", "deliveryDir", "home", "pbUrl", "gatewayUrl", "apiKey"];
  for (const key of required) {
    if (!options[key]) throw new Error(`${key} is required`);
  }
  return options;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2));
  const operation = options.baselineOnly
    ? baselineClaudeTranscriptUsage(options)
    : options.deliveryOnly
    ? drainClaudeTelemetry(options)
    : projectClaudeTranscriptUsage(options);
  operation
    .then((result) => {
      process.stdout.write(`${JSON.stringify({ projected: result.projected === true, baselined: result.baselined === true, reason: result.reason ?? "" })}\n`);
    })
    .catch((error) => {
      process.stderr.write(`[statewright] Claude transcript telemetry: ${error.message}\n`);
      process.exitCode = 1;
    });
}
