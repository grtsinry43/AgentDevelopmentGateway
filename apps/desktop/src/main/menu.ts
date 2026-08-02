/**
 * 应用菜单(macOS 菜单栏;其他平台作为窗口菜单)。
 *
 * 功能映射:
 *  - 文件:新建本地/远程工程、Show Launcher、最近工程(切换走 This/New 选择器);
 *  - 主机:动态列出已保存主机 → 打开各自的管理中心,以及「刷新主机状态」;
 *  - App(仅 macOS):About、设置…(⌘,)等;
 *  - 编辑/视图/窗口:系统默认 role。
 * 最近工程与主机列表在窗口聚焦时重建,保持最新。
 */
import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { probeHosts } from './remote/index.js'
import { resolveServerProject } from './server/gateway.js'
import { listHostProfiles } from './store/host-profiles.js'
import { listRecentProjects } from './store/recent-projects.js'
import { openAboutWindow } from './windows/about.js'
import { openLauncher } from './windows/launcher.js'
import { openNewProjectWindow } from './windows/new-project.js'
import { openHostManagerWindow } from './windows/host-manager.js'
import { openProjectChooser } from './windows/project-chooser.js'
import { openProjectWindow, projectKeyForWebContents } from './windows/project.js'
import { openSettingsWindow } from './windows/settings.js'

function buildRecentSubmenu(
  recents: Awaited<ReturnType<typeof listRecentProjects>>
): MenuItemConstructorOptions[] {
  if (recents.length === 0) return [{ label: '还没有工程', enabled: false }]
  return recents.slice(0, 20).map((project) => ({
    label: `${project.name}  —  ${project.path}`,
    click: () => void openRecentProject(project.key)
  }))
}

/** 最近工程项点击:聚焦的是工程窗口 → 弹 This/New 选择器;否则直接新窗口。 */
async function openRecentProject(key: string): Promise<void> {
  const focused = BrowserWindow.getFocusedWindow()
  const isProjectWindow =
    focused && !focused.isDestroyed() && projectKeyForWebContents(focused.webContents) !== undefined
  if (isProjectWindow) {
    await openProjectChooser(key, focused.webContents.id)
    return
  }
  const project = (await resolveServerProject(key)).recent
  await openProjectWindow(project)
}

function buildHostsSubmenu(
  hosts: Awaited<ReturnType<typeof listHostProfiles>>
): MenuItemConstructorOptions[] {
  const hostItems: MenuItemConstructorOptions[] =
    hosts.length === 0
      ? [{ label: '还没有主机', enabled: false }]
      : hosts.map((host) => ({
          label: `${host.name}  (${host.username}@${host.hostname})`,
          click: () => void openHostManagerWindow(host.id)
        }))
  return [
    {
      label: '主机管理中心…',
      click: () => void openLauncher().then((launcher) => launcher.focus())
    },
    { type: 'separator' },
    ...hostItems,
    { type: 'separator' },
    {
      label: '刷新主机状态',
      click: () => void listHostProfiles().then((profiles) => probeHosts(profiles))
    }
  ]
}

export async function installMenu(): Promise<void> {
  const isMac = process.platform === 'darwin'
  const [recents, hosts] = await Promise.all([listRecentProjects(), listHostProfiles()])

  const template: MenuItemConstructorOptions[] = [
    // macOS App 菜单:About / Services / Hide / Quit,并放设置。
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              {
                label: `关于 ${app.name}`,
                click: () => void openAboutWindow()
              },
              { type: 'separator' as const },
              {
                label: '设置…',
                accelerator: 'CmdOrCtrl+,',
                click: () => void openSettingsWindow()
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: '文件',
      submenu: [
        {
          label: '新建本地工程…',
          accelerator: 'CmdOrCtrl+N',
          click: () => void openNewProjectWindow('local')
        },
        {
          label: '新建远程工程…',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => void openNewProjectWindow('ssh')
        },
        { type: 'separator' },
        {
          label: 'Show Launcher',
          accelerator: 'CmdOrCtrl+Shift+L',
          click: () => void openLauncher()
        },
        { type: 'separator' },
        {
          label: '最近工程',
          submenu: buildRecentSubmenu(recents)
        },
        { type: 'separator' },
        ...(isMac
          ? [{ role: 'close' as const, label: '关闭窗口' }]
          : [{ role: 'quit' as const, label: '退出' }])
      ]
    },
    {
      label: '主机',
      submenu: buildHostsSubmenu(hosts)
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** 在应用就绪与窗口聚焦时刷新菜单(最近工程/主机列表可能已变)。 */
export function wireMenuLifecycle(): void {
  void installMenu()
  app.on('browser-window-focus', () => void installMenu())
}
