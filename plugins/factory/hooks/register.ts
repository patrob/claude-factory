/**
 * Factory mod: Token Weather–style band, Blast Radius hard-stop pane,
 * Replay Theater–style Claim→PR step strip.
 * Gates stay in cf-* + cf-guard.sh. Claude Code ≥ 2.1.287.
 * Draws in CLI + Desktop Code tab only (not VS Code chat / claude -p).
 */

const PANE = 'factory'
const COMMAND = 'factory-pane'
const PHASES = ['Claim', 'Plan', 'Build', 'Check', 'PR'] as const

type Claim = {
  issue?: number | string
  title?: string
  repo?: string
  url?: string
  branch?: string
  worktree?: string
  check_cmd?: string
  pr?: string | null
  status?: string
}

type State = {
  issue?: number | string
  check_failures?: number
  max_failures?: number
  checks_run?: number
  last_check?: {
    result?: string
    at?: string
    exit_code?: number
  } | null
  updated_at?: string
  reset_at?: string
  reset_by?: string
}

type Snapshot = {
  stateDir: string | null
  claim: Claim | null
  state: State | null
  hardStop: boolean
  queueHint: string
}

type Engine = {
  session: { cwd: () => Promise<string> | string }
  process: { run: (argv: string[]) => Promise<{ exitCode: number; stdout: string }> }
  fs: {
    exists: (path: string) => Promise<boolean>
    read: (path: string) => Promise<string>
    write: (path: string, text: string) => Promise<void>
  }
  env: { get: (name: string) => Promise<string | undefined> | string | undefined }
  clock: { now: () => Promise<number> | number; every: (ms: number, fn: () => void) => void }
  command: {
    register: (spec: { name: string; description: string; immediate?: boolean }) => Promise<void>
  }
  ui: {
    open: (args: {
      id: string
      title?: string
      focus?: boolean
      closeOnEscape?: boolean
    }) => Promise<{ isPlaced?: boolean }>
    close: (args: { id: string }) => Promise<void>
    invalidate: (event: string) => void
    toast: (message: string) => Promise<void> | void
    resolve: (e: unknown) => {
      Box: (props: Record<string, unknown>) => unknown
      Text: (props: Record<string, unknown>) => unknown
      Button: (props: Record<string, unknown>) => unknown
    }
  }
}

let lastHardStop = false
let toastShownForStop = false
/** Replay-style: which phase the human is browsing (null = follow live). */
let viewStep: number | null = null

type PhaseInfo = { index: number; name: string; done: boolean; detail: string }

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function line(label: string, value: string): string {
  return label + ': ' + value
}

async function primaryRoot($: Engine): Promise<string | null> {
  const cwd = await Promise.resolve($.session.cwd())
  const { exitCode, stdout } = await $.process.run([
    'git',
    '-C',
    cwd,
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ])
  if (exitCode !== 0) return null
  const common = stdout.trim()
  if (!common) return null
  if (common.endsWith('/.git')) return common.slice(0, -5)
  const idx = common.lastIndexOf('/')
  return idx > 0 ? common.slice(0, idx) : null
}

async function resolveStateDir($: Engine): Promise<string | null> {
  const cwd = await Promise.resolve($.session.cwd())
  const root = await primaryRoot($)
  const guard =
    String((await Promise.resolve($.env.get('CF_PRIMARY_GUARD'))) ?? '') === '1' ||
    (root !== null && root.includes('ship-it'))

  const candidates: string[] = []
  if (root) {
    if (guard) candidates.push(root + '/.git/claude-factory')
    candidates.push(root + '/.claude-factory', root + '/.git/claude-factory')
  }
  candidates.push(cwd + '/.claude-factory')

  for (const dir of candidates) {
    if (await $.fs.exists(dir + '/state.json')) return dir
  }
  if (root) return guard ? root + '/.git/claude-factory' : root + '/.claude-factory'
  return null
}

async function readJson($: Engine, path: string): Promise<Record<string, unknown> | null> {
  if (!(await $.fs.exists(path))) return null
  try {
    return asRecord(JSON.parse(await $.fs.read(path)))
  } catch {
    return null
  }
}

