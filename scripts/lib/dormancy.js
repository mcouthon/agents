"use strict";

/**
 * The engine's one dormancy clock: how many quiet days make a done task's
 * workspace reclaimable — the same grace `a tasks sweep` archives on and the
 * one removal rule reaps a done-but-open task's worktree after. A missing or
 * unparsable timestamp reads infinitely old (the sweep's own convention:
 * no intent events, nothing recent to protect).
 */
const GRACE_DAYS = 3;

/** Age of an ISO timestamp in days; absent or unparsable reads infinitely old. */
function daysAgo(isoTimestamp) {
  if (!isoTimestamp) return Infinity;
  const then = new Date(isoTimestamp).getTime();
  if (Number.isNaN(then)) return Infinity;
  return (Date.now() - then) / (1000 * 60 * 60 * 24);
}

module.exports = { GRACE_DAYS, daysAgo };
