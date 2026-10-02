import { expect, test } from 'claude-code/testing'

import { claimDetailRows, formatLastCheck, loadClaimStatus, parseClaimDetails } from './cockpit-claim'

test('loadClaimStatus: no files present returns none', async () => {
  const status = await loadClaimStatus('/repo', {
    exists: async () => false,
    read: async () => {
      throw new Error('should not be called')
    },
  })

  expect(status).toEqual({ kind: 'none' })
})

test('loadClaimStatus: exists() rejecting is treated as not there', async () => {
  const status = await loadClaimStatus('/repo', {
    exists: async () => {
      throw new Error('fs is unavailable')
    },
    read: async () => {
      throw new Error('should not be called')
    },
  })

  expect(status).toEqual({ kind: 'none' })
})

test('loadClaimStatus: read() rejecting on an existing file is unreadable', async () => {
  const status = await loadClaimStatus('/repo', {
    exists: async () => true,
    read: async () => {
      throw new Error('permission denied')
    },
  })

  expect(status.kind).toBe('unreadable')
})

test('loadClaimStatus: invalid JSON is unreadable', async () => {
  const status = await loadClaimStatus('/repo', {
    exists: async () => true,
    read: async () => 'not json',
  })

  expect(status.kind).toBe('unreadable')
})

test('loadClaimStatus: valid JSON only at the guard-mode path is present', async () => {
  const status = await loadClaimStatus('/repo', {
    exists: async path => path === '/repo/.git/claude-factory/claim.json',
    read: async () => JSON.stringify({ ticket: '27' }),
  })

  expect(status.kind).toBe('present')
  expect(status.kind === 'present' && status.path).toBe('/repo/.git/claude-factory/claim.json')
})

test('loadClaimStatus: reads sibling state.json alongside claim.json', async () => {
  const files: Record<string, string> = {
    '/repo/.claude-factory/claim.json': JSON.stringify({
      issue: 28,
      repo: 'acme/widget',
      status: 'building',
      worktree: '/w/widget-cf-28',
    }),
    '/repo/.claude-factory/state.json': JSON.stringify({
      check_failures: 1,
      max_failures: 2,
      last_check: { result: 'fail', exit_code: 2, at: '2026-10-01T12:00:00Z' },
    }),
  }

  const status = await loadClaimStatus('/repo', {
    exists: async path => path in files,
    read: async path => files[path],
  })

  expect(status.kind).toBe('present')
  if (status.kind !== 'present') throw new Error('expected present')
  expect(status.details).toEqual({
    ticket: 'acme/widget#28',
    phase: 'building',
    failCount: 1,
    maxFailures: 2,
    lastCheck: { result: 'fail', exitCode: 2, at: '2026-10-01T12:00:00Z' },
    worktree: '/w/widget-cf-28',
  })
})

test('loadClaimStatus: no state.json present still returns present with null fields', async () => {
  const files: Record<string, string> = {
    '/repo/.claude-factory/claim.json': JSON.stringify({ issue: 28, repo: 'acme/widget', status: 'building' }),
  }

  const status = await loadClaimStatus('/repo', {
    exists: async path => path in files,
    read: async path => files[path],
  })

  expect(status.kind).toBe('present')
  if (status.kind !== 'present') throw new Error('expected present')
  expect(status.details.failCount).toBeNull()
  expect(status.details.lastCheck).toBeNull()
})

test('loadClaimStatus: invalid state.json still returns present (not unreadable), with null state fields', async () => {
  const files: Record<string, string> = {
    '/repo/.claude-factory/claim.json': JSON.stringify({ issue: 28, repo: 'acme/widget', status: 'building' }),
    '/repo/.claude-factory/state.json': 'not json',
  }

  const status = await loadClaimStatus('/repo', {
    exists: async path => path in files,
    read: async path => files[path],
  })

  expect(status.kind).toBe('present')
  if (status.kind !== 'present') throw new Error('expected present')
  expect(status.details.failCount).toBeNull()
  expect(status.details.lastCheck).toBeNull()
})

test('loadClaimStatus: state.json read() rejecting still returns present (not unreadable)', async () => {
  const files: Record<string, string> = {
    '/repo/.claude-factory/claim.json': JSON.stringify({ issue: 28, repo: 'acme/widget', status: 'building' }),
  }

  const status = await loadClaimStatus('/repo', {
    exists: async path => path === '/repo/.claude-factory/claim.json' || path === '/repo/.claude-factory/state.json',
    read: async path => {
      if (path in files) return files[path]
      throw new Error('permission denied')
    },
  })

  expect(status.kind).toBe('present')
  if (status.kind !== 'present') throw new Error('expected present')
  expect(status.details.failCount).toBeNull()
  expect(status.details.lastCheck).toBeNull()
})

