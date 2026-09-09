#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { bootstrapManagedClients, installManagedClientShim, managedClientChildEnvironment, managedClientEnabled, runManagedClient, setManagedClientEnabled, uninstallManagedClients } from "./lib/managed-client-supervisor.mjs";
import { createErrorReporter, isExpectedExit, isExpectedPluginError } from "./lib/error-reporting.mjs";

const launcherPath = fileURLToPath(import.meta.url);

function managedClientVersion(argv = process.argv.slice(2)) {
  const hostIndex = argv.indexOf("--host");
  return hostIndex >= 0 && argv[hostIndex + 1] === "claude" ? "0.3.1" : "0.3.2";
}

function parseArgs(argv) {
  const options = { args: [] };
  let commandArgs = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (commandArgs) { options.args.push(arg); continue; }
    if (arg === "--") { commandArgs = true; continue; }
    if (arg === "--host") options.host = argv[++index];
    else if (arg === "--real-bin") options.realBin = argv[++index];
    else if (arg === "--install") options.install = true;
    else if (arg === "--enable") options.enable = true;
    else if (arg === "--disable") options.disable = true;
    else if (arg === "--shell-init") options.shellInit = true;
    else if (arg === "--bootstrap") options.bootstrap = true;
    else if (arg === "--uninstall") options.uninstall = true;
    else if (arg === "--kill-app-server") options.killAppServer = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function usage() {
  return "Usage: statewright-managed-client --host codex|claude --real-bin PATH -- [client args]\n       statewright-managed-client --bootstrap\n       statewright-managed-client --uninstall\n       statewright-managed-client --install --enable --host codex|claude [--real-bin PATH]\n       statewright-managed-client --disable --host codex|claude";
}

async function killProjectAppServers({ cwd = process.cwd(), home = homedir(), all = false } = {}) {
  const root = join(home, ".statewright", "codex-app-server");
  const matches = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    try {
      const manifestPath = join(root, entry.name, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if ((manifest.cwd === cwd || manifest.threadListCwd === cwd) && Number.isInteger(manifest.pid)) matches.push({ ...manifest, manifestPath });
    } catch {}
  }
  if (!matches.length) { process.stdout.write(`[statewright] no managed App Server found for ${cwd}\n`); return; }
  let selected = matches;
  if (matches.length > 1 && !all) {
    process.stderr.write(`${matches.map((item, index) => `${index + 1}) pid=${item.pid} client=${item.clientId ?? "unknown"}`).join("\n")}\nKill one (number) or all (a)? [N] `);
    const answer = await new Promise((resolveAnswer) => process.stdin.once("data", (chunk) => resolveAnswer(String(chunk).trim().toLowerCase())));
    if (answer === "a" || answer === "all") selected = matches;
    else { const index = Number.parseInt(answer, 10) - 1; selected = Number.isInteger(index) && matches[index] ? [matches[index]] : []; }
  }
  if (!selected.length) return;
  if (selected.length === 1) {
    process.stderr.write(`Kill managed App Server pid=${selected[0].pid} for ${cwd}? [y/N] `);
    const answer = await new Promise((resolveAnswer) => process.stdin.once("data", (chunk) => resolveAnswer(String(chunk).trim().toLowerCase())));
    if (answer !== "y" && answer !== "yes") return;
  }
  const killed = [];
  for (const item of selected) { try { process.kill(item.pid, "SIGTERM"); killed.push(item.pid); } catch (error) { if (error?.code !== "ESRCH") throw error; } }
  process.stdout.write(`${JSON.stringify({ cwd, killed, count: killed.length })}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const reporter = createErrorReporter({
    plugin: options.host === "claude" ? "claude-code" : "codex",
    version: managedClientVersion(),
  });
  reporter.installProcessHandlers();
  if (options.help) return process.stdout.write(`${usage()}\n`);
  if (options.bootstrap) {
    process.stdout.write(`${JSON.stringify(await bootstrapManagedClients({ launcherPath }))}\n`);
    return;
  }
  if (options.uninstall) {
    process.stdout.write(`${JSON.stringify(await uninstallManagedClients())}\n`);
    return;
  }
  if (options.killAppServer) {
    await killProjectAppServers({ cwd: process.cwd(), all: options.all });
    return;
  }
  if (options.shellInit) {
    process.stdout.write(process.platform === "win32"
      ? '$env:Path = "$HOME\\.statewright\\bin;$env:Path"\n'
      : 'export PATH="$HOME/.statewright/bin:$PATH"\n');
    return;
  }
  if (!["codex", "claude"].includes(options.host)) throw new Error("--host must be codex or claude.");
  if (options.enable && options.disable) throw new Error("Choose either --enable or --disable.");
  if (options.install) {
    const installed = await installManagedClientShim({ host: options.host, launcherPath, realBinary: options.realBin });
    if (options.enable) await setManagedClientEnabled(options.host, true);
    process.stdout.write(`${installed.shimPath}\n`);
    return;
  }
  if (options.enable || options.disable) {
    const path = await setManagedClientEnabled(options.host, options.enable);
    process.stdout.write(`${path}\n`);
    return;
  }
  if (!options.realBin) throw new Error("--real-bin is required when launching a managed client.");
  if (await managedClientEnabled(options.host)) {
    process.exitCode = await runManagedClient({ host: options.host, command: options.realBin, args: options.args, reporter });
    return;
  }
  const child = spawn(options.realBin, options.args, {
    stdio: "inherit",
    env: managedClientChildEnvironment({ host: options.host }),
    cwd: process.cwd(),
    shell: process.platform === "win32",
  });
  const result = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code: code ?? 1, signal }));
  });
  if (!isExpectedExit(result)) await reporter.report(new Error(`Unmanaged ${options.host} client exited unexpectedly.`), {
    mechanism: "child_exit", host: options.host, operation: "unmanaged_client", exit_code: result.code, signal: result.signal,
  });
  process.exitCode = result.code;
}

if (process.argv[1] && resolve(process.argv[1]) === launcherPath) {
  main().catch(async (error) => {
    const reporter = createErrorReporter({ plugin: "managed-client", version: managedClientVersion() });
    if (!isExpectedPluginError(error)) await reporter.report(error, { mechanism: "entrypoint", operation: "managed_client" });
    process.stderr.write(`[statewright] ${error.message}\n`);
    process.exitCode = 2;
  });
}
