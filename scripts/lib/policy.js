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

/** "pr", "direct" or "unlisted" for the repo at `inputPath`. */
function policyKind(inputPath) {
  const p = resolvePolicy(inputPath);
  return p.source === "unlisted" ? "unlisted" : (p.push === "pr" ? "pr" : "direct");
}

/** Record `kind` ("pr" or "direct") for a repo's main root, keeping every other entry. */
function writePolicy(mainRoot, kind) {
  if (kind !== "pr" && kind !== "direct") throw new Error(`policy must be pr or direct, not "${kind}"`);
  const policies = loadPolicies();
  policies[mainRoot] = kind;
  fs.mkdirSync(path.dirname(POLICIES_PATH), { recursive: true });
  fs.writeFileSync(POLICIES_PATH, JSON.stringify(policies, null, 2) + "\n", "utf8");
}

module.exports = { resolvePolicy, policyKind, writePolicy, POLICIES_PATH, DEFAULT_POLICY };
