import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { registerIpcHandlers } from './ipc/index.js'
import { localServerManager } from './local/server-manager.js'
import { wireMenuLifecycle } from './menu.js'
import { closeAllRemoteConnections } from './remote/index.js'
import { listHostProfiles } from './store/host-profiles.js'
import { openLauncher } from './windows/launcher.js'
import { markAppQuitting, setOnLastProjectClosed } from './windows/project.js'

// electron-vite 以 `electron <entry>` 启动,Electron 不会读 package.json 的
// productName,默认名字是 "Electron"。显式设置应用名(菜单/Dock/关于都用到)。
app.setName('Agent Development Gateway')

/** dev 下用项目图标作为 Dock 图标(打包后由 app bundle 提供)。 */
function applyDockIcon(): void {
  if (process.platform !== 'darwin' || !app.dock) return
  const icon = join(app.getAppPath(), 'build', 'icon.png')
  if (existsSync(icon)) app.dock.setIcon(icon)
}

/** 单实例:第二次启动应该聚焦已有 Launcher,而不是开出第二个应用。 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    void openLauncher()
  })

  // 关掉最后一个工程窗口后回到 Launcher —— 否则应用还活着但没有任何入口。
  setOnLastProjectClosed(() => {
    if (BrowserWindow.getAllWindows().length === 0) void openLauncher()
  })

  app.whenReady().then(async () => {
    registerIpcHandlers()
    applyDockIcon()
    wireMenuLifecycle()
    await openLauncher()

    app.on('activate', () => {
      // macOS:dock 图标点击时,没有任何窗口才开 Launcher
      if (BrowserWindow.getAllWindows().length === 0) void openLauncher()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // 退出时收掉 SSH 隧道与控制连接(远程 server 继续运行);本地 server 是应用拉起的,
  // 跟随应用优雅停止(外部已存在的实例不碰)。关闭窗口不再逐个弹确认。
  app.on('before-quit', () => {
    markAppQuitting()
    void listHostProfiles().then((profiles) => closeAllRemoteConnections(profiles))
    void localServerManager.stop()
  })
}
