"use strict";

// Session launch path: the facts about running sessions (zmx names, liveness)
// and task lookup that `a ls`, `a start`, `a attach` and `a resume` share.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

/**
 * The sessions `zmx list` knows: [{ name, ended }] (ended sessions included,
 * flagged). `null` when zmx is missing or fails: "no zmx facts", which is
 * different from `[]` ("zmx knows no session").
 */
function zmxSessions() {
  let out;
  try {
    out = execFileSync("zmx", ["list"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 2000 });
  } catch {
    return null;
  }
  const sessions = [];
  for (const line of out.split("\n")) {
    const fields = line.split("\t");
    const nameField = fields.find((f) => f.startsWith("name="));
    if (!nameField) continue;
    sessions.push({ name: nameField.slice(5), ended: fields.some((f) => f.startsWith("ended=")) });
  }
  return sessions;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Is this registration a running session? Counts its process (the claude pid
 * recorded by a hook) and its zmx session, so a launcher entry stays visible
 * while hooks are off. A registration without `mux` is matched to a zmx
 * session named `<Agent>-<first 8 of the session id>[-rN]`, the name shell
 * launchers use without recording a mux.
 *
 * @param {object} reg - a registration
 * @param {{name: string, ended: boolean}[]|null} zmx - zmxSessions() result
 * @returns {{ live: boolean, zmxName: string|null }}
 */
function liveSession(reg, zmx) {
  if (!reg || reg.ended_at) return { live: false, zmxName: null };
  const names = (zmx || []).filter((z) => !z.ended).map((z) => z.name);
  let zmxName = null;
  if (reg.mux && reg.mux.kind === "zmx" && reg.mux.name) {
    if (names.includes(reg.mux.name)) zmxName = reg.mux.name;
  } else if (!reg.mux && reg.session_id) {
    const re = new RegExp(`-${escapeRegExp(String(reg.session_id).slice(0, 8))}(-r\\d+)?$`);
    zmxName = names.find((n) => re.test(n)) || null;
  }
  const live = require("./session").isLive(reg) || zmxName !== null;
  return { live, zmxName };
}

function taskCandidates(key) {
  const db = require("./db");
  if (db.enabled()) {
    return db.listTasks({ disposition: "active" })
      .filter((r) => r.repo_key === key.key)
      .map((r) => ({ name: r.dir_name, dir: r.task_dir }));
  }
  const root = require("./tasks-root").tasksRoot(key);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((n) => !n.startsWith(".") && n !== "archive" && n !== "trash")
    .filter((n) => fs.existsSync(path.join(root, n, "task.json")))
    .map((n) => ({ name: n, dir: path.join(root, n) }));
}

/**
 * Find a task of the repo by number, `NNN-slug` or slug. Reads only (no
 * migration). Returns `{ name, dir }` or null; throws an error with
 * `.ambiguous` when a slug names several tasks.
 */
function resolveTask(input, key) {
  if (!input) return null;
  const candidates = taskCandidates(key);
  if (path.isAbsolute(input)) return candidates.find((c) => c.dir === input) || null;
  if (/^\d+$/.test(input)) {
    const padded = input.padStart(3, "0");
    return candidates.find((c) => c.name === padded || c.name.startsWith(padded + "-")) || null;
  }
  const exact = candidates.find((c) => c.name === input);
  if (exact) return exact;
  const exactSlug = candidates.filter((c) => c.name.replace(/^\d+-/, "") === input);
  if (exactSlug.length === 1) return exactSlug[0];
  const bySlug = (exactSlug.length ? exactSlug : candidates).filter((c) => c.name.endsWith("-" + input));
  if (bySlug.length > 1) {
    const err = new Error(`"${input}" names several tasks (${bySlug.map((c) => c.name).join(", ")}); use the number`);
    err.ambiguous = true;
    throw err;
  }
  return bySlug[0] || null;
}

module.exports = { zmxSessions, liveSession, resolveTask };
