// Factory floor pane: `claude plugin test plugins/factory` runs this with no session.
// The test's own hooks stand in for the host: the session's directory, git, and the
// state files the cf-* tools write. The mod under test only reads them.

import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  attentionOf,
  deriveFloor,
  formatTokenHud,
  planIsWritten,
  stateDirCandidates,
  usageFromApi,
} from '../hooks/floor-model'

const ROOT = '/work/widget'
const DIR = `${ROOT}/.claude-factory`
const PANE = 'factory-floor'
const SURFACES = ['terminal', 'desktop'] as const
const PANE_PROPS = {
  title: 'Factory floor',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

const PLAN_TEMPLATE = `# Plan — acme/widget#1: Add a widget

## Done when

<!-- Copy the ticket's DONE_WHEN / Gherkin here. -->

## Approach
`
const PLAN_WRITTEN = PLAN_TEMPLATE.replace('<!-- Copy', 'A widget renders.\n<!-- Copy')

const claim = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    issue: 1,
    repo: 'acme/widget',
    title: 'Add a widget',
    url: 'https://github.com/acme/widget/issues/1',
    ready_reasons: ['label:factory-ready'],
    check_cmd: 'make test',
    claimed_at: '2026-10-04T10:00:00Z',
    claimed_by: 'Smoke Test',
    status: 'claimed',
    worktree: null,
    branch: null,
    base: null,
    pr: null,
    ...extra,
  })

const state = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    issue: 1,
    check_failures: 0,
    max_failures: 2,
    checks_run: 0,
    last_check: null,
    updated_at: '2026-10-04T10:00:00Z',
    ...extra,
  })

const building = {
  status: 'building',
  worktree: '/work/widget-cf-1',
  branch: 'cf/1-add-a-widget',
  base: 'main',
}
const check = (result: 'pass' | 'fail', at = '2026-10-04T11:00:00Z') => ({
  cmd: 'make test',
  exit_code: result === 'pass' ? 0 : 2,
  result,
  log: `${DIR}/runs/check-1.log`,
  at,
})
const evidenceMd = (at: string) =>
  `## 🏭 Claude Factory evidence — acme/widget#1\n\n| Generated | ${at} |\n\n> **Human merge required.**\n`

type Host = { files: Record<string, string>; opened: string[]; argv: string[][] }

