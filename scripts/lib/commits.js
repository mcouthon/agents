"use strict";

/**
 * Git readers for a phase's commits: what was made since a recorded start, whether commits are on
 * base, and where rebased commits went. Read-only except `git fetch`.
 */

const { execFileSync, spawnSync } = require("child_process");

function git(repo, args, opts) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    timeout: (opts && opts.timeout) || 30000,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, AGENTS_LAND: "1" },
  }).trim();
}

function gitOk(repo, args) {
  try { git(repo, args, { timeout: 5000 }); return true; } catch { return false; }
}

function lines(out) {
  return out.split("\n").filter(Boolean);
}

/** The refs that count as base: the remote-tracking branch when it exists, and the local branch. */
function baseRefs(repo, base) {
  return [`origin/${base}`, base].filter((ref) => gitOk(repo, ["rev-parse", "--verify", "--quiet", ref]));
}

/**
 * Commits made since `startSha` up to `tip` that origin's base does not have, oldest first.
 * Fetches first; a failed fetch is ignored.
 */
function sinceStart({ repo, startSha, tip, base }) {
  try { git(repo, ["fetch", "origin"]); } catch {}
  const args = ["rev-list", "--reverse", `${startSha}..${tip}`];
  if (gitOk(repo, ["rev-parse", "--verify", "--quiet", `origin/${base}`])) args.push(`^origin/${base}`);
  return lines(git(repo, args));
}

/** Every commit from `startSha` up to `tip`, oldest first, pushed or not. */
function allSince({ repo, startSha, tip }) {
  return lines(git(repo, ["rev-list", "--reverse", `${startSha}..${tip}`]));
}

/** Every sha is an ancestor of origin's base or of the local base. */
function onBase(repo, base, shas) {
  const refs = baseRefs(repo, base);
  return shas.every((sha) => refs.some((ref) => gitOk(repo, ["merge-base", "--is-ancestor", sha, ref])));
}

function patchId(repo, sha) {
  const shown = spawnSync("git", ["-C", repo, "show", "--format=", sha], { encoding: "utf8", timeout: 10000 });
  if (shown.status !== 0 || !shown.stdout) return null;
  const pid = spawnSync("git", ["-C", repo, "patch-id", "--stable"], { input: shown.stdout, encoding: "utf8", timeout: 10000 });
  if (pid.status !== 0) return null;
  return pid.stdout.split(" ")[0] || null;
}

/**
 * Map recorded shas that are on neither base to the commits that carry the same patch on origin's
 * base (a rebase rewrote them). Shas already on base are kept. `ok` is true only when every sha
 * resolves; otherwise `missing` names the ones that do not.
 *
 * @returns {{ok: true, shas: string[]} | {ok: false, missing: string[]}}
 */
function reresolve({ repo, base, shas }) {
  const remote = `origin/${base}`;
  const refs = baseRefs(repo, base);
  const out = [];
  const missing = [];
  for (const sha of shas) {
    if (refs.some((ref) => gitOk(repo, ["merge-base", "--is-ancestor", sha, ref]))) { out.push(sha); continue; }
    let found = null;
    if (refs.includes(remote) && gitOk(repo, ["cat-file", "-e", `${sha}^{commit}`])) {
      const wanted = patchId(repo, sha);
      if (wanted) {
        let mb = "";
        try { mb = git(repo, ["merge-base", remote, sha]); } catch {}
        if (mb) {
          for (const candidate of lines(git(repo, ["rev-list", "--reverse", `${mb}..${remote}`]))) {
            if (patchId(repo, candidate) === wanted) { found = candidate; break; }
          }
        }
      }
    }
    if (found) out.push(found); else missing.push(sha);
  }
  return missing.length ? { ok: false, missing } : { ok: true, shas: out };
}

module.exports = { sinceStart, allSince, onBase, reresolve };
