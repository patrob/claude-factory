// Factory floor model: turns the files the cf-* tools write into what the pane shows.
// Pure functions, no `$`: the hooks module reads the files, this decides the stage.
// The source of truth stays the state dir that cf-claim, cf-worktree, cf-check and
// cf-evidence maintain. Nothing here writes to it.

import type { FloorEvidence, FloorNext, FloorSnapshot, FloorStage, FloorStageId, FloorTicket } from '../types'

export const STAGES: readonly { id: FloorStageId; label: string }[] = [
  { id: 'ready', label: 'Ready' },
  { id: 'claim', label: 'Claim' },
  { id: 'plan', label: 'Plan' },
  { id: 'worktree', label: 'Worktree' },
  { id: 'check', label: 'Check' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'pr', label: 'PR' },
  { id: 'merge', label: 'Human merge' },
]

export function stagePosition(id: FloorStageId): { index: number; label: string } {
  const index = STAGES.findIndex(st => st.id === id)
  return { index, label: STAGES[index]?.label ?? id }
}

export type FloorFiles = {
  repoRoot: string | null
  stateDir: string | null
  claim: string | null
  state: string | null
  plan: string | null
  evidence: string | null
}

type Claim = {
  issue?: number
  repo?: string
  title?: string
  url?: string
  status?: string
  claimed_at?: string
  claimed_by?: string
  ready_reasons?: string[]
  check_cmd?: string | null
  worktree?: string | null
  branch?: string | null
  base?: string | null
  pr?: string | null
}

type State = {
  issue?: number
  check_failures?: number
  max_failures?: number
  checks_run?: number
  updated_at?: string
  last_check?: { cmd?: string; result?: string; log?: string; at?: string } | null
}

// The same lookup order cf-guard.sh uses, so the pane and the guard agree on one state dir.
export function stateDirCandidates(root: string | null, cwd: string, guard: boolean): string[] {
  const inRoot = root ? [`${root}/.claude-factory`, `${root}/.git/claude-factory`] : []
  const dirs = [...inRoot, `${cwd}/.claude-factory`]
  if (root && (guard || root.includes('ship-it'))) dirs.unshift(`${root}/.git/claude-factory`)
  return [...new Set(dirs)]
}

function parseJson<T>(text: string | null): T | null {
  if (!text) return null
  try {
    const v: unknown = JSON.parse(text)
    return v && typeof v === 'object' ? (v as T) : null
  } catch {
    return null
  }
}

