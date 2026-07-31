import type { BrowserWindow, Rectangle } from 'electron'
import { screen } from 'electron'
import type { WorkspaceLayoutState } from '../../contract/bridge.js'
import { JsonStore } from './json-store.js'

interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

interface WindowStateFile {
  version: 1
  /** 'launcher' 或 `project:<projectKey>` */
  bounds: Record<string, WindowBounds>
  layouts: Record<string, WorkspaceLayoutState>
}

const store = new JsonStore<WindowStateFile>('window-state.json', () => ({
  version: 1,
  bounds: {},
  layouts: {}
}))

/**
 * 恢复窗口位置,但要先确认它还在某个显示器可见范围内。
 * 外接屏拔掉后,记住的坐标会把窗口放到不存在的区域 —— 用户会看到一个「打不开的」应用。
 */
function isOnScreen(bounds: WindowBounds): boolean {
  if (bounds.x === undefined || bounds.y === undefined) return false

  return screen.getAllDisplays().some((display) => {
    const area: Rectangle = display.workArea
    // 只要标题栏区域可见就算可用,不要求完全包含
    return (
      bounds.x! >= area.x - 20 &&
      bounds.y! >= area.y - 20 &&
      bounds.x! < area.x + area.width - 80 &&
      bounds.y! < area.y + area.height - 40
    )
  })
}

export async function loadWindowBounds(
  id: string,
  fallback: { width: number; height: number }
): Promise<WindowBounds> {
  const file = await store.read()
  const saved = file.bounds[id]
  if (!saved || !isOnScreen(saved)) return fallback
  return saved
}

/**
 * 绑定窗口的尺寸/位置记忆。
 * 在 resize/move 上防抖,避免拖动过程中疯狂写盘。
 */
export function trackWindowBounds(id: string, window: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined

  const persist = (): void => {
    if (window.isDestroyed()) return
    // 最大化时记录的是还原后的尺寸,否则取消最大化会得到全屏大小
    const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds()

    void store.update((current) => ({
      ...current,
      bounds: {
        ...current.bounds,
        [id]: {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          maximized: window.isMaximized()
        }
      }
    }))
  }

  const schedule = (): void => {
    clearTimeout(timer)
    timer = setTimeout(persist, 400)
  }

  window.on('resize', schedule)
  window.on('move', schedule)
  window.on('maximize', persist)
  window.on('unmaximize', persist)
  window.once('close', () => {
    clearTimeout(timer)
    persist()
  })
}

export async function loadLayout(projectKey: string): Promise<WorkspaceLayoutState | null> {
  const file = await store.read()
  return file.layouts[projectKey] ?? null
}

export async function saveLayout(
  projectKey: string,
  layout: WorkspaceLayoutState
): Promise<void> {
  await store.update((current) => ({
    ...current,
    layouts: { ...current.layouts, [projectKey]: layout }
  }))
}

/** Keeps per-project window/layout preferences when a legacy project key is rebound. */
export async function migrateProjectState(previousKey: string, nextKey: string): Promise<void> {
  if (previousKey === nextKey) return
  await store.update((current) => {
    const previousBoundsId = `project:${previousKey}`
    const nextBoundsId = `project:${nextKey}`
    const bounds = { ...current.bounds }
    const layouts = { ...current.layouts }
    if (bounds[previousBoundsId] && !bounds[nextBoundsId]) {
      bounds[nextBoundsId] = bounds[previousBoundsId]
    }
    if (layouts[previousKey] && !layouts[nextKey]) layouts[nextKey] = layouts[previousKey]
    delete bounds[previousBoundsId]
    delete layouts[previousKey]
    return { ...current, bounds, layouts }
  })
}