// Answer what the mod asks Claude Code for, beneath it, from an in-memory repo.
function host(on: On, files: Record<string, string>, surfaces: readonly string[] = ['terminal']): Host {
  const h: Host = { files, opened: [], argv: [] }
  on('session.cwd', () => ({ value: ROOT }))
  on('session.surfaces', () => ({ value: surfaces as never }))
  on('env.get', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    h.argv.push([...e.argv])
    return { value: { exitCode: 0, stdout: `${ROOT}/.git\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', ($, e) => ({ value: e.path in h.files }))
  on('fs.read', ($, e) => (e.path in h.files ? { value: h.files[e.path] ?? '' } : { deny: `ENOENT ${e.path}` }))
  on('ui.open', ($, e) => {
    h.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('session.usage', () => ({
    value: { startedAt: 1, context: { window: 200_000 }, rateLimits: [], cost: { usd: 0 } },
  }))
  return h
}

// The person typing /factory:floor at the prompt of a fullscreen terminal.
const run = ($: Engine) =>
  $.command.run({
    command: 'factory:floor',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 180 },
  })

describe('/factory:floor', () => {
  test('opens the pane and prints nothing where a pane can draw', async ($, on) => {
    const h = host(on, {})
    const answer = await run($)
    expect(h.opened).toEqual([PANE])
    expect(answer.text).toBeUndefined()
  })

  test('answers with the floor as text where nothing draws (claude -p, VS Code chat)', async ($, on) => {
    const h = host(on, { [`${DIR}/state.json`]: state(), [`${DIR}/claim.json`]: claim(building) }, [])
    const answer = await run($)
    expect(h.opened).toEqual([])
    expect(answer.text).toContain('Ticket: acme/widget#1 Add a widget')
    expect(answer.text).toContain('Stage: 5/8 Check')
    expect(answer.text).toContain('Next: /factory:sdv')
  })
})

describe('the pane', () => {
  test('with no claim: quiet aside from idle and the token HUD', async ($, on) => {
    host(on, {})
    await run($)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'factory', surface, component: 'Pane', requestId: PANE, props: PANE_PROPS })
      expect(await ui.find({ text: 'idle' })).toBeDefined()
      expect(await ui.find({ text: /in —/ })).toBeDefined()
      expect(await ui.find({ text: /out —/ })).toBeDefined()
      expect(await ui.find({ text: /cached —/ })).toBeDefined()
      expect(await ui.find({ text: /cost \$0/ })).toBeDefined()
      expect(await ui.find({ text: 'No ticket claimed.' })).toBeUndefined()
      expect(await ui.find({ text: /1\/8/ })).toBeUndefined()
      const buttons = await ui.findAll({ type: 'Button' })
      expect(buttons.map(b => b.key)).toEqual(['refresh'])
      await ui.unmount()
    }
  })

  test('a failed check is the only action, with no stage rail or evidence dump', async ($, on) => {
    host(on, {
      [`${DIR}/claim.json`]: claim(building),
      [`${DIR}/state.json`]: state({ check_failures: 1, checks_run: 1, last_check: check('fail') }),
      [`${DIR}/plan.md`]: PLAN_WRITTEN,
    })
    await run($)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'factory', surface, component: 'Pane', requestId: PANE, props: PANE_PROPS })
      expect(await ui.find({ text: 'Check failed' })).toBeDefined()
      expect(await ui.find({ text: /#1 Add a widget/ })).toBeDefined()
      expect(await ui.find({ text: /\/factory:sdv/ })).toBeDefined()
      expect(await ui.find({ text: /cf-check/ })).toBeDefined()
      expect(await ui.find({ text: /5\/8/ })).toBeUndefined()
      expect(await ui.find({ text: 'cf/1-add-a-widget → main' })).toBeUndefined()
      expect(await ui.find({ text: 'Blocked' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('hard stop: the blocked check, not the stage rail', async ($, on) => {
    host(on, {
      [`${DIR}/claim.json`]: claim(building),
      [`${DIR}/state.json`]: state({ check_failures: 2, checks_run: 2, last_check: check('fail') }),
    })
    await run($)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'factory', surface, component: 'Pane', requestId: PANE, props: PANE_PROPS })
      expect(await ui.find({ text: 'Blocked' })).toBeDefined()
      expect(await ui.find({ text: /cf-check failed 2\/2/ })).toBeDefined()
      expect(await ui.find({ text: /cf-reset/ })).toBeDefined()
      expect(await ui.find({ text: /✗/ })).toBeUndefined()
      const buttons = await ui.findAll({ type: 'Button' })
      expect(buttons.map(b => b.key)).toEqual(['refresh'])
      await ui.unmount()
    }
  })

  test('PR recorded: stops at human merge and offers no merge', async ($, on) => {
    const h = host(on, {
      [`${DIR}/claim.json`]: claim({ ...building, status: 'awaiting-merge', pr: 'https://github.com/acme/widget/pull/9' }),
      [`${DIR}/state.json`]: state({ checks_run: 1, last_check: check('pass') }),
      [`${DIR}/evidence.md`]: evidenceMd('2026-10-04T11:05:00Z'),
    })
    await run($)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'factory', surface, component: 'Pane', requestId: PANE, props: PANE_PROPS })
      expect(await ui.find({ text: 'Human merge' })).toBeDefined()
      expect(await ui.find({ text: /PR #9/ })).toBeDefined()
      expect(await ui.find({ text: /8\/8/ })).toBeUndefined()
      const buttons = await ui.findAll({ type: 'Button' })
      expect(buttons.map(b => b.key)).toEqual(['refresh'])
      await ui.press({ key: 'refresh' })
      await ui.unmount()
    }
    expect(h.argv.flat().some(a => /merge|approve/.test(a))).toBe(false)
  })

  test('redraws when a cf-* call moves the ticket on', async ($, on) => {
    const h = host(on, {
      [`${DIR}/claim.json`]: claim(building),
      [`${DIR}/state.json`]: state(),
      [`${DIR}/plan.md`]: PLAN_WRITTEN,
    })
    await run($)
    const ui = await $.ui.mount({ plugin: 'factory', surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await ui.find({ text: /Steps 5–6 · Build, Check/ })).toBeDefined()

    h.files[`${DIR}/state.json`] = state({ checks_run: 1, last_check: check('pass') })
    await $.tool.call({ tool: 'Bash', command: 'cf-check' })
    expect(await ui.find({ text: /Step 7 · Evidence/ })).toBeDefined()

    h.files[`${DIR}/evidence.md`] = evidenceMd('2026-10-04T11:05:00Z')
    await $.tool.call({ tool: 'Bash', command: 'cf-evidence' })
    expect(await ui.find({ text: /Step 7 · PR/ })).toBeDefined()
    expect(await ui.find({ text: `${DIR}/evidence.md` })).toBeUndefined()
    await ui.unmount()
  })
})

describe('floor model', () => {
  test('finds the state dir in the same order cf-guard.sh does', () => {
    expect(stateDirCandidates(ROOT, ROOT, false)).toEqual([`${ROOT}/.claude-factory`, `${ROOT}/.git/claude-factory`])
    expect(stateDirCandidates(ROOT, '/work/widget-cf-1', true)).toEqual([
      `${ROOT}/.git/claude-factory`,
      `${ROOT}/.claude-factory`,
      '/work/widget-cf-1/.claude-factory',
    ])
  })

  test('a plan counts once Done when has content', () => {
    expect(planIsWritten(PLAN_TEMPLATE)).toBe(false)
    expect(planIsWritten(PLAN_WRITTEN)).toBe(true)
  })

  test('walks plan, worktree, check, evidence in order', () => {
    const at = (c: string, s: string, plan: string | null = null, evidence: string | null = null) =>
      deriveFloor({ repoRoot: ROOT, stateDir: DIR, claim: c, state: s, plan, evidence }).current
    expect(at(claim(), state(), PLAN_TEMPLATE)).toBe('plan')
    expect(at(claim(), state(), PLAN_WRITTEN)).toBe('worktree')
    expect(at(claim(building), state())).toBe('check')
    expect(at(claim(building), state({ last_check: check('pass') }))).toBe('evidence')
    // Evidence built before the last passing check is stale.
    expect(at(claim(building), state({ last_check: check('pass') }), null, evidenceMd('2026-10-04T10:30:00Z'))).toBe('evidence')
    expect(at(claim(building), state({ last_check: check('pass') }), null, evidenceMd('2026-10-04T11:05:00Z'))).toBe('pr')
    expect(at(claim({ ...building, status: 'released' }), state())).toBe('ready')
  })
})

describe('attention and token HUD', () => {
  test('nothing claimed is no attention item', () => {
    const f = deriveFloor({ repoRoot: ROOT, stateDir: null, claim: null, state: null, plan: null, evidence: null })
    expect(attentionOf(f)).toBeNull()
  })

  test('session.usage without a request labels the split fields empty', () => {
    expect(formatTokenHud({ contextTokens: null, costUsd: 0 }, {
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null,
    })).toBe('in —  out —  cached —  cost $0')
    expect(formatTokenHud({ contextTokens: 15500, costUsd: 0.01234 }, {
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null,
    })).toBe('in+cached 15,500  out —  cached —  cost $0.0123')
  })

  test('turn.step usage fills in, out, and cached from the API fields', () => {
    const got = usageFromApi({
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: 8,
      cache_creation_input_tokens: 1,
      model: 'claude',
    })
    expect(got).toEqual({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 8, cacheCreationTokens: 1 })
    expect(formatTokenHud({ contextTokens: 999, costUsd: 1.2 }, got!)).toBe('in 10  out 2  cached 8  cost $1.20')
    expect(usageFromApi({ model: 'claude' })).toBeNull()
  })
})