// A plan counts as written once its "Done when" section holds more than the template's comment.
export function planIsWritten(plan: string | null): boolean {
  if (!plan) return false
  const body = plan.replace(/<!--[\s\S]*?-->/g, '')
  const m = body.match(/^## Done when[^\n]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)
  return (m?.[1] ?? '').trim().length > 0
}

// cf-evidence stamps the ticket in its heading and the time in its "Generated" row.
export function evidenceStamp(evidence: string | null): { ref: string | null; at: string | null } {
  if (!evidence) return { ref: null, at: null }
  const ref = evidence.match(/evidence — (\S+#\d+)/)?.[1] ?? null
  const at = evidence.match(/^\| Generated \| ([^|]+?) \|/m)?.[1] ?? null
  return { ref, at }
}

function nextStep(id: FloorStageId, c: Claim, ev: FloorEvidence, stateDir: string | null): FloorNext {
  const sdv = '/factory:sdv'
  switch (id) {
    case 'ready':
    case 'claim':
      return {
        skill: `${sdv} next`,
        step: 'Steps 1–2 · Ready, Claim',
        run: 'cf-ready, then cf-claim',
        why: 'Takes the oldest open issue labeled factory-ready or sdv. /factory:watch drains the queue headless instead.',
        isHuman: false,
      }
    case 'plan':
      return {
        skill: sdv,
        step: 'Step 3 · Plan',
        run: `edit ${stateDir ?? '.claude-factory'}/plan.md`,
        why: 'Write Done when, approach, files, tests and out of scope. Too big for one PR: cf-claim --release and stop.',
        isHuman: false,
      }
    case 'worktree':
      return {
        skill: sdv,
        step: 'Step 4 · Worktree',
        run: 'cf-worktree',
        why: 'Creates ../<repo>-cf-<issue> on a fresh cf/<issue>-<slug> branch. Build only there.',
        isHuman: false,
      }
    case 'check': {
      const left = Math.max(0, ev.maxFailures - ev.failures)
      return ev.lastResult === 'fail'
        ? {
            skill: sdv,
            step: 'Step 6 · Check',
            run: 'cf-check',
            why: `Read the check log, fix the cause, commit, then cf-check once more (${left} attempt${left === 1 ? '' : 's'} left).`,
            isHuman: false,
          }
        : {
            skill: sdv,
            step: 'Steps 5–6 · Build, Check',
            run: 'cf-check',
            why: 'Make the smallest change in the worktree, commit it, then cf-check. It is the only judge of done.',
            isHuman: false,
          }
    }
    case 'evidence':
      return {
        skill: sdv,
        step: 'Step 7 · Evidence',
        run: c.branch ? `git -C <worktree> push -u origin ${c.branch}, then cf-evidence` : 'cf-evidence',
        why: 'Everything committed and pushed, then cf-evidence renders the PR body.',
        isHuman: false,
      }
    case 'pr':
      return {
        skill: sdv,
        step: 'Step 7 · PR',
        run: 'gh pr create --body-file <evidence.md>, then cf-claim --pr <url>',
        why: 'Opens the PR with the evidence pack as its body and records it on the claim.',
        isHuman: false,
      }
    case 'merge':
      return {
        skill: null,
        step: 'Step 8 · Stop',
        run: null,
        why: 'A human reviews the PR and the evidence, then merges it. The factory never merges.',
        isHuman: true,
      }
  }
}

function shortPr(url: string): string {
  const m = url.match(/\/pull\/(\d+)/)
  return m ? `PR #${m[1]}` : url
}

export function deriveFloor(files: FloorFiles): FloorSnapshot {
  const c = parseJson<Claim>(files.claim) ?? {}
  const s = parseJson<State>(files.state) ?? {}
  const active = c.issue !== undefined && c.status !== undefined && c.status !== 'released'

  const failures = s.check_failures ?? 0
  const maxFailures = s.max_failures ?? 2
  const hardStop = s.issue !== undefined && failures >= maxFailures
  const last = s.last_check ?? null
  const lastResult = last?.result === 'pass' || last?.result === 'fail' ? last.result : null
  const stamp = evidenceStamp(files.evidence)
  const ticketRef = active ? `${c.repo}#${c.issue}` : null
  const evidenceFresh =
    !!ticketRef && stamp.ref === ticketRef && lastResult === 'pass' && !!stamp.at && !!last?.at && stamp.at >= last.at
  const pr = active ? (c.pr ?? null) : null

  const evidence: FloorEvidence = {
    checkCmd: last?.cmd ?? (active ? (c.check_cmd ?? null) : null),
    lastResult,
    lastAt: last?.at ?? null,
    log: last?.log ?? null,
    checksRun: s.checks_run ?? 0,
    failures,
    maxFailures,
    evidencePath: evidenceFresh && files.stateDir ? `${files.stateDir}/evidence.md` : null,
    evidenceAt: evidenceFresh ? stamp.at : null,
    branch: active ? (c.branch ?? null) : null,
    base: active ? (c.base ?? null) : null,
    worktree: active ? (c.worktree ?? null) : null,
    pr,
  }

  // Each stage is done once the artifact the cf-* tool leaves behind is there.
  const hasPr = !!pr
  const done: Record<FloorStageId, boolean> = {
    ready: active,
    claim: active,
    plan: active && (planIsWritten(files.plan) || !!c.worktree || hasPr),
    worktree: active && (!!c.worktree || hasPr),
    check: active && (lastResult === 'pass' || hasPr),
    evidence: active && (evidenceFresh || hasPr),
    pr: hasPr,
    merge: false,
  }
  const current = STAGES.find(st => !done[st.id])?.id ?? 'merge'

  const notes: Record<FloorStageId, string> = {
    ready: active ? (c.ready_reasons ?? []).join(', ') : 'oldest factory-ready / sdv issue',
    claim: active ? [c.claimed_by, c.claimed_at].filter(Boolean).join(' · ') : '',
    plan: done.plan ? 'plan.md written' : active ? 'plan.md is still the template' : '',
    worktree: c.worktree && active ? (c.branch ?? c.worktree) : '',
    check: lastResult
      ? `${lastResult === 'pass' ? 'pass' : 'fail'} · ${failures}/${maxFailures} failures`
      : active
        ? 'not run yet'
        : '',
    evidence: evidenceFresh ? `evidence.md · ${stamp.at}` : hasPr ? 'in the PR body' : '',
    pr: pr ? shortPr(pr) : '',
    merge: pr ? 'waiting for a human' : '',
  }

  const stages: FloorStage[] = STAGES.map(st => ({
    id: st.id,
    label: st.label,
    status: done[st.id]
      ? 'done'
      : st.id === current
        ? hardStop && (st.id === 'check' || !active)
          ? 'blocked'
          : 'current'
        : 'todo',
    note: notes[st.id],
  }))

  const ticket: FloorTicket | null = active
    ? {
        repo: c.repo ?? '',
        number: c.issue ?? 0,
        title: c.title ?? '',
        url: c.url ?? '',
        status: c.status ?? '',
        claimedAt: c.claimed_at ?? null,
        claimedBy: c.claimed_by ?? null,
      }
    : null

  const next: FloorNext = hardStop
    ? {
        skill: null,
        step: 'Hard stop',
        run: 'cf-reset (typed by a human as a prompt)',
        why: `cf-check failed ${failures}/${maxFailures} times for #${s.issue}. Claude stops here. A human reads the log and decides; typing cf-reset allows ${maxFailures} more attempts.`,
        isHuman: true,
      }
    : nextStep(current, c, evidence, files.stateDir)

  return {
    repoRoot: files.repoRoot,
    stateDir: files.stateDir,
    ticket,
    current,
    hardStop,
    stages,
    evidence,
    next,
    updatedAt: s.updated_at ?? null,
  }
}

export type RequestUsage = {
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheCreationTokens: number | null
}

export type SessionUsageSnap = {
  // $.session.usage().context.tokens: uncached + cache-write + cache-read together.
  // Absent until the first response of the live window. Not a substitute for `in`.
  contextTokens: number | null
  // $.session.usage().cost.usd. Absent only when the host has no cost ledger.
  costUsd: number | null
}

const EMPTY_USAGE: RequestUsage = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheCreationTokens: null,
}

function apiCount(usage: Record<string, unknown>, key: string): number | null {
  const v = usage[key]
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

// The four counts a turn.step result.usage reports for one main-loop request.
// Anything else is not a number we can show.
export function usageFromApi(usage: unknown): RequestUsage | null {
  if (!usage || typeof usage !== "object") return null
  const rec = usage as Record<string, unknown>
  const got: RequestUsage = {
    inputTokens: apiCount(rec, "input_tokens"),
    outputTokens: apiCount(rec, "output_tokens"),
    cacheReadTokens: apiCount(rec, "cache_read_input_tokens"),
    cacheCreationTokens: apiCount(rec, "cache_creation_input_tokens"),
  }
  if (
    got.inputTokens == null &&
    got.outputTokens == null &&
    got.cacheReadTokens == null &&
    got.cacheCreationTokens == null
  ) {
    return null
  }
  return got
}

function addCount(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null
  return (a ?? 0) + (b ?? 0)
}

export function addUsage(a: RequestUsage, b: RequestUsage): RequestUsage {
  return {
    inputTokens: addCount(a.inputTokens, b.inputTokens),
    outputTokens: addCount(a.outputTokens, b.outputTokens),
    cacheReadTokens: addCount(a.cacheReadTokens, b.cacheReadTokens),
    cacheCreationTokens: addCount(a.cacheCreationTokens, b.cacheCreationTokens),
  }
}

export const ZERO_USAGE = EMPTY_USAGE

function fmtCount(n: number | null): string {
  if (n == null) return "—"
  return n.toLocaleString("en-US")
}

function fmtUsd(n: number | null): string {
  if (n == null) return "—"
  if (n === 0) return "$0"
  const abs = Math.abs(n)
  if (abs < 1) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

// Compact HUD. Per-request counts win when a main-loop turn.step has reported them.
// Until then, context.tokens is labeled in+cached because the API does not split it,
// and out / cached stay an em dash rather than a guessed zero.
export function formatTokenHud(session: SessionUsageSnap, request: RequestUsage): string {
  const split =
    request.inputTokens != null ||
    request.outputTokens != null ||
    request.cacheReadTokens != null
  const cost = `cost ${fmtUsd(session.costUsd)}`
  if (split) {
    return `in ${fmtCount(request.inputTokens)}  out ${fmtCount(request.outputTokens)}  cached ${fmtCount(request.cacheReadTokens)}  ${cost}`
  }
  const inn = session.contextTokens == null ? "in —" : `in+cached ${fmtCount(session.contextTokens)}`
  return `${inn}  out —  cached —  ${cost}`
}

export type FloorAttention = {
  title: string
  detail: string
  tone: "red" | "yellow" | "cyan"
}

// The one thing that needs a person. Null when nothing is claimed and nothing is blocked:
// the pane stays quiet apart from running/idle and the HUD.
export function attentionOf(f: FloorSnapshot): FloorAttention | null {
  const ticket = f.ticket ? `#${f.ticket.number} ${f.ticket.title}` : null
  if (f.hardStop) {
    return {
      title: "Blocked",
      detail: `${ticket ? `${ticket} · ` : ""}cf-check failed ${f.evidence.failures}/${f.evidence.maxFailures}. A human decides; cf-reset allows more attempts.`,
      tone: "red",
    }
  }
  if (f.evidence.lastResult === "fail") {
    return {
      title: "Check failed",
      detail: [ticket, f.next.skill, f.next.run].filter(Boolean).join(" · "),
      tone: "red",
    }
  }
  if (f.current === "merge") {
    const pr = f.evidence.pr?.match(/\/pull\/(\d+)/)
    return {
      title: "Human merge",
      detail: [ticket, pr ? `PR #${pr[1]}` : "A human reviews and merges."].filter(Boolean).join(" · "),
      tone: "yellow",
    }
  }
  if (f.ticket && f.next.skill) {
    return {
      title: f.next.skill,
      detail: [ticket, f.next.step].filter(Boolean).join(" · "),
      tone: "cyan",
    }
  }
  return null
}

// The floor as plain text: the command's answer where nothing draws a pane (claude -p, VS Code chat).
export function floorText(f: FloorSnapshot): string {
  const lines: string[] = ['Factory floor']
  lines.push(f.ticket ? `Ticket: ${f.ticket.repo}#${f.ticket.number} ${f.ticket.title}` : 'Ticket: none claimed')
  const at = stagePosition(f.current)
  lines.push(`Stage: ${at.index + 1}/${STAGES.length} ${at.label}${f.hardStop ? ' (HARD STOP)' : ''}`)
  lines.push(
    `Stages: ${f.stages.map(st => `${st.status === 'done' ? '✓' : st.status === 'blocked' ? '✗' : st.status === 'current' ? '▶' : '·'} ${st.label}`).join('  ')}`,
  )
  const e = f.evidence
  lines.push(
    `Evidence: check ${e.checkCmd ?? '—'} → ${e.lastResult ?? 'not run'} (${e.failures}/${e.maxFailures} failures, ${e.checksRun} runs)` +
      (e.evidencePath ? `; ${e.evidencePath}` : '') +
      (e.pr ? `; ${e.pr}` : ''),
  )
  lines.push(`Next: ${f.next.skill ?? 'human'} · ${f.next.step}${f.next.run ? ` · ${f.next.run}` : ''}`)
  lines.push(f.next.why)
  return lines.join('\n')
}
