import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startCodexAppServerRuntime } from "./codex-app-server-transport.mjs";
import { createErrorReporter, isExpectedPluginError } from "./error-reporting.mjs";
import { codexRouteOwnsRoot, readCodexRootSession, writeManagedControlIdentity } from "./managed-client-identity.mjs";
import { ManagedMcpBridge } from "./managed-mcp-bridge.mjs";
import { resolveApiKey } from "./remote-client.mjs";
import { createTelemetryWriter } from "./telemetry.mjs";

const EXECUTOR_ROOT = dirname(fileURLToPath(import.meta.url));
const RESIDENT_ENTRYPOINT = join(EXECUTOR_ROOT, "codex-app-server-resident.mjs");
const RESIDENT_RUNTIME_FILES = [
  RESIDENT_ENTRYPOINT,
  join(EXECUTOR_ROOT, "codex-app-server-transport.mjs"),
  join(EXECUTOR_ROOT, "codex-app-server-route-proxy.mjs"),
  join(EXECUTOR_ROOT, "model-ladder.mjs"),
  join(EXECUTOR_ROOT, "error-reporting.mjs"),
  join(EXECUTOR_ROOT, "managed-client-identity.mjs"),
];

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 96);
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function residentRoot(home, clientId) {
  return join(home, ".statewright", "codex-app-server", safeName(clientId));
}

export function residentControlDir(home, clientId) {
  return join(residentRoot(home, clientId), "routes");
}

export function residentProviderHandoffPath(home, clientId) {
  return join(residentRoot(home, clientId), "provider-handoff.json");
}

export function residentThreadAttachmentPath(home, clientId, launchNonce = null) {
  const suffix = launchNonce ? `.${safeName(launchNonce)}` : "";
  return join(residentRoot(home, clientId), `thread-attachment${suffix}.json`);
}

