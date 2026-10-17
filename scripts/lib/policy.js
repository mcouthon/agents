"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { repoKey } = require("./repo");

const POLICIES_PATH = path.join(os.homedir(), ".claude", "repo-policies.json");
const DEFAULT_POLICY = { push: "ask", worktree: "auto", merge: "manual" };

function resolvePolicy(inputPath) {
  const key = repoKey(inputPath);
  const policies = loadPolicies();

  let raw = policies[key.main_root];
  let source = "main_root";

  if (!raw && key.origin_slug) {
    raw = policies[key.origin_slug];
    source = "origin_slug";
  }

  if (!raw) {
    return { ...DEFAULT_POLICY, base: key.base, source: "unlisted" };
  }

  const policy = normalizePolicy(raw);
  return {
    push: policy.push || DEFAULT_POLICY.push,
    worktree: policy.worktree || DEFAULT_POLICY.worktree,
    merge: policy.merge || DEFAULT_POLICY.merge,
    base: policy.base || key.base,
    source,
  };
}

function normalizePolicy(raw) {
  if (typeof raw === "string") {
    return { push: raw, worktree: "auto", merge: "manual" };
  }
  return raw;
}

function loadPolicies() {
  try {
    return JSON.parse(fs.readFileSync(POLICIES_PATH, "utf8"));
  } catch {
    return {};
  }
}

module.exports = { resolvePolicy, POLICIES_PATH, DEFAULT_POLICY };
