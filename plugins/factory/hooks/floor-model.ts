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
