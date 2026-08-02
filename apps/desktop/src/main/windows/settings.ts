import { BrowserWindow } from 'electron'
import { baseWindowOptions, entryUrl } from './chrome.js'

const DEFAULT_SIZE = { width: 960, height: 640 }

let window: BrowserWindow | null = null

/** 设置窗口。偏好以独立窗口承载,不做模态弹窗。 */
export async function openSettingsWindow(): Promise<BrowserWindow> {
  if (window && !window.isDestroyed()) {
    window.show()
    window.focus()
    return window
  }

  const win = new BrowserWindow({
    ...baseWindowOptions({ kind: 'settings' }),
    width: DEFAULT_SIZE.width,
    height: DEFAULT_SIZE.height,
    minWidth: 720,
    minHeight: 520,
    maximizable: false,
    fullscreenable: false,
    title: '设置'
  })

  window = win
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    window = null
  })

  const entry = entryUrl('settings')
  await (entry.url ? win.loadURL(entry.url) : win.loadFile(entry.file!))
  return win
}
