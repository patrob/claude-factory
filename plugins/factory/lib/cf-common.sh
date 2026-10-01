# shellcheck shell=bash
# Shared helpers for the claude-factory bin scripts. Sourced, never executed.
# Keep this compatible with macOS /bin/bash 3.2: no mapfile, no ${x,,}, guard empty arrays.

CF_PLUGIN_ROOT="${CF_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CF_MAX_FAILURES="${CF_MAX_FAILURES:-2}"
CF_READY_LABELS="${CF_READY_LABELS:-factory-ready sdv ready}"
CF_QUEUE_LABELS="${CF_QUEUE_LABELS:-factory-ready sdv}"
CF_CLAIMED_LABEL="${CF_CLAIMED_LABEL:-factory-claimed}"
CF_TOO_BIG_LABELS="${CF_TOO_BIG_LABELS:-epic size:L size:XL large}"
CF_MAX_TASKS="${CF_MAX_TASKS:-12}"

cf_me() { basename "$0"; }
cf_die() { echo "$(cf_me): $*" >&2; exit 1; }
cf_log() { echo "$(cf_me): $*" >&2; }
cf_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

cf_require() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || cf_die "missing required command: $c"
  done
}

# Root of the primary checkout, even when called from inside a linked worktree.
cf_primary_root() {
  local common
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || cf_die "not inside a git repository"
  [[ "$(basename "$common")" == ".git" ]] || cf_die "unsupported repository layout (git dir: $common)"
  dirname "$common"
}

# Guard mode keeps every byte of runtime state out of the primary working tree.
cf_guard_on() {
  [[ "${CF_PRIMARY_GUARD:-0}" == "1" ]] && return 0
  case "$(cf_primary_root)" in *ship-it*) return 0 ;; esac
  return 1
}

# State lives with the primary checkout so the primary session, the worktree, and the hook all agree on it.
cf_state_dir() {
  local root
  root=$(cf_primary_root) || exit 1
  if cf_guard_on; then echo "$root/.git/claude-factory"; else echo "$root/.claude-factory"; fi
}

cf_init_state_dir() {
  local dir root exclude
  dir=$(cf_state_dir) || exit 1
  root=$(cf_primary_root) || exit 1
  mkdir -p "$dir/runs"
  # Hide runtime files from `git status` without hiding a committed .claude-factory/check.
  exclude="$root/.git/info/exclude"
  if [[ "$dir" == "$root/.claude-factory" ]] && ! grep -qsF '/.claude-factory/*.json' "$exclude"; then
    mkdir -p "$(dirname "$exclude")"
    printf '%s\n' '# claude-factory runtime state' '/.claude-factory/*.json' '/.claude-factory/*.jsonl' \
      '/.claude-factory/*.md' '/.claude-factory/runs/' >>"$exclude"
  fi
  echo "$dir"
}

cf_json_get() {
  local file=$1 query=$2
  [[ -f "$file" ]] || return 0
  jq -r "($query) // empty" "$file"
}

# cf_json_update FILE JQ_ARGS... — rewrite FILE in place through jq.
cf_json_update() {
  local file=$1 tmp
  shift
  tmp=$(mktemp "$file.XXXXXX")
  if jq "$@" "$file" >"$tmp"; then mv "$tmp" "$file"; else rm -f "$tmp"; return 1; fi
}

cf_current_repo() {
  local url
  if gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null; then return 0; fi
  url=$(git remote get-url origin 2>/dev/null) || cf_die "cannot determine repository; pass owner/repo#N"
  echo "$url" | sed -E 's#^(git@|ssh://git@|https://)github\.com[:/]##; s#\.git$##'
}

# Open issues carrying a queue label and not yet claimed, oldest first.
cf_queue() {
  local repo=$1 label
  for label in $CF_QUEUE_LABELS; do
    gh issue list -R "$repo" --state open --label "$label" --limit 100 --json number,labels \
      --jq ".[] | select([.labels[].name] | index(\"$CF_CLAIMED_LABEL\") | not) | .number"
  done | sort -n | uniq
}

