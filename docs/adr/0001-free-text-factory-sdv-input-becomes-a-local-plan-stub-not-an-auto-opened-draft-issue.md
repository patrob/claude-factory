# ADR-0001: Free-text /factory:sdv input becomes a local plan stub, not an auto-opened draft issue

- Status: Accepted
- Date: 2026-10-01

## Context

/factory:sdv is growing past bare issue references (owner/repo#N, URL, N, next) so a user can
paste a ticket or describe a task in free text. A free-text task has no GitHub issue, but the
pipeline (cf-ready, cf-claim, plan.md, evidence pack) expects a ticket. Two options exist:
auto-open a draft GitHub issue and run the normal flow against it, or write a local plan stub
in the factory state directory (.claude-factory/) and run from that. The factory already
treats remote side effects as opt-in: cf-claim only comments and labels when given --remote.
It never pushes to the base branch, and a human has the final say before anything lands. The
offline smoke test stubs gh, and the tool should still work without a network round-trip just
to start.

## Decision

Free-text input to /factory:sdv creates a local plan stub in the factory state directory,
and the run proceeds from that stub. The factory does not open a GitHub issue (draft or
otherwise) on its own. Writing to the tracker stays an explicit, opt-in action, consistent
with cf-claim --remote.

## Consequences

Positive: starting work has no remote side effects, so the tracker never collects stray or
abandoned issues. A free-text run can start offline and is easier to test. The rule matches
the existing opt-in model for remote writes.
Negative: a free-text run has no issue number, so there is no issue to link, comment on, or
label, and nothing for "Closes #N" in the PR. Teammates can't see the work in the tracker
until a PR exists. Readiness checks built on issue labels and checklists don't apply directly
and need a local equivalent. If a user wants an issue, they have to create it themselves.

## References

- [Issue #19: Document SDV input flexibility](https://github.com/patrob/claude-factory/issues/19)
- [Parent issue #5](https://github.com/patrob/claude-factory/issues/5)
