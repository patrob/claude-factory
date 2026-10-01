# Plan — {{REPO}}#{{ISSUE}}: {{TITLE}}

- Ticket: {{URL}}
- Claimed: {{CLAIMED_AT}} by {{CLAIMED_BY}}
- Check: `{{CHECK_CMD}}`

## Done when

<!-- Copy the ticket's DONE_WHEN / Gherkin here. If it has none, write 1–3 observable outcomes. -->

## Approach

<!-- The smallest change that satisfies "Done when". 3–7 bullets. -->

## Files to touch

<!-- Paths relative to the repo root. -->

## Tests

<!-- Which tests prove "Done when"? New or changed tests go here. -->

## Out of scope

<!-- What this PR will not do. -->

## Stop conditions

- `cf-check` fails twice → hard stop. A human decides what happens next.
- The change grows beyond one small PR → stop and ask for the ticket to be split.
- The ticket is ambiguous → stop and ask; do not guess.