# Sets CF_REPO (owner/name) and CF_NUM from: owner/repo#N, an issue URL (http/https, optional
# www., tolerating a trailing slash/query/fragment), #N, N, or "next" (case-insensitive; empty
# also means "next"). Dies with a clear message on a /pull/N URL or an unparseable reference.
cf_resolve_issue() {
  local ref="${1:-}" lower
  CF_REPO="" CF_NUM=""
  # Trim surrounding whitespace.
  ref="${ref#"${ref%%[![:space:]]*}"}"
  ref="${ref%"${ref##*[![:space:]]}"}"
  lower=$(printf '%s' "$ref" | tr '[:upper:]' '[:lower:]')
  case "$lower" in
    http://github.com/*/pull/* | https://github.com/*/pull/* | http://www.github.com/*/pull/* | https://www.github.com/*/pull/*)
      cf_die "'$ref' is a pull request, not an issue (use an issue URL, owner/repo#N, N, or 'next')" ;;
    http://github.com/*/issues/* | https://github.com/*/issues/* | http://www.github.com/*/issues/* | https://www.github.com/*/issues/*)
      CF_REPO=$(echo "$ref" | sed -E 's#^[Hh][Tt][Tt][Pp][Ss]?://([Ww][Ww][Ww]\.)?[Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm]/([^/]+/[^/]+)/issues/.*#\2#')
      CF_NUM=$(echo "$ref" | sed -E 's#^.*/issues/([0-9]+)([/?#].*)?$#\1#')
      ;;
    */*'#'*) CF_REPO="${ref%%#*}" CF_NUM="${ref##*#}" ;;
    '#'*) CF_NUM="${ref#\#}" ;;
    '' | next) ref=next ;;
    *) CF_NUM="$ref" ;;
  esac
  if [[ -n "$CF_REPO" && ! "$CF_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    cf_die "cannot parse issue reference '$ref' (use owner/repo#N, an issue URL, N, or 'next')"
  fi
  [[ -n "$CF_REPO" ]] || CF_REPO=$(cf_current_repo) || exit 1
  if [[ "$ref" == "next" ]]; then
    CF_NUM=$(cf_queue "$CF_REPO" | awk 'NR == 1')
    [[ -n "$CF_NUM" ]] || cf_die "no open, unclaimed issues in $CF_REPO labeled: $CF_QUEUE_LABELS"
  fi
  [[ "$CF_NUM" =~ ^[0-9]+$ ]] || cf_die "cannot parse issue reference '$ref' (use owner/repo#N, an issue URL, N, or 'next')"
}

# Prints the check command for directory $1 (default: cwd). Returns 1 when none is documented.
cf_detect_check() {
  local dir="${1:-$PWD}"
  if [[ -n "${CF_CHECK:-}" ]]; then echo "$CF_CHECK"; return 0; fi
  if [[ -f "$dir/.claude-factory/check" ]]; then echo "bash .claude-factory/check"; return 0; fi
  if [[ -f "$dir/package.json" ]] &&
    jq -e '.scripts.test // empty | test("no test specified") | not' "$dir/package.json" >/dev/null 2>&1; then
    if [[ -f "$dir/pnpm-lock.yaml" ]]; then echo "pnpm test"
    elif [[ -f "$dir/yarn.lock" ]]; then echo "yarn test"
    elif [[ -f "$dir/bun.lock" || -f "$dir/bun.lockb" ]]; then echo "bun run test"
    else echo "npm test"; fi
    return 0
  fi
  if [[ -f "$dir/Makefile" ]] && grep -qE '^test[[:space:]]*:' "$dir/Makefile"; then echo "make test"; return 0; fi
  return 1
}

# cf_render TEMPLATE KEY=VALUE... — literal {{KEY}} substitution; values may span lines.
cf_render() {
  local tpl=$1 kv keys=""
  shift
  for kv in "$@"; do
    export "CFV_${kv%%=*}=${kv#*=}"
    keys="$keys ${kv%%=*}"
  done
  CFV_KEYS="$keys" awk '
    BEGIN { n = split(ENVIRON["CFV_KEYS"], k, " ") }
    {
      line = $0
      for (i = 1; i <= n; i++) {
        pat = "{{" k[i] "}}"; val = ENVIRON["CFV_" k[i]]; out = ""
        while ((p = index(line, pat)) > 0) {
          out = out substr(line, 1, p - 1) val
          line = substr(line, p + length(pat))
        }
        line = out line
      }
      print line
    }' "$tpl"
}

cf_failures() { local v; v=$(cf_json_get "$1" .check_failures); echo "${v:-0}"; }
cf_max_failures() { local v; v=$(cf_json_get "$1" .max_failures); echo "${v:-$CF_MAX_FAILURES}"; }

cf_hard_stop_message() {
  cat >&2 <<EOF

  ┌─ claude-factory HARD STOP ─────────────────────────────────────────┐
    The check failed $1 time(s) for issue #$2. No more attempts.
    Claude must stop and hand this to a human.

    A human can allow more attempts by either:
      • typing  cf-reset  as a prompt in Claude Code, or
      • running  cf-check --reset  from their own terminal.
  └────────────────────────────────────────────────────────────────────┘
EOF
}
