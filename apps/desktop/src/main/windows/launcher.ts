import { BrowserWindow } from 'electron'
import { loadWindowBounds, trackWindowBounds } from '../store/window-state.js'
import { baseWindowOptions, entryUrl } from './chrome.js'

const BOUNDS_ID = 'launcher'
const DEFAULT_SIZE = { width: 880, height: 560 }

let launcher: BrowserWindow | null = null

/**
 * Launcher 窗口:最近工程 + 新建工程。固定小尺寸,不可最大化 —— 它是一次性的入口,
 * 不是工作区。打开工程后由调用方关掉它(见 ipc/projects.ts)。
 */
export async function openLauncher(): Promise<BrowserWindow> {
  if (launcher && !launcher.isDestroyed()) {
    launcher.show()
    launcher.focus()
    return launcher
  }

  const bounds = await loadWindowBounds(BOUNDS_ID, DEFAULT_SIZE)

  const window = new BrowserWindow({
    ...baseWindowOptions({ kind: 'launcher' }),
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: 720,
    minHeight: 480,
    maximizable: false,
    fullscreenable: false
  })

  launcher = window
  trackWindowBounds(BOUNDS_ID, window)

  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    launcher = null
  })

  const entry = entryUrl('launcher')
  await (entry.url ? window.loadURL(entry.url) : window.loadFile(entry.file!))

  return window
}

export function getLauncher(): BrowserWindow | null {
  return launcher && !launcher.isDestroyed() ? launcher : null
}

export function closeLauncher(): void {
  getLauncher()?.close()
}
