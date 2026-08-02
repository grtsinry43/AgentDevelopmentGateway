import { BrowserWindow } from 'electron'
import { baseWindowOptions, entryUrl } from './chrome.js'

let window: BrowserWindow | null = null

/** 关于窗口。应用信息 + 图标 + 版本。 */
export async function openAboutWindow(): Promise<BrowserWindow> {
  if (window && !window.isDestroyed()) {
    window.show()
    window.focus()
    return window
  }

  const win = new BrowserWindow({
    ...baseWindowOptions({ kind: 'about' }),
    width: 420,
    height: 480,
    minWidth: 380,
    minHeight: 440,
    maximizable: false,
    fullscreenable: false,
    resizable: false,
    title: '关于'
  })

  window = win
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    window = null
  })

  const entry = entryUrl('about')
  await (entry.url ? win.loadURL(entry.url) : win.loadFile(entry.file!))
  return win
}
