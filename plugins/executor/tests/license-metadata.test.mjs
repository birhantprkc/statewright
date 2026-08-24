import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pluginsRoot = new URL("../../", import.meta.url);
const expectedLicenses = {
  codex: "FSL-1.1-ALv2",
  executor: "FSL-1.1-ALv2",
  omx: "FSL-1.1-ALv2",
  opencode: "Apache-2.0",
  pi: "FSL-1.1-ALv2",
};

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, pluginsRoot), "utf8"));
}

test("plugin package metadata matches the declared component license", async () => {
  for (const [packageDir, expectedLicense] of Object.entries(expectedLicenses)) {
    const manifest = await readJson(`${packageDir}/package.json`);
    const lockfile = await readJson(`${packageDir}/package-lock.json`);
    const lockRoot = lockfile.packages?.[""];

    assert.equal(manifest.license, expectedLicense, `${packageDir} package license`);
    assert.equal(lockRoot?.license, expectedLicense, `${packageDir} lockfile license`);
    assert.equal(lockRoot?.name, manifest.name, `${packageDir} lockfile package name`);
    assert.equal(lockRoot?.version, manifest.version, `${packageDir} lockfile version`);
  }

  const claudePlugin = await readJson("claude-code/plugin.json");
  assert.equal(claudePlugin.license, expectedLicenses.codex, "claude-code plugin license");
});
