export const CLAIM_PATHS = ['.claude-factory/claim.json', '.git/claude-factory/claim.json'] as const

export type ClaimStatus =
  | { kind: 'none' }
  | { kind: 'unreadable'; path: string; reason: string }
  | { kind: 'present'; path: string }

type ClaimFs = { exists: (path: string) => Promise<boolean>; read: (path: string) => Promise<string> }

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
      return { kind: 'present', path }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return { kind: 'unreadable', path, reason }
    }
  }

  return { kind: 'none' }
}
