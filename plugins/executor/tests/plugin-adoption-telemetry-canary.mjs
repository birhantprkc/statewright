import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PLUGIN_EVENT_NAMES = Object.freeze({
  claude: "claude-code",
  codex: "codex",
  cursor: "cursor",
  omx: "omx",
  opencode: "opencode",
  pi: "pi",
});

function boundedIdentity(value) {
  return String(value ?? "unknown").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
}

export async function resolvePluginVersion(pluginRoot, plugin) {
  const manifestPaths = {
    claude: "plugins/claude-code/plugin.json",
    codex: "plugins/codex/.codex-plugin/plugin.json",
    cursor: "plugins/cursor/.cursor-plugin/plugin.json",
    omx: "plugins/omx/package.json",
    opencode: "plugins/opencode/package.json",
    pi: "plugins/pi/package.json",
  };
  const manifestPath = manifestPaths[plugin];
  if (!manifestPath) throw new Error(`Unsupported plugin telemetry canary: ${plugin}`);
  const manifest = JSON.parse(await readFile(resolve(pluginRoot, manifestPath), "utf8"));
  return plugin === "codex" ? manifest.version.split("+")[0] : manifest.version;
}

export function buildCanaryEvent({ plugin, apiKey, version, platform, runId, runAttempt }) {
  const eventPlugin = PLUGIN_EVENT_NAMES[plugin];
  if (!eventPlugin) throw new Error(`Unsupported plugin telemetry canary: ${plugin}`);
  if (!apiKey) throw new Error("STATEWRIGHT_API_KEY is required.");
  if (!version) throw new Error("Plugin version is required.");
  return {
    plugin: eventPlugin,
    event: "ci_canary",
    version,
    api_key: apiKey,
    platform: boundedIdentity(`github-${platform}-${runId}-${runAttempt}`),
  };
}

export async function submitCanaryEvent({ baseUrl, event, fetchImpl = fetch }) {
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/api/telemetry/plugin-event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(5_000),
  });
  let acknowledgement;
  try {
    acknowledgement = await response.json();
  } catch {
    acknowledgement = null;
  }
  if (!response.ok || acknowledgement?.ok !== true) {
    throw new Error(`Plugin adoption endpoint did not acknowledge the event (HTTP ${response.status}).`);
  }
  return acknowledgement;
}

async function main() {
  if (process.env.STATEWRIGHT_PLUGIN_PRODUCTION_CANARY !== "1") {
    throw new Error("Refusing live telemetry outside an explicit production canary.");
  }
  const [plugin, requestedVersion] = process.argv.slice(2);
  const version = requestedVersion || await resolvePluginVersion(
    process.env.STATEWRIGHT_PLUGIN_ROOT?.trim() || process.cwd(),
    plugin,
  );
  const event = buildCanaryEvent({
    plugin,
    version,
    apiKey: process.env.STATEWRIGHT_API_KEY,
    platform: process.env.RUNNER_OS ?? process.platform,
    runId: process.env.GITHUB_RUN_ID ?? "local",
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "1",
  });
  await submitCanaryEvent({
    baseUrl: process.env.STATEWRIGHT_PB_URL ?? "https://statewright.ai",
    event,
  });
  console.log(`[plugin-adoption-canary] ${plugin}: endpoint acknowledgement accepted`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