export async function clearResidentThreadAttachment(home, clientId, launchNonce = null) {
  await unlink(residentThreadAttachmentPath(home, clientId, launchNonce)).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

export async function readResidentThreadAttachment(home, clientId, residentPid, launchNonce = null) {
  const attachment = await readManifest(residentThreadAttachmentPath(home, clientId, launchNonce));
  return attachment?.version === 1 && attachment.residentPid === residentPid ? attachment : null;
}

async function readManifest(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

export async function residentRuntimeRevision() {
  const sources = await Promise.all(RESIDENT_RUNTIME_FILES.map((path) => readFile(path, "utf8")));
  return createHash("sha256").update(sources.join("\n--- statewright resident module ---\n")).digest("hex").slice(0, 16);
}

export function residentMatchesRuntime(manifest, runtimeRevision, threadListCwd = undefined, profile = undefined) {
  if (manifest?.runtimeRevision !== runtimeRevision) return false;
  if (threadListCwd !== undefined && (manifest.threadListCwd ?? null) !== threadListCwd) return false;
  return profile === undefined || (manifest.profile ?? null) === profile;
}

async function ready(manifest, runtimeRevision, threadListCwd, profile) {
  if (!residentMatchesRuntime(manifest, runtimeRevision, threadListCwd, profile) || !manifest?.pid || !processAlive(manifest.pid) || !manifest.proxyUrl) return false;
  try {
    return (await fetch(`${manifest.proxyUrl.replace(/^ws/, "http")}/readyz`, { signal: AbortSignal.timeout(400) })).ok;
  } catch { return false; }
}

async function writeManifest(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function writeResidentProviderHandoff(home, clientId, handoff) {
  const transaction = await stageResidentProviderHandoff(home, clientId, handoff);
  await transaction.publish();
}

export async function stageResidentProviderHandoff(home, clientId, handoff) {
  const root = residentRoot(home, clientId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = residentProviderHandoffPath(home, clientId);
  const transactionId = randomUUID();
  const stagedPath = `${path}.${process.pid}.${transactionId}.pending`;
  const publishedPath = join(root, `${Date.now()}-${transactionId}.provider-handoff.json`);
  await writeFile(stagedPath, `${JSON.stringify({
    version: 1,
    clientId,
    transactionId,
    ...handoff,
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  let settled = false;
  return {
    async publish() {
      if (settled) return;
      // Every selection is published as its own durable queue entry. A second
      // picker write can no longer overwrite an earlier durable handoff.
      await rename(stagedPath, publishedPath);
      settled = true;
    },
    async discard() {
      if (settled) return;
      await unlink(stagedPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      settled = true;
    },
  };
}

export async function takeResidentProviderHandoff(home, clientId) {
  const root = residentRoot(home, clientId);
  const entries = await readdir(root).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const staleInflight = entries.filter((name) => {
    const match = name.match(/(?:^|\.)provider-handoff\.json\.(\d+)\.[^.]+\.inflight$/);
    return match && !processAlive(Number(match[1]));
  }).sort();
  const stalePending = entries.filter((name) => {
    const match = name.match(/^provider-handoff\.json\.(\d+)\.[^.]+\.pending$/);
    return match && !processAlive(Number(match[1]));
  }).sort();
  const visible = [
    ...(entries.includes("provider-handoff.json") ? ["provider-handoff.json"] : []),
    ...entries.filter((name) => name.endsWith(".provider-handoff.json") && name !== "provider-handoff.json").sort(),
  ];
  for (const name of [...staleInflight, ...stalePending, ...visible]) {
    const path = join(root, name);
    const reservationPath = join(root, `${Date.now()}-${randomUUID()}.provider-handoff.json.${process.pid}.${randomUUID()}.inflight`);
    try {
      // Re-claim orphaned inflights as well as visible entries. Merely reading
      // a dead owner's path lets two recovering supervisors consume it.
      await rename(path, reservationPath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const retryPath = join(root, `${Date.now()}-${randomUUID()}.provider-handoff.json`);
    let settled = false;
    const ack = async () => {
      if (settled) return;
      await unlink(reservationPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      settled = true;
    };
    const release = async () => {
      if (settled) return;
      await rename(reservationPath, retryPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      settled = true;
    };
    try {
      const handoff = await readManifest(reservationPath);
      if (!handoff || handoff.clientId !== clientId || handoff.version !== 1) {
        await ack();
        continue;
      }
      return { handoff, ack, release };
    } catch (error) {
      await release().catch(() => {});
      throw error;
    }
  }
  return null;
}

export async function nextCodexResidentRouteRequest(controlDir, clientId, threadId = null, {
  renameImpl = rename,
  unlinkImpl = unlink,
} = {}) {
  const entries = await readdir(controlDir);
  const staleInflight = entries.filter((name) => {
    const match = name.match(/^(.*route\.json)\.(\d+)\.[^.]+\.inflight$/);
    return match && !processAlive(Number(match[2]));
  }).sort();
  const visible = entries.filter((name) => name === "route.json" || name.endsWith(".route.json")).sort();
  for (const name of [...staleInflight, ...visible]) {
    const path = join(controlDir, name);
    const alreadyInflight = name.endsWith(".inflight");
    const originalPath = alreadyInflight
      ? join(controlDir, name.match(/^(.*route\.json)\.\d+\.[^.]+\.inflight$/)?.[1] ?? "route.json")
      : path;
    const reservationPath = `${originalPath}.${process.pid}.${randomUUID()}.inflight`;
    try {
      await renameImpl(path, reservationPath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const retryPath = `${originalPath}.${randomUUID()}.retry.route.json`;
    let settled = false;
    const ack = async () => {
      if (settled) return;
      try {
        await unlinkImpl(reservationPath);
        settled = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        settled = true;
      }
    };
    const release = async () => {
      if (settled) return;
      try {
        await renameImpl(reservationPath, retryPath);
        settled = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        settled = true;
      }
    };
    try {
      const request = JSON.parse(await readFile(reservationPath, "utf8"));
      const registration = await readCodexRootSession(controlDir, clientId);
      if (codexRouteOwnsRoot(request, registration)) {
        if (threadId && request.session_id !== threadId) {
          await release();
          return null;
        }
        return { route: request, ack, release };
      }
      await ack();
      process.stderr.write("[statewright] discarded route request outside the attached Codex root session.\n");
    } catch (error) {
      await release().catch(() => {});
      throw error;
    }
  }
  return null;
}

function telemetryWriter(environment) {
  const explicit = environment.STATEWRIGHT_TELEMETRY_URL?.trim();
  const pocketbase = environment.STATEWRIGHT_PB_URL?.replace(/\/$/, "");
  return createTelemetryWriter(undefined, {
    endpoint: explicit || (pocketbase ? `${pocketbase}/api/gateway/telemetry/events` : null),
    apiKey: environment.STATEWRIGHT_API_KEY ?? null,
  });
}

async function createManagedMcpBridge({ environment, clientId }) {
  const bridge = new ManagedMcpBridge({
    gatewayUrl: environment.STATEWRIGHT_GATEWAY_URL ?? "https://mcp.statewright.ai",
    apiKey: await resolveApiKey(environment),
    clientId,
  });
  await bridge.start();
  return bridge;
}

export async function ensureCodexAppServerResident({ command, commandArgs = [], cwd, environment = process.env, home = homedir(), clientId, threadListCwd = null, profile = null, resumeRoute = null }) {
  const root = residentRoot(home, clientId);
  const manifestPath = join(root, "manifest.json");
  const runtimeRevision = await residentRuntimeRevision();
  const existing = await readManifest(manifestPath);
  if (await ready(existing, runtimeRevision, threadListCwd, profile)) return existing;
  if (existing?.pid && processAlive(existing.pid)) {
    throw new Error(
      `Statewright Codex App Server resident ${existing.pid} is still running with a different runtime or resume scope. `
      + "It may be preserving detached work; exit it or wait for it to become idle, then retry.",
    );
  }
  await unlink(manifestPath).catch(() => {});
  await mkdir(root, { recursive: true, mode: 0o700 });
  const logHandle = await open(join(root, "resident.log"), "a", 0o600);
  const child = spawn(process.execPath, [
    RESIDENT_ENTRYPOINT,
    "--client-id", clientId,
    "--command", command,
    "--command-args", JSON.stringify(commandArgs),
    "--cwd", cwd,
    "--home", home,
    "--thread-list-cwd", threadListCwd ?? "",
    "--profile", profile ?? "",
    "--provider", resumeRoute?.provider ?? "",
    "--model", resumeRoute?.model ?? "",
    "--effort", resumeRoute?.effort ?? "",
  ], {
    cwd,
    env: { ...environment, STATEWRIGHT_CODEX_RESIDENT_ROOT: root },
    detached: true,
    stdio: ["ignore", logHandle.fd, logHandle.fd],
  });
  await logHandle.close();
  child.unref();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const manifest = await readManifest(manifestPath);
    if (await ready(manifest, runtimeRevision, threadListCwd, profile)) return manifest;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  const log = await readFile(join(root, "resident.log"), "utf8").catch(() => "");
  throw new Error(`Timed out waiting for the resident Statewright Codex App Server. ${log.slice(-1200).trim()}`);
}

async function main() {
  const values = Object.fromEntries(process.argv.slice(2).filter((_, index) => index % 2 === 0).map((key, index) => [key.replace(/^--/, ""), process.argv[(index * 2) + 3]]));
  const clientId = values["client-id"];
  const command = values.command;
  const commandArgs = JSON.parse(values["command-args"] || "[]");
  const cwd = values.cwd;
  const home = values.home ?? homedir();
  const threadListCwd = values["thread-list-cwd"] || null;
  const profile = values.profile || null;
  const resumeRoute = values.provider && values.model ? {
    provider: values.provider,
    model: values.model,
    effort: values.effort || null,
  } : null;
  const reporter = createErrorReporter({ plugin: "codex", version: "0.3.2" });
  reporter.installProcessHandlers();
  if (!clientId || !command || !cwd) throw new Error("resident requires client-id, command, and cwd");
  const root = process.env.STATEWRIGHT_CODEX_RESIDENT_ROOT ?? residentRoot(home, clientId);
  const controlDir = residentControlDir(home, clientId);
  const manifestPath = join(root, "manifest.json");
  await mkdir(controlDir, { recursive: true, mode: 0o700 });
  await unlink(residentThreadAttachmentPath(home, clientId)).catch(() => {});
  await writeManagedControlIdentity(controlDir, { host: "codex", clientId });
  const bridge = await createManagedMcpBridge({ environment: process.env, clientId });
  let runtime = null;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await runtime?.close();
    await bridge.close();
    await unlink(manifestPath).catch(() => {});
    process.exit(0);
  };
  runtime = await startCodexAppServerRuntime({
    command,
    commandArgs,
    cwd,
    home,
    clientId,
    environment: {
      ...process.env,
      STATEWRIGHT_ROUTE_CONTROL_DIR: controlDir,
      STATEWRIGHT_MANAGED_CLIENT_HOST: "codex",
      STATEWRIGHT_CLIENT_ID: clientId,
      STATEWRIGHT_MANAGED_MCP_URL: bridge.url,
      STATEWRIGHT_MANAGED_MCP_TOKEN: bridge.token,
    },
    nextRouteRequest: (threadId) => nextCodexResidentRouteRequest(controlDir, clientId, threadId),
    threadListCwd,
    profile,
    resumeRoute,
    prepareProviderHandoff: (handoff) => stageResidentProviderHandoff(home, clientId, handoff),
    onThreadAttached: (attachment) => writeManifest(residentThreadAttachmentPath(home, clientId, attachment.launchNonce), {
      version: 1,
      residentPid: process.pid,
      ...attachment,
      attachedAt: new Date().toISOString(),
    }),
    onIdle: stop,
    telemetry: telemetryWriter(process.env),
    reporter,
  });
  await writeManifest(manifestPath, {
    version: 2,
    pid: process.pid,
    clientId,
    proxyUrl: runtime.proxyUrl,
    appServerPid: runtime.appServerPid,
    runtimeRevision: await residentRuntimeRevision(),
    threadListCwd,
    profile,
    provider: resumeRoute?.provider ?? "openai",
    startedAt: new Date().toISOString(),
  });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (process.argv[1] && resolve(process.argv[1]) === RESIDENT_ENTRYPOINT) {
  main().catch(async (error) => {
    const reporter = createErrorReporter({ plugin: "codex", version: "0.3.2" });
    if (!isExpectedPluginError(error)) await reporter.report(error, { mechanism: "entrypoint", operation: "resident_app_server" });
    process.stderr.write(`[statewright] resident App Server failed: ${error.message}\n`);
    process.exitCode = 2;
  });
}
