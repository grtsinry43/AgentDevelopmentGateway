import { BrowserWindow, dialog, ipcMain } from 'electron'
import { z } from 'zod'
import { IPC } from '../../contract/bridge.js'
import { listHostProfiles, removeHostProfile, saveHostProfile } from '../store/host-profiles.js'
import { broadcast } from './broadcast.js'

const hostProfileInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1),
  username: z.string().trim().min(1),
  hostname: z.string().trim().min(1),
  port: z.number().int().min(1).max(65_535),
  auth: z.enum(['key', 'password']),
  keyPath: z.string().trim().min(1).optional(),
  password: z.string().optional(),
  rememberPassword: z.boolean().optional()
})

async function announceHosts(): Promise<void> {
  broadcast({ kind: 'hosts.changed', hosts: await listHostProfiles() })
}

export function registerHostHandlers(): void {
  ipcMain.handle(IPC.hostsList, () => listHostProfiles())

  ipcMain.handle(IPC.hostsSave, async (_event, rawInput: unknown) => {
    const input = hostProfileInputSchema.parse(rawInput)
    if (input.auth === 'key' && !input.keyPath) throw new Error('密钥认证需要选择私钥文件')
    const saved = await saveHostProfile(input)
    await announceHosts()
    return saved
  })

  ipcMain.handle(IPC.hostsRemove, async (_event, rawId: unknown) => {
    await removeHostProfile(z.string().uuid().parse(rawId))
    await announceHosts()
  })

  ipcMain.handle(IPC.hostsPickKeyFile, async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: '选择私钥文件',
      properties: ['openFile', 'showHiddenFiles'] as Array<'openFile' | 'showHiddenFiles'>
    }
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled) return null
    return result.filePaths[0] ?? null
  })
}
