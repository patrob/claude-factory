# ADR-0001: Free-text /factory:sdv tasks run on a local plan stub, not a GitHub issue

- Status: Accepted
- Date: 2026-10-01

## Context

/factory:sdv required a GitHub issue reference, so small ad hoc tasks forced users to
create placeholder issues just to start the workflow. The factory's gates (claim,
plan, worktree, 2-fail check, PR + evidence, human merge) are keyed on an issue id
stored in claim.json/state.json and used in worktree paths, branch names, and the
evidence pack. We needed a task identity for free text that keeps those gates intact
without writing anything to the issue tracker.

## Decision

Any /factory:sdv input that does not strictly match a GitHub issue URL, owner/repo#N,
#N, N, or "next" is treated as a free-text task. The factory creates a local plan stub:
a claim whose id is "local-<8 hex digits of cksum(text)>", with local=true, url=null and
the text stored as the task, and a plan.md seeded from it. No GitHub issue is created,
viewed, labeled, or commented on for local tasks. The stub flows through the unchanged
worktree/check/PR+evidence gates; the PR body says the task is local instead of
"Closes repo#N". A free-text task is ready only when the repo documents a check command.

## Consequences

Ad hoc tasks need no tracker noise, and every gate (one ticket at a time, 2-fail hard
stop, human-only merge) still applies. Issue ids are no longer guaranteed numeric:
code reading claim.json/state.json "issue" must treat it as a string. Re-running the
same text reuses its claim; slightly different text yields a different id. Local tasks
leave no record on GitHub except the PR itself, and they are never picked up by
"next" or cf-watch. Mistyped issue refs that fall outside the issue patterns become
free-text tasks rather than errors.

## References

- [Issue #18: Support free-text task input for /factory:sdv via local plan stub](https://github.com/patrob/claude-factory/issues/18)
