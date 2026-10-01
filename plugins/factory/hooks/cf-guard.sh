#!/usr/bin/env bash
# claude-factory guard hook.
#   PreToolUse:       enforce the 2-fail hard stop, the human-only reset, and "never merge".
#   UserPromptSubmit: a human typing exactly "cf-reset" zeroes the failure counter.
# Does nothing in repos without claude-factory state.
set -euo pipefail

input=$(cat)
command -v jq >/dev/null 2>&1 || exit 0

field() { jq -r "$1 // empty" <<<"$input"; }
event=$(field .hook_event_name)
cwd=$(field .cwd)
[[ -n "$cwd" && -d "$cwd" ]] || cwd=$PWD

root=""
if common=$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then
  root=$(dirname "$common")
fi
dirs=(${root:+"$root/.claude-factory" "$root/.git/claude-factory"} "$cwd/.claude-factory")
if [[ "${CF_PRIMARY_GUARD:-0}" == "1" || "$root" == *ship-it* ]]; then
  dirs=(${root:+"$root/.git/claude-factory"} "${dirs[@]}")
fi
state_dir=""
for d in "${dirs[@]}"; do
  if [[ -f "$d/state.json" ]]; then state_dir=$d; break; fi
done

if [[ "$event" == "UserPromptSubmit" ]]; then
  [[ "$(field .prompt | tr -d '[:space:]')" == "cf-reset" ]] || exit 0
  if [[ -z "$state_dir" ]]; then
    jq -n '{decision: "block", reason: "claude-factory: no factory state here, nothing to reset."}'
    exit 0
  fi
  tmp=$(mktemp "$state_dir/state.json.XXXXXX")
  jq --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.check_failures = 0 | .reset_at = $at | .reset_by = "human (cf-reset prompt)" | .updated_at = $at' \
    "$state_dir/state.json" >"$tmp" && mv "$tmp" "$state_dir/state.json"
  issue=$(jq -r '.issue // "?"' "$state_dir/state.json")
  jq -n --arg r "claude-factory: failure counter reset for #$issue. Claude may run cf-check again (2 more attempts)." \
    '{decision: "block", reason: $r}'
  exit 0
fi

[[ "$event" == "PreToolUse" && -n "$state_dir" ]] || exit 0

deny() {
  jq -n --arg r "claude-factory: $1" \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}'
  exit 0
}

tool=$(field .tool_name)
cmd=$(field .tool_input.command)
path=$(field '.tool_input.file_path // .tool_input.notebook_path')
state="$state_dir/state.json"
claim="$state_dir/claim.json"

# Always: only a human resets the counter, and nobody merges.
case "$tool" in
  Bash)
    if grep -Eq 'cf-check[^|;&]*--reset' <<<"$cmd"; then
      deny "cf-check --reset is human-only. Ask the human to type cf-reset as a prompt."
    fi
    if grep -Eq 'claude-factory/(state|claim)\.json' <<<"$cmd"; then
      deny "do not touch the factory state file from Bash. Use 'cf-check --status' to read it."
    fi
    if grep -Eq 'gh[[:space:]]+pr[[:space:]]+merge|--dangerously-skip-permissions' <<<"$cmd"; then
      deny "claude-factory never merges or skips permissions. Stop and hand the PR to a human."
    fi
    ;;
  Edit | Write | MultiEdit | NotebookEdit)
    case "$path" in
      */claude-factory/state.json | */.claude-factory/state.json | */claude-factory/claim.json | */.claude-factory/claim.json)
        deny "factory state files are managed by the cf-* tools only."
        ;;
    esac
    ;;
esac

# Hard stop: after max failures, no more edits or commands except read-only status.
failures=$(jq -r '.check_failures // 0' "$state" 2>/dev/null || echo 0)
max=$(jq -r '.max_failures // 2' "$state" 2>/dev/null || echo 2)
if ((failures >= max)); then
  issue=$(jq -r '.issue // "?"' "$state")
  reason="HARD STOP — cf-check failed $failures time(s) for #$issue. Stop working on this ticket. Summarize what failed (see 'cf-check --status' and the check log) and ask the human to decide. Only a human can allow more attempts, by typing cf-reset as a prompt."
  case "$tool" in
    Bash)
      if ! grep -Eq '[;&|<>`]|\$\(' <<<"$cmd" &&
        grep -Eq '^[[:space:]]*(cf-check --status|git (status|diff|log|show))([[:space:]]|$)' <<<"$cmd"; then
        exit 0
      fi
      deny "$reason"
      ;;
    *) deny "$reason" ;;
  esac
fi

# Primary guard: once a worktree exists, edits belong in the worktree, not the primary checkout.
if [[ -f "$claim" && "$(jq -r '.primary_guard // false' "$claim")" == "true" && -n "$path" ]]; then
  wt=$(jq -r '.worktree // empty' "$claim")
  primary=$(jq -r '.primary_root // empty' "$claim")
  if [[ -n "$wt" && -n "$primary" && "$path" == "$primary/"* && "$path" != "$state_dir/"* ]]; then
    deny "primary guard is on — edit files under $wt, not the primary checkout $primary."
  fi
fi

exit 0