async function loadSnapshot($: Engine): Promise<Snapshot> {
  const stateDir = await resolveStateDir($)
  if (!stateDir) {
    return {
      stateDir: null,
      claim: null,
      state: null,
      hardStop: false,
      queueHint: 'no git repo',
    }
  }
  const claim = (await readJson($, stateDir + '/claim.json')) as Claim | null
  const state = (await readJson($, stateDir + '/state.json')) as State | null
  const failures = Number(state?.check_failures ?? 0)
  const max = Number(state?.max_failures ?? 2)
  const hardStop = Boolean(state) && failures >= max
  let queueHint = 'idle — claim with /factory:sdv next'
  if (claim?.issue != null) {
    queueHint = claim.pr
      ? 'PR open — human merge (' + String(claim.pr) + ')'
      : hardStop
        ? 'HARD STOP — Proceed / Reset or Cancel'
        : 'in progress — /factory:sdv loop'
  }
  return { stateDir, claim, state, hardStop, queueHint }
}

function phasesOf(snap: Snapshot, planExists: boolean): PhaseInfo[] {
  const claim = snap.claim
  const state = snap.state
  const claimed = claim?.issue != null
  const building = Boolean(claim?.worktree)
  const checked = Number(state?.checks_run ?? 0) > 0 || Boolean(state?.last_check)
  const prOpen = Boolean(claim?.pr)
  return [
    {
      index: 0,
      name: 'Claim',
      done: claimed,
      detail: claimed ? '#' + String(claim?.issue) + ' ' + String(claim?.title ?? '') : 'cf-claim /factory:sdv',
    },
    {
      index: 1,
      name: 'Plan',
      done: claimed && planExists,
      detail: planExists ? 'plan.md' : 'fill .claude-factory/plan.md',
    },
    {
      index: 2,
      name: 'Build',
      done: building,
      detail: building ? String(claim?.branch ?? claim?.worktree) : 'cf-worktree',
    },
    {
      index: 3,
      name: 'Check',
      done: checked && !snap.hardStop,
      detail: snap.hardStop
        ? 'HARD STOP ' + String(state?.check_failures) + '/' + String(state?.max_failures)
        : checked
          ? String(state?.last_check?.result ?? 'ran') +
            ' · ' +
            String(state?.check_failures ?? 0) +
            '/' +
            String(state?.max_failures ?? 2)
          : 'cf-check',
    },
    {
      index: 4,
      name: 'PR',
      done: prOpen,
      detail: prOpen ? String(claim?.pr) : 'open PR · human merge',
    },
  ]
}

function liveStepIndex(phases: PhaseInfo[]): number {
  const firstOpen = phases.findIndex(p => !p.done)
  return firstOpen === -1 ? phases.length - 1 : firstOpen
}

async function humanReset($: Engine, stateDir: string): Promise<boolean> {
  const path = stateDir + '/state.json'
  if (!(await $.fs.exists(path))) return false
  const obj = asRecord(JSON.parse(await $.fs.read(path)))
  if (!obj) return false
  const ms = await Promise.resolve($.clock.now())
  const at = new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
  obj.check_failures = 0
  obj.reset_at = at
  obj.reset_by = 'human (factory pane Proceed/Reset)'
  obj.updated_at = at
  await $.fs.write(path, JSON.stringify(obj, null, 2) + '\n')
  $.ui.invalidate('ui.render')
  await Promise.resolve(
    $.ui.toast('claude-factory: failure counter reset — Claude may cf-check again'),
  )
  return true
}

