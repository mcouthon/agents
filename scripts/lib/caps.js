"use strict";

/**
 * Counter caps enforcement for task.json v2 phases.
 * Each counter has a maximum; exceeding returns cap_reached so `a next`
 * can turn it into a checkpoint.
 */

const { CAPS } = require("./transitions");

/**
 * Check a single counter against its cap.
 * @param {string} name - Counter name (review_passes, fix_attempts, etc.)
 * @param {number} current - Current value
 * @returns {{ reached: boolean, cap: number, current: number }}
 */
function checkCap(name, current) {
  const cap = CAPS[name];
  if (cap === undefined) return { reached: false, cap: 0, current: current || 0 };
  return {
    reached: (current || 0) >= cap,
    cap,
    current: current || 0,
  };
}

/**
 * Check all counters for a phase. Returns a map of counters that reached
 * their cap, plus a formatted string for display.
 * @param {object} counters - The phase's counters object
 * @returns {{ reached: object, summary: string }}
 */
function checkAllCaps(counters) {
  const c = counters || {};
  const reached = {};
  const parts = [];
  for (const name of Object.keys(CAPS)) {
    const r = checkCap(name, c[name]);
    if (r.reached) {
      reached[name] = r;
      parts.push(`${name}: ${r.current}/${r.cap}`);
    }
  }
  return {
    reached,
    summary: parts.length > 0 ? parts.join(", ") : "",
  };
}

/**
 * Format a counter for display as "current/cap".
 * @param {string} name
 * @param {number} current
 * @returns {string}
 */
function formatCap(name, current) {
  const cap = CAPS[name];
  if (cap === undefined) return `${current || 0}`;
  return `${current || 0}/${cap}`;
}

module.exports = { checkCap, checkAllCaps, formatCap, CAPS };
