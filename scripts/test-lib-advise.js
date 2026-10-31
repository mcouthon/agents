#!/usr/bin/env node
"use strict";

// advise: one move for every shape of task, derived from phases, the owner's rows and git facts.
// factsFor: the unlanded count comes from the task's own tree.

(function isolateEnv() {
  const fs = require("fs"), os = require("os"), path = require("path");
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "agents-advise-"));
  for (const d of ["home", "xdg", "tasks", "sessions"]) fs.mkdirSync(path.join(t, d));
  fs.writeFileSync(path.join(t, "cfg.json"), "{}");
  Object.assign(process.env, {
    HOME: path.join(t, "home"),
    AGENTS_CONFIG_PATH: path.join(t, "cfg.json"),
    XDG_CONFIG_HOME: path.join(t, "xdg"),
    GIT_CONFIG_NOSYSTEM: "1",
    AGENTS_TASKS_ROOT: path.join(t, "tasks"),
    AGENTS_SESSIONS_ROOT: path.join(t, "sessions"),
    AGENTS_DB: path.join(t, "agents.db"),
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  });
})();

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { advise, factsFor } = require("./lib/advise");
const { landHold } = require("./lib/land");

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log("OK: " + msg); } else { fail++; console.log("FAIL: " + msg); } }

const { BANNED } = require("./surface-guard");
const AGENT_MOVES = ["plan", "revise", "build", "commit", "check"];

const PLAN_AT = "2026-01-02T00:00:00.000Z";
const BEFORE = "2026-01-01T00:00:00.000Z";
const AFTER = "2026-01-03T00:00:00.000Z";
const row = (choice, decided_at, phase_id = 1) => ({ phase_id, choice, quote: `owner says ${choice}`, decided_at });

const STATUSES = ["not_started", "planned", "approved", "in_progress", "committed", "done", "landed", "skipped"];
const DECISION_SETS = {
  none: [],
  approveBeforePlan: [row("approve", BEFORE)],
  approveAfterPlan: [row("approve", AFTER)],
  rejectAfterApprove: [row("approve", AFTER), row("reject", "2026-01-04T00:00:00.000Z")],
  accept: [row("approve", AFTER), row("accept", "2026-01-04T00:00:00.000Z")],
  skip: [row("skip", AFTER)],
  answer: [row("answer", AFTER), row("answer", AFTER), row("answer", AFTER)],
};
const AFTERS = {
  none: () => [],
  previous: (i) => (i > 0 ? [i] : []),
  cycle: (i, n) => (n > 1 ? [i === 0 ? n : i] : []),
  unknown: () => [99],
};

function build(n, statuses, afterKind) {
  return {
    number: 1,
    phases: Array.from({ length: n }, (_, i) => ({
      id: i + 1, name: `P${i + 1}`, status: statuses[i], blocked_by: AFTERS[afterKind](i, n), plan_path: `plan/p${i + 1}.md`,
    })),
  };
}

function* shapes() {
  for (let n = 1; n <= 3; n++) {
    const combos = STATUSES.length ** n;
    for (let c = 0; c < combos; c++) {
      const statuses = Array.from({ length: n }, (_, i) => STATUSES[Math.floor(c / STATUSES.length ** i) % STATUSES.length]);
      for (const afterKind of Object.keys(AFTERS)) {
        for (const plan of [false, true]) {
          for (const dec of Object.keys(DECISION_SETS)) {
            for (const approvals of ["ask", "none", undefined]) {
              for (const land of ["per_phase", "at_end"]) {
                for (const unlanded of [0, 2]) yield { n, statuses, afterKind, plan, dec, approvals, land, unlanded };
              }
            }
          }
        }
      }
    }
  }
}

function inputsOf(s) {
  const task = build(s.n, s.statuses, s.afterKind);
  task.knobs = { land: s.land, ...(s.approvals ? { approvals: s.approvals } : {}) };
  const planMtime = {};
  for (const p of task.phases) planMtime[p.id] = s.plan ? PLAN_AT : null;
  const facts = { planMtime, decisions: DECISION_SETS[s.dec], commitsSince: {}, unlanded: s.unlanded, lastLandAt: null, boundSessions: 0, worktree: null, policy: "direct" };
  return { task, facts };
}

