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

module.exports = { initBackup, runBackup, commitSnapshot, launchdPlistText, installLaunchdPlist };
