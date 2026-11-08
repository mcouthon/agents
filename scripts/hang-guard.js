"use strict";

/**
 * The one shared hang guard for test child spawns, and the classifier that
 * labels a timed-out spawn honestly. HANG_GUARD_MS is a hang detector, not a
 * load budget: 30 s sits far beyond any plausible load tail (the old
 * unbounded fan-out inflated spawns ~5x against 5 s budgets, and what this
 * guard must catch is "never returns", not "slow"). Load tolerance comes from
 * the check pool bound and the AGENTS_TEST_TIMING gates, never from this
 * number — do not lower it to make a loaded run pass; that is the flake class
 * the bounded-pool CHANGELOG entry retired.
 */

const HANG_GUARD_MS = 30000;

/** True when a child_process throw is a timeout kill (execSync's timeout fires SIGTERM). */
function timeoutHit(err) {
  return !!(err && (err.code === "ETIMEDOUT" || (err.killed && err.signal === "SIGTERM")));
}

/** A timed-out spawn says so; every other error keeps its own message. */
function spawnErr(err, what) {
  return timeoutHit(err) ? `${what} timed out after ${HANG_GUARD_MS} ms` : String(err);
}

module.exports = { HANG_GUARD_MS, timeoutHit, spawnErr };
