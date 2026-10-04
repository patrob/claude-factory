# factory (Claude Factory plugin)

Claim one ready ticket → plan → worktree → check (2-fail hard stop) → PR + evidence → human merge.

- `/factory:sdv <owner/repo#N | URL | N | next>` — one ticket to one PR, then stop for a human to merge
- `/factory:watch [status|once|drain]` — drain the labeled queue one ticket at a time via headless `claude -p`
- `/factory:floor` — open the factory-floor pane (ticket, stage, evidence, next skill). A mod: needs Claude Code v2.1.287+, draws in the terminal and the Desktop Code tab, prints text under `claude -p` and in VS Code chat
- Type `cf-reset` as a prompt to clear the failure counter after a hard stop (human only)

Tools on Claude's PATH while enabled: `cf-ready`, `cf-claim`, `cf-worktree`, `cf-check`, `cf-evidence`, `cf-watch`.
Each takes `--help`.

Full docs: <https://github.com/patrob/claude-factory#readme>
