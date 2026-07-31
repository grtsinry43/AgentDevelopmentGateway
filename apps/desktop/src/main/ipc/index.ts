import { registerContextProfileHandlers } from './context-profiles.js'
import { registerLayoutHandlers, registerProjectHandlers } from './projects.js'
import { registerSessionHandlers } from './sessions.js'
import { registerSystemHandlers, registerWindowHandlers } from './system.js'

/** 注册全部 IPC handler。必须在任何窗口创建前调用。 */
export function registerIpcHandlers(): void {
  registerSystemHandlers()
  registerWindowHandlers()
  registerProjectHandlers()
  registerSessionHandlers()
  registerLayoutHandlers()
  registerContextProfileHandlers()
}
