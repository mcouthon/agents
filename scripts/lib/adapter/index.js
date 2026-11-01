"use strict";

/**
 * The harness adapter registry. `forHarness(name?)` returns the adapter
 * module for the configured or default harness; an unknown name refuses.
 */

const DEFAULT_HARNESS = "claude-code";

function forHarness(name) {
  const config = require("../config");
  const harness = name || (config.loadConfig().harness) || DEFAULT_HARNESS;
  if (harness === "claude-code") return require("./claude-code");
  throw new Error(`unknown harness "${harness}"; no adapter registered for it`);
}

module.exports = { forHarness, DEFAULT_HARNESS };
