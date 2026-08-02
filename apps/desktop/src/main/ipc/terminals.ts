import {
  createTerminalRequestSchema,
  terminalClientMessageSchema,
  terminalParamsSchema
} from '@agent-gateway/shared'
import { ipcMain } from 'electron'
import { IPC } from '../../contract/bridge.js'
import { resolveForSender, resolveServerProject } from '../server/gateway.js'
import { terminalConnections } from '../server/terminal-connections.js'

export function registerTerminalHandlers(): void {
  ipcMain.handle(IPC.terminalsCapabilities, async (_event, rawProjectKey: unknown) => {
    const resolved = await resolveServerProject(parseProjectKey(rawProjectKey))
    return (await resolved.client.serverInfo()).capabilities.filter((capability) =>
      capability.startsWith('workspace.terminals.')
    )
  })

  ipcMain.handle(IPC.terminalsList, async (_event, rawProjectKey: unknown) => {
    const resolved = await resolveServerProject(parseProjectKey(rawProjectKey))
    return resolved.client.terminals(resolved.serverProjectId)
  })

  ipcMain.handle(
    IPC.terminalsCreate,
    async (_event, rawProjectKey: unknown, rawInput: unknown) => {
      const resolved = await resolveServerProject(parseProjectKey(rawProjectKey))
      return resolved.client.createTerminal(
        resolved.serverProjectId,
        createTerminalRequestSchema.parse(rawInput)
      )
    }
  )

  ipcMain.handle(IPC.terminalsClose, async (event, rawTerminalId: unknown) => {
    const { client } = await resolveForSender(event.sender)
    await client.closeTerminal(parseTerminalId(rawTerminalId))
  })

  ipcMain.handle(
    IPC.terminalsAttach,
    async (
      event,
      rawTerminalId: unknown,
      rawAfterSequence: unknown,
      rawCols: unknown,
      rawRows: unknown
    ) => {
      const message = terminalClientMessageSchema.parse({
        type: 'terminal.attach',
        afterSequence: rawAfterSequence,
        cols: rawCols,
        rows: rawRows
      })
      if (message.type !== 'terminal.attach') throw new Error('无效的终端连接参数')
      const { client } = await resolveForSender(event.sender)
      terminalConnections.attach(
        event.sender,
        client,
        parseTerminalId(rawTerminalId),
        message.afterSequence,
        message.cols,
        message.rows
      )
    }
  )

  ipcMain.handle(IPC.terminalsDetach, (event, rawTerminalId: unknown) => {
    terminalConnections.detach(event.sender, parseTerminalId(rawTerminalId))
  })

  ipcMain.handle(
    IPC.terminalsInput,
    (event, rawTerminalId: unknown, rawData: unknown) => {
      const terminalId = parseTerminalId(rawTerminalId)
      const message = terminalClientMessageSchema.parse({ type: 'terminal.input', data: rawData })
      if (message.type !== 'terminal.input') throw new Error('无效的终端输入')
      terminalConnections.input(event.sender, terminalId, message.data)
    }
  )

  ipcMain.handle(
    IPC.terminalsResize,
    (event, rawTerminalId: unknown, rawCols: unknown, rawRows: unknown) => {
      const terminalId = parseTerminalId(rawTerminalId)
      const message = terminalClientMessageSchema.parse({
        type: 'terminal.resize',
        cols: rawCols,
        rows: rawRows
      })
      if (message.type !== 'terminal.resize') throw new Error('无效的终端尺寸')
      terminalConnections.resize(event.sender, terminalId, message.cols, message.rows)
    }
  )

  ipcMain.handle(IPC.terminalsRetry, (event, rawTerminalId: unknown) => {
    terminalConnections.retry(event.sender, parseTerminalId(rawTerminalId))
  })

  ipcMain.handle(
    IPC.terminalsAck,
    (event, rawTerminalId: unknown, rawSequence: unknown) => {
      const message = terminalClientMessageSchema.parse({
        type: 'terminal.ack',
        sequence: rawSequence
      })
      if (message.type !== 'terminal.ack') throw new Error('无效的终端确认序列')
      terminalConnections.acknowledge(
        event.sender,
        parseTerminalId(rawTerminalId),
        message.sequence
      )
    }
  )
}

function parseProjectKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('无效的工程标识')
  return value
}

function parseTerminalId(value: unknown): string {
  return terminalParamsSchema.parse({ terminalId: value }).terminalId
}
