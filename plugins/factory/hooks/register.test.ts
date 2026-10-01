import { expect, mock, test } from 'claude-code/testing'

const ROOT = '/work'

const PANE = {
  plugin: 'factory',
  component: 'Pane' as const,
  requestId: 'factory',
  props: {
    title: 'Factory',
    isFocused: true,
    bodyColumns: 60,
    placement: 'inline' as const,
    scroll: { bodyRows: 24 },
    view: {},
  },
  viewport: { columns: 120, rows: 40 },
}

function stubIdleWorld(on: (event: string, ...rest: unknown[]) => unknown) {
  mock.clock(on)
  on('session.start', () => ({ cwd: ROOT }))
  on('command.register', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: ROOT }))
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ deny: 'missing' }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: ROOT + '/.git\n', stderr: '' },
  }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', () => ({
    type: 'Text',
    props: {},
    children: ['drawn by Claude Code'],
  }))
}

test('/factory-pane command returns empty transcript text', async ($, on) => {
  stubIdleWorld(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
  expect(await $.command.run({ command: 'factory-pane', args: '' })).toEqual({})
})

test('idle pane shows Software Factory + step strip', async ($, on) => {
  stubIdleWorld(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
  await $.command.run({ command: 'factory-pane', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Software Factory/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Step 1\/5/ })).toBeDefined()
  await ui.unmount()
})

test('Proceed reset zeroes check_failures via fs.write', async ($, on) => {
  mock.clock(on)
  on('session.start', () => ({ cwd: ROOT }))
  on('command.register', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: ROOT }))
  on('env.get', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', () => ({
    type: 'Text',
    props: {},
    children: ['drawn by Claude Code'],
  }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: ROOT + '/.git\n', stderr: '' },
  }))

  let state: Record<string, unknown> = {
    issue: 1,
    check_failures: 2,
    max_failures: 2,
    checks_run: 2,
    last_check: { result: 'fail', at: '2026-10-01T00:00:00Z' },
  }
  const writes: Array<{ path: string; text: string }> = []

  on('fs.exists', (_$: unknown, e: { path: string }) => ({
    value: e.path.endsWith('/state.json') || e.path.endsWith('/claim.json'),
  }))
  on('fs.read', (_$: unknown, e: { path: string }) => {
    if (e.path.endsWith('/state.json')) return { value: JSON.stringify(state) }
    if (e.path.endsWith('/claim.json')) {
      return {
        value: JSON.stringify({
          issue: 1,
          title: 'Demo',
          repo: 'acme/widget',
          branch: 'cf/1-demo',
        }),
      }
    }
    return { deny: 'missing' }
  })
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => {
    writes.push({ path: e.path, text: e.text })
    if (e.path.endsWith('/state.json')) state = JSON.parse(e.text)
    return { value: undefined }
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
  await $.command.run({ command: 'factory-pane', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /HARD STOP/ })).toBeDefined()
  await ui.press({ key: 'proceed' })
  expect(writes.some(w => w.path.endsWith('/state.json'))).toBe(true)
  expect(state.check_failures).toBe(0)
  expect(String(state.reset_by || '')).toContain('factory pane')
  await ui.unmount()
})
