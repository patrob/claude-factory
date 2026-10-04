// Factory floor: a pane that shows the claimed ticket, its stage, the evidence so far and
// the next skill to run. `/factory:floor` opens it. It reads the state the cf-* tools write
// and never writes it, never merges, and offers no action but Refresh.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FloorSnapshot, FloorStageStatus } from '../types'
import { STAGES, deriveFloor, floorText, stagePosition, stateDirCandidates } from './floor-model'

const PANE = 'factory-floor'
const COMMAND = 'factory:floor'
const POLL_MS = 10_000
const floor = atom({ plugin: 'factory', key: 'floor' } as const, null)

// Bash and Edit/Write calls that move a ticket through the stages.
const FACTORY_BASH = /\bcf-(ready|claim|worktree|check|evidence|watch)\b|\bgh\s+pr\s+create\b|\bgit\b.*\b(commit|push)\b/
const FACTORY_FILE = /claude-factory\//

// True once the pane has drawn in this load of the module: only then do tool calls and the timer re-read state.
let isShowing = false

async function readText($: EngineInterface, path: string): Promise<string | null> {
  try {
    if (!(await $.fs.exists(path))) return null
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

async function loadFloor($: EngineInterface): Promise<FloorSnapshot> {
  const cwd = await $.session.cwd()
  let root: string | null = null
  try {
    const git = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      timeoutMs: 5_000,
    })
    const common = git.stdout.trim()
    if (git.exitCode === 0 && common.endsWith('/.git')) root = common.slice(0, -'/.git'.length)
  } catch {
    root = null
  }
  const guard = (await $.env.get('CF_PRIMARY_GUARD')) === '1'
  let stateDir: string | null = null
  for (const dir of stateDirCandidates(root, cwd, guard)) {
    if (await $.fs.exists(`${dir}/state.json`)) {
      stateDir = dir
      break
    }
  }
  return deriveFloor({
    repoRoot: root,
    stateDir,
    claim: stateDir ? await readText($, `${stateDir}/claim.json`) : null,
    state: stateDir ? await readText($, `${stateDir}/state.json`) : null,
    plan: stateDir ? await readText($, `${stateDir}/plan.md`) : null,
    evidence: stateDir ? await readText($, `${stateDir}/evidence.md`) : null,
  })
}

async function refresh($: EngineInterface): Promise<FloorSnapshot> {
  const snap = await loadFloor($)
  const json = JSON.stringify(snap)
  await update($, floor, prev => (prev && JSON.stringify(prev) === json ? prev : snap))
  return snap
}

