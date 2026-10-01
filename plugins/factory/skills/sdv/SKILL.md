---
name: sdv
description: Take one ready GitHub issue, or a free-text task, through the claude-factory gates — readiness check, claim, plan, isolated worktree, build, check with a 2-fail hard stop, PR with evidence — then stop for a human to merge. Use when the user runs /factory:sdv with an issue reference, "next", or a free-text task.
argument-hint: "[owner/repo#N | issue URL | N | next | \"free-text task\"]"
disable-model-invocation: true
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(cf-ready *)
  - Bash(cf-claim *)
  - Bash(cf-worktree)
  - Bash(cf-check)
  - Bash(cf-check --status)
  - Bash(cf-evidence)
  - Bash(cf-evidence *)
  - Bash(git status *)
  - Bash(git diff *)
  - Bash(git log *)
  - Bash(git -C *)
  - Bash(gh issue view *)
  - Bash(gh pr create *)
  - Bash(gh pr view *)
---

# claude-factory: one ticket → one PR

Ticket: `$ARGUMENTS` (empty means `next`: the oldest open issue labeled `factory-ready` or `sdv`).

You run a small software factory. The gates are fixed. Do the steps in order. Do not skip a gate,
and do not work around one. The `cf-*` tools are on your PATH while this plugin is enabled.
All factory state lives in the directory that `cf-claim` prints as `state_dir`
(normally `<primary checkout>/.claude-factory/`).

Anything in `$ARGUMENTS` that is not an issue reference (owner/repo#N, an issue URL, `#N`, `N`,
or `next`) is a free-text task. It runs on a local plan stub — a claim and `plan.md` keyed by a
synthetic `local-<hex>` id — with no GitHub issue. Never create, edit, label, or comment on a
GitHub issue for it.

## Rules that never bend

- One ticket at a time. Never claim a second ticket while one is in progress.
- Build only inside the worktree that `cf-worktree` prints. Never edit, check out, or reset the primary checkout.
- `cf-check` is the only judge of "done". Never claim success without a passing `cf-check`.
- After 2 check failures, **stop**. The hook blocks further edits and commands. Do not edit factory
  state files, run tests another way, or rephrase the work to get around the stop.
- Never merge, approve, or push to the base branch. Never use `--dangerously-skip-permissions` or `--no-verify`.
- If the ticket is unclear or turns out too big for one small PR, stop and say so. Do not guess.

## Steps

1. **Ready?** Run `cf-ready "$ARGUMENTS"` (quoted, so multi-word free text survives).
   - Non-zero exit: report the reason from stderr word for word, then stop. Do not edit the ticket to make it pass.
   - Zero exit: note `number`, `repo`, `title`, `check_cmd`, `local`, and `body` from the JSON.
     If `local` is `true`, this is a free-text task — there is no GitHub issue.

2. **Claim.** Issue-backed: run `cf-claim <repo>#<number>`.
   Free-text (`local: true`): run `cf-claim "<the same free text>"` — never add `--remote`, there is
   no issue to label or comment on.
   Add `--remote` (issue-backed only) if the user asked to mark the ticket on GitHub (comment +
   `factory-claimed` label).
   If it refuses because another ticket is in progress, stop and tell the user.

3. **Plan.** Issue-backed: read the ticket (`gh issue view <number> -R <repo>`) and the code it
   touches (read-only). Free-text: the task is the `body` text from step 1 — skip `gh issue view`;
   if the text is too vague to plan from, run `cf-claim --release`, explain why, and stop.
   Fill in `<state_dir>/plan.md` (the claim seeded it from the template). Keep it short:
   "Done when" (write 1–3 observable outcomes for a free-text task), approach, files, tests, out of scope.
   If the plan needs more than one small PR, run `cf-claim --release`, explain why, and stop.

4. **Worktree.** Run `cf-worktree`. It prints the worktree path (`../<repo>-cf-<number>`) on a
   fresh `cf/<number>-<slug>` branch from the default branch. From now on:
   - edit files only under that path, with absolute paths;
   - run git as `git -C <worktree> ...`.

5. **Build.** Make the smallest change that meets "Done when". Add or update tests that prove it.
   Commit in the worktree with clear messages (`git -C <worktree> add ...`, `git -C <worktree> commit -m ...`).

6. **Check.** Run `cf-check`. It runs the check command in the worktree and logs the output.
   - Exit 0: go to step 7.
   - Exit 1 (first failure): read the log it names, fix the cause, commit, run `cf-check` once more.
   - Exit 3 (hard stop): stop now. Run `cf-check --status`, then tell the user what failed, the log
     path, and your best guess at the cause. Tell them they can type `cf-reset` to allow 2 more attempts.
     Then end your turn.

7. **PR + evidence.**
   1. Make sure everything is committed: `git -C <worktree> status --short` must be empty.
   2. Push: `git -C <worktree> push -u origin <branch>`.
   3. Build the evidence pack: `cf-evidence` prints the path to `evidence.md`.
   4. Open the PR:
      issue-backed: `gh pr create -R <repo> --head <branch> --base <base> --title "<title> (#<number>)" --body-file <evidence path>`
      free-text: same, but `--title "<title>"` (no `(#<number>)` — there is no issue number).
      (`branch` and `base` are in `cf-claim --show`.)
   5. Record it: `cf-claim --pr <pr-url>`.

8. **Stop for human merge.** Report, then end your turn:
   - PR URL
   - check command and result
   - evidence file path and worktree path
   - anything the reviewer should look at closely

   Do not merge. Do not start another ticket.