let count = 0;
const failures = { i1: [], i2: [], i3: [], i5: [], i6: [], i7: [] };
const note = (bucket, s) => { if (failures[bucket].length < 3) failures[bucket].push(JSON.stringify(s)); };

for (const s of shapes()) {
  count++;
  const { task, facts } = inputsOf(s);
  const a = advise(task, facts);
  const asks = a.question !== null;
  const moveOk = AGENT_MOVES.includes(a.move) || a.move === "land" || a.move === "close" || (["approve", "phases"].includes(a.move) && asks);
  if (!moveOk || (asks !== ["approve", "phases"].includes(a.move)) || (asks && a.question.choices.length === 0) || a.move === "blocked") note("i1", s);
  const text = [a.advice, a.question && a.question.text, ...a.warnings].join("\n");
  if (BANNED.some((b) => text.includes(b))) note("i2", s);
  for (const q of a.ready) {
    const marked = { ...task, phases: task.phases.map((p) => (p.id === q ? { ...p, status: "done" } : p)) };
    const after = advise(marked, facts).ready;
    if (!a.ready.filter((r) => r !== q).every((r) => after.includes(r))) note("i3", s);
  }
  if (JSON.stringify(advise(task, facts)) !== JSON.stringify(a)) note("i5", s);
  if (s.unlanded === 0 && a.move === "land") note("i6", s);
  if (a.checked.length === task.phases.length && s.unlanded > 0 && a.move !== "land") note("i6", s);
  if (a.checked.length === task.phases.length && !["land", "close"].includes(a.move)) note("i7", s);
}
check(count > 100000, `enumerated ${count} shapes`);
check(failures.i1.length === 0, `I1: exactly one agent move, land, close or one question, never blocked (${failures.i1[0] || "ok"})`);
check(failures.i2.length === 0, `I2: no advice, question or warning names a hand-edit phrase (${failures.i2[0] || "ok"})`);
check(failures.i3.length === 0, `I3: marking a phase checked never removes another from ready (${failures.i3[0] || "ok"})`);
check(failures.i5.length === 0, `I5: advise twice deep-equals (${failures.i5[0] || "ok"})`);
check(failures.i6.length === 0, `I6: unlanded 0 never lands; all checked with unlanded > 0 always lands (${failures.i6[0] || "ok"})`);
check(failures.i7.length === 0, `I7: all checked means land or close (${failures.i7[0] || "ok"})`);

