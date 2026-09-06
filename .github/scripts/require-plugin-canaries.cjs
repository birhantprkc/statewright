"use strict";

const REQUIRED_WORKFLOWS = Object.freeze([
  { workflowId: "plugin-production-canary.yml", label: "macOS/Linux production matrix" },
  { workflowId: "windows-plugin-canary.yml", label: "Windows bootstrap" },
]);

async function requirePluginCanaries({ github, context, core, sourceSha }) {
  if (!sourceSha) throw new Error("Release source SHA is required.");
  const branch = await github.rest.repos.getBranch({
    owner: context.repo.owner,
    repo: context.repo.repo,
    branch: "main",
  });
  if (branch.data.commit.sha !== sourceSha) {
    throw new Error(`Release tag commit ${sourceSha} is not current main ${branch.data.commit.sha}.`);
  }

  const evidence = [];
  for (const requirement of REQUIRED_WORKFLOWS) {
    const { data } = await github.rest.actions.listWorkflowRuns({
      owner: context.repo.owner,
      repo: context.repo.repo,
      workflow_id: requirement.workflowId,
      head_sha: sourceSha,
      status: "completed",
      per_page: 100,
    });
    const passed = data.workflow_runs.find((run) =>
      run.conclusion === "success"
      && (run.event === "push" || run.event === "workflow_dispatch"));
    if (!passed) {
      throw new Error(`${requirement.label} has no successful run for ${sourceSha}.`);
    }
    core.info(`${requirement.label}: ${passed.html_url}`);
    evidence.push({ workflowId: requirement.workflowId, runId: passed.id, url: passed.html_url });
  }
  return evidence;
}

module.exports = { REQUIRED_WORKFLOWS, requirePluginCanaries };
