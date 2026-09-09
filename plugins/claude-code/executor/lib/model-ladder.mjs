const OPENAI_PROVIDER_ALIASES = new Set(["openai", "openai-codex"]);

function ladderEntries(request) {
  return Array.isArray(request?.model_ladder) ? request.model_ladder : [];
}

function candidateRequest(request, candidate) {
  const entry = typeof candidate === "string" ? { model: candidate } : candidate;
  if (!entry || typeof entry !== "object" || !String(entry.model ?? "").trim()) return null;
  // Workflow-authored ladder entries may select only route properties. The
  // enclosing request owns the managed-client and root-session identities.
  return {
    ...request,
    model: String(entry.model).trim(),
    effort: entry.thinking_level ?? entry.effort ?? request.effort,
    health_url: entry.health_url,
  };
}

export function providerModel(value) {
  const raw = String(value ?? "").trim();
  const slash = raw.indexOf("/");
  if (slash <= 0) return { provider: null, model: raw };
  const declaredProvider = raw.slice(0, slash).trim();
  return {
    provider: OPENAI_PROVIDER_ALIASES.has(declaredProvider.toLowerCase()) ? "openai" : declaredProvider,
    model: raw.slice(slash + 1).trim(),
  };
}

export function selectRouteForProvider(request, activeProvider) {
  const provider = providerModel(`${String(activeProvider ?? "").trim()}/_`).provider;
  if (!provider) return request;
  const candidates = ladderEntries(request)
    .map((candidate) => candidateRequest(request, candidate))
    .filter(Boolean);
  if (candidates.length === 0) {
    const declared = providerModel(request?.model).provider;
    if (!declared || declared === provider) return request;
    throw new Error(`Statewright route provider '${declared}' does not match active Codex thread provider '${provider}'. Use restart transport or add a '${provider}' model_ladder entry.`);
  }
  const exact = candidates.find((candidate) => providerModel(candidate.model).provider === provider);
  if (exact) return exact;
  const inherited = candidates.find((candidate) => providerModel(candidate.model).provider === null);
  if (inherited) return inherited;
  throw new Error(`Statewright model_ladder has no route for active Codex thread provider '${provider}'. Use restart transport or add an equivalent provider entry.`);
}

async function healthAvailable(url, fetchImpl, timeoutMs) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function selectAvailableRoute(request, {
  fetchImpl = fetch,
  timeoutMs = 800,
} = {}) {
  const candidates = ladderEntries(request)
    .map((candidate) => candidateRequest(request, candidate))
    .filter(Boolean);
  if (candidates.length === 0) return request;
  for (const candidate of candidates) {
    const healthUrl = String(candidate.health_url ?? "").trim();
    if (!healthUrl || await healthAvailable(healthUrl, fetchImpl, timeoutMs)) return candidate;
  }
  throw new Error("No Statewright model_ladder candidate passed its availability check.");
}
