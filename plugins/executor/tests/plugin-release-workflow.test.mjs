import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);
const { REQUIRED_WORKFLOWS, requirePluginCanaries } = require(
  resolve(root, ".github/scripts/require-plugin-canaries.cjs"),
);
const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";

function githubClient({ branchSha = SOURCE_SHA, jobs = successfulJobs(), runs = {} } = {}) {
  return {
    rest: {
      repos: {
        getBranch: async (request) => {
          assert.deepEqual(request, { owner: "statewright", repo: "statewright", branch: "main" });
          return { data: { commit: { sha: branchSha } } };
        },
      },
      actions: {
        listWorkflowRuns: async (request) => {
          assert.equal(request.owner, "statewright");
          assert.equal(request.repo, "statewright");
          assert.equal(request.head_sha, SOURCE_SHA);
          assert.equal(request.status, "completed");
          return { data: { workflow_runs: runs[request.workflow_id] ?? [] } };
        },
        listJobsForWorkflowRun: async (request) => {
          assert.equal(request.owner, "statewright");
          assert.equal(request.repo, "statewright");
          return { data: { jobs: jobs[request.run_id] ?? [] } };
        },
      },
    },
  };
}

function successfulJobs() {
  return {
    11: REQUIRED_WORKFLOWS[0].requiredJobs.map((name) => ({ name, conclusion: "success", steps: [] })),
    12: [{
      name: "Codex and Claude managed-client bootstrap",
      conclusion: "success",
      steps: [{ name: "Run authenticated production gateway canary", conclusion: "success" }],
    }],
  };
}

function successfulRuns(event = "push") {
  return {
    "plugin-production-canary.yml": [{ id: 11, event, conclusion: "success", html_url: "https://example.test/unix" }],
    "windows-plugin-canary.yml": [{ id: 12, event, conclusion: "success", html_url: "https://example.test/windows" }],
  };
}

