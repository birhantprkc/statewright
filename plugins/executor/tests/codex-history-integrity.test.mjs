import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  guardCodexResumeHistory,
  inspectCodexHistory,
  resolveCodexHistoryStorage,
  withCodexWriterLock,
} from "../lib/codex-history-integrity.mjs";

const SESSION_ID = "01a0531f-2295-7852-b575-f9d4c2c1201b";

function codexTestEnvironment(overrides = {}) {
  const environment = { ...process.env };
  delete environment.CODEX_HOME;
  delete environment.CODEX_SQLITE_HOME;
  return { ...environment, ...overrides };
}

function record(ordinal, type, payload) {
  return JSON.stringify({ timestamp: "2026-08-30T00:00:00.000Z", ordinal, type, payload });
}

function legacyRecord(type, payload) {
  return JSON.stringify({ timestamp: "2026-08-30T00:00:00.000Z", type, payload });
}

async function writeRollout(home, lines) {
  const path = join(home, ".codex", "sessions", "2026", "08", "30", `rollout-2026-08-30T00-00-00-${SESSION_ID}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  return path;
}

function createProjectionAt(path) {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE thread_history_projection_state (
      thread_id TEXT PRIMARY KEY,
      next_rollout_byte_offset INTEGER NOT NULL,
      next_rollout_ordinal INTEGER NOT NULL
    );
    CREATE TABLE thread_items (thread_id TEXT NOT NULL, item_id TEXT NOT NULL);
    CREATE TABLE thread_turns (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL);
    CREATE TABLE thread_realtime_items (thread_id TEXT NOT NULL, item_id TEXT NOT NULL);
    CREATE TRIGGER thread_realtime_items_projection_cleanup
      AFTER DELETE ON thread_history_projection_state
      BEGIN DELETE FROM thread_realtime_items WHERE thread_id = OLD.thread_id; END;
  `);
  const ids = [SESSION_ID, "other-thread"];
  for (const id of ids) {
    database.prepare("INSERT INTO thread_history_projection_state VALUES (?, 100, 2)").run(id);
    database.prepare("INSERT INTO thread_items VALUES (?, ?)").run(id, `${id}-item`);
    database.prepare("INSERT INTO thread_turns VALUES (?, ?)").run(id, `${id}-turn`);
    database.prepare("INSERT INTO thread_realtime_items VALUES (?, ?)").run(id, `${id}-realtime`);
  }
  database.close();
  return path;
}

function createProjection(home) {
  return createProjectionAt(join(home, ".codex", "thread_history_1.sqlite"));
}

