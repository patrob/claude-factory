---
name: watch
description: Show or drain the claude-factory queue — open issues with either the factory-ready or the sdv label — one ticket at a time, each in its own headless claude -p session running /factory:sdv. Use when the user runs /factory:watch.
argument-hint: "[status | once | drain] [--repo owner/repo]"
disable-model-invocation: true
allowed-tools:
  - Bash(cf-watch --dry-run)
  - Bash(cf-watch --dry-run *)
  - Bash(cf-check --status)
  - Bash(cf-claim --show)
---

# claude-factory: watch the queue

Arguments: `$ARGUMENTS` (empty means `status`).

`cf-watch` is a headless drain loop. For each queued issue (open, labeled `factory-ready` or `sdv` — either one is enough; oldest first) it runs `cf-claim` and
`cf-worktree`, then starts `claude -p "/factory:sdv owner/repo#N"` inside the worktree.
It stops at the first hard stop, or when a run ends without a PR. Every outcome goes to
`.claude-factory/watch-ledger.jsonl`, and each run's full output goes to `.claude-factory/runs/`.

Run all commands from the primary checkout of the target repo. Pass `--repo owner/repo` through if the user gave one.

## Modes

**status** (default)
1. Run `cf-watch --dry-run`. It lists the queue and prints the current claim and failure counter.
2. Summarize: how many issues are queued, which were already attempted, and whether a hard stop is active.
3. Tell the user how to drain: `/factory:watch once`, `/factory:watch drain`, or from a terminal:
   `${CLAUDE_SKILL_DIR}/../../bin/cf-watch`.

**once**
1. Run `cf-watch --dry-run` and show the next issue.
2. Ask the user to confirm. One run opens one PR on GitHub.
3. On yes, start `cf-watch --once` with the Bash tool in the background (`run_in_background: true`).
   It can take many minutes.
4. When it finishes, report the ledger's last line (PR URL or reason it stopped) and the log path.

**drain**
1. Run `cf-watch --dry-run` and show the whole queue.
2. Ask the user to confirm. A drain opens one PR per issue, one after another.
3. On yes, start `cf-watch` in the background. Report each outcome from the ledger when it finishes.

## Rules

- Never pass `--dangerously-skip-permissions`. Never merge anything.
- If `cf-watch` reports a hard stop, stop. Show the log path and tell the user to type `cf-reset` after they decide.
- If it reports an in-progress claim, do not release it yourself. Ask the user.

## Limits (v0.1)

- Not a daemon: it runs only while the process lives. No launchd/systemd unit.
- Needs Claude Code auth and `gh auth` in the shell that runs it.
- Headless sessions use `--permission-mode acceptEdits` plus a fixed tool allowlist. Build commands
  outside that list (for example `npm install`) are denied unless the user adds them with
  `CF_WATCH_ALLOWED_TOOLS`.
- Strictly serial: one ticket, one worktree, one PR at a time.
