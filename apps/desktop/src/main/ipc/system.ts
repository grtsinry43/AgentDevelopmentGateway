import { BrowserWindow, ipcMain, nativeTheme, shell } from 'electron'
import { IPC } from '../../contract/bridge.js'
import { broadcast } from './broadcast.js'

export function registerSystemHandlers(): void {
  // 注意:SystemInfo 不走 IPC —— 它在窗口创建时通过 additionalArguments 注入,
  // 渲染进程首帧就能同步读到(见 windows/chrome.ts)。

  ipcMain.handle(IPC.systemOpenExternal, async (_event, url: string) => {
    // 只放行 http(s)。`file://` / `javascript:` 之类交给 shell 会变成本地代码执行面。
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`拒绝打开非 http(s) 链接: ${parsed.protocol}`)
    }
    await shell.openExternal(url)
  })

  // nativeTheme 是系统主题的权威来源(比 renderer 的 matchMedia 更可靠)。
  // 推送给所有窗口,渲染进程侧只订阅、不查询。
  nativeTheme.on('updated', () => {
    broadcast({ kind: 'theme.changed', isDark: nativeTheme.shouldUseDarkColors })
  })
}

export function registerWindowHandlers(): void {
  const senderWindow = (event: Electron.IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(event.sender)

  ipcMain.handle(IPC.windowMinimize, (event) => {
    senderWindow(event)?.minimize()
  })

  ipcMain.handle(IPC.windowToggleMaximize, (event) => {
    const window = senderWindow(event)
    if (!window) return
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })

  ipcMain.handle(IPC.windowClose, (event) => {
    senderWindow(event)?.close()
  })
}
