import { BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC, type WorkspaceLayoutState } from '../../contract/bridge.js'
import type { NewProjectInput } from '../../contract/project.js'
import {
  addProject,
  findProject,
  listRecentProjects,
  removeProject,
  togglePinProject,
  touchProject
} from '../store/recent-projects.js'
import { loadLayout, saveLayout } from '../store/window-state.js'
import { closeLauncher, getLauncher } from '../windows/launcher.js'
import { openProjectWindow } from '../windows/project.js'
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
    const created = await addProject(input)
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
    const project = await findProject(key)
    if (!project) throw new Error(`工程不存在: ${key}`)

    await touchProject(key)
    await openProjectWindow(project)
    await announceProjects()

    // Launcher 是一次性入口:工程窗口起来后就该让位。
    if (getLauncher()) closeLauncher()
  })
}

export function registerLayoutHandlers(): void {
  ipcMain.handle(IPC.layoutGet, (_event, projectKey: string) => loadLayout(projectKey))
  ipcMain.handle(IPC.layoutSave, (_event, projectKey: string, layout: WorkspaceLayoutState) =>
    saveLayout(projectKey, layout)
  )
}
