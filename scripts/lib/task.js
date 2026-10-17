"use strict";

const fs = require("fs");
const path = require("path");
const { withLock } = require("./lock");
const { tasksRoot } = require("./tasks-root");
const { doRebuildIndex } = require("./store");

function createTask({ repo, title, slug, mode, phases, description, session_id }) {
  const sid = session_id || `pid-${process.pid}`;
  const tasksDir = tasksRoot(repo);
  if (!fs.existsSync(tasksDir)) fs.mkdirSync(tasksDir, { recursive: true });
  const holder = { session_id: sid, pid: process.pid };

  const result = withLock(tasksDir, holder, () => {
    const number = nextTaskNumber(tasksDir);
    const paddedNumber = String(number).padStart(3, "0");
    const dirName = slug ? `${paddedNumber}-${slug}` : `${paddedNumber}`;
    const taskDir = path.join(tasksDir, dirName);

    try {
      fs.mkdirSync(taskDir);
    } catch (err) {
      if (err.code === "EEXIST") {
        const e = new Error(`Task directory already exists: ${taskDir}`);
        e.code = "EEXIST";
        throw e;
      }
      throw err;
    }

    const taskMd = renderTaskMd({ number, slug, title, description });
    fs.writeFileSync(path.join(taskDir, "task.md"), taskMd, "utf8");

    const state = {
      schema_version: 1,
      task: slug || dirName,
      status: "planning",
      updated: new Date().toISOString(),
      phases: (phases || []).map((p) => ({
        id: p.id,
        name: p.name,
        status: "not_started",
        owner: null,
        started: null,
        completed: null,
        blocked_by: p.blocked_by || [],
        parallel_group: p.parallel_group ?? null,
        execution: { model: null, effort: null, agent_type: null, estimated_scope: null },
      })),
      flags: [],
    };
    if (mode) state.mode = mode;
    fs.writeFileSync(path.join(taskDir, "state.json"), JSON.stringify(state, null, 2), "utf8");

    return { task_dir: taskDir, slug: dirName, number };
  });

  try {
    doRebuildIndex(repo.main_root, sid);
  } catch {}

  return result;
}

function nextTaskNumber(tasksDir) {
  const numbers = [];
  if (fs.existsSync(tasksDir)) {
    for (const name of fs.readdirSync(tasksDir)) {
      if (name.startsWith(".")) continue;
      const match = name.match(/^(\d{3})(?:-|$)/);
      if (match) numbers.push(parseInt(match[1], 10));
    }
  }
  return numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
}

function renderTaskMd({ number, slug, title, description }) {
  const lines = [
    `---`,
    `task: ${title}`,
    `slug: ${slug || ""}`,
    `created: ${new Date().toISOString().slice(0, 10)}`,
    `status: planning`,
    `---`,
    ``,
    `# ${title}`,
    ``,
  ];
  if (description) {
    lines.push(description, "");
  }
  lines.push("## Phases", "", "| # | Phase | Status | Notes |", "|---|---|---|---|", "", "## Decision Log", "");
  return lines.join("\n");
}

module.exports = { createTask, nextTaskNumber };
