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
  const err = new Error(`unknown harness "${harness}"; no adapter registered for it`);
  err.exitCode = 2;
  err.code = "unknown_harness";
  err.detail = { remedy: 'set `harness` in ~/.agents/config.json to a supported name, or leave it unset for the default (claude-code)' };
  throw err;
}

module.exports = { forHarness, DEFAULT_HARNESS };