const MARK: Record<FloorStageStatus, { glyph: string; color?: string }> = {
  done: { glyph: '✓', color: 'green' },
  current: { glyph: '▶', color: 'cyan' },
  blocked: { glyph: '✗', color: 'red' },
  todo: { glyph: '·' },
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.clock.every(POLL_MS, () => {
      if (isShowing) void refresh($)
    })
    return next(e)
  })

  // /factory:floor is the plugin's skill command; answering it here opens the pane with no model turn.
  on('command.run', { command: COMMAND }, async $ => {
    const snap = await refresh($)
    const surfaces = await $.session.surfaces()
    if (!surfaces.some(s => s === 'terminal' || s === 'desktop')) return { text: floorText(snap) }
    const placed = await $.ui.open({ id: PANE, title: 'Factory floor' })
    return placed.isPlaced ? {} : { text: `Factory floor is open but not drawn yet: ${placed.reason}` }
  })

  // Watch the session move through the stages; the call itself runs exactly as it would without the pane.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (isShowing) {
      const input = e as { tool: unknown; command?: unknown; file_path?: unknown }
      const tool = String(input.tool)
      const touches =
        (tool === 'Bash' && typeof input.command === 'string' && FACTORY_BASH.test(input.command)) ||
        ((tool === 'Edit' || tool === 'Write') &&
          typeof input.file_path === 'string' &&
          FACTORY_FILE.test(input.file_path))
      if (touches) await refresh($)
    }
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    isShowing = true
    const { Box, Text, Button } = $.ui.resolve(e)
    const f = await read($, floor)
    const width = Math.max(24, e.props.bodyColumns)
    const labelWidth = 10

    const heading = (text: string, extra?: string) => (
      <Box flexDirection="row" columnGap={1} marginTop={1}>
        <Text bold>{text}</Text>
        {extra ? <Text dimColor>{extra}</Text> : null}
      </Box>
    )
    const row = (label: string, value: string, opts: { color?: string; wrap?: 'wrap' | 'truncate-middle' } = {}) => (
      <Box flexDirection="row">
        <Box width={labelWidth} flexShrink={0}>
          <Text dimColor>{label}</Text>
        </Box>
        <Text color={opts.color} wrap={opts.wrap ?? 'truncate-middle'}>
          {value}
        </Text>
      </Box>
    )
    const refreshButton = (
      <Button key="refresh" label="Refresh" hotkey="r" plain onPress={() => void refresh($)} />
    )

    if (!f) {
      return (
        <Box flexDirection="column" width={width}>
          <Text dimColor>Reading factory state…</Text>
          {refreshButton}
        </Box>
      )
    }

    const at = stagePosition(f.current)
    const ev = f.evidence
    const result =
      ev.lastResult === 'pass' ? '✅ pass' : ev.lastResult === 'fail' ? '❌ fail' : 'not run'

    return (
      <Box flexDirection="column" width={width}>
        {f.hardStop ? (
          <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
            <Text color="red" bold>
              {`HARD STOP · cf-check failed ${ev.failures}/${ev.maxFailures}`}
            </Text>
            <Text wrap="wrap">A human decides. Typing cf-reset as a prompt allows more attempts.</Text>
          </Box>
        ) : null}

        {heading('Ticket')}
        {f.ticket ? (
          <Box flexDirection="column" key="ticket">
            <Text bold wrap="wrap">{`#${f.ticket.number}  ${f.ticket.title}`}</Text>
            <Text dimColor wrap="truncate-end">
              {[f.ticket.repo, f.ticket.status, f.ticket.claimedBy].filter(Boolean).join(' · ')}
            </Text>
            <Text dimColor wrap="truncate-middle">{f.ticket.url}</Text>
          </Box>
        ) : (
          <Box flexDirection="column" key="ticket">
            <Text>No ticket claimed.</Text>
            <Text dimColor wrap="wrap">
              {f.repoRoot ? `Queue: open issues labeled factory-ready or sdv in ${f.repoRoot}` : 'Not inside a git repository.'}
            </Text>
          </Box>
        )}

        {heading('Stage', `${at.index + 1}/${STAGES.length} · ${at.label}`)}
        <Box flexDirection="column" key="stages">
          {f.stages.map(st => (
            <Box flexDirection="row" key={`stage-${st.id}`}>
              <Box width={2} flexShrink={0}>
                <Text color={MARK[st.status].color} dimColor={st.status === 'todo'}>
                  {MARK[st.status].glyph}
                </Text>
              </Box>
              <Box width={labelWidth + 2} flexShrink={0}>
                <Text bold={st.status === 'current' || st.status === 'blocked'} dimColor={st.status === 'todo'}>
                  {st.label}
                </Text>
              </Box>
              <Text dimColor wrap="truncate-end">
                {st.note}
              </Text>
            </Box>
          ))}
        </Box>

        {heading('Evidence')}
        <Box flexDirection="column" key="evidence">
          {row('Check', ev.checkCmd ?? '—')}
          {row('Result', `${result} · ${ev.checksRun} run${ev.checksRun === 1 ? '' : 's'} · ${ev.failures}/${ev.maxFailures} failures`, {
            color: ev.lastResult === 'fail' ? 'red' : undefined,
          })}
          {ev.log ? row('Log', ev.log) : null}
          {ev.branch ? row('Branch', ev.base ? `${ev.branch} → ${ev.base}` : ev.branch) : null}
          {ev.worktree ? row('Worktree', ev.worktree) : null}
          {row('Pack', ev.evidencePath ?? 'not built for this check yet')}
          {row('PR', ev.pr ?? 'none yet')}
        </Box>

        {heading('Next')}
        <Box flexDirection="column" key="next">
          <Box flexDirection="row" columnGap={1}>
            <Text bold color={f.next.isHuman ? 'yellow' : 'cyan'}>
              {f.next.skill ?? 'Human'}
            </Text>
            <Text dimColor>{f.next.step}</Text>
          </Box>
          {f.next.run ? row('Run', f.next.run, { wrap: 'wrap' }) : null}
          <Text wrap="wrap">{f.next.why}</Text>
        </Box>

        <Box flexDirection="row" columnGap={2} marginTop={1}>
          {refreshButton}
          <Text dimColor wrap="truncate-end">
            {`Human merges · state ${f.updatedAt ?? '—'}`}
          </Text>
        </Box>
      </Box>
    )
  })
}
