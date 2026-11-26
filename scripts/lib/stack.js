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

/** The phases of the group that are not checked yet. */
const uncheckedIn = (phases, groups, group) =>
  phases.filter((p) => groups.get(p.id) === group && !p.checked).map((p) => p.id);

/** Every phase of the group is checked. */
const groupComplete = (phases, groups, group) => uncheckedIn(phases, groups, group).length === 0;

/**
 * The group a land carries: `{ group }`, or `{ mixed: { reason, phases, groups, ... } }` when
 * the land cannot go on a layer. Reasons: `groups` (phases of two groups, or of a group below
 * the top layer), `merged` (the group's PR is merged, it takes no more commits), `incomplete`
 * (a new group would be cut on a top group with unchecked phases). A land carrying no phase (a
 * re-land for review fixes) goes to the top layer, or the first group when nothing has landed.
 */
function landingGroup(phases, groups, layers, lastLandAt) {
  const carried = landedPhases(phases, lastLandAt);
  const ids = carried.map((p) => p.id);
  const letters = [...new Set(carried.map((p) => groups.get(p.id)))];
  const top = layers[layers.length - 1];
  if (letters.length > 1) return { mixed: { reason: "groups", phases: ids, groups: letters } };

  const group = letters.length === 1 ? letters[0] : top ? top.group : groups.values().next().value;
  const recorded = layers.find((l) => l.group === group);
  if (recorded && recorded.merged) return { mixed: { reason: "merged", phases: ids, groups: [group] } };
  if (recorded && recorded !== top) return { mixed: { reason: "groups", phases: ids, groups: [group, top.group] } };
  if (!recorded && top && !top.merged) {
    const unchecked = uncheckedIn(phases, groups, top.group);
    if (unchecked.length > 0) return { mixed: { reason: "incomplete", phases: ids, groups: [top.group, group], unchecked } };
  }
  return { group };
}

/**
 * The layers after a merge, bottom first: the ones whose PR GitHub reports merged (`mergedRefs`)
 * marked `merged`, and the lowest open layer re-based on `base` once every layer below it is
 * merged. `{ layers, topMerged, retarget }` — the topmost merged layer or null, and the ref of the
 * layer whose PR must move onto base or null — or `{ outOfOrder: { upper, lower } }` when a merged
 * layer sits above an open one (its commits went into the lower branch on GitHub).
 */
function restacked(layers, mergedRefs, base) {
  const marked = layers.map((l) => (l.merged || mergedRefs.has(l.ref) ? { ...l, merged: true } : l));
  const lowest = marked.findIndex((l) => !l.merged);
  const above = lowest === -1 ? [] : marked.slice(lowest).filter((l) => l.merged);
  if (above.length > 0) return { outOfOrder: { upper: above[0].ref, lower: marked[lowest].ref } };

  const retarget = lowest > 0 && marked[lowest].base !== base ? marked[lowest].ref : null;
  const rebased = retarget ? marked.map((l) => (l.ref === retarget ? { ...l, base } : l)) : marked;
  const merged = rebased.filter((l) => l.merged);
  return { layers: rebased, topMerged: merged[merged.length - 1] || null, retarget };
}

/** The stacked state — `{ groups, layers, number }` (number: the linked GitHub stack, or null) — or null for today's one-branch land: the task
 * has fewer than two PR letters, or its last land already opened one PR from the task branch. */
function stackOf(phases, lastLand) {
  const groups = groupsOf(phases);
  if (!groups || (lastLand && !lastLand.layers)) return null;
  return { groups, layers: (lastLand && lastLand.layers) || [], number: (lastLand && lastLand.stack) || null };
}

const STACK_API_VERSION = "X-GitHub-Api-Version: 2026-03-10";

/** A PR's number: the last segment of its URL. */
const prNumber = (url) => Number(url.split("/").pop());

/** The PR numbers of a stack's `GET` answer; null when it cannot be read. */
function stackNumbers(text) {
  try { return new Set(JSON.parse(text).pull_requests.map((pr) => pr.number)); } catch { return null; }
}

/** The PR numbers a GitHub stack takes from these layers, bottom first: the open layers' PRs. */
const stackPrs = (layers) => layers.filter((l) => !l.merged && l.pr_url).map((l) => prNumber(l.pr_url));

const layerRef = (branch, group) => `${branch}.${group}`;

/**
 * The layer the next land carries: `{ layer }` — the recorded one, or a new one cut on the top
 * layer (on base when that layer's PR is merged) — or `{ mixed }` as landingGroup reports it.
 */
function nextLayer(phases, groups, layers, branch, base, lastLandAt) {
  const landing = landingGroup(phases, groups, layers, lastLandAt);
  if (landing.mixed) return { mixed: landing.mixed };
  const recorded = layers.find((l) => l.group === landing.group);
  if (recorded) return { layer: recorded };
  const top = layers[layers.length - 1];
  const stackedOnTop = top && !top.merged;
  return { layer: { group: landing.group, ref: layerRef(branch, landing.group), base: stackedOnTop ? top.ref : base, pr_url: null } };
}

module.exports = { groupsOf, landedPhases, landingGroup, groupComplete, restacked, layerRef, stackOf, nextLayer, STACK_API_VERSION, prNumber, stackPrs, stackNumbers };
