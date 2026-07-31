import { BrowserWindow } from 'electron'
import type { RecentProject } from '../../contract/project.js'
import { loadWindowBounds, trackWindowBounds } from '../store/window-state.js'
import { baseWindowOptions, entryUrl } from './chrome.js'

const DEFAULT_SIZE = { width: 1360, height: 860 }

/** projectKey → 窗口。同一个工程只有一个窗口,再次打开是聚焦而非新开。 */
const windows = new Map<string, BrowserWindow>()

/** 最后一个工程窗口关闭时的回调。由 main/index.ts 注入,用于回到 Launcher。 */
let onLastClosed: (() => void) | undefined

export function setOnLastProjectClosed(handler: () => void): void {
  onLastClosed = handler
}

export async function openProjectWindow(project: RecentProject): Promise<BrowserWindow> {
  const existing = windows.get(project.key)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return existing
  }

  // 尺寸按工程分别记忆:不同项目常需要不同的窗口大小
  const boundsId = `project:${project.key}`
  const bounds = await loadWindowBounds(boundsId, DEFAULT_SIZE)

  const window = new BrowserWindow({
    ...baseWindowOptions({ kind: 'project', projectKey: project.key }),
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: 960,
    minHeight: 600,
    title: project.name
  })

  windows.set(project.key, window)
  trackWindowBounds(boundsId, window)

  window.once('ready-to-show', () => {
    window.show()
    if (bounds.maximized) window.maximize()
  })
  window.on('closed', () => {
    windows.delete(project.key)
    // 关掉最后一个工程窗口后应该回到 Launcher,否则 macOS 上应用还活着却没有任何入口。
    // 用 setImmediate 让 BrowserWindow 的销毁先完成,再统计剩余窗口数。
    setImmediate(() => {
      if (countProjectWindows() === 0) onLastClosed?.()
    })
  })

  const entry = entryUrl('project')
  await (entry.url ? window.loadURL(entry.url) : window.loadFile(entry.file!))

  return window
}

export function countProjectWindows(): number {
  return [...windows.values()].filter((window) => !window.isDestroyed()).length
}
