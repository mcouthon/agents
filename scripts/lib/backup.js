"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function initBackup(root) {
  if (!fs.existsSync(path.join(root, ".git"))) {
    execSync("git init -q", { cwd: root });
  }
  const gitignore = ["trash/", "tasks.json", "*.lock", ".*.tmp", ".agents.db", ".agents.db-wal", ".agents.db-shm", ".agents.db.bak*", ""].join("\n");
  fs.writeFileSync(path.join(root, ".gitignore"), gitignore);
  try {
    execSync("git rev-parse HEAD", { cwd: root, stdio: "pipe" });
  } catch {
    execSync("git add -A", { cwd: root });
    execSync('git commit -q -m "initial snapshot"', { cwd: root });
  }
  installLaunchdPlist();
}

// The pause before the one retry: the coordinator's tmp+rename records writes can hold
// .git/index.lock across this job's `git add -A`, and a wait of one breath usually
// outlives the contender (overridable so a test need not sleep the full window).
const RETRY_WAIT_MS = parseInt(process.env.AGENTS_BACKUP_RETRY_WAIT_MS, 10) || 5000;

function stampLastBackupAttempt() {
  try {
    const dir = path.join(require("os").homedir(), ".agents");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".last-backup-attempt"), new Date().toISOString());
  } catch {}
}

function readLastBackupAttempt() {
  try {
    const p = path.join(require("os").homedir(), ".agents", ".last-backup-attempt");
    const ts = fs.readFileSync(p, "utf8").trim();
    const d = new Date(ts);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

/** `git add -A` plus the snapshot commit; a failed attempt waits once and retries, and a second failure names both attempts. */
function commitSnapshot(root, iso) {
  const attempt = () => {
    execSync("git add -A", { cwd: root });
    execSync(`git commit -q -m "snapshot ${iso}"`, { cwd: root });
  };
  let firstError;
  try {
    attempt();
    return;
  } catch (err) {
    firstError = err;
  }
  execSync(`/bin/sleep ${RETRY_WAIT_MS / 1000}`);
  try {
    attempt();
  } catch (secondError) {
    throw new Error(`snapshot commit failed twice (a held .git/index.lock?): attempt 1: ${firstError.message}; attempt 2: ${secondError.message}`);
  }
}

function runBackup(root) {
  if (!fs.existsSync(path.join(root, ".git"))) {
    return { committed: false, message: "central root is not a git repo (run: a tasks backup --init)" };
  }
  stampLastBackupAttempt(root);
  const dirty = execSync("git status --porcelain", { cwd: root }).toString().trim();
  if (!dirty) return { committed: false, message: "nothing to snapshot" };
  const iso = new Date().toISOString();
  commitSnapshot(root, iso);
  let pushed = false;
  try {
    execSync("git remote get-url origin", { cwd: root, stdio: "pipe" });
    execSync("git push -q", { cwd: root, stdio: "pipe" });
    pushed = true;
  } catch {}
  return { committed: true, pushed, message: `snapshot ${iso}` };
}

function launchdPlistText(label, nodeAbs, aBin, logDir) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeAbs}</string><string>${aBin}</string><string>tasks</string><string>backup</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>StandardOutPath</key><string>${logDir}/backup.log</string>
  <key>StandardErrorPath</key><string>${logDir}/backup.log</string>
</dict>
</plist>`;
}

function installLaunchdPlist() {
  if (process.env.AGENTS_TASKS_ROOT) return { skipped: true };
  const os = require("os");
  const plistDir = path.join(os.homedir(), "Library", "LaunchAgents");
  fs.mkdirSync(plistDir, { recursive: true });
  const label = "com.mcouthon.agents.maintenance";
  const plistPath = path.join(plistDir, label + ".plist");
  const aBin = path.join(os.homedir(), ".local", "bin", "a");
  const logDir = path.join(os.homedir(), ".agents", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const nodeAbs = process.execPath;
  fs.writeFileSync(plistPath, launchdPlistText(label, nodeAbs, aBin, logDir));
  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null; launchctl load "${plistPath}"`);
  } catch {}
  return { skipped: false, plistPath };
}

// The maintenance family's second job: one `a doctor --clean` a day. The
// calendar interval (local noon) still fires when the Mac slept through it —
// launchd runs a missed calendar job once on wake. The extended PATH matters
// because launchd runs without a shell: `a doctor` looks up `zmx` and the
// worktree teardowns run through `zsh -c`, none of which resolve on the
// default /usr/bin:/bin PATH when the tools live under a Homebrew prefix.
const CLEANUP_PLIST_LABEL = "com.mcouthon.agents.cleanup";
const CLEANUP_HOUR = 12;
const CLEANUP_MINUTE = 0;
const CLEANUP_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");

function cleanupPlistText(label, nodeAbs, aBin, logDir) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeAbs}</string><string>${aBin}</string><string>doctor</string><string>--clean</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>${CLEANUP_HOUR}</integer>
    <key>Minute</key><integer>${CLEANUP_MINUTE}</integer>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${CLEANUP_PATH}</string>
  </dict>
  <key>StandardOutPath</key><string>${logDir}/cleanup.log</string>
  <key>StandardErrorPath</key><string>${logDir}/cleanup.log</string>
</dict>
</plist>`;
}

/**
 * The cleanup plist install, the watcher's shape: skipped under
 * AGENTS_TASKS_ROOT (a fixture root), written under the given home (the
 * installer's INSTALL_PREFIX-respecting home), and the live `launchctl load`
 * runs only when that home is the REAL home — the passwd entry, not $HOME,
 * because an isolated install overrides $HOME itself. A load failure is
 * recorded, never fatal: the next install retries.
 */
function installCleanupPlist(opts = {}) {
  if (process.env.AGENTS_TASKS_ROOT) return { skipped: true };
  const os = require("os");
  const home = path.resolve(opts.home || os.homedir());
  const plistDir = path.join(home, "Library", "LaunchAgents");
  fs.mkdirSync(plistDir, { recursive: true });
  const plistPath = path.join(plistDir, `${CLEANUP_PLIST_LABEL}.plist`);
  const aBin = path.join(home, ".local", "bin", "a");
  const logDir = path.join(home, ".agents", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(plistPath, cleanupPlistText(CLEANUP_PLIST_LABEL, process.execPath, aBin, logDir));
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  let loaded = false;
  let loadError = null;
  if (real(home) === real(os.userInfo().homedir)) {
    try { execSync(`launchctl unload "${plistPath}"`, { stdio: ["ignore", "pipe", "pipe"] }); }
    catch { /* not loaded yet: a first install */ }
    try { execSync(`launchctl load "${plistPath}"`, { stdio: ["ignore", "pipe", "pipe"] }); loaded = true; }
    catch (err) { loadError = err.message; }
  }
  return { skipped: false, plistPath, loaded, loadError };
}

module.exports = {
  initBackup, runBackup, commitSnapshot, launchdPlistText, installLaunchdPlist,
  cleanupPlistText, installCleanupPlist, CLEANUP_PLIST_LABEL,
  stampLastBackupAttempt, readLastBackupAttempt,
};
