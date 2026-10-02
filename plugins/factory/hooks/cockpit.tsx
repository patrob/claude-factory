import type { Register } from 'claude-code'

import { claimDetailRows, loadClaimStatus } from './cockpit-claim'

const PANE = 'factory-cockpit'
const COMMAND = 'factory-cockpit'
const TITLE = 'Factory cockpit'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Open the factory cockpit pane (job status)',
    })

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true })

    return { text: 'Factory cockpit opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)

    let root: string
    try {
      root = await $.session.root()
    } catch {
      return (
        <Box flexDirection="column">
          <Box key="cockpit-empty" flexDirection="column">
            <Text bold>No active claim</Text>
            <Text dimColor>Claim a ticket with /factory:sdv or cf-claim to see its status here.</Text>
          </Box>
        </Box>
      )
    }

    const status = await loadClaimStatus(root, {
      exists: p => $.fs.exists(p),
      read: p => $.fs.read(p),
    })

    if (status.kind === 'present') {
      return (
        <Box flexDirection="column">
          <Box key="cockpit-present" flexDirection="column">
            <Text bold>Active claim</Text>
            {claimDetailRows(status.details).map(row => (
              <Box key={`cockpit-${row.key}`}>
                <Text dimColor>{row.label}: </Text>
                <Text>{row.value}</Text>
              </Box>
            ))}
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box key="cockpit-empty" flexDirection="column">
          <Text bold>No active claim</Text>
          <Text dimColor>Claim a ticket with /factory:sdv or cf-claim to see its status here.</Text>
        </Box>
        {status.kind === 'unreadable' && (
          <Box key="cockpit-unreadable">
            <Text dimColor>Claim file unreadable: {status.reason}</Text>
          </Box>
        )}
      </Box>
    )
  })
}
