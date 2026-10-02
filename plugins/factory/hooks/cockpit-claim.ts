export const CLAIM_PATHS = ['.claude-factory/claim.json', '.git/claude-factory/claim.json'] as const

export type LastCheck = { result: string; exitCode: number | null; at: string | null }

export type ClaimDetails = {
  ticket: string
  phase: string
  failCount: number | null
  maxFailures: number | null
  lastCheck: LastCheck | null
  worktree: string | null
}

export type ClaimDetailRow = { key: string; label: string; value: string }

export type ClaimStatus =
  | { kind: 'none' }
  | { kind: 'unreadable'; path: string; reason: string }
  | { kind: 'present'; path: string; details: ClaimDetails }

type ClaimFs = { exists: (path: string) => Promise<boolean>; read: (path: string) => Promise<string> }

export function parseClaimDetails(
  claim: Record<string, unknown>,
  state: Record<string, unknown> | null,
): ClaimDetails {
  const issue = claim.issue
  const repo = claim.repo
  let ticket: string
  if (typeof issue === 'number') {
    ticket = `#${issue}`
  } else if (typeof issue === 'string' && issue.length > 0) {
    ticket = `#${issue.replace(/^#/, '')}`
  } else {
    ticket = 'unknown'
  }
  if (ticket !== 'unknown' && typeof repo === 'string' && repo.length > 0) {
    ticket = `${repo}${ticket}`
  }

  const phase = typeof claim.status === 'string' && claim.status.length > 0 ? claim.status : 'unknown'

  const worktree = typeof claim.worktree === 'string' && claim.worktree.length > 0 ? claim.worktree : null

  const failCount = state && typeof state.check_failures === 'number' && Number.isFinite(state.check_failures)
    ? state.check_failures
    : null
  const maxFailures = state && typeof state.max_failures === 'number' && Number.isFinite(state.max_failures)
    ? state.max_failures
    : null

  let lastCheck: LastCheck | null = null
  if (state && typeof state.last_check === 'object' && state.last_check !== null && !Array.isArray(state.last_check)) {
    const lc = state.last_check as Record<string, unknown>
    if (typeof lc.result === 'string') {
      lastCheck = {
        result: lc.result,
        exitCode: typeof lc.exit_code === 'number' && Number.isFinite(lc.exit_code) ? lc.exit_code : null,
        at: typeof lc.at === 'string' ? lc.at : null,
      }
    }
  }

  return { ticket, phase, failCount, maxFailures, lastCheck, worktree }
}

export function formatLastCheck(lastCheck: LastCheck | null): string {
  if (lastCheck === null) return 'no checks yet'
  let text = lastCheck.result.toUpperCase()
  if (lastCheck.exitCode !== null) text += ` (exit ${lastCheck.exitCode})`
  if (lastCheck.at) text += ` at ${lastCheck.at}`
  return text
}

export function claimDetailRows(details: ClaimDetails): ClaimDetailRow[] {
  const rows: ClaimDetailRow[] = [
    { key: 'ticket', label: 'Ticket', value: details.ticket },
    { key: 'phase', label: 'Phase', value: details.phase },
    {
      key: 'failures',
      label: 'Failures',
      value:
        details.failCount === null
          ? 'unknown'
          : details.maxFailures === null
            ? `${details.failCount}`
            : `${details.failCount}/${details.maxFailures}`,
    },
    { key: 'last-check', label: 'Last check', value: formatLastCheck(details.lastCheck) },
  ]
  if (details.worktree !== null) {
    rows.push({ key: 'worktree', label: 'Worktree', value: details.worktree })
  }
  return rows
}

export async function loadClaimStatus(root: string, fs: ClaimFs): Promise<ClaimStatus> {
  for (const rel of CLAIM_PATHS) {
    const path = `${root}/${rel}`
    let exists: boolean
    try {
      exists = await fs.exists(path)
    } catch {
      continue
    }
    if (!exists) continue

    try {
      const text = await fs.read(path)
      const parsed = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { kind: 'unreadable', path, reason: 'claim file is not a JSON object' }
      }

      let state: Record<string, unknown> | null = null
      const statePath = path.replace(/claim\.json$/, 'state.json')
      try {
        if (await fs.exists(statePath)) {
          const s = JSON.parse(await fs.read(statePath))
          if (typeof s === 'object' && s !== null && !Array.isArray(s)) state = s
        }
      } catch {
        state = null
      }

      return { kind: 'present', path, details: parseClaimDetails(parsed, state) }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return { kind: 'unreadable', path, reason }
    }
  }

  return { kind: 'none' }
}
