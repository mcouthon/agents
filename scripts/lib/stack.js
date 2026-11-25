"use strict";

/**
 * PR groups, pure: a task whose phases carry two or more `pr` letters lands each group on its
 * own branch, stacked on the group below. The git and gh work stays in land.js.
 */

/** phaseId -> letter. A phase without a letter takes the one before it (the first letter when
 * none is before it). Null unless the task has two or more distinct letters. */
function groupsOf(phases) {
  const letters = new Set(phases.map((p) => p.pr).filter(Boolean));
  if (letters.size < 2) return null;
  let current = phases.find((p) => p.pr).pr;
  const groups = new Map();
  for (const p of phases) {
    current = p.pr || current;
    groups.set(p.id, current);
  }
  return groups;
}

/** The phases a land carries: checked (not skipped, not migrated) since the last land. */
function landedPhases(phases, lastLandAt) {
  return phases
    .filter((p) => p.checked && !p.skipped)
    .filter((p) => p.checked_by !== "migration")
    .filter((p) => !lastLandAt || (p.checked_at && p.checked_at > lastLandAt));
}

/**
 * The group a land carries: `{ group }`, or `{ mixed: { phases, groups } }` when it carries
 * phases of two groups or of a group below the top layer. A land carrying no phase (a re-land
 * for review fixes) goes to the top layer, or the first group when nothing has landed.
 */
function landingGroup(phases, groups, layers, lastLandAt) {
  const carried = landedPhases(phases, lastLandAt);
  const letters = [...new Set(carried.map((p) => groups.get(p.id)))];
  const top = layers[layers.length - 1];
  const belowTop = letters.length === 1 && top && letters[0] !== top.group && layers.some((l) => l.group === letters[0]);
  if (letters.length > 1) return { mixed: { phases: carried.map((p) => p.id), groups: letters } };
  if (belowTop) return { mixed: { phases: carried.map((p) => p.id), groups: [letters[0], top.group] } };
  if (letters.length === 1) return { group: letters[0] };
  return { group: top ? top.group : groups.values().next().value };
}

/** Every phase of the group is checked or skipped. */
function groupComplete(phases, groups, group) {
  return phases.filter((p) => groups.get(p.id) === group).every((p) => p.checked);
}

const layerRef = (branch, group) => `${branch}.${group}`;

module.exports = { groupsOf, landedPhases, landingGroup, groupComplete, layerRef };
