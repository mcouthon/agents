#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync, execSync } = require("child_process");
const { trashRoot, trashDir, listTrash, purgeTrash } = require("./lib/trash");
const { initBackup, runBackup, launchdPlistText, installLaunchdPlist } = require("./lib/backup");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log("OK: " + msg); }
function fail_(msg) { fail++; console.log("FAIL: " + msg); }

const tasksTmp = fs.mkdtempSync(path.join(os.tmpdir(), "agents-trash-tasks-"));
const trashTmp = fs.mkdtempSync(path.join(os.tmpdir(), "agents-trash-base-"));
process.env.AGENTS_TASKS_ROOT = path.join(tasksTmp, "tasks");
fs.mkdirSync(process.env.AGENTS_TASKS_ROOT, { recursive: true });

const repoKey = "github.com/test/repo";

function makeDir(name) {
  const dir = path.join(tasksTmp, "work", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "task.json"), "{}");
  return dir;
}

// --- Test 1: trashDir renames src to trash and returns the path ---
{
  const src = makeDir("task-a");
  const dest = trashDir(src, repoKey);
  if (!fs.existsSync(dest)) fail_("T1: dest should exist");
  else ok("T1: trashDir moves src to trash");
  if (fs.existsSync(src)) fail_("T1: src should not exist at original location");
  else ok("T1: src removed from original location");
  if (dest.includes(path.join("trash", new Date().toISOString().slice(0, 10), repoKey))) ok("T1: dest path has correct structure");
  else fail_(`T1: dest path wrong: ${dest}`);
}

// --- Test 2: collision suffixing ---
{
  const src1 = makeDir("task-b");
  const dest1 = trashDir(src1, repoKey);
  const src2 = makeDir("task-b");
  const dest2 = trashDir(src2, repoKey);
  if (dest1 !== dest2) ok("T2: collision produces different dest paths");
  else fail_("T2: collision should produce different dest paths");
  if (fs.existsSync(dest1) && fs.existsSync(dest2)) ok("T2: both trash entries exist");
  else fail_("T2: both trash entries should exist");
  if (dest2.endsWith("task-b-2")) ok("T2: second collision has -2 suffix");
  else fail_(`T2: second collision should end with -2, got: ${dest2}`);
}

// --- Test 3: listTrash returns entries with correct fields ---
{
  const entries = listTrash();
  if (entries.length >= 2) ok(`T3: listTrash returns ${entries.length} entries`);
  else fail_(`T3: expected >= 2 entries, got ${entries.length}`);
  const e = entries[0];
  if (e.date && e.repo_key && e.basename && e.path && typeof e.ageDays === "number") ok("T3: entry has all required fields");
  else fail_(`T3: entry missing fields: ${JSON.stringify(e)}`);
}

// --- Test 4: listTrash with --older-than filter ---
{
  const oldDate = "2020-01-01";
  const oldDir = path.join(trashRoot(), oldDate, repoKey, "old-task");
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, "task.json"), "{}");
  const entries = listTrash({ olderThanDays: 365 });
  if (entries.length >= 1 && entries.some((e) => e.basename === "old-task")) ok("T4: listTrash --older-than 365 includes old entry");
  else fail_(`T4: old entry not found in filtered list: ${JSON.stringify(entries)}`);
  const recent = listTrash({ olderThanDays: 9999 });
  if (recent.length === 0) ok("T4: listTrash --older-than 9999 returns empty");
  else fail_(`T4: expected empty for 9999 days, got ${recent.length}`);
}

// --- Test 5: purgeTrash refuses without olderThanDays ---
{
  try {
    purgeTrash({});
    fail_("T5: purgeTrash should throw without olderThanDays");
  } catch (err) {
    if (err.message.includes("--older-than")) ok("T5: purgeTrash throws without --older-than");
    else fail_(`T5: wrong error: ${err.message}`);
  }
}