function waitForLine(child, expected) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${expected}`)), 2_000);
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes(`${expected}\n`)) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}

const duplicateSettingsRollout = () => [
  record(0, "session_meta", { id: SESSION_ID, history_mode: "paginated" }),
  record(1, "event_msg", { type: "token_count" }),
  record(1, "event_msg", { type: "thread_settings_applied", thread_settings: { model: "gpt-test" } }),
  record(2, "event_msg", { type: "task_complete" }),
];

test("inspection classifies only repeated restart settings as safely repairable", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-inspect-"));
  try {
    await writeRollout(home, duplicateSettingsRollout());
    const inspection = await inspectCodexHistory({ home, sessionId: SESSION_ID });
    assert.equal(inspection.status, "repairable");
    assert.equal(inspection.duplicateSettingsCount, 1);
    assert.equal(inspection.unknownAnomalies.length, 0);
    assert.equal(inspection.finalOrdinal, 2);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("legacy history retains native resume behavior without mutation or backup", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-legacy-"));
  const backupRoot = join(home, "backups");
  try {
    const rollout = await writeRollout(home, [
      legacyRecord("session_meta", { id: SESSION_ID, history_mode: "legacy" }),
      legacyRecord("event_msg", { type: "task_complete" }),
    ]);
    const before = await readFile(rollout, "utf8");
    const inspection = await inspectCodexHistory({ home, sessionId: SESSION_ID });
    assert.equal(inspection.status, "healthy");
    assert.equal(inspection.historyMode, "legacy");
    assert.equal(inspection.finalOrdinal, null);
    assert.deepEqual(inspection.unknownAnomalies, []);

    const result = await guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "guard", backupRoot, environment: codexTestEnvironment() });
    assert.deepEqual(result, { status: "not_applicable", historyMode: "legacy" });
    assert.equal(await readFile(rollout, "utf8"), before);
    await assert.rejects(access(backupRoot));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("legacy history still fails closed on identity or mixed-schema anomalies", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-legacy-unsafe-"));
  try {
    const rollout = await writeRollout(home, [
      legacyRecord("session_meta", { id: "01a0531f-2295-7852-b575-f9d4c2c1201c", history_mode: "legacy" }),
      legacyRecord("event_msg", { type: "task_complete" }),
    ]);
    let inspection = await inspectCodexHistory({ home, sessionId: SESSION_ID });
    assert.equal(inspection.status, "unsafe");
    assert.equal(inspection.unknownAnomalies.some((item) => item.kind === "session_identity_mismatch"), true);

    await writeFile(rollout, `${[
      legacyRecord("session_meta", { id: SESSION_ID, history_mode: "legacy" }),
      record(1, "event_msg", { type: "task_complete" }),
    ].join("\n")}\n`);
    inspection = await inspectCodexHistory({ home, sessionId: SESSION_ID });
    assert.equal(inspection.status, "unsafe");
    assert.equal(inspection.unknownAnomalies.some((item) => item.kind === "unexpected_ordinal"), true);
    await assert.rejects(
      guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "guard", environment: codexTestEnvironment() }),
      /canonical identity or ordinal contract/i,
    );
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("legacy history rejects non-record JSON and conflicting mode aliases", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-legacy-shape-"));
  try {
    const rollout = await writeRollout(home, []);
    for (const invalidRecord of [{}, [], "corrupt", null]) {
      await writeFile(rollout, `${[
        legacyRecord("session_meta", { id: SESSION_ID, history_mode: "legacy" }),
        JSON.stringify(invalidRecord),
      ].join("\n")}\n`);
      const inspection = await inspectCodexHistory({ home, sessionId: SESSION_ID });
      assert.equal(inspection.status, "unsafe");
      assert.equal(inspection.unknownAnomalies.some((item) => item.kind === "invalid_record_shape"), true);
    }

    await writeFile(rollout, `${[
      legacyRecord("session_meta", { id: SESSION_ID, history_mode: "legacy", historyMode: "paginated" }),
      legacyRecord("event_msg", { type: "task_complete" }),
    ].join("\n")}\n`);
    const inspection = await inspectCodexHistory({ home, sessionId: SESSION_ID });
    assert.equal(inspection.status, "unsafe");
    assert.equal(inspection.unknownAnomalies.some((item) => item.kind === "conflicting_history_mode"), true);
    await assert.rejects(
      guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "guard", environment: codexTestEnvironment() }),
      /canonical identity or ordinal contract/i,
    );
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("guard mode refuses a stale Codex resume without changing history", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-guard-"));
  const backupRoot = join(home, "backups");
  try {
    const rollout = await writeRollout(home, duplicateSettingsRollout());
    const before = await readFile(rollout, "utf8");
    await assert.rejects(
      guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "guard", backupRoot, environment: codexTestEnvironment() }),
      /refusing to resume from a stale paginated projection/i,
    );
    assert.equal(await readFile(rollout, "utf8"), before);
    await assert.rejects(access(backupRoot));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("repair mode backs up history, removes only redundant settings, and clears only the target projection", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-repair-"));
  const backupRoot = join(home, "backups");
  try {
    const rollout = await writeRollout(home, duplicateSettingsRollout());
    const projection = createProjection(home);
    const original = await readFile(rollout, "utf8");
    const result = await guardCodexResumeHistory({
      home, sessionId: SESSION_ID, mode: "repair", backupRoot,
      environment: codexTestEnvironment(),
      withWriterLock: async (_options, operation) => operation(),
    });

    assert.equal(result.status, "repaired");
    assert.equal(result.droppedRecords, 1);
    const repaired = (await readFile(rollout, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(repaired.map((row) => row.ordinal), [0, 1, 2]);
    assert.equal(repaired.some((row) => row.payload?.type === "thread_settings_applied"), false);

    const backupDirs = await readdir(backupRoot);
    assert.equal(backupDirs.length, 1);
    const backupDir = join(backupRoot, backupDirs[0]);
    assert.equal(await readFile(join(backupDir, "rollout.jsonl"), "utf8"), original);
    await access(join(backupDir, "thread_history_1.sqlite"));
    const manifest = JSON.parse(await readFile(join(backupDir, "manifest.json"), "utf8"));
    assert.equal(manifest.version, 2);
    assert.equal(manifest.thread_id, SESSION_ID);
    assert.equal(manifest.dropped_records, 1);
    assert.match(manifest.rollback, /stop every Codex writer/i);
    assert.match(manifest.rollback, /rewinds every thread/i);
    assert.doesNotMatch(manifest.target_scoped_projection_restore_sql, /other-thread/);

    const database = new DatabaseSync(projection);
    for (const table of ["thread_history_projection_state", "thread_items", "thread_turns", "thread_realtime_items"]) {
      assert.equal(database.prepare(`SELECT count(*) AS count FROM ${table} WHERE thread_id = ?`).get(SESSION_ID).count, 0);
      assert.equal(database.prepare(`SELECT count(*) AS count FROM ${table} WHERE thread_id = ?`).get("other-thread").count, 1);
    }
    database.close();

    const healthy = await guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "guard", backupRoot, environment: codexTestEnvironment() });
    assert.equal(healthy.status, "healthy");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("inspection rejects filename or embedded identity mismatch and a nonzero root ordinal", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-identity-"));
  try {
    const path = await writeRollout(home, [
      record(0, "session_meta", { id: "01a0531f-2295-7852-b575-f9d4c2c1201c", history_mode: "paginated" }),
      record(1, "event_msg", { type: "task_complete" }),
    ]);
    let inspection = await inspectCodexHistory({ home, sessionId: SESSION_ID });
    assert.equal(inspection.status, "unsafe");
    assert.equal(inspection.unknownAnomalies.some((item) => item.kind === "session_identity_mismatch"), true);

    const misnamed = join(dirname(path), `not-a-rollout-${SESSION_ID}.jsonl`);
    await rename(path, misnamed);
    inspection = await inspectCodexHistory({ home, sessionId: SESSION_ID });
    assert.equal(inspection.unknownAnomalies.some((item) => item.kind === "unrecognized_rollout_filename"), true);
    await rename(misnamed, path);

    await writeFile(path, `${record(100, "session_meta", { id: SESSION_ID, history_mode: "paginated" })}\n`);
    inspection = await inspectCodexHistory({ home, sessionId: SESSION_ID });
    assert.equal(inspection.status, "unsafe");
    assert.equal(inspection.unknownAnomalies.some((item) => item.kind === "invalid_root_record"), true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("unsafe history without a trustworthy mode fails closed instead of bypassing the guard", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-unknown-mode-"));
  try {
    await writeRollout(home, [
      record(0, "session_meta", { id: SESSION_ID }),
      record(2, "event_msg", { type: "task_complete" }),
    ]);
    await assert.rejects(
      guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "guard", environment: codexTestEnvironment() }),
      /canonical identity or ordinal contract/i,
    );
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a rollout without its canonical final newline fails closed", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-truncated-"));
  try {
    const path = await writeRollout(home, [
      record(0, "session_meta", { id: SESSION_ID, history_mode: "paginated" }),
      record(1, "event_msg", { type: "task_complete" }),
    ]);
    const content = await readFile(path, "utf8");
    await writeFile(path, content.trimEnd());
    const inspection = await inspectCodexHistory({ home, sessionId: SESSION_ID });
    assert.equal(inspection.status, "unsafe");
    assert.equal(inspection.unknownAnomalies.some((item) => item.kind === "noncanonical_line_endings_or_final_newline"), true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("source compare-and-swap refuses a concurrent append before replacement", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-cas-"));
  const backupRoot = join(home, "backups");
  try {
    const rollout = await writeRollout(home, duplicateSettingsRollout());
    const projection = createProjection(home);
    await assert.rejects(
      guardCodexResumeHistory({
        home, sessionId: SESSION_ID, mode: "repair", backupRoot,
        environment: codexTestEnvironment(),
        withWriterLock: async (_options, operation) => operation(),
        repairOperations: {
          beforeCompareAndSwap: async () => appendFile(rollout, `${record(3, "event_msg", { type: "task_complete" })}\n`),
        },
      }),
      /changed while Statewright prepared the repair/i,
    );
    const rows = (await readFile(rollout, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(rows.map((row) => row.ordinal), [0, 1, 1, 2, 3]);
    const database = new DatabaseSync(projection);
    assert.equal(database.prepare("SELECT count(*) AS count FROM thread_history_projection_state WHERE thread_id = ?").get(SESSION_ID).count, 1);
    database.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a post-commit manifest failure retains the repaired rollout and cleared target projection", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-post-commit-"));
  const backupRoot = join(home, "backups");
  try {
    const rollout = await writeRollout(home, duplicateSettingsRollout());
    const projection = createProjection(home);
    await assert.rejects(
      guardCodexResumeHistory({
        home, sessionId: SESSION_ID, mode: "repair", backupRoot,
        environment: codexTestEnvironment(),
        withWriterLock: async (_options, operation) => operation(),
        repairOperations: {
          writeManifest: async (path, value) => {
            if (value.state === "completed") throw new Error("injected final manifest failure");
            await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
          },
        },
      }),
      /applied the safe history repair/i,
    );
    const rows = (await readFile(rollout, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(rows.map((row) => row.ordinal), [0, 1, 2]);
    const database = new DatabaseSync(projection);
    assert.equal(database.prepare("SELECT count(*) AS count FROM thread_history_projection_state WHERE thread_id = ?").get(SESSION_ID).count, 0);
    database.close();
    const backupDirs = await readdir(backupRoot);
    const manifest = JSON.parse(await readFile(join(backupRoot, backupDirs[0], "manifest.json"), "utf8"));
    assert.equal(manifest.state, "repair_applied_manifest_incomplete");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("native writer-lock contention fails closed", { skip: process.platform === "win32" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-writer-lock-"));
  try {
    await withCodexWriterLock({ home, sessionId: SESSION_ID }, async () => {
      await assert.rejects(
        withCodexWriterLock({ home, sessionId: SESSION_ID }, async () => {}),
        /active writer/i,
      );
    });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("writer-lock acquisition coordinates across native cleanup without an inode ABA split", { skip: process.platform === "win32" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-writer-aba-"));
  const lockRoot = join(home, ".codex", "thread-writer-locks");
  const threadLock = join(lockRoot, `${SESSION_ID}.lock`);
  const coordinationLock = join(lockRoot, ".coordination.lock");
  await mkdir(lockRoot, { recursive: true });
  const oldWriter = spawn("perl", ["-MFcntl=:flock", "-e", String.raw`
