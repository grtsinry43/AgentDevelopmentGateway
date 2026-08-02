import { BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC, type WorkspaceLayoutState } from '../../contract/bridge.js'
import type { NewProjectInput } from '../../contract/project.js'
import { findProject, listRecentProjects, removeProject, togglePinProject, touchProject } from '../store/recent-projects.js'
import { registerRecentProject, resolveServerProject } from '../server/gateway.js'
import { loadLayout, saveLayout } from '../store/window-state.js'
import { closeLauncher, getLauncher } from '../windows/launcher.js'
import {
  closeProjectChooser,
  openProjectChooser,
  projectChooserContext
} from '../windows/project-chooser.js'
import {
  openProjectWindow,
  setSuppressLastClosed
} from '../windows/project.js'
import { broadcast } from './broadcast.js'

/** 列表变更后统一广播,让所有窗口(Launcher / 其他工程窗口)同步。 */
async function announceProjects(): Promise<void> {
  broadcast({ kind: 'projects.changed', projects: await listRecentProjects() })
}

export function registerProjectHandlers(): void {
  ipcMain.handle(IPC.projectsList, () => listRecentProjects())

  ipcMain.handle(IPC.projectsPickDirectory, async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    // 挂到父窗口上,macOS 才会显示为 sheet 而不是独立窗口。
    // showOpenDialog 是异步的 —— 同步版本会冻结整个应用直到用户选完。
    const result = parent
      ? await dialog.showOpenDialog(parent, {
          properties: ['openDirectory', 'createDirectory'],
          title: '选择工程目录'
        })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })

    if (result.canceled) return null
    return result.filePaths[0] ?? null
  })

  ipcMain.handle(IPC.projectsAdd, async (_event, input: NewProjectInput) => {
    const created = await registerRecentProject(input)
    await announceProjects()
    return created
  })

  ipcMain.handle(IPC.projectsRemove, async (_event, key: string) => {
    await removeProject(key)
    await announceProjects()
  })

  ipcMain.handle(IPC.projectsTogglePin, async (_event, key: string) => {
    await togglePinProject(key)
    // 不返回列表:调用方通过推送拿到新状态,保证「唯一数据流向」——
    // 否则同一份数据有两条到达路径,顺序打架时会闪一下旧值。
    await announceProjects()
  })

  ipcMain.handle(IPC.projectsTouch, async (_event, key: string) => {
    await touchProject(key)
    await announceProjects()
  })

  ipcMain.handle(IPC.projectsOpen, async (_event, key: string) => {
    await openProjectIntoNewWindow(key)
  })

  // 切换工程:弹出「在此窗口 / 新窗口打开」选择器(来源窗口记下来给 This Window)。
  ipcMain.handle(IPC.projectsOpenChooser, async (event, key: string) => {
    const cached = await findProject(key)
    if (!cached) throw new Error(`工程不存在: ${key}`)
    await openProjectChooser(key, event.sender.id)
  })

  ipcMain.handle(IPC.projectsOpenFromChooser, async (_event, rawMode: unknown) => {
    const mode = rawMode === 'this' ? 'this' : 'new'
    const context = projectChooserContext()
    if (!context) throw new Error('没有待打开的工程')
    // 先打开、成功后关选择器;失败时选择器留在原地,渲染进程把错误显示出来。
    if (mode === 'this') await openProjectIntoWindow(context.projectKey, context.sourceWindowId)
    else await openProjectIntoNewWindow(context.projectKey)
    closeProjectChooser()
  })
}

/** 打开工程到新窗口(默认行为)。 */
async function openProjectIntoNewWindow(key: string): Promise<void> {
  const cached = await findProject(key)
  if (!cached) throw new Error(`工程不存在: ${key}`)
  // 本地与远程都先解析:远程会按需建立 SSH 连接 + provision,并把 hostId rebind 到服务端权威值。
  const project = (await resolveServerProject(key)).recent

  await touchProject(project.key)
  await openProjectWindow(project)
  await announceProjects()

  // Launcher 是一次性入口:工程窗口起来后就该让位。
  if (getLauncher()) closeLauncher()
}

/** This Window:用目标工程替换来源工程窗口(沿用来源窗口尺寸)。 */
async function openProjectIntoWindow(key: string, sourceWebContentsId: number): Promise<void> {
  const cached = await findProject(key)
  if (!cached) throw new Error(`工程不存在: ${key}`)
  const project = (await resolveServerProject(key)).recent

  const source = BrowserWindow.getAllWindows().find(
    (candidate) => !candidate.isDestroyed() && candidate.webContents.id === sourceWebContentsId
  )
  const bounds = source ? source.getBounds() : undefined

  // 解析完成后再替换,避免目标不可用时把当前窗口关掉。
  setSuppressLastClosed(true)
  source?.close()
  setSuppressLastClosed(false)

  await touchProject(project.key)
  await openProjectWindow(project, bounds ? { bounds } : undefined)
  await announceProjects()
  if (getLauncher()) closeLauncher()
}

export function registerLayoutHandlers(): void {
  ipcMain.handle(IPC.layoutGet, (_event, projectKey: string) => loadLayout(projectKey))
  ipcMain.handle(IPC.layoutSave, (_event, projectKey: string, layout: WorkspaceLayoutState) =>
    saveLayout(projectKey, layout)
  )
}
