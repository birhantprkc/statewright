import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const STORE_FILE = "managed-client-session-ids.json";
export const CODEX_ROOT_SESSION_FILE = "codex-root-session.json";
const CODEX_OPTIONS_WITH_VALUE = new Set([
  "-a", "--ask-for-approval", "-C", "--cd", "-c", "--config",
  "--disable", "--enable", "--local-provider", "-m", "--model",
  "-p", "--profile", "--remote", "--remote-auth-token-env",
  "-s", "--sandbox", "--add-dir",
]);
const CODEX_TOP_LEVEL_COMMANDS = new Set([
  "agents", "app", "app-server", "apply", "archive", "cloud", "completion", "debug", "delete",
  "doctor", "e", "exec", "exec-server", "features", "fork", "help", "login", "logout", "mcp",
  "mcp-server", "migrate-rollouts", "plugin", "queue", "remote-control", "resume", "review", "sandbox",
  "unarchive", "update",
]);

function codexTopLevelCommandIndex(args) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") return -1;
    if (argument.startsWith("-") && argument.includes("=")) continue;
    if (argument === "-i" || argument === "--image") {
      while (index + 1 < args.length) {
        const candidate = args[index + 1];
        if (candidate === "--" || candidate.startsWith("-") || CODEX_TOP_LEVEL_COMMANDS.has(candidate)) break;
        index += 1;
      }
      continue;
    }
    if (CODEX_OPTIONS_WITH_VALUE.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) continue;
    return CODEX_TOP_LEVEL_COMMANDS.has(argument) ? index : -1;
  }
  return -1;
}

function opaqueId() {
  return `swc_${randomUUID().replaceAll("-", "")}`;
}

function deterministicResumeId(host, sessionId) {
  const digest = createHash("sha256")
    .update(`${host}-thread:${sessionId}`)
    .digest("hex")
    .slice(0, 32);
  return `swc_${digest}`;
}

function validId(value) {
  return typeof value === "string" && /^swc_[a-f0-9]{32}$/.test(value);
}

export function resumedSessionId(host, args) {
  if (host === "codex") {
    const index = codexTopLevelCommandIndex(args);
    if (index < 0) return null;
    if (args[index] !== "resume") return null;
    for (let argumentIndex = index + 1; argumentIndex < args.length; argumentIndex += 1) {
      const argument = args[argumentIndex];
      if (argument === "--last") return null;
      if (argument === "--") return args[argumentIndex + 1] ?? null;
      if (argument.startsWith("-") && argument.includes("=")) continue;
      if (CODEX_OPTIONS_WITH_VALUE.has(argument)) {
        argumentIndex += 1;
        continue;
      }
      if (argument.startsWith("-")) continue;
      return argument;
    }
    return null;
  }
  if (host === "claude") {
    for (let index = 0; index < args.length; index += 1) {
      if (["--resume", "-r", "--session-id"].includes(args[index])) return args[index + 1] ?? null;
    }
  }
  return null;
}

export async function readCodexRootSession(controlDir, expectedClientId = null) {
  try {
    const registration = JSON.parse(await readFile(join(controlDir, CODEX_ROOT_SESSION_FILE), "utf8"));
    if (registration?.version !== 1 || typeof registration.session_id !== "string" || !registration.session_id.trim()) return null;
    if (!validId(registration.client_id)) return null;
    if (expectedClientId && registration.client_id !== expectedClientId) return null;
    return { sessionId: registration.session_id.trim(), clientId: registration.client_id };
  } catch {
    return null;
  }
}

export async function resetCodexRootSession(controlDir, { sessionId = null, clientId } = {}) {
  const path = join(controlDir, CODEX_ROOT_SESSION_FILE);
  await unlink(path).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  if (!sessionId) return null;
  if (!validId(clientId)) throw new Error("Statewright Codex root registration requires a valid managed client identity.");
  const registration = { version: 1, session_id: sessionId, client_id: clientId };
  await writeFile(path, `${JSON.stringify(registration)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
  return registration;
}

export function codexRouteOwnsRoot(request, registration) {
  if (!registration) return false;
  const requestSessionId = String(request?.session_id ?? "").trim();
  const declaredRoot = String(request?.root_session_id ?? "").trim();
  return request?.client_id === registration.clientId
    && requestSessionId === registration.sessionId
    && (!declaredRoot || declaredRoot === registration.sessionId);
}

function storePath(home) {
  return join(home, ".statewright", STORE_FILE);
}

async function loadStore(home) {
  try {
    const parsed = JSON.parse(await readFile(storePath(home), "utf8"));
    return parsed && typeof parsed === "object" && typeof parsed.bindings === "object"
      ? parsed
      : { version: 1, bindings: {} };
  } catch {
    return { version: 1, bindings: {} };
  }
}

async function saveStore(home, store) {
  const path = storePath(home);
  await mkdir(join(home, ".statewright"), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function bindingKey(host, sessionId) {
  return `${host}:${sessionId}`;
}

export async function resolveManagedClientIdentity({ host, args, home = homedir() }) {
  const sessionId = resumedSessionId(host, args);
  if (!sessionId) return { clientId: opaqueId(), sessionId: null, restored: false };
  const store = await loadStore(home);
  const restored = store.bindings[bindingKey(host, sessionId)];
  if (validId(restored)) return { clientId: restored, sessionId, restored: true };
  const clientId = deterministicResumeId(host, sessionId);
  store.bindings[bindingKey(host, sessionId)] = clientId;
  await saveStore(home, store);
  return { clientId, sessionId, restored: false };
}

export async function bindManagedClientIdentity({ host, sessionId, clientId, home = homedir() }) {
  if (!sessionId || !validId(clientId)) return false;
  const store = await loadStore(home);
  const key = bindingKey(host, sessionId);
  if (store.bindings[key] === clientId) return true;
  if (store.bindings[key] && store.bindings[key] !== clientId) {
    throw new Error(`Statewright managed identity conflict for ${host} session '${sessionId}'.`);
  }
  store.bindings[key] = clientId;
  await saveStore(home, store);
  return true;
}

export async function writeManagedControlIdentity(controlDir, { host, clientId }) {
  const path = join(controlDir, "identity.json");
  await writeFile(path, `${JSON.stringify({ version: 1, host, client_id: clientId })}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}