use Fcntl qw(:flock);
my ($coord_path, $thread_path) = @ARGV;
open(my $thread, "+>>", $thread_path) or exit 1;
flock($thread, LOCK_EX) or exit 2;
select(STDOUT); $| = 1; print "HELD\n";
<STDIN>;
open(my $coord, "+>>", $coord_path) or exit 3;
flock($coord, LOCK_EX) or exit 4;
print "COORDINATED\n";
<STDIN>;
close($thread) or exit 5;
unlink($thread_path) unless !-e $thread_path;
close($coord) or exit 6;
`, coordinationLock, threadLock], { env: { ...process.env, LC_ALL: "C", LANG: "C" }, stdio: ["pipe", "pipe", "ignore"] });
  try {
    await waitForLine(oldWriter, "HELD");
    const oldInode = (await stat(threadLock)).ino;
    oldWriter.stdin.write("release\n");
    await waitForLine(oldWriter, "COORDINATED");
    let entered = false;
    const acquired = withCodexWriterLock({ home, sessionId: SESSION_ID }, async () => {
      entered = true;
      assert.notEqual((await stat(threadLock)).ino, oldInode);
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    assert.equal(entered, false);
    oldWriter.stdin.end("finish\n");
    await acquired;
    assert.equal(entered, true);
  } finally {
    if (oldWriter.exitCode === null) oldWriter.kill("SIGTERM");
    await rm(home, { recursive: true, force: true });
  }
});

test("environment storage overrides repair the effective Codex home and SQLite projection", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-env-storage-"));
  const codexHome = join(home, "custom-codex");
  const effectiveCwd = join(home, "effective-cwd");
  const sqliteHome = join(effectiveCwd, "custom-sqlite");
  try {
    await mkdir(sqliteHome, { recursive: true });
    const customRollout = join(codexHome, "sessions", "2026", "08", "30", `rollout-2026-08-30T00-00-00-${SESSION_ID}.jsonl`);
    await mkdir(dirname(customRollout), { recursive: true });
    await writeFile(customRollout, `${duplicateSettingsRollout().join("\n")}\n`, { mode: 0o600 });
    const projection = createProjectionAt(join(sqliteHome, "thread_history_1.sqlite"));
    let lockOptions = null;
    const result = await guardCodexResumeHistory({
      home, cwd: home, args: ["-C", "effective-cwd", "resume", SESSION_ID], sessionId: SESSION_ID, mode: "repair",
      environment: codexTestEnvironment({ CODEX_HOME: codexHome, CODEX_SQLITE_HOME: "custom-sqlite" }),
      withWriterLock: async (options, operation) => { lockOptions = options; return operation(); },
    });
    assert.equal(result.status, "repaired");
    const canonicalCodexHome = await realpath(codexHome);
    assert.equal(lockOptions.codexHome, canonicalCodexHome);
    assert.equal(lockOptions.writerLockRoot, join(canonicalCodexHome, "thread-writer-locks"));
    assert.deepEqual((await readFile(customRollout, "utf8")).trim().split("\n").map((line) => JSON.parse(line).ordinal), [0, 1, 2]);
    const database = new DatabaseSync(projection);
    assert.equal(database.prepare("SELECT count(*) AS count FROM thread_history_projection_state WHERE thread_id = ?").get(SESSION_ID).count, 0);
    database.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("top-level TOML sqlite_home takes precedence over the environment and durability sync precedes replacement", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-toml-storage-"));
  const codexHome = join(home, ".codex");
  const configuredSqliteHome = join(codexHome, "configured-sqlite");
  const envSqliteHome = join(home, "environment-sqlite");
  const events = [];
  try {
    await mkdir(codexHome, { recursive: true });
    await mkdir(configuredSqliteHome, { recursive: true });
    await mkdir(envSqliteHome, { recursive: true });
    await writeFile(join(codexHome, "config.toml"), 'sqlite_home = "configured-sqlite"\n');
    await writeRollout(home, duplicateSettingsRollout());
    const configuredProjection = createProjectionAt(join(configuredSqliteHome, "thread_history_1.sqlite"));
    const environmentProjection = createProjectionAt(join(envSqliteHome, "thread_history_1.sqlite"));
    const result = await guardCodexResumeHistory({
      home, sessionId: SESSION_ID, mode: "repair",
      environment: codexTestEnvironment({ CODEX_SQLITE_HOME: envSqliteHome }),
      withWriterLock: async (_options, operation) => operation(),
      repairOperations: { onDurabilityEvent: async (event) => events.push(event) },
    });
    assert.equal(result.status, "repaired");
    assert.deepEqual(events.slice(0, 5), ["backup_root_created", "backup_parent_synced", "backup_dir_created", "backup_root_synced", "canonical_replaced"]);
    assert.ok(events.indexOf("backup_root_synced") < events.indexOf("canonical_replaced"));
    const configuredDatabase = new DatabaseSync(configuredProjection);
    assert.equal(configuredDatabase.prepare("SELECT count(*) AS count FROM thread_history_projection_state WHERE thread_id = ?").get(SESSION_ID).count, 0);
    configuredDatabase.close();
    const environmentDatabase = new DatabaseSync(environmentProjection);
    assert.equal(environmentDatabase.prepare("SELECT count(*) AS count FROM thread_history_projection_state WHERE thread_id = ?").get(SESSION_ID).count, 1);
    environmentDatabase.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("every Codex config option spelling selects the same SQLite home", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-cli-storage-"));
  const sqliteHome = join(home, "cli-sqlite");
  try {
    await mkdir(sqliteHome, { recursive: true });
    const override = `sqlite_home=${JSON.stringify(sqliteHome)}`;
    const forms = [
      ["-c", override],
      ["--config", override],
      [`--config=${override}`],
      [`-c=${override}`],
      [`-c${override}`],
    ];
    for (const args of forms) {
      const storage = await resolveCodexHistoryStorage({ home, cwd: home, environment: {}, args });
      assert.equal(storage.sqliteHome, await realpath(sqliteHome), args.join(" "));
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("every Codex cwd option spelling anchors a relative environment SQLite home", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-cli-cwd-"));
  const effectiveCwd = join(home, "effective");
  const sqliteHome = join(effectiveCwd, "sqlite");
  try {
    await mkdir(sqliteHome, { recursive: true });
    const forms = [
      ["-C", "effective"],
      ["--cd", "effective"],
      ["--cd=effective"],
      ["-C=effective"],
      ["-Ceffective"],
    ];
    for (const args of forms) {
      const storage = await resolveCodexHistoryStorage({ home, cwd: home, environment: { CODEX_SQLITE_HOME: "sqlite" }, args });
      assert.equal(storage.effectiveCwd, await realpath(effectiveCwd), args.join(" "));
      assert.equal(storage.sqliteHome, await realpath(sqliteHome), args.join(" "));
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("repair aborts before backup or mutation for any unknown ordinal anomaly", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-unknown-"));
  const backupRoot = join(home, "backups");
  try {
    const rollout = await writeRollout(home, [
      record(0, "session_meta", { id: SESSION_ID, history_mode: "paginated" }),
      record(2, "event_msg", { type: "task_complete" }),
    ]);
    const before = await readFile(rollout, "utf8");
    await assert.rejects(
      guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "repair", backupRoot, environment: codexTestEnvironment() }),
      /not safe for automatic repair/i,
    );
    assert.equal(await readFile(rollout, "utf8"), before);
    await assert.rejects(access(backupRoot));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("repair relinks an exact stale managed App Server pointer after backing up Codex state", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-pointer-"));
  try {
    const canonical = await writeRollout(home, [
      legacyRecord("session_meta", { id: SESSION_ID, history_mode: "legacy" }),
      legacyRecord("event_msg", { type: "task_complete" }),
    ]);
    const databasePath = join(home, ".codex", "state_5.sqlite");
    const stale = join(tmpdir(), `statewright-swc_${"a".repeat(32)}-app-server-dead`, "sessions", "2026", "08", "30", `rollout-2026-08-30T00-00-00-${SESSION_ID}.jsonl`);
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    database.prepare("INSERT INTO threads VALUES (?, ?)").run(SESSION_ID, stale);
    database.close();
    const result = await guardCodexResumeHistory({
      home, sessionId: SESSION_ID, mode: "repair", environment: codexTestEnvironment(),
    });
    assert.equal(result.repairKind, "stale_rollout_pointer");
    const repaired = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(repaired.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(SESSION_ID).rollout_path, canonical);
    repaired.close();
    const backups = await readdir(join(home, ".codex", "backups"));
    assert.equal(backups.length, 1);
    assert.ok((await readdir(join(home, ".codex", "backups", backups[0]))).includes("state_5.sqlite"));
    const manifest = JSON.parse(await readFile(join(home, ".codex", "backups", backups[0], "manifest.json"), "utf8"));
    assert.match(manifest.target_scoped_rollback_sql, /UPDATE threads SET rollout_path/);
    assert.match(manifest.rollback, /whole database is disaster recovery only/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("stale pointer repair never falls through to an obsolete Codex state database", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-pointer-version-"));
  try {
    await writeRollout(home, [
      legacyRecord("session_meta", { id: SESSION_ID, history_mode: "legacy" }),
      legacyRecord("event_msg", { type: "task_complete" }),
    ]);
    const stale = join(tmpdir(), `statewright-swc_${"b".repeat(32)}-app-server-dead`, "sessions", "2026", "08", "30", `rollout-2026-08-30T00-00-00-${SESSION_ID}.jsonl`);
    const oldDatabase = new DatabaseSync(join(home, ".codex", "state_4.sqlite"));
    oldDatabase.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    oldDatabase.prepare("INSERT INTO threads VALUES (?, ?)").run(SESSION_ID, stale);
    oldDatabase.close();
    const currentDatabase = new DatabaseSync(join(home, ".codex", "state_5.sqlite"));
    currentDatabase.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    currentDatabase.close();
    const result = await guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "repair", environment: codexTestEnvironment() });
    assert.notEqual(result.repairKind, "stale_rollout_pointer");
    const unchanged = new DatabaseSync(join(home, ".codex", "state_4.sqlite"), { readOnly: true });
    assert.equal(unchanged.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(SESSION_ID).rollout_path, stale);
    unchanged.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});
