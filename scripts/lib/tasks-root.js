"use strict";

const path = require("path");
const os = require("os");
const { loadConfig } = require("./config");

function tasksRoot(repoKeyObj) {
  const config = loadConfig();
  const rootMode = (config.tasks && config.tasks.root) || "repo";
  if (rootMode === "central") {
    return path.join(os.homedir(), ".agents", "tasks", repoKeyObj.key);
  }
  return path.join(repoKeyObj.main_root, ".tasks");
}

module.exports = { tasksRoot };
