// The factory plugin's $.state contract: what the factory-floor pane draws from.
// Every value here is derived, read-only, from the files the cf-* tools write in the
// factory state dir (claim.json, state.json, plan.md, evidence.md). The pane never writes them.

export type FloorStageId = 'ready' | 'claim' | 'plan' | 'worktree' | 'check' | 'evidence' | 'pr' | 'merge'

export type FloorStageStatus = 'done' | 'current' | 'blocked' | 'todo'

export type FloorStage = {
  id: FloorStageId
  label: string
  status: FloorStageStatus
  note: string
}

export type FloorTicket = {
  repo: string
  number: number
  title: string
  url: string
  status: string
  claimedAt: string | null
  claimedBy: string | null
}

export type FloorEvidence = {
  checkCmd: string | null
  lastResult: 'pass' | 'fail' | null
  lastAt: string | null
  log: string | null
  checksRun: number
  failures: number
  maxFailures: number
  evidencePath: string | null
  evidenceAt: string | null
  branch: string | null
  base: string | null
  worktree: string | null
  pr: string | null
}

export type FloorNext = {
  // The slash command that runs the step, or null when the next move is a human's.
  skill: string | null
  step: string
  run: string | null
  why: string
  isHuman: boolean
}

export type FloorSnapshot = {
  repoRoot: string | null
  stateDir: string | null
  ticket: FloorTicket | null
  current: FloorStageId
  hardStop: boolean
  stages: FloorStage[]
  evidence: FloorEvidence
  next: FloorNext
  updatedAt: string | null
}

declare module 'claude-code' {
  interface PluginState {
    factory: { floor: FloorSnapshot | null }
  }
}