{
  const src = advise.toString();
  check(!/\bDate\b|\bprocess\b|require\(|child_process/.test(src), "I5: the advise source references no Date, process, require or child_process");
  const empty = advise({ number: 5, phases: [] }, {});
  check(empty.move === "phases" && empty.question && /task 5/.test(empty.question.text), "I7: no phases gives the one question");
}

{
  const task = { knobs: { approvals: "ask" }, phases: [{ id: 1, status: "committed" }, { id: 2, status: "done" }, { id: 3, status: "not_started" }] };
  const hold = landHold(task, []);
  check(hold && hold.phases.join() === "1,2" && /accept/.test(hold.remedy) && /land_anyway/.test(hold.remedy), "I4: ask with unaccepted checked phases holds and names accept or land_anyway");
  check(landHold(task, [row("accept", AFTER, 1), row("land_anyway", AFTER, 2)]) === null, "I4: accept and land_anyway rows lift the hold");
  check(landHold({ ...task, knobs: { approvals: "none" } }, []) === null && landHold({ ...task, knobs: {} }, []) === null, "I4: approvals none or absent holds nothing");
}

{
  const base = (k) => advise(inputsOf({ n: 1, statuses: ["not_started"], afterKind: "none", plan: true, dec: "answer", approvals: "ask", land: "per_phase", unlanded: 0 }).task, {
    planMtime: { 1: PLAN_AT }, decisions: Array.from({ length: k }, () => row("answer", AFTER)), commitsSince: {}, unlanded: 0,
  }).move;
  check(base(1) === base(3) && base(3) === base(7), "I8: 1, 3 or 7 answer rows give the same move");
  const rej = (k) => advise({ knobs: { approvals: "ask" }, phases: [{ id: 1, name: "P", status: "planned", blocked_by: [] }] }, {
    planMtime: { 1: PLAN_AT }, decisions: Array.from({ length: k }, () => row("reject", AFTER)), commitsSince: {}, unlanded: 0,
  }).move;
  check(rej(1) === "revise" && rej(3) === "revise" && rej(7) === "revise", "I8: 1, 3 or 7 reject rows all give revise");
}

{
  const t = (extra = {}) => ({ knobs: { approvals: "ask", land: "per_phase" }, phases: [
    { id: 1, name: "A", status: "done", checked_at: "2026-02-02T00:00:00.000Z", blocked_by: [] },
    { id: 2, name: "B", status: "not_started", blocked_by: [] },
  ], ...extra });
  const f = (over) => ({ planMtime: {}, decisions: [], commitsSince: {}, unlanded: 2, lastLandAt: null, boundSessions: 0, worktree: null, policy: "direct", ...over });
  check(advise(t(), f({ lastLandAt: "2026-02-01T00:00:00.000Z" })).move === "land", "land-due: a phase checked after the last land, with unlanded commits, lands");
  check(advise(t(), f({ lastLandAt: "2026-02-03T00:00:00.000Z" })).move === "plan", "land-due: checked before the last land, the current phase's move comes instead");
  check(advise(t(), f({ lastLandAt: "2026-02-01T00:00:00.000Z", unlanded: 0 })).move === "plan", "land-due: nothing unlanded, no land");
  const legacy = { knobs: { land: "per_phase" }, phases: [{ id: 1, name: "A", status: "landed", blocked_by: [] }, { id: 2, name: "B", status: "not_started", blocked_by: [] }] };
  check(advise(legacy, f()).move === "land", "land-due: no checked_at anywhere uses the old rule (fresh phase, unlanded commits)");
  const atEnd = { ...t(), knobs: { approvals: "ask", land: "at_end" } };
  check(advise(atEnd, f()).move === "plan", "land-due at_end: not every phase is checked, so no land");
  check(advise({ ...atEnd, phases: atEnd.phases.map((p) => ({ ...p, status: "done" })) }, f()).move === "land", "land-due at_end: every phase checked and unlanded commits lands");
}

{
  const dir = path.join(__dirname, "fixtures", "advise");
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const fx = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    const a = advise(fx.task, { planMtime: {}, decisions: [], commitsSince: {}, unlanded: 0, ...fx.facts });
    const ok = (a.phase ? a.phase.id : null) === fx.expect.phase && a.move === fx.expect.move && a.migrated === fx.expect.migrated
      && (fx.expect.question === undefined || (a.question !== null) === fx.expect.question);
    check(ok, `fixture ${name}: ${a.move} on ${a.phase ? a.phase.id : "-"} (${a.advice})`);
  }
  const f295 = JSON.parse(fs.readFileSync(path.join(dir, "295-3-rebased.json"), "utf8"));
  check(advise(f295.task, { ...f295.facts, planMtime: {}, decisions: [] }).checked.includes(3), "fixture 295-3: the done phase counts as checked whatever its stored SHAs");
}

