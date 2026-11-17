---
name: pr-ready
description: "Drive an open PR to ready: description per the environment's PR conventions, every failing check fixed, every review comment answered and its thread resolved. Ready means green checks and no unresolved threads — never said over a red check or an open thread. Triggers on: 'pr-ready', 'make the PR ready', 'drive the PR', 'finish the PR'."

cc:
  allowed-tools: [Read, Bash, Skill]
---

# PR-Ready — drive a PR to ready

A PR is not done when it opens. It is done when its checks are green and every
review thread is resolved — you drive it there before anyone hears "ready".

Run each step with your own tools. A seat without the shell dispatches instead:
the review seat runs the gh commands, the builder seat fixes, pushes go through
the engine's `land` — the caller's dispatch pattern names the seats.

## Description

Apply the environment's PR-description skill where one exists (/pr:update-description,
/pr:create conventions) — it carries the conventions this framework must not bake in.
Where none exists, derive the body from the commit messages: what changed and why,
one line per commit, no boilerplate.

## Checks

`gh pr checks`. A failing check is yours to fix: find the failure, fix it, push,
re-check. Where the environment provides a PR-watch skill (/pr:check), it can hold
the wait; otherwise poll calmly and report at the end, not every spin. After 5 failed
fix attempts on one check, report what remains and stop.

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
