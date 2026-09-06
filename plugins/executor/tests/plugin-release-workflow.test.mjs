import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);
const { requirePluginCanaries } = require(resolve(root, ".github/scripts/require-plugin-canaries.cjs"));
const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";

function githubClient({ branchSha = SOURCE_SHA, runs = {} } = {}) {
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
      },
    },
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
  const windowsCanary = await readFile(
    resolve(root, ".github/workflows/windows-plugin-canary.yml"),
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
  assert.match(workflow, /body_path: "\${{ steps\.plugin\.outputs\.notes_path }}"/);
  assert.doesNotMatch(workflow, /generate_release_notes:/);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /require\("\.\/\.github\/scripts\/require-plugin-canaries\.cjs"\)/);
  assert.match(workflow, /await requirePluginCanaries\(/);
  assert.match(windowsCanary, /push:\n\s+branches: \[main\]/);
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
      /Windows bootstrap has no successful run/,
    );
  }
});