test('loadClaimStatus: guard-mode path reads state.json from the .git state dir', async () => {
  const files: Record<string, string> = {
    '/repo/.git/claude-factory/claim.json': JSON.stringify({ issue: 28, repo: 'acme/widget', status: 'building' }),
    '/repo/.git/claude-factory/state.json': JSON.stringify({ check_failures: 0, max_failures: 2, last_check: null }),
  }

  const status = await loadClaimStatus('/repo', {
    exists: async path => path in files,
    read: async path => files[path],
  })

  expect(status.kind).toBe('present')
  if (status.kind !== 'present') throw new Error('expected present')
  expect(status.path).toBe('/repo/.git/claude-factory/claim.json')
  expect(status.details.failCount).toBe(0)
  expect(status.details.maxFailures).toBe(2)
})

test('claimDetailRows: full details produce all five rows in order', () => {
  const details = parseClaimDetails(
    { issue: 28, repo: 'acme/widget', status: 'building', worktree: '/w/widget-cf-28' },
    { check_failures: 1, max_failures: 2, last_check: { result: 'fail', exit_code: 2, at: '2026-10-01T12:00:00Z' } },
  )
  const rows = claimDetailRows(details)

  expect(rows.map(r => r.key)).toEqual(['ticket', 'phase', 'failures', 'last-check', 'worktree'])
  expect(rows.find(r => r.key === 'failures')?.value).toBe('1/2')
  expect(rows.find(r => r.key === 'last-check')?.value).toBe('FAIL (exit 2) at 2026-10-01T12:00:00Z')
  expect(rows.find(r => r.key === 'worktree')?.value).toBe('/w/widget-cf-28')
})

test('claimDetailRows: worktree null omits the worktree row', () => {
  const details = parseClaimDetails({ issue: 28, repo: 'acme/widget', status: 'building', worktree: null }, null)
  const rows = claimDetailRows(details)

  expect(rows.map(r => r.key)).toEqual(['ticket', 'phase', 'failures', 'last-check'])
})

test('claimDetailRows: missing worktree field omits the worktree row', () => {
  const details = parseClaimDetails({ issue: 28, repo: 'acme/widget', status: 'building' }, null)
  const rows = claimDetailRows(details)

  expect(rows.map(r => r.key)).toEqual(['ticket', 'phase', 'failures', 'last-check'])
})

test('claimDetailRows: non-string worktree omits the worktree row and does not throw', () => {
  const details = parseClaimDetails({ issue: 28, repo: 'acme/widget', status: 'building', worktree: 42 }, null)
  const rows = claimDetailRows(details)

  expect(rows.map(r => r.key)).toEqual(['ticket', 'phase', 'failures', 'last-check'])
})

test('formatLastCheck: null means no checks yet', () => {
  expect(formatLastCheck(null)).toBe('no checks yet')
})

test('formatLastCheck: pass with exit 0 formats result, exit code, and timestamp', () => {
  expect(formatLastCheck({ result: 'pass', exitCode: 0, at: '2026-10-01T12:00:00Z' })).toBe(
    'PASS (exit 0) at 2026-10-01T12:00:00Z',
  )
})

test('parseClaimDetails: empty claim and null state yields all-unknown details', () => {
  const details = parseClaimDetails({}, null)

  expect(details.ticket).toBe('unknown')
  expect(details.phase).toBe('unknown')
  expect(details.failCount).toBeNull()
  expect(details.maxFailures).toBeNull()
  expect(details.lastCheck).toBeNull()
  expect(details.worktree).toBeNull()
})

// A command.run test that exercises $.ui.open is omitted: the test kit has no
// implementation for ui.open (only $.ui.mount draws a pane instance), so the
// manual check in the spec's verification plan covers the opened-with-focus path.

for (const surface of ['terminal', 'desktop'] as const) {
  test(`Pane renders the empty state with no claim.json on ${surface}`, async $ => {
    const ui = await $.ui.mount({
      plugin: 'factory',
      surface,
      component: 'Pane',
      requestId: 'factory-cockpit',
      props: {
        title: 'Factory cockpit',
        isFocused: false,
        bodyColumns: 80,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 24 },
        view: {},
      },
    })

    const empty = await ui.find({ key: 'cockpit-empty' })
    expect(empty).toBeDefined()
    expect(empty?.text).toMatch(/No active claim/)

    await ui.unmount()
  })
}
