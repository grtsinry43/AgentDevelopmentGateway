import { BrowserWindow, dialog, type WebContents } from 'electron'
import type { RecentProject } from '../../contract/project.js'
import { getHostProfile } from '../store/host-profiles.js'
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

/** 替换窗口期间抑制「最后窗口关闭 → 回 Launcher」与关闭确认。 */
let suppressLastClosed = false

export function setSuppressLastClosed(value: boolean): void {
  suppressLastClosed = value
}

/** 应用正在退出:关闭窗口不弹确认。由 main/index.ts 在 before-quit 标记。 */
let appQuitting = false

export function markAppQuitting(): void {
  appQuitting = true
}

export interface OpenProjectWindowOptions {
  /** 替换窗口时沿用来源窗口的尺寸位置。 */
  bounds?: Electron.Rectangle & { maximized?: boolean }
}

export async function openProjectWindow(
  project: RecentProject,
  options: OpenProjectWindowOptions = {}
): Promise<BrowserWindow> {
  const existing = windows.get(project.key)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return existing
  }

  // 尺寸按工程分别记忆:不同项目常需要不同的窗口大小;替换窗口时沿用来源尺寸。
  const boundsId = `project:${project.key}`
  const bounds = options.bounds ?? (await loadWindowBounds(boundsId, DEFAULT_SIZE))

  // hostId 是服务端 UUID,只做身份;展示用 hostLabel 取 hostname(远程)/空(本地)。
  const hostLabel =
    project.hostType === 'ssh' && project.hostProfileId
      ? (await getHostProfile(project.hostProfileId).catch(() => undefined))?.hostname
      : undefined

  const window = new BrowserWindow({
    ...baseWindowOptions({
      kind: 'project',
      projectKey: project.key,
      hostId: project.hostId,
      hostType: project.hostType,
      projectPath: project.path,
      ...(hostLabel ? { hostLabel } : {})
    }),
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
  // 关闭工程需要确认(退出/取消)。替换窗口(This Window)与应用退出时跳过。
  window.on('close', (event) => {
    if (appQuitting || suppressLastClosed) return
    event.preventDefault()
    void dialog
      .showMessageBox(window, {
        type: 'question',
        buttons: ['退出', '取消'],
        defaultId: 1,
        cancelId: 1,
        message: '退出工程？',
        detail: '该工程窗口将关闭并返回主页。'
      })
      .then(({ response }) => {
        if (response === 0) {
          // 已确认:直接销毁,不再弹确认。
          window.destroy()
        }
      })
  })
  window.on('closed', () => {
    windows.delete(project.key)
    // 关掉最后一个工程窗口后应该回到 Launcher,否则应用还活着却没有任何入口。
    // closed 事件时窗口已销毁并从 BrowserWindow 移除,所以同步统计/触发是可靠的;
    // 同步调用让主进程能及时置起「回 Launcher」标志,抑制 window-all-closed 退出
    // (原 setImmediate 太晚,window-all-closed 先到就直接 quit 了)。
    // This Window 替换期间由 setSuppressLastClosed 抑制,避免闪出 Launcher。
    if (countProjectWindows() === 0 && !suppressLastClosed) onLastClosed?.()
  })

  const entry = entryUrl('project')
  await (entry.url ? window.loadURL(entry.url) : window.loadFile(entry.file!))

  return window
}

export function countProjectWindows(): number {
  return [...windows.values()].filter((window) => !window.isDestroyed()).length
}

/**
 * webContents → projectKey。IPC handler 据此把 session/terminal 这类不带
 * projectKey 的调用路由到正确的 server 连接(工程窗口与 host 一一对应)。
 */
export function projectKeyForWebContents(contents: WebContents): string | undefined {
  for (const [key, window] of windows) {
    if (!window.isDestroyed() && window.webContents.id === contents.id) return key
  }
  return undefined
}
