"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

function agentsConfigPath() {
  return process.env.AGENTS_CONFIG_PATH || path.join(os.homedir(), ".agents", "config.json");
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(agentsConfigPath(), "utf8"));
  } catch {
    return {};
  }
}

module.exports = { agentsConfigPath, loadConfig };