test("plugin release workflow resolves distinct names and curated notes", async () => {
  const workflow = await readFile(resolve(root, ".github/workflows/plugin-release.yml"), "utf8");
  const unixCanary = await readFile(
    resolve(root, ".github/workflows/plugin-production-canary.yml"),
    "utf8",
  );
  const versionCanary = await readFile(
    resolve(root, ".github/workflows/plugin-version-canary.yml"),
    "utf8",
  );
  const windowsCanary = await readFile(
    resolve(root, ".github/workflows/windows-plugin-canary.yml"),
    "utf8",
  );
  const windowsRouteCanary = await readFile(
    resolve(root, "plugins/executor/tests/windows-managed-client-route-canary.mjs"),
    "utf8",
  );
  const codexManifest = JSON.parse(
    await readFile(resolve(root, "plugins/codex/.codex-plugin/plugin.json"), "utf8"),
  );
  const claudeManifest = JSON.parse(
    await readFile(resolve(root, "plugins/claude-code/plugin.json"), "utf8"),
  );
  const codexVersion = codexManifest.version.split("+")[0];
  const claudeVersion = claudeManifest.version;

  assert.equal(codexVersion, claudeVersion, "Codex and Claude must share the release-note version");
  await readFile(resolve(root, `docs/releases/${codexVersion}.md`), "utf8");

  assert.match(workflow, /release_name=Statewright Codex plugin \$version/);
  assert.match(workflow, /release_name=Statewright Claude Code plugin \$version/);
  assert.match(workflow, /notes_path=docs\/releases\/\$version\.md/);
  assert.match(workflow, /body_path: "\${{ needs\.package\.outputs\.notes_path }}"/);
  assert.doesNotMatch(workflow, /generate_release_notes:/);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /require\("\.\/\.github\/scripts\/require-plugin-canaries\.cjs"\)/);
  assert.match(workflow, /await requirePluginCanaries\(/);
  assert.match(workflow, /artifact-smoke:\n\s+needs: package/);
  assert.match(workflow, /name: Smoke packaged plugin against production/);
  assert.match(workflow, /uses: actions\/attest@v4/);
  assert.match(workflow, /attestations: write/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /STATEWRIGHT_PLUGIN_ROOT: \${{ runner\.temp }}\/plugin-candidate/);
  assert.match(workflow, /publish:\n\s+needs: \[package, artifact-smoke\]/);
  assert.match(windowsCanary, /push:\n\s+branches: \[main\]/);
  assert.match(windowsCanary, /name: Run managed-client bootstrap and route canaries\n\s+timeout-minutes: 3/);
  assert.match(
    windowsCanary,
    /name: Run authenticated production gateway canary\n\s+if: github\.event_name != 'pull_request'/,
  );
  assert.match(windowsCanary, /release_ref:/);
  assert.match(windowsCanary, /git merge-base --is-ancestor HEAD origin\/main/);
  assert.match(unixCanary, /release_ref:/);
  assert.match(unixCanary, /plugin: \${{ fromJSON\(/);
  assert.match(unixCanary, /git merge-base --is-ancestor HEAD origin\/main/);
  assert.doesNotMatch(unixCanary, /\bomp\b/);
  assert.match(versionCanary, /evidence_mode:/);
  assert.match(versionCanary, /release-artifact/);
  assert.match(versionCanary, /release_ref is not part of trusted main history/);
  assert.match(versionCanary, /codex:codex-v\*/);
  assert.match(versionCanary, /claude:claude-v\*/);
  assert.match(versionCanary, /gh attestation verify/);
  assert.match(
    versionCanary,
    /permissions:\n\s+attestations: read\n\s+contents: read/,
  );
  assert.match(versionCanary, /--signer-workflow/);
  assert.match(versionCanary, /--source-digest "\$SOURCE_SHA"/);
  assert.match(versionCanary, /--source-ref "refs\/tags\/\$RELEASE_REF"/);
  assert.match(versionCanary, /--deny-self-hosted-runners/);
  assert.doesNotMatch(versionCanary, /\bomp\b/);
  assert.match(windowsRouteCanary, /codex-root-session\.json/);
  assert.match(windowsRouteCanary, /root_session_id: "windows-route-session"/);
});

test("release gate accepts successful exact-commit hosted canaries", async () => {
  const messages = [];
  const evidence = await requirePluginCanaries({
    github: githubClient({ runs: successfulRuns() }),
    context: { repo: { owner: "statewright", repo: "statewright" } },
    core: { info: (message) => messages.push(message) },
    sourceSha: SOURCE_SHA,
  });
  assert.deepEqual(evidence.map((item) => item.runId), [11, 12]);
  assert.equal(messages.length, 2);
});

test("release gate rejects a tag that is not current main", async () => {
  await assert.rejects(
    requirePluginCanaries({
      github: githubClient({ branchSha: "ffffffffffffffffffffffffffffffffffffffff" }),
      context: { repo: { owner: "statewright", repo: "statewright" } },
      core: { info() {} },
      sourceSha: SOURCE_SHA,
    }),
    /is not current main/,
  );
});

test("release gate rejects missing, failed, and pull-request-only evidence", async () => {
  for (const windowsRuns of [
    [],
    [{ id: 12, event: "push", conclusion: "failure", html_url: "https://example.test/windows" }],
    [{ id: 12, event: "pull_request", conclusion: "success", html_url: "https://example.test/windows" }],
  ]) {
    const runs = successfulRuns();
    runs["windows-plugin-canary.yml"] = windowsRuns;
    await assert.rejects(
      requirePluginCanaries({
        github: githubClient({ runs }),
        context: { repo: { owner: "statewright", repo: "statewright" } },
        core: { info() {} },
        sourceSha: SOURCE_SHA,
      }),
      /Windows production\/bootstrap has no successful trusted push run/,
    );
  }
});

test("release gate rejects a false-green Unix matrix with a missing job", async () => {
  const jobs = successfulJobs();
  jobs[11] = jobs[11].slice(1);
  await assert.rejects(
    requirePluginCanaries({
      github: githubClient({ jobs, runs: successfulRuns() }),
      context: { repo: { owner: "statewright", repo: "statewright" } },
      core: { info() {} },
      sourceSha: SOURCE_SHA,
    }),
    /lacks successful job codex on ubuntu-24\.04/,
  );
});

test("release gate rejects a skipped Windows production step", async () => {
  const jobs = successfulJobs();
  jobs[12][0].steps[0].conclusion = "skipped";
  await assert.rejects(
    requirePluginCanaries({
      github: githubClient({ jobs, runs: successfulRuns() }),
      context: { repo: { owner: "statewright", repo: "statewright" } },
      core: { info() {} },
      sourceSha: SOURCE_SHA,
    }),
    /lacks successful step Run authenticated production gateway canary/,
  );
});

test("release gate ignores a newer incomplete push when complete evidence exists", async () => {
  const runs = successfulRuns();
  runs["plugin-production-canary.yml"] = [
    { id: 13, event: "push", conclusion: "success", html_url: "https://example.test/partial" },
    ...runs["plugin-production-canary.yml"],
  ];
  const jobs = successfulJobs();
  jobs[13] = jobs[11].slice(0, 1);
  const evidence = await requirePluginCanaries({
    github: githubClient({ jobs, runs }),
    context: { repo: { owner: "statewright", repo: "statewright" } },
    core: { info() {} },
    sourceSha: SOURCE_SHA,
  });
  assert.equal(evidence[0].runId, 11);
});

test("release gate never treats manual dispatches as release evidence", async () => {
  await assert.rejects(
    requirePluginCanaries({
      github: githubClient({ runs: successfulRuns("workflow_dispatch") }),
      context: { repo: { owner: "statewright", repo: "statewright" } },
      core: { info() {} },
      sourceSha: SOURCE_SHA,
    }),
    /no successful trusted push run/,
  );
});