export function register(
  on: (
    event: string,
    matcherOrHook?: unknown,
    hook?: unknown,
  ) => { catch?: (handler: unknown) => void },
) {
  on('session.start', async ($: Engine, e: unknown, next: (ev: unknown) => Promise<unknown>) => {
    await $.command.register({
      name: COMMAND,
      description: 'Open the Software Factory pane (steps / status / hard-stop)',
      immediate: true,
    })
    $.clock.every(2000, async () => {
      $.ui.invalidate('ui.render')
      try {
        const snap = await loadSnapshot($)
        if (snap.hardStop && !lastHardStop) {
          lastHardStop = true
          const placed = await $.ui.open({
            id: PANE,
            title: 'Factory',
            focus: true,
            closeOnEscape: true,
          })
          if (!placed?.isPlaced && !toastShownForStop) {
            toastShownForStop = true
            await Promise.resolve($.ui.toast('Factory HARD STOP — run /factory-pane'))
          }
        }
        if (!snap.hardStop) {
          lastHardStop = false
          toastShownForStop = false
        }
      } catch {
        // ignore poll errors
      }
    })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($: Engine) => {
    await $.ui.open({ id: PANE, title: 'Factory', focus: true, closeOnEscape: true })
    toastShownForStop = false
    return {}
  })

  on(
    'tool.call',
    async ($: Engine, e: Record<string, unknown>, next: (ev: unknown) => Promise<unknown>) => {
      const result = await next(e)
      const tool = e.tool ?? e.name
      const input = asRecord(e.input) ?? asRecord(e.arguments) ?? {}
      const cmd = String(input.command ?? '')
      if (tool === 'Bash' && /cf-(check|claim|ready|worktree|evidence)/.test(cmd)) {
        $.ui.invalidate('ui.render')
      }
      return result
    },
  )

  // #2 Token Weather–style AbovePrompt band
  on(
    'ui.render',
    { component: 'AbovePrompt' },
    async ($: Engine, e: Record<string, unknown>, next: (ev: unknown) => Promise<unknown>) => {
      const props = asRecord(e.props) ?? {}
      if (props.hasSurvey) return next(e)
      const snap = await loadSnapshot($)
      if (!snap.claim && !snap.hardStop) return next(e)
      const { Box, Text, Button } = $.ui.resolve(e)
      const failures = Number(snap.state?.check_failures ?? 0)
      const max = Number(snap.state?.max_failures ?? 2)
      const issue = snap.claim?.issue ?? snap.state?.issue ?? '?'
      const planExists = Boolean(snap.stateDir && (await $.fs.exists(snap.stateDir + '/plan.md')))
      const live = liveStepIndex(phasesOf(snap, planExists))
      const status = snap.hardStop
        ? 'HARD STOP ' + failures + '/' + max
        : PHASES[live] + ' · ' + failures + '/' + max
      const theirs = await next(e)
      const band = Box({
        flexDirection: 'row',
        columnGap: 2,
        children: [
          Text({
            bold: snap.hardStop,
            color: snap.hardStop ? 'red' : undefined,
            children: ['factory #' + String(issue) + ' · ' + status],
          }),
          Button({
            key: 'open-factory-pane',
            label: 'pane',
            plain: true,
            hotkey: 'f',
            onPress: async () => {
              await $.ui.open({ id: PANE, title: 'Factory', focus: true, closeOnEscape: true })
            },
          }),
        ],
      })
      if (theirs == null) return band
      return Box({ flexDirection: 'column', children: [band, theirs] })
    },
  )

  on(
    'ui.render',
    { component: 'Spinner' },
    async ($: Engine, e: Record<string, unknown>, next: (ev: unknown) => Promise<unknown>) => {
      const snap = await loadSnapshot($)
      if (!snap.state) return next(e)
      const failures = Number(snap.state.check_failures ?? 0)
      const max = Number(snap.state.max_failures ?? 2)
      const suffix = snap.hardStop
        ? ' · factory HARD STOP ' + failures + '/' + max
        : ' · factory ' + failures + '/' + max
      const props = asRecord(e.props) ?? {}
      return next({ ...e, props: { ...props, suffix } })
    },
  )

  // #3 Blast Radius hard-stop + #4 Replay step strip
  on(
    'ui.render',
    { component: 'Pane' },
    async ($: Engine, e: Record<string, unknown>, next: (ev: unknown) => Promise<unknown>) => {
      if (e.requestId !== PANE) return next(e)
      const { Box, Text, Button } = $.ui.resolve(e)
      const snap = await loadSnapshot($)
      const redraw = () => $.ui.invalidate('ui.render')
      const planExists = Boolean(snap.stateDir && (await $.fs.exists(snap.stateDir + '/plan.md')))
      const phases = phasesOf(snap, planExists)
      const live = liveStepIndex(phases)
      const step = viewStep == null ? live : Math.max(0, Math.min(PHASES.length - 1, viewStep))
      const focus = phases[step]

      const failures = Number(snap.state?.check_failures ?? 0)
      const max = Number(snap.state?.max_failures ?? 2)
      const issue = snap.claim?.issue ?? snap.state?.issue
      const title = snap.claim?.title ?? '(no claim)'
      const last = snap.state?.last_check
      const lastLine = last
        ? String(last.result ?? '?') +
          ' @ ' +
          String(last.at ?? '?') +
          (last.exit_code != null ? ' (exit ' + String(last.exit_code) + ')' : '')
        : '—'

      const strip = Box({
        flexDirection: 'row',
        columnGap: 1,
        children: phases.map(ph =>
          Button({
            key: 'step-' + String(ph.index),
            label: String(ph.index + 1) + ':' + ph.name,
            plain: true,
            hotkey: String(ph.index + 1),
            dimColor: ph.index !== step,
            onPress: () => {
              viewStep = ph.index
              redraw()
            },
          }),
        ),
      })

      const nav = Box({
        flexDirection: 'row',
        columnGap: 2,
        children: [
          Button({
            key: 'prev',
            label: 'Prev',
            hotkey: 'b',
            onPress: () => {
              viewStep = Math.max(0, step - 1)
              redraw()
            },
          }),
          Button({
            key: 'next',
            label: 'Next',
            hotkey: 'n',
            onPress: () => {
              viewStep = Math.min(PHASES.length - 1, step + 1)
              redraw()
            },
          }),
          Button({
            key: 'live',
            label: 'Live',
            hotkey: 'v',
            plain: true,
            dimColor: viewStep == null,
            onPress: () => {
              viewStep = null
              redraw()
            },
          }),
          Button({
            key: 'close',
            label: 'Close',
            hotkey: 'x',
            onPress: async () => {
              await $.ui.close({ id: PANE })
            },
          }),
        ],
      })

      const body: unknown[] = [
        Text({ bold: true, children: ['Software Factory'] }),
        Text({
          dimColor: true,
          children: [
            'Step ' +
              String(step + 1) +
              '/' +
              String(PHASES.length) +
              ' · ' +
              focus.name +
              (viewStep == null ? ' (live)' : ' (browsing)'),
          ],
        }),
        Text({ children: [' '] }),
        strip,
        Text({ children: [' '] }),
        Text({ bold: true, children: [focus.name + ' — ' + focus.detail] }),
        Text({ children: [' '] }),
        Text({
          children: [line('Claim', issue != null ? '#' + String(issue) + ' ' + title : 'none')],
        }),
        Text({ children: [line('Repo', snap.claim?.repo ?? '—')] }),
        Text({ children: [line('Branch', snap.claim?.branch ?? '—')] }),
        Text({
          children: [
            line(
              'Checks',
              String(failures) +
                ' / ' +
                String(max) +
                ' failures · runs ' +
                String(snap.state?.checks_run ?? 0),
            ),
          ],
        }),
        Text({
          color: snap.hardStop ? 'red' : undefined,
          bold: snap.hardStop,
          children: [
            line('Status', snap.hardStop ? 'HARD STOP' : issue != null ? 'active' : 'idle'),
          ],
        }),
        Text({ children: [line('Last check', lastLine)] }),
        Text({ children: [line('Queue', snap.queueHint)] }),
        Text({ dimColor: true, children: [line('State', snap.stateDir ?? '—')] }),
        Text({ children: [' '] }),
        nav,
      ]

      if (snap.hardStop) {
        body.push(Text({ children: [' '] }))
        body.push(
          Text({
            children: [
              'Hard stop: cf-guard blocks tools until a human resets. Cancel closes this pane only.',
            ],
          }),
        )
        body.push(
          Box({
            flexDirection: 'row',
            columnGap: 2,
            children: [
              Button({
                key: 'proceed',
                label: 'Proceed (reset)',
                hotkey: 'p',
                autoFocus: true,
                onPress: async () => {
                  if (snap.stateDir) await humanReset($, snap.stateDir)
                  viewStep = null
                  redraw()
                },
              }),
              Button({
                key: 'reset',
                label: 'Reset',
                hotkey: 'r',
                onPress: async () => {
                  if (snap.stateDir) await humanReset($, snap.stateDir)
                  viewStep = null
                  redraw()
                },
              }),
              Button({
                key: 'cancel',
                label: 'Cancel',
                hotkey: 'c',
                onPress: async () => {
                  await $.ui.close({ id: PANE })
                },
              }),
            ],
          }),
        )
      }

      return Box({ flexDirection: 'column', children: body })
    },
  )
}
