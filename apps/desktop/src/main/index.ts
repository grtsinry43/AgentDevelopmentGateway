import { app, BrowserWindow } from 'electron'
import { registerIpcHandlers } from './ipc/index.js'
import { openLauncher } from './windows/launcher.js'
import { setOnLastProjectClosed } from './windows/project.js'

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
    await openLauncher()

    app.on('activate', () => {
      // macOS:dock 图标点击时,没有任何窗口才开 Launcher
      if (BrowserWindow.getAllWindows().length === 0) void openLauncher()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