// --- Test 6: purgeTrash deletes only older entries ---
{
  const oldDate = "2020-01-01";
  const oldEntry = path.join(trashRoot(), oldDate, repoKey, "purge-me");
  fs.mkdirSync(oldEntry, { recursive: true });
  fs.writeFileSync(path.join(oldEntry, "task.json"), "{}");
  const todayEntry = path.join(trashRoot(), new Date().toISOString().slice(0, 10), repoKey, "keep-me");
  fs.mkdirSync(todayEntry, { recursive: true });
  fs.writeFileSync(path.join(todayEntry, "task.json"), "{}");
  const result = purgeTrash({ olderThanDays: 365 });
  if (result.purged.some((p) => p.includes("purge-me"))) ok("T6: purgeTrash deleted old entry");
  else fail_("T6: old entry not in purged list");
  if (!fs.existsSync(oldEntry)) ok("T6: old entry deleted from disk");
  else fail_("T6: old entry should be deleted");
  if (fs.existsSync(todayEntry)) ok("T6: young entry survived purge");
  else fail_("T6: young entry should survive");
}

// --- Test 7: Static assertion — no rmSync outside trash.js in scripts/lib ---
{
  const libDir = path.join(__dirname, "lib");
  const files = fs.readdirSync(libDir).filter((f) => f.endsWith(".js"));
  let violations = [];
  for (const file of files) {
    if (file === "trash.js") continue;
    const content = fs.readFileSync(path.join(libDir, file), "utf8");
    if (content.includes("rmSync")) violations.push(file + " (rmSync)");
    if (content.includes("rm -rf")) violations.push(file + " (rm -rf)");
  }
  if (violations.length === 0) ok(`T7: no rmSync or rm -rf outside trash.js (scanned ${files.length} files)`);
  else fail_(`T7: violations found: ${violations.join(", ")}`);
}

// --- Backup tests ---

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

// backup.js execSync calls inherit process.env (no env option passed), so the
// git identity must live on process.env itself — GIT_ENV only covers the
// verification execSync calls below. Without this, commits succeed only when
// the machine has a global git user.name/user.email (CI would fail).
const _origGit = {
  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
  GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
};
process.env.GIT_AUTHOR_NAME = "test";
process.env.GIT_AUTHOR_EMAIL = "test@test.com";
process.env.GIT_COMMITTER_NAME = "test";
process.env.GIT_COMMITTER_EMAIL = "test@test.com";

// --- Test 8: backup --init creates git repo ---
{
  const backupRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agents-backup-")), "tasks");
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.writeFileSync(path.join(backupRoot, "index.json"), "{}");
  const oldRoot = process.env.AGENTS_TASKS_ROOT;
  process.env.AGENTS_TASKS_ROOT = backupRoot;
  try {
    initBackup(backupRoot);
    if (fs.existsSync(path.join(backupRoot, ".git"))) ok("T8: .git created");
    else fail_("T8: .git should exist");
    if (fs.existsSync(path.join(backupRoot, ".gitignore"))) ok("T8: .gitignore created");
    else fail_("T8: .gitignore should exist");
    const log = execSync("git log --oneline", { cwd: backupRoot, env: GIT_ENV }).toString().trim();
    if (log.includes("initial snapshot")) ok("T8: initial commit exists");
    else fail_(`T8: no initial commit in log: ${log}`);
  } finally {
    process.env.AGENTS_TASKS_ROOT = oldRoot;
  }
}

// --- Test 9: backup --init idempotent ---
{
  const backupRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agents-backup-")), "tasks");
  fs.mkdirSync(backupRoot, { recursive: true });
  const oldRoot = process.env.AGENTS_TASKS_ROOT;
  process.env.AGENTS_TASKS_ROOT = backupRoot;
  try {
    initBackup(backupRoot);
    initBackup(backupRoot);
    const log = execSync("git log --oneline", { cwd: backupRoot, env: GIT_ENV }).toString().trim();
    const lines = log.split("\n");
    if (lines.length === 1) ok("T9: idempotent — still one commit");
    else fail_(`T9: expected 1 commit, got ${lines.length}: ${log}`);
  } finally {
    process.env.AGENTS_TASKS_ROOT = oldRoot;
  }
}

