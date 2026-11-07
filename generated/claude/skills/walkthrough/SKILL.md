---
name: walkthrough
description: "Turn a multi-step ask into guided execution instead of a command dump: self-execute every step you can, hand the owner only the steps that genuinely need them — one command at a time, each result verified before the next. Use when the owner invokes /walkthrough or asks to be walked through testing or verifying something step by step. Triggers on: '/walkthrough', 'walk me through', 'walk me through testing', 'walk me through this', 'guide me through testing'. Full access mode - runs commands, reads output, and fixes what it can itself."
allowed-tools: [Read, Edit, Write, Bash, Grep, Glob, LSP]
---

# Walkthrough — Self-Execute, Then Guide

A multi-step ask is not a list of commands for the owner to run alone. Re-plan
it: execute every step you can yourself, and hand over only the steps that
genuinely need the owner — one command at a time, each result verified before
the next.

## The reframe

On invocation, re-plan the current ask around self-execution:

1. List the steps the ask needs — testing, verifying, deploying, whatever.
2. Sort them into yours and the owner's.
3. Execute yours now — builds, tests, commands, curls, log reading, file
   inspection. Run them, read the output, fix what breaks. Report each result.
4. The owner's steps become guided handoffs, one at a time.

The majority of the work is yours. Hand a step to the owner only when one of
these applies — otherwise run it yourself:

- **You cannot run it** — it needs their credentials or token, their
  interactive approval (login, MFA, OAuth click), a GUI or device only they
  see, or a system your environment cannot reach.
- **You should not run it** — the command carries risk the owner must
  personally control (destructive, irreversible, production-affecting),
  needs permissions or authority beyond yours, or is important enough that
  the owner should execute it themselves.

Never hand over a step you could and should have run.

If you already answered with a command dump, convert it: run what you can
immediately, then continue from the first step that needs the owner.

## The handoff format

One step per message, never a list. Each handoff has:

- **Step N of M** — position in the remaining sequence
- The command in a fenced block — copy-pasteable verbatim, absolute paths
- **Expected:** what success looks like — key output, exit code, or visible
  change
- **Wait:** how long it should take and what a hang means (e.g. "returns in
  ~10 s; nothing after 2 min means it stalled — paste whatever you have")

If a step needs a secret, have the owner export it into their own environment
— never ask them to paste it to you.

## The verification loop

After each handoff, wait for the owner's result. Then:

1. **Verify before advancing.** Compare the result against the expectation.
   Where you can observe the side effect yourself — a file that appeared, a
   process that is up, a log line — check it directly instead of trusting the
   paste.
2. **Match:** confirm in one line, execute the next steps you can yourself,
   and send the next handoff only when you reach another owner step.
3. **Divergence:** stop. Diagnose it yourself first — reproduce with read-only
   commands, read the logs, compare against the expectation. Fix what you can
   yourself, then resume from the current step — never restart the sequence.
   Say what changed and which later steps it affects; adjust them, don't
   silently replan.
4. If you cannot diagnose or fix it, hand over one diagnostic step in the same
   format and keep the loop.

## Rules

- One command per message during handoffs. The owner's result is the only
  signal to advance — never assume a step completed.
- Self-verify first: after an owner step, check the observable outcome yourself
  before asking the owner what happened.
- Recompute N of M when a diagnosis changes the plan.
- Close with a summary: what you executed, what the owner ran, and the final
  verification that answers the original ask.
