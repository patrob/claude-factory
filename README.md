# Claude Factory

A lightweight software factory that runs **inside Claude Code**.
Claim one ready ticket → plan → worktree → check → PR + evidence → **human merge**.

The factory supplies the gates; Claude supplies the loop. There is no daemon, no auto-merge,
and no `--dangerously-skip-permissions`.

MIT licensed, public: <https://github.com/patrob/claude-factory>


> **Naming note:** Anthropic reserves plugin names starting with `claude-`. The installable plugin is therefore named `factory` (skills: `/factory:sdv`, `/factory:watch`). The GitHub repo and marketplace id remain `claude-factory` / `patrob/claude-factory`.

## Install

In Claude Code:

```
/plugin marketplace add patrob/claude-factory
/plugin install factory@claude-factory
```

From a shell:

```bash
claude plugin marketplace add patrob/claude-factory
claude plugin install factory@claude-factory          # add --scope project to share it with a repo
```

Restart Claude Code (or run `/reload-plugins`) after installing.

> **Why `factory` and not `claude-factory`?** Claude Code reserves plugin names that start with
> `claude-` for Anthropic. The marketplace is `claude-factory`; the plugin inside it is `factory`.

### Requirements

- Claude Code with plugin `bin/` support (v2.1.91 or later)
- `git` 2.31+, [`gh`](https://cli.github.com) (authenticated), and `jq`
- macOS or Linux, bash 3.2+

The plugin ships executables in `bin/`, so claude.ai and Cowork will not install it. It is for Claude Code (CLI, desktop, IDE).

## Use

| Command | What it does |
|---|---|
| `/factory:sdv <ticket>` | Take one ticket to a PR, then stop for a human to merge. `<ticket>` is `owner/repo#N`, an issue URL, `N`, or `next`. |
| `/factory:watch [status\|once\|drain]` | Show the queue, or drain it one ticket at a time in headless `claude -p` sessions. |
| `cf-reset` (typed as a prompt) | Human only: clear the failure counter after a hard stop. |

You can paste a ticket (issue reference, URL, or ticket text) or type a free-text task after `/factory:sdv`. A free-text task becomes a local plan stub, not a new GitHub issue.

Run both from the primary checkout of the repo the tickets belong to.

### What `/factory:sdv` does

1. **Ready?** `cf-ready` refuses tickets that are not ready (see the rules below).
2. **Claim.** `cf-claim` writes `.claude-factory/claim.json`, resets the failure counter, and seeds
   `.claude-factory/plan.md` from the plan template. `--remote` also comments on the issue and adds a
   `factory-claimed` label.
3. **Plan.** Claude fills in the plan: done-when, approach, files, tests, out of scope.
4. **Worktree.** `cf-worktree` fetches the default branch and adds a worktree at `../<repo>-cf-<N>`
   on branch `cf/<N>-<slug>`. The primary checkout is never checked out, reset, or edited.
5. **Build.** Claude makes the smallest change that meets done-when, with tests, in the worktree.
6. **Check.** `cf-check` runs the check command in the worktree and logs it.
   **Two failures and it stops.** A hook then blocks Edit, Write, and Bash until a human resets.
7. **PR + evidence.** Claude pushes the branch. `cf-evidence` builds the evidence pack, which becomes the PR body.
8. **Stop.** Claude reports the PR and ends its turn. A human reviews and merges.

## Readiness rules

`cf-ready` accepts a ticket only if it is **open**, **small**, and shows **at least one ready signal**.

Small:

- no `epic`, `size:L`, `size:XL`, or `large` label (`CF_TOO_BIG_LABELS`)
- at most 12 checklist items in the body (`CF_MAX_TASKS`)

Ready signals (any one is enough):

- a `factory-ready`, `sdv`, or `ready` label (`CF_READY_LABELS`)
- a `DONE_WHEN` / `Done when` section, or Gherkin (`Scenario:` or `Given` / `When` / `Then`) in the body
- a documented check command in the repo, found in this order:
  1. `CF_CHECK` environment variable
  2. `.claude-factory/check` (a committed shell script)
  3. `package.json` `scripts.test` (run with npm, pnpm, yarn, or bun, based on the lockfile)
  4. a Makefile `test:` target

On success `cf-ready` prints JSON (`repo`, `number`, `title`, `url`, `labels`, `check_cmd`, `ready_reasons`).
On failure it exits non-zero and says why on stderr.

`next` and the watch queue use open issues labeled `factory-ready` or `sdv` (`CF_QUEUE_LABELS`),
oldest first, skipping `factory-claimed`.

## The 2-fail hard stop

`cf-check` counts failures per ticket in `.claude-factory/state.json`. After the second failure:

- `cf-check` and `cf-claim` refuse to run (exit 3).
- The plugin's `PreToolUse` hook denies Edit, Write, and Bash. Only `git status`, `git diff`, `git log`,
  `git show`, and `cf-check --status` stay allowed.
- Claude summarizes what failed and hands it to you.

To allow two more attempts, a human either:

- types `cf-reset` as a prompt in Claude Code (a `UserPromptSubmit` hook resets the counter; Claude never sees the prompt), or
- runs `cf-check --reset` from their own terminal (it refuses to run without a TTY).

The hook also always denies `cf-check --reset`, Bash commands that touch the factory state files,
edits to `state.json` / `claim.json`, `gh pr merge`, and `--dangerously-skip-permissions` while a
factory claim exists. Re-claiming the same ticket never resets its counter.
The hook is a no-op in repos without factory state.

## Evidence and human merge

`cf-evidence` renders `templates/evidence.md` into `.claude-factory/evidence.md`, which becomes the PR body:

- the ticket link and `Closes owner/repo#N`
- branch and base
- the check command, result, and failure count
- commits and diffstat
- the last 40 lines of the check log
- the plan

A failing or missing check is marked **do not merge**. Claude Factory never merges, approves, or
pushes to the base branch. Merging is always a human decision.

## Watch: draining the queue

`/factory:watch` (or the `cf-watch` script) drains the queue **one ticket at a time**. For each issue it:

1. runs `cf-claim` (which runs `cf-ready`) and `cf-worktree`,
2. starts `claude -p "/factory:sdv owner/repo#N"` inside the worktree, with `--add-dir` for the state directory,
3. appends the outcome to `.claude-factory/watch-ledger.jsonl` and logs the run to `.claude-factory/runs/`.

It stops at the first hard stop, or when a run ends without a PR. Issues already in the ledger are skipped;
delete a ledger line to retry one.

```bash
cf-watch --dry-run            # show the queue
cf-watch --once               # one ticket, then exit
cf-watch --max 3              # at most three tickets
cf-watch --interval 600       # poll every 10 minutes when the queue is empty
```

The `cf-*` tools are on Claude's PATH inside Claude Code. To use them from your own terminal,
put a clone's `bin/` on your PATH:

```bash
git clone https://github.com/patrob/claude-factory ~/src/claude-factory
export PATH="$PATH:$HOME/src/claude-factory/plugins/factory/bin"
```

(The installed copy also lives under `~/.claude/plugins/cache/claude-factory/factory/`.)

### v0.1 limitations

- **Not a daemon.** `cf-watch` runs only while its process lives. There is no launchd or systemd unit.
  Run it in a terminal, `tmux`, a cron job, or a scheduled routine.
- **Needs auth.** The shell that runs it needs Claude Code auth and `gh auth`.
- **Fixed permissions.** Headless sessions use `--permission-mode acceptEdits` and a fixed tool allowlist
  (the `cf-*` tools, basic git, `gh issue view`, `gh pr create`). Build steps outside that list, such as
  `npm install`, are denied. Add them with `CF_WATCH_ALLOWED_TOOLS="Bash(npm install),Bash(npm run *)"`.
- **Serial only.** One ticket, one worktree, one PR at a time. No multi-lane supervisor.
- **Stops for humans.** An in-progress claim, a hard stop, or a run without a PR stops the drain.
- **Local ledger.** The ledger and claims live in one checkout. Two machines draining the same repo
  can collide unless both use `CF_WATCH_REMOTE=1` (claims add the `factory-claimed` label).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CF_CHECK` | detected | Check command to run |
| `CF_MAX_FAILURES` | `2` | Failures before the hard stop (applies to new claims) |
| `CF_READY_LABELS` | `factory-ready sdv ready` | Labels that mark a ticket ready |
| `CF_QUEUE_LABELS` | `factory-ready sdv` | Labels that `next` and `watch` pick from |
| `CF_CLAIMED_LABEL` | `factory-claimed` | Label added by `cf-claim --remote` |
| `CF_TOO_BIG_LABELS` | `epic size:L size:XL large` | Labels that make a ticket too big |
| `CF_MAX_TASKS` | `12` | Max checklist items in a ticket body |
| `CF_PRIMARY_GUARD` | `0` | `1` keeps all state in `.git/claude-factory/` and denies edits to the primary checkout once a worktree exists. Always on when the repo path contains `ship-it`. |
| `CF_WATCH_PERMISSION_MODE` | `acceptEdits` | Permission mode for headless runs |
| `CF_WATCH_ALLOWED_TOOLS` | — | Extra comma-separated tool rules for headless runs |
| `CF_WATCH_MODEL` | — | Model for headless runs |
| `CF_WATCH_REMOTE` | `0` | `1` makes watch claims comment and label on GitHub |

Runtime state lives in `<primary checkout>/.claude-factory/` (or `.git/claude-factory/` in guard mode).
`cf-claim` adds those files to `.git/info/exclude`, so they never show in `git status`.
A committed `.claude-factory/check` script is not hidden.

## What v0.1 does not do

- No daemon or launchd service
- No auto-merge, approvals, or pushes to the base branch
- No `--dangerously-skip-permissions`
- No multi-lane or parallel tickets
- No ADR corpus or long-term memory
- GitHub only (uses `gh`)

## Layout

```
.claude-plugin/marketplace.json     marketplace "claude-factory"
plugins/factory/
├── .claude-plugin/plugin.json      plugin "factory"
├── skills/sdv/SKILL.md             /factory:sdv
├── skills/watch/SKILL.md           /factory:watch
├── hooks/hooks.json                PreToolUse + UserPromptSubmit → hooks/cf-guard.sh
├── bin/                            cf-ready cf-claim cf-worktree cf-check cf-evidence cf-watch
├── lib/cf-common.sh                shared helpers
└── templates/                      plan.md evidence.md
tests/smoke.sh                      offline end-to-end test (stub gh + claude)
```

## Development

```bash
tests/smoke.sh                           # bash on PATH
CF_TEST_BASH=/bin/bash tests/smoke.sh    # macOS bash 3.2
claude plugin validate ./plugins/factory
claude plugin validate .
claude --plugin-dir ./plugins/factory    # try it without installing
```

## License

MIT © 2026 Patrick Robinson. See [LICENSE](LICENSE).
