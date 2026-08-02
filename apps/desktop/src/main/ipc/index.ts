import { registerContextProfileHandlers } from './context-profiles.js'
import { registerExportIpc } from '../export/manager.js'
import { registerFileHandlers } from './files.js'
import { registerGitHandlers } from './git.js'
import { registerHostHandlers } from './hosts.js'
import { registerProviderHandlers } from './providers.js'
import { registerPreviewHandlers } from './preview.js'
import { registerLayoutHandlers, registerProjectHandlers } from './projects.js'
import { registerRemoteHandlers } from './remote.js'
import { registerSessionHandlers } from './sessions.js'
import { registerSystemHandlers, registerWindowHandlers } from './system.js'
import { registerTerminalHandlers } from './terminals.js'

/** 注册全部 IPC handler。必须在任何窗口创建前调用。 */
export function registerIpcHandlers(): void {
  registerSystemHandlers()
  registerWindowHandlers()
  registerProjectHandlers()
  registerHostHandlers()
  registerProviderHandlers()
  registerPreviewHandlers()
  registerRemoteHandlers()
  registerExportIpc()
  registerSessionHandlers()
  registerFileHandlers()
  registerGitHandlers()
  registerTerminalHandlers()
  registerLayoutHandlers()
  registerContextProfileHandlers()
}