// --- Test 10: backup commits on change ---
{
  const backupRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agents-backup-")), "tasks");
  fs.mkdirSync(backupRoot, { recursive: true });
  const oldRoot = process.env.AGENTS_TASKS_ROOT;
  process.env.AGENTS_TASKS_ROOT = backupRoot;
  try {
    initBackup(backupRoot);
    fs.writeFileSync(path.join(backupRoot, "new-file.txt"), "test");
    const result = runBackup(backupRoot);
    if (result.committed) ok("T10: backup committed on dirty tree");
    else fail_(`T10: should commit, got ${JSON.stringify(result)}`);
    const log = execSync("git log --oneline", { cwd: backupRoot, env: GIT_ENV }).toString().trim();
    if (log.split("\n").length === 2) ok("T10: two commits (initial + snapshot)");
    else fail_(`T10: expected 2 commits, got ${log.split("\n").length}: ${log}`);
  } finally {
    process.env.AGENTS_TASKS_ROOT = oldRoot;
  }
}

// --- Test 11: backup no-op when clean ---
{
  const backupRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agents-backup-")), "tasks");
  fs.mkdirSync(backupRoot, { recursive: true });
  const oldRoot = process.env.AGENTS_TASKS_ROOT;
  process.env.AGENTS_TASKS_ROOT = backupRoot;
  try {
    initBackup(backupRoot);
    const result = runBackup(backupRoot);
    if (!result.committed && result.message.includes("nothing to snapshot")) ok("T11: backup no-op on clean tree");
    else fail_(`T11: expected no-op, got ${JSON.stringify(result)}`);
  } finally {
    process.env.AGENTS_TASKS_ROOT = oldRoot;
  }
}

// --- Test 12: backup without init degrades gracefully ---
{
  const backupRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agents-backup-")), "tasks");
  fs.mkdirSync(backupRoot, { recursive: true });
  const oldRoot = process.env.AGENTS_TASKS_ROOT;
  process.env.AGENTS_TASKS_ROOT = backupRoot;
  try {
    const result = runBackup(backupRoot);
    if (!result.committed && result.message.includes("a tasks backup --init")) ok("T12: backup without init degrades with pointer");
    else fail_(`T12: expected graceful message, got ${JSON.stringify(result)}`);
  } finally {
    process.env.AGENTS_TASKS_ROOT = oldRoot;
  }
}

// --- Test 13: installLaunchdPlist skipped when AGENTS_TASKS_ROOT set ---
{
  const result = installLaunchdPlist();
  if (result.skipped) ok("T13: installLaunchdPlist skipped in test env");
  else fail_(`T13: should skip in test env, got ${JSON.stringify(result)}`);
}

// --- Test 14: launchdPlistText produces correct content ---
{
  const text = launchdPlistText("com.test.agents", "/usr/local/bin/node", "/home/user/.local/bin/a", "/home/user/.agents/logs");
  if (text.includes("<key>StartInterval</key><integer>900</integer>")) ok("T14: plist has 900s interval");
  else fail_("T14: plist missing StartInterval 900");
  if (text.includes("/usr/local/bin/node")) ok("T14: plist has absolute node path as first arg");
  else fail_("T14: plist missing node path");
  if (text.includes("/home/user/.local/bin/a")) ok("T14: plist has a binary path");
  else fail_("T14: plist missing a path");
}

// --- Test 15: backup does not push when no origin remote ---
{
  const backupRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agents-backup-")), "tasks");
  fs.mkdirSync(backupRoot, { recursive: true });
  const oldRoot = process.env.AGENTS_TASKS_ROOT;
  process.env.AGENTS_TASKS_ROOT = backupRoot;
  try {
    initBackup(backupRoot);
    fs.writeFileSync(path.join(backupRoot, "push-test.txt"), "x");
    const result = runBackup(backupRoot);
    if (!result.pushed) ok("T15: backup does not push without origin");
    else fail_("T15: should not push without origin");
  } finally {
    process.env.AGENTS_TASKS_ROOT = oldRoot;
  }
}

// Restore git identity env vars so they don't leak to anything after the test.
process.env.GIT_AUTHOR_NAME = _origGit.GIT_AUTHOR_NAME;
process.env.GIT_AUTHOR_EMAIL = _origGit.GIT_AUTHOR_EMAIL;
process.env.GIT_COMMITTER_NAME = _origGit.GIT_COMMITTER_NAME;
process.env.GIT_COMMITTER_EMAIL = _origGit.GIT_COMMITTER_EMAIL;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
