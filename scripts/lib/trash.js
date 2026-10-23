"use strict";

const fs = require("fs");
const path = require("path");

function trashRoot() {
  const { tasksRootBase } = require("./tasks-root");
  return path.join(path.dirname(tasksRootBase()), "trash");
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

function trashDir(srcDir, repoKey) {
  const date = new Date().toISOString().slice(0, 10);
  const destParent = path.join(trashRoot(), date, repoKey);
  fs.mkdirSync(destParent, { recursive: true });
  const base = path.basename(srcDir);
  let destPath = path.join(destParent, base);
  if (fs.existsSync(destPath)) {
    let suffix = 2;
    while (fs.existsSync(path.join(destParent, `${base}-${suffix}`))) suffix++;
    destPath = path.join(destParent, `${base}-${suffix}`);
  }
  try {
    fs.renameSync(srcDir, destPath);
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
    copyDirRecursive(srcDir, destPath);
    fs.rmSync(srcDir, { recursive: true, force: true });
  }
  const db = require("./db");
  if (db.enabled()) db.markDeletedUnder(srcDir);
  return destPath;
}

/** Remove a scratch dir this process made under the OS temp dir (agents-* names only). */
function removeTempDir(dir) {
  const abs = path.resolve(dir);
  if (path.dirname(abs) !== path.resolve(require("os").tmpdir()) || !path.basename(abs).startsWith("agents-")) {
    throw new Error(`refusing to remove ${abs}: not an agents-* dir directly under the temp dir`);
  }
  fs.rmSync(abs, { recursive: true, force: true });
}

function findTrashEntries(datePath, dateDir, ageDays) {
  const entries = [];
  function walk(dir, relParts) {
    let hasSubdirs = false;
    let hasFiles = false;
    const subdirs = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) { hasSubdirs = true; subdirs.push(entry.name); }
      else hasFiles = true;
    }
    if (hasFiles) {
      entries.push({
        date: dateDir,
        repo_key: relParts.slice(0, -1).join("/"),
        basename: relParts[relParts.length - 1],
        path: dir,
        ageDays,
      });
    } else if (hasSubdirs) {
      for (const name of subdirs) walk(path.join(dir, name), [...relParts, name]);
    }
  }
  for (const name of fs.readdirSync(datePath)) {
    if (name.startsWith(".")) continue;
    const p = path.join(datePath, name);
    try { if (!fs.statSync(p).isDirectory()) continue; } catch { continue; }
    walk(p, [name]);
  }
  return entries;
}

function listTrash({ olderThanDays } = {}) {
  const root = trashRoot();
  if (!fs.existsSync(root)) return [];
  const entries = [];
  const now = Date.now();
  for (const dateDir of fs.readdirSync(root)) {
    if (dateDir.startsWith(".")) continue;
    const datePath = path.join(root, dateDir);
    try { if (!fs.statSync(datePath).isDirectory()) continue; } catch { continue; }
    const ageDays = Math.floor((now - new Date(dateDir).getTime()) / 86400000);
    if (olderThanDays !== undefined && ageDays < olderThanDays) continue;
    entries.push(...findTrashEntries(datePath, dateDir, ageDays));
  }
  return entries;
}

function purgeTrash({ olderThanDays }) {
  if (olderThanDays === undefined || olderThanDays === null) {
    throw new Error("--older-than <Nd> is required for purge");
  }
  if (Number.isNaN(olderThanDays)) {
    throw new Error("--older-than must parse to a number of days");
  }
  const entries = listTrash({ olderThanDays });
  const purged = [];
  for (const entry of entries) {
    fs.rmSync(entry.path, { recursive: true, force: true });
    purged.push(entry.path);
  }
  return { purged };
}

module.exports = { trashRoot, trashDir, removeTempDir, listTrash, purgeTrash };
