#!/usr/bin/env bash
# Offline smoke test for the factory plugin: stub gh + claude, temp git repos.
# Usage: tests/smoke.sh            (uses the bash on PATH)
#        CF_TEST_BASH=/bin/bash tests/smoke.sh   (macOS bash 3.2)
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
plugin="$here/../plugins/factory"
tmp=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$tmp"' EXIT

pass=0 fail=0
ok() { pass=$((pass + 1)); echo "  ok   $*"; }
bad() { fail=$((fail + 1)); echo "  FAIL $*"; }
expect_rc() { # want desc cmd...
  local want=$1 desc=$2 rc=0
  shift 2
  "$@" >"$tmp/out" 2>"$tmp/err" || rc=$?
  if [[ "$rc" == "$want" ]]; then ok "$desc"; else bad "$desc (rc=$rc, want $want)"; sed 's/^/       /' "$tmp/err"; fi
}

# --- stubs -----------------------------------------------------------------
mkdir -p "$tmp/stubs" "$tmp/issues"
if [[ -n "${CF_TEST_BASH:-}" ]]; then ln -s "$CF_TEST_BASH" "$tmp/stubs/bash"; fi
cat >"$tmp/stubs/gh" <<'EOF'
#!/usr/bin/env bash
# Minimal gh stub. Issues are JSON files in $CF_TEST_ISSUES/<n>.json.
set -euo pipefail
args="$*"
echo "$args" >>"$CF_TEST_GH_LOG"
jqexpr=""; prev=""
for a in "$@"; do [[ "$prev" == "--jq" || "$prev" == "-q" ]] && jqexpr=$a; prev=$a; done
out() { if [[ -n "$jqexpr" ]]; then jq -r "$jqexpr"; else cat; fi; }
case "$args" in
  "repo view --json nameWithOwner"*) echo "acme/widget" ;;
  "repo view acme/widget --json defaultBranchRef"*) echo '{"defaultBranchRef":{"name":"main"}}' | out ;;
  "issue view "*) n=$3; [[ -f "$CF_TEST_ISSUES/$n.json" ]] || { echo "not found" >&2; exit 1; }; out <"$CF_TEST_ISSUES/$n.json" ;;
  "issue list "*)
    label=$(sed -E 's/.*--label ([^ ]+).*/\1/' <<<"$args")
    jq -s --arg l "$label" '[.[] | select(.state == "OPEN" and ([.labels[].name] | index($l)))]' "$CF_TEST_ISSUES"/*.json | out ;;
  *) echo "gh stub: unhandled: $args" >&2; exit 1 ;;
esac
EOF
cat >"$tmp/stubs/claude" <<'EOF'
#!/usr/bin/env bash
# claude stub: pretend the sdv skill ran — commit, pass the check, record a PR.
set -euo pipefail
echo "claude stub: $*"
echo "done" >feature.txt
git add feature.txt && git commit -qm "feat: stub change"
cf-check && cf-evidence >/dev/null && cf-claim --pr "https://github.com/acme/widget/pull/99" >/dev/null
EOF
chmod +x "$tmp/stubs/"*
export PATH="$tmp/stubs:$plugin/bin:$PATH" CF_TEST_ISSUES="$tmp/issues" CF_TEST_GH_LOG="$tmp/gh.log"
: >"$CF_TEST_GH_LOG"
unset CF_CHECK CF_PRIMARY_GUARD || true

issue() { # n title labels-json body
  jq -n --argjson n "$1" --arg t "$2" --argjson l "$3" --arg b "$4" \
    '{number: $n, title: $t, url: "https://github.com/acme/widget/issues/\($n)", state: "OPEN",
      labels: [$l[] | {name: .}], body: $b}' >"$tmp/issues/$1.json"
}
issue 1 "Add a widget" '["factory-ready"]' "Make a widget."
issue 2 "Vague idea" '[]' "Something something."
issue 3 "Gherkin ticket" '[]' $'Scenario: it works\n  Given a\n  When b\n  Then c'
issue 4 "Huge epic" '["factory-ready","epic"]' "All the things."
issue 5 "Second queued" '["sdv"]' "Done when: it is done."

# --- repos -----------------------------------------------------------------
git init -q --bare -b main "$tmp/origin.git"
git clone -q "$tmp/origin.git" "$tmp/widget" 2>/dev/null
cd "$tmp/widget"
git config user.name "Smoke Test" && git config user.email smoke@example.com
printf 'test:\n\t@test ! -f fail.flag\n' >Makefile
git add Makefile && git commit -qm init && git push -q origin main
git remote set-head origin main

echo "cf-ready"
expect_rc 0 "labeled issue is ready" cf-ready 1
jq -e '.check_cmd == "make test" and (.ready_reasons | index("label:factory-ready"))' "$tmp/out" >/dev/null &&
  ok "ready JSON has check_cmd and reasons" || bad "ready JSON: $(cat "$tmp/out")"
expect_rc 0 "gherkin issue is ready" cf-ready acme/widget#3
expect_rc 1 "epic is refused" cf-ready 4
grep -q "Split it" "$tmp/err" && ok "epic refusal explains why" || bad "epic stderr: $(cat "$tmp/err")"
expect_rc 0 "next picks the oldest queued issue" cf-ready next
jq -e '.number == 1' "$tmp/out" >/dev/null && ok "next == #1" || bad "next: $(cat "$tmp/out")"
mv Makefile Makefile.off
expect_rc 1 "vague issue without check command is refused" cf-ready 2
grep -q "NOT READY" "$tmp/err" && ok "refusal says NOT READY" || bad "stderr: $(cat "$tmp/err")"
mv Makefile.off Makefile
expect_rc 1 "malformed #ref still errors" cf-ready "#abc"
expect_rc 1 "malformed owner/repo#x still errors" cf-ready acme/widget#x

echo "cf-claim / cf-worktree"
expect_rc 0 "claim #1" cf-claim https://github.com/acme/widget/issues/1
[[ -f .claude-factory/plan.md ]] && grep -q "acme/widget#1: Add a widget" .claude-factory/plan.md &&
  ok "plan seeded from template" || bad "plan.md missing"
[[ -z "$(git status --porcelain)" ]] && ok "state dir hidden from git status" || bad "primary dirty: $(git status --porcelain)"
expect_rc 1 "second ticket refused while #1 in progress" cf-claim 5
expect_rc 0 "worktree created" cf-worktree
wt=$(cat "$tmp/out")
[[ "$wt" == "$tmp/widget-cf-1" && -d "$wt" ]] && ok "worktree at sibling path" || bad "worktree path: $wt"
[[ "$(git -C "$wt" branch --show-current)" == "cf/1-add-a-widget" ]] && ok "branch cf/1-add-a-widget" || bad "branch"
[[ "$(git branch --show-current)" == "main" ]] && ok "primary still on main" || bad "primary branch moved"
expect_rc 0 "worktree reused" cf-worktree

echo "cf-check + hard stop"
touch "$wt/fail.flag"
expect_rc 1 "first failure" cf-check
expect_rc 3 "second failure is a hard stop" cf-check
grep -q "HARD STOP" "$tmp/err" && ok "hard stop banner" || bad "no banner"
expect_rc 3 "check refuses while stopped" cf-check
expect_rc 3 "claim refuses while stopped" cf-claim 5

hook() { jq -n --arg e "$1" --arg t "${2:-}" --arg c "${3:-}" --arg p "${4:-}" --arg cwd "$PWD" \
  '{hook_event_name: $e, cwd: $cwd, tool_name: $t, tool_input: {command: $c, file_path: $p}, prompt: $c}' |
  "$plugin/hooks/cf-guard.sh"; }
decision() { # prints deny / block / allow (the hook prints nothing to allow)
  local out
  out=$(hook "$@")
  if [[ -z "$out" ]]; then echo allow; else jq -r '.hookSpecificOutput.permissionDecision // .decision' <<<"$out"; fi
}

echo "hook"
[[ "$(decision PreToolUse Edit "" "$wt/x.txt")" == deny ]] && ok "Edit denied after hard stop" || bad "Edit allowed"
[[ "$(decision PreToolUse Bash "npm test")" == deny ]] && ok "Bash denied after hard stop" || bad "Bash allowed"
[[ "$(decision PreToolUse Bash "git status")" == allow ]] && ok "git status allowed" || bad "git status denied"
[[ "$(decision PreToolUse Bash "git status; rm -rf /")" == deny ]] && ok "chained command denied" || bad "chain allowed"
[[ "$(decision PreToolUse Bash "cf-check --reset")" == deny ]] && ok "Claude cannot reset" || bad "reset allowed"
expect_rc 1 "cf-check --reset needs a terminal" cf-check --reset </dev/null
[[ "$(decision UserPromptSubmit "" "cf-reset")" == block ]] && ok "human cf-reset prompt handled" || bad "cf-reset"
[[ "$(jq .check_failures .claude-factory/state.json)" == 0 ]] && ok "counter reset to 0" || bad "counter not reset"
[[ "$(decision PreToolUse Edit "" "$wt/x.txt")" == allow ]] && ok "Edit allowed after reset" || bad "Edit still denied"
[[ "$(decision PreToolUse Bash "gh pr merge 99")" == deny ]] && ok "gh pr merge always denied" || bad "merge allowed"
[[ "$(decision PreToolUse Write "" "$PWD/.claude-factory/state.json")" == deny ]] && ok "state.json write denied" || bad "state write allowed"
[[ "$(cd "$tmp" && decision PreToolUse Bash "npm test")" == allow ]] && ok "no-op outside factory repos" || bad "hook leaked"

echo "pass + evidence"
rm "$wt/fail.flag"
echo hi >"$wt/hello.txt" && git -C "$wt" add hello.txt && git -C "$wt" commit -qm "feat: hello"
expect_rc 0 "check passes" cf-check
expect_rc 0 "evidence built" cf-evidence
ev=$(cat "$tmp/out")
grep -q "Closes acme/widget#1" "$ev" && grep -q "✅ PASS" "$ev" && grep -q "feat: hello" "$ev" &&
  grep -q "Human merge required" "$ev" && ! grep -q '{{' "$ev" && ok "evidence rendered" || bad "evidence: $(cat "$ev")"
expect_rc 0 "record PR" cf-claim --pr https://github.com/acme/widget/pull/1

echo "cf-watch"
echo '{"issue":1,"outcome":"pr-opened"}' >>.claude-factory/watch-ledger.jsonl
expect_rc 0 "dry run" cf-watch --dry-run
grep -q "#5" "$tmp/out" && grep -q "already attempted" "$tmp/out" && ok "dry run lists queue" || bad "dry run: $(cat "$tmp/out")"
expect_rc 0 "watch --once drains #5 via headless claude" cf-watch --once
tail -n1 .claude-factory/watch-ledger.jsonl | jq -e '.issue == 5 and .outcome == "pr-opened"' >/dev/null &&
  ok "ledger records PR for #5" || bad "ledger: $(tail -n1 .claude-factory/watch-ledger.jsonl)"
[[ -d "$tmp/widget-cf-5" ]] && ok "watch used worktree widget-cf-5" || bad "no worktree for #5"

echo "primary guard"
cf-claim --release >/dev/null 2>&1 || true
export CF_PRIMARY_GUARD=1
expect_rc 0 "guarded claim" cf-claim 3
[[ -f .git/claude-factory/claim.json && -f .git/claude-factory/plan.md ]] && ok "guard keeps state in .git" || bad "guard state"
expect_rc 0 "guarded worktree" cf-worktree
[[ "$(decision PreToolUse Edit "" "$PWD/Makefile")" == deny ]] && ok "primary edit denied in guard mode" || bad "primary edit allowed"
[[ "$(decision PreToolUse Edit "" "$tmp/widget-cf-3/Makefile")" == allow ]] && ok "worktree edit allowed in guard mode" || bad "worktree edit denied"
unset CF_PRIMARY_GUARD

echo "free-text task"
git clone -q "$tmp/origin.git" "$tmp/gizmo"
cd "$tmp/gizmo"
git config user.name "Smoke Test" && git config user.email smoke@example.com
git remote set-head origin main
: >"$CF_TEST_GH_LOG"

mv Makefile Makefile.off
expect_rc 1 "free text without check command is refused" cf-ready "fix flaky retry logic in worker pool"
mv Makefile.off Makefile
expect_rc 0 "free text is ready" cf-ready "fix flaky retry logic in worker pool"
jq -e '.local == true and (.number | test("^local-[0-9a-f]{8}$")) and .url == null and (.ready_reasons | index("free-text"))' "$tmp/out" >/dev/null &&
  ok "ready JSON is a local task" || bad "ready JSON: $(cat "$tmp/out")"

expect_rc 0 "claim free text" cf-claim "fix flaky retry logic in worker pool"
jq -e '.local == true and .task == "fix flaky retry logic in worker pool"' .claude-factory/claim.json >/dev/null &&
  ok "claim.json records the local task" || bad "claim.json: $(cat .claude-factory/claim.json)"
grep -q "fix flaky retry logic in worker pool" .claude-factory/plan.md &&
  grep -q "local task (no GitHub issue)" .claude-factory/plan.md &&
  ok "local plan seeded" || bad "plan.md: $(cat .claude-factory/plan.md)"
expect_rc 0 "re-claim same text reuses it" cf-claim fix flaky retry logic in worker pool

expect_rc 0 "local worktree created" cf-worktree
wt=$(cat "$tmp/out")
[[ "$wt" == "$tmp"/gizmo-cf-local-* && -d "$wt" ]] && ok "local worktree at sibling path" || bad "worktree path: $wt"
branch=$(git -C "$wt" branch --show-current)
[[ "$branch" == cf/local-* && "$branch" == *fix-flaky-retry* ]] && ok "local branch name" || bad "branch: $branch"

echo "local worktree" >"$wt/local.txt" && git -C "$wt" add local.txt && git -C "$wt" commit -qm "feat: local change"
expect_rc 0 "local check passes" cf-check
expect_rc 0 "local evidence built" cf-evidence
ev=$(cat "$tmp/out")
grep -q "Local task" "$ev" && grep -q "Human merge required" "$ev" && grep -q "✅ PASS" "$ev" &&
  ! grep -q "Closes" "$ev" && ! grep -q '{{' "$ev" && ok "local evidence rendered" || bad "evidence: $(cat "$ev")"
expect_rc 0 "record local PR" cf-claim --pr "https://github.com/acme/widget/pull/100"

! grep -qE '^issue (create|view|edit|comment)' "$CF_TEST_GH_LOG" && ok "no GitHub issue touched for the local task" ||
  bad "gh log: $(cat "$CF_TEST_GH_LOG")"

echo
echo "$pass passed, $fail failed ($(bash -c 'echo $BASH_VERSION'))"
((fail == 0))