// Plan presence from the folder: the files in plan/, not the stored plan_path or status.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agents-plan-"));
  const taskDir = path.join(root, "001-x");
  const planDir = path.join(taskDir, "plan");
  fs.mkdirSync(planDir, { recursive: true });
  const task = { number: 1, phases: [{ id: 7, name: "Seven", status: "not_started", blocked_by: [] }], knobs: { approvals: "none", land: "per_phase" } };
  const taskOf = (id) => ({ ...task, phases: [{ id, name: `P${id}`, status: "planned", blocked_by: [] }] });
  const factsOf = (t) => factsFor(taskDir, t);

  const a0 = advise(task, factsOf(task));
  check(a0.move === "plan" && a0.phase.plan_path === null, `no plan file reads "plan it" whatever the status (${a0.move})`);

  fs.writeFileSync(path.join(planDir, "phase-7-x.md"), "# plan\n");
  const found = factsOf(task);
  check(found.planFiles[7] === path.join(planDir, "phase-7-x.md") && found.planCounts[7] === 1, "the found file comes from the folder, not plan_path");
  const a1 = advise(task, found);
  check(a1.phase.plan_path === path.join(planDir, "phase-7-x.md") && a1.move === "build", `a plan file on disk means it is not "plan it" (${a1.move})`);

  fs.writeFileSync(path.join(planDir, "phase-10-y.md"), "# other\n");
  const a2 = advise(taskOf(1), factsOf(taskOf(1)));
  check(a2.move === "plan", "a file for another phase leaves phase 1 with no plan");

  fs.writeFileSync(path.join(planDir, "phase-3-a.md"), "# a\n");
  fs.writeFileSync(path.join(planDir, "phase-3-a.rewritten-by-builder-1606.md"), "# rewritten\n");
  const t3 = taskOf(3);
  const f3 = factsOf(t3);
  check(f3.planFiles[3] === path.join(planDir, "phase-3-a.md") && f3.planCounts[3] === 1, "a suffixed sibling is not a second plan file");
  check(advise(t3, f3).warnings.length === 0, "no two-plans warning for a suffixed sibling");

  fs.writeFileSync(path.join(planDir, "phase-3-b.md"), "# b\n");
  const stale = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(planDir, "phase-3-a.md"), stale, stale);
  const f3b = factsOf(t3);
  check(f3b.planFiles[3] === path.join(planDir, "phase-3-b.md") && f3b.planCounts[3] === 2, "two matching files pick the newer mtime");
  const a3b = advise(t3, f3b);
  check(a3b.warnings.includes("phase 3 has 2 plan files"), `the warning names the phase (${a3b.warnings.join("; ")})`);
  fs.rmSync(root, { recursive: true, force: true });
}

// The plan body hash: appended evidence and ticks do not change it; a line above does.
{
  const { planBody, planHash } = require("./lib/derive");
  const base = "# Plan\n\n- [ ] one\n- [ ] two\n";
  const withEvidence = `${base}\n## Verification Evidence\n\n- ran the suite\n`;
  check(planHash(base) === planHash(withEvidence), "appended evidence sections leave the hash alone");
  const ticked = "# Plan\n\n- [x] one\n- [X] two\n";
  check(planHash(base) === planHash(ticked), "checkbox ticks leave the hash alone");
  check(planHash(base) !== planHash("# Plan\n\n- [ ] one\n- [ ] two\nchanged\n"), "a changed line above the sections moves the hash");
  check(planBody("a  \nb\t") === "a\nb", "trailing whitespace is trimmed from every line");
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agents-advise-git-"));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const origin = path.join(root, "origin.git");
  const main = path.join(root, "main");
  const wt = path.join(root, "wt");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, main);
  fs.writeFileSync(path.join(main, "a.txt"), "a\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  git(main, "push", "-q", "origin", "main");
  git(main, "worktree", "add", "-q", "-b", "task-branch", wt, "origin/main");
  for (const n of [1, 2]) {
    fs.writeFileSync(path.join(main, `stray${n}.txt`), "x\n");
    git(main, "add", ".");
    git(main, "commit", "-q", "-m", `stray ${n}`);
  }
  const taskDir = path.join(root, "task");
  fs.mkdirSync(taskDir);
  const task = { number: 1, worktree_path: wt, phases: [{ id: 1, name: "P", status: "not_started", blocked_by: [] }] };
  const facts0 = factsFor(taskDir, task, { mainRoot: main });
  check(facts0.worktree && fs.realpathSync(facts0.worktree) === fs.realpathSync(wt), "factsFor: the task's worktree is found");
  check(facts0.unlanded === 0, `factsFor: 2 stray commits on the main checkout do not count for a task with a worktree (unlanded ${facts0.unlanded})`);
  for (const n of [1, 2]) {
    fs.writeFileSync(path.join(wt, `task${n}.txt`), "y\n");
    git(wt, "add", ".");
    git(wt, "commit", "-q", "-m", `task ${n}`);
  }
  check(factsFor(taskDir, task, { mainRoot: main }).unlanded === 2, "factsFor: 2 commits in the task's worktree count as unlanded");
  const noWt = factsFor(taskDir, { ...task, worktree_path: "" }, { mainRoot: main });
  check(noWt.worktree === null && noWt.unlanded === 2, `factsFor: with no worktree the main checkout's own commits count (${noWt.unlanded})`);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
