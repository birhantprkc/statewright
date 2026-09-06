#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { bootstrapManagedClients, installManagedClientShim, managedClientChildEnvironment, managedClientEnabled, runManagedClient, setManagedClientEnabled, uninstallManagedClients } from "./lib/managed-client-supervisor.mjs";
import { createErrorReporter, isExpectedExit, isExpectedPluginError } from "./lib/error-reporting.mjs";

const launcherPath = fileURLToPath(import.meta.url);

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
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function usage() {
  return "Usage: statewright-managed-client --host codex|claude --real-bin PATH -- [client args]\n       statewright-managed-client --bootstrap\n       statewright-managed-client --uninstall\n       statewright-managed-client --install --enable --host codex|claude [--real-bin PATH]\n       statewright-managed-client --disable --host codex|claude";
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const reporter = createErrorReporter({ plugin: options.host === "claude" ? "claude-code" : "codex", version: "0.3.1" });
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
    const reporter = createErrorReporter({ plugin: "managed-client", version: "0.3.1" });
    if (!isExpectedPluginError(error)) await reporter.report(error, { mechanism: "entrypoint", operation: "managed_client" });
    process.stderr.write(`[statewright] ${error.message}\n`);
    process.exitCode = 2;
  });
}
