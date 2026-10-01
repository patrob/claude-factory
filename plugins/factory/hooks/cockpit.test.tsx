import { expect, test } from 'claude-code/testing'

import { loadClaimStatus } from './cockpit-claim'

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

  expect(status).toEqual({ kind: 'present', path: '/repo/.git/claude-factory/claim.json' })
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
