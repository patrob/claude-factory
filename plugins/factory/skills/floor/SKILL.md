---
name: floor
description: Open the factory-floor pane — the claimed ticket, its stage in the claude-factory flow, the evidence so far, and the next skill to run. Use when the user runs /factory:floor.
disable-model-invocation: true
allowed-tools:
  - Bash(cf-check --status)
  - Bash(cf-claim --show)
---

# claude-factory: factory floor

`/factory:floor` opens a pane drawn by this plugin's mod (`hooks/floor.tsx`). When the mod is
loaded, it answers this command itself and opens the pane; you never see these instructions.

You are reading this because the mod did not load in this session (mods are off: `--safe-mode`,
`--bare`, `disableAllHooks`, or an organization policy). Show the floor as text instead:

1. Run `cf-check --status` and `cf-claim --show`. Both are read-only.
2. Report, in this order:
   - **Ticket**: `repo#issue` and title, or "none claimed".
   - **Stage**: the first of ready → claim → plan → worktree → check → evidence → PR → human merge
     that is not done yet (no claim: ready; claim without worktree: plan or worktree; worktree without
     a passing check: check; passing check: evidence; PR recorded: human merge).
   - **Evidence**: check command, last result, failures / max, PR URL if any.
   - **Next skill**: `/factory:sdv` and the step it resumes at, or "a human merges the PR".
3. If `hard_stop` is true, say so first: a human decides, and typing `cf-reset` allows more attempts.

Do not change anything. Do not merge, approve, or run any other command.
