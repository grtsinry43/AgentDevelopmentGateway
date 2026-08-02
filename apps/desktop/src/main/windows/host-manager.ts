import { BrowserWindow } from 'electron'
import { baseWindowOptions, entryUrl } from './chrome.js'

const DEFAULT_SIZE = { width: 520, height: 680 }

let window: BrowserWindow | null = null
let currentHostProfileId: string | undefined

/** 主机管理中心窗口。显示后端版本/资源/启停/重装与远程日志。 */
export async function openHostManagerWindow(hostProfileId: string): Promise<BrowserWindow> {
  if (window && !window.isDestroyed() && currentHostProfileId === hostProfileId) {
    window.show()
    window.focus()
    return window
  }

  const win = new BrowserWindow({
    ...baseWindowOptions({ kind: 'host-manager', hostProfileId }),
    width: DEFAULT_SIZE.width,
    height: DEFAULT_SIZE.height,
    minWidth: 440,
    minHeight: 560,
    maximizable: false,
    fullscreenable: false,
    title: '远程主机'
  })

  window = win
  currentHostProfileId = hostProfileId
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    window = null
    currentHostProfileId = undefined
  })

  const entry = entryUrl('host-manager')
  await (entry.url ? win.loadURL(entry.url) : win.loadFile(entry.file!))
  return win
}
