// Factory floor: the one action that needs a person, drawn as a picture, whether
// this session is running or idle, and a compact token HUD. `/factory:floor` opens it.
// It reads the state the cf-* tools write and Claude Code's own usage figures.
// It never writes factory state and never merges. Its controls are Refresh and Start,
// which runs the current skill in this session with this session's conversation.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { FloorSnapshot } from '../types'
import { badgeRgba, pictureOf, RASTER_ROWS, rasterCells, rasterColumns, svgMarkup } from './floor-picture'
import {
  addUsage,
  attentionOf,
  carriedConversation,
  deriveFloor,
  floorText,
  formatTokenHud,
  skillCommand,
  stateDirCandidates,
  usageFromApi,
  ZERO_USAGE,
} from './floor-model'
import type { RequestUsage, SessionUsageSnap } from './floor-model'

const PANE = 'factory-floor'
const COMMAND = 'factory:floor'
const POLL_MS = 10_000
const floor = atom({ plugin: 'factory', key: 'floor' } as const, null)

// Bash and Edit/Write calls that move a ticket through the stages.
const FACTORY_BASH = /\bcf-(ready|claim|worktree|check|evidence|watch)\b|\bgh\s+pr\s+create\b|\bgit\b.*\b(commit|push)\b/
const FACTORY_FILE = /claude-factory\//

// True once the pane has drawn in this load of the module: only then do tool calls and the timer re-read state.
let isShowing = false
// Main-loop turns in flight. Subagent turns do not flip the floor.
let openTurns = 0
// Sum of main-loop turn.step result.usage. Stays empty until a request reports counts.
let requestUsage: RequestUsage = ZERO_USAGE
// What the last Start press did, shown under the picture; error marks a start that did not happen.
let startNote: { text: string; isError: boolean } | null = null
let isStarting = false

function isSubagent(e: { agentId?: unknown }): boolean {
  return typeof e.agentId === 'string' && e.agentId.length > 0
}

function noteRequest(usage: unknown): void {
  const picked = usageFromApi(usage)
  if (!picked) return
  requestUsage = addUsage(requestUsage, picked)
}

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

// cost.usd and context.tokens, nothing else. A missing field stays null.
async function readSessionUsage($: EngineInterface): Promise<SessionUsageSnap> {
  try {
    const usage = await $.session.usage()
    const tokens = usage.context.tokens
    const usd = usage.cost?.usd
    return {
      contextTokens: typeof tokens === 'number' ? tokens : null,
      costUsd: typeof usd === 'number' ? usd : null,
    }
  } catch {
    return { contextTokens: null, costUsd: null }
  }
}

// Start: read this session, append a user row the model reads (not a system notice), then run the skill here.
async function startSkill($: EngineInterface, skill: string): Promise<void> {
  if (isStarting) return
  isStarting = true
  const { command, args } = skillCommand(skill)
  const label = `/${command}${args ? ` ${args}` : ''}`
  try {
    let messages: Awaited<ReturnType<EngineInterface['session']['messages']>>
    try {
      messages = await $.session.messages()
    } catch (err) {
      startNote = { text: `Not started: could not read this session (${String(err)})`, isError: true }
      return
    }
    // The skill runs in this session, so a row that is not kept loses the label, not the context: say so and start.
    const text = carriedConversation(messages)
    let carried = text ? 'with this conversation' : 'with no conversation to carry'
    if (text) {
      try {
        // type user: the model reads it. type system is a notice the model never reads (2.1.289 SessionAppendArgs).
        const appended = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
        if (appended.deny !== undefined) carried = `conversation not carried: ${appended.deny}`
      } catch (err) {
        carried = `conversation not carried: ${String(err)}`
      }
    }
    startNote = { text: `Starting ${label} · ${carried}`, isError: false }
    $.ui.invalidate('ui.render')
    await $.command.run(args ? { command, args } : { command })
    startNote = { text: `Started ${label} · ${carried}`, isError: false }
  } catch (err) {
    startNote = { text: `Not started: ${label} failed (${String(err)})`, isError: true }
  } finally {
    isStarting = false
    $.ui.invalidate('ui.render')
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.clock.every(POLL_MS, () => {
      if (!isShowing) return
      void refresh($).finally(() => $.ui.invalidate('ui.render'))
    })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!isSubagent(e)) {
      openTurns += 1
      if (isShowing) $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!isSubagent(e)) {
      openTurns = Math.max(0, openTurns - 1)
      if (isShowing) $.ui.invalidate('ui.render')
    }
    return result
  })

  // Each main-loop request reports input_tokens, output_tokens, and the cache counts.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (!isSubagent(e)) {
      noteRequest(result.usage)
      if (isShowing) $.ui.invalidate('ui.render')
    }
    return result
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
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const [f, session] = await Promise.all([read($, floor), readSessionUsage($)])
    const width = Math.max(24, e.props.bodyColumns)
    const running = openTurns > 0
    const hud = formatTokenHud(session, requestUsage)
    const att = f ? attentionOf(f) : null
    const pic = pictureOf(f, att, running)
    // Only a step the factory runs itself: hard stop and human merge carry no skill.
    const skill = att && f && typeof f.next.skill === 'string' && f.next.skill.length > 0 ? f.next.skill : null

    // Terminal: Raster plus an Image badge. Desktop: Svg. Neither draws the other's element.
    let picture: RenderElement | null = null
    if (e.surface === 'terminal' && 'Raster' in ui && 'Image' in ui) {
      const { Raster, Image } = ui
      const columns = rasterColumns(pic.word, width - 6)
      picture = (
        <Box flexDirection="row" gap={1} alignItems="center">
          <Raster key="floor-picture" columns={columns} rows={RASTER_ROWS} cells={rasterCells(pic, columns)} />
          <Image key="floor-badge" source={badgeRgba(pic)} columns={4} rows={2} alt={pic.word} />
        </Box>
      )
    } else if (e.surface === 'desktop' && 'Svg' in ui) {
      const { Svg } = ui
      picture = <Svg source={svgMarkup(pic)} alt={pic.word} width={Math.min(360, width * 8)} />
    }

    return (
      <Box flexDirection="column" width={width}>
        {picture}
        <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
          <Text bold color={running ? 'green' : 'gray'} dimColor={!running}>
            {running ? '● running' : '○ idle'}
          </Text>
          <Box flexDirection="row" gap={2}>
            {skill ? (
              <Button
                key="start"
                label="Start"
                hotkey="s"
                variant="primary"
                onPress={() => void startSkill($, skill)}
              />
            ) : null}
            <Button key="refresh" label="Refresh" hotkey="r" plain dimColor onPress={() => void refresh($)} />
          </Box>
        </Box>
        {!f ? (
          <Text dimColor>Reading factory state…</Text>
        ) : att ? (
          <Box flexDirection="column" key="attention">
            <Text bold color={att.tone} wrap="wrap">
              {att.title}
            </Text>
            <Text wrap="wrap">{att.detail}</Text>
          </Box>
        ) : null}
        {startNote ? (
          <Text color={startNote.isError ? 'red' : undefined} dimColor={!startNote.isError} wrap="wrap">
            {startNote.text}
          </Text>
        ) : null}
        <Text dimColor wrap="truncate-end">
          {hud}
        </Text>
      </Box>
    )
  })
}
