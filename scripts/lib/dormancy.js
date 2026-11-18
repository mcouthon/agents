"use strict";

/**
 * The engine's dormancy clocks: WORKTREE_GRACE_DAYS is how many quiet days
 * hold a done task's worktree (the one removal rule's wait), SWEEP_GRACE_DAYS
 * the archive grace `a tasks sweep` defaults its --older-than to — apart
 * since the removal stopped waiting on the sweep. A missing or unparsable
 * timestamp reads infinitely old (the sweep's own convention: no intent
 * events, nothing recent to protect).
 */
const WORKTREE_GRACE_DAYS = 1;
const SWEEP_GRACE_DAYS = 3;

/** Age of an ISO timestamp in days; absent or unparsable reads infinitely old. */
function daysAgo(isoTimestamp) {
  if (!isoTimestamp) return Infinity;
  const then = new Date(isoTimestamp).getTime();
  if (Number.isNaN(then)) return Infinity;
  return (Date.now() - then) / (1000 * 60 * 60 * 24);
}

module.exports = { WORKTREE_GRACE_DAYS, SWEEP_GRACE_DAYS, daysAgo };
