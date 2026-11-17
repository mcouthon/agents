---
name: pr-ready
description: "Drive an open PR to ready: description per the framework's contract (an environment PR-description skill's conventions come first), every failing check fixed, every review comment answered and its thread resolved. Ready means green checks, no unresolved threads and a current description — never said over a red check or an open thread. Triggers on: 'pr-ready', 'make the PR ready', 'drive the PR', 'finish the PR', after land opens a PR."
allowed-tools: [Read, Bash, Skill]
---

# PR-Ready — drive a PR to ready

A PR is not done when it opens. It is done when its checks are green and every
review thread is resolved — you drive it there before anyone hears "ready".

Run each step with your own tools. A seat without the shell dispatches instead:
the review seat runs the gh commands, the builder seat fixes, pushes go through
the engine's `land` — the caller's dispatch pattern names the seats.

## Description

Where the setup provides a PR-description skill, apply it — it carries conventions this
framework must not bake in. What it leaves uncovered — and the whole body where no skill
exists — follows the contract below, one baseline for every agent that opens or rewrites
a PR description.

Write for a colleague with less context than you: someone reviewing between other
things, not the author. Brief — lead with what changes, then why.

- One-line summary of the change, in plain words.
- **Why:** the problem it fixes or the decision behind it, with the concrete trigger
  where there is one — "Google returned 429 at ~2 requests/s from one IP, so the job
  now paces requests at 1/s."
- **What changes:** short bullets.
- **Examples** where judgement is involved: a few cases in and out at the line — a
  threshold, a classifier — real-looking but anonymised (title @ company, no names).
  Reviewers judge examples far faster than rules.
- **How this was tested**, only for substantial testing: counts, replays, scoring
  runs, a local check against the real service — "26/48 failed before, 0/48 after".
  Never the routine checks; CI shows those.
- Screenshots for UI changes: saved locally, dragged into the PR by a human, never
  committed.

Short sentences, plain words, specifics over adjectives — numbers, file names,
before→after. Bullets only for parallel items. No filler ("This PR aims to…"), no
internal task or phase numbers — say why instead. Derive it from the commits and the
diff, and update it whenever the design changes, so it never goes stale.

Set it with `gh pr edit <number> --body-file -`, stdin as at creation.

## Checks

`gh pr checks`. A failing check is yours to fix: find the failure, fix it, push,
re-check. Where the setup provides a PR-watch skill, it can hold the wait; otherwise
poll calmly and report at the end, not every spin. After 5 failed fix attempts on one
check, report what remains and stop.

## Review comments

Every unresolved thread gets an answer:

- **Agree** — fix, push, reply with what changed, resolve the thread.
- **Disagree** — one-line reply saying why; resolve only when the exchange is
  settled. Never resolve a thread you did not answer.
- **Needs the owner's call** — an ask, in their terms: the effect of each way,
  no history, no internals. Not a silent resolve.

Unresolved threads: `gh pr view --json comments,reviews`. Reply: `gh api
repos/{owner}/{repo}/pulls/{n}/comments -f body="..." -F in_reply_to=<comment-id>`.
Resolve: `gh api graphql -f query='mutation{resolveReviewThread(input:{threadId:"<thread-id>"}){thread{isResolved}}}'`
— thread ids via the pull request's `reviewThreads` field.

## Done

Green checks, no unresolved threads, description current. Until all three hold,
the PR — and the task behind it — is not ready.
