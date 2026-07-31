import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  PUSH_CHANNEL,
  type DesktopBridge,
  type PushEvent,
  type SystemInfo,
  type WindowIdentity,
  type WorkspaceLayoutState
} from '../contract/bridge.js'
import type { ContextProfile, NewProjectInput } from '../contract/project.js'
import type { CreateSessionRequest, SendSessionInputRequest } from '@agent-gateway/shared'

/**
 * 从 additionalArguments 读取主进程注入的启动数据。
 *
 * 为什么不走 IPC:渲染进程首帧就需要 identity(决定渲染哪个壳)和 SystemInfo
 * (首帧主题、把路径折成 `~`)。`invoke` 是异步的,preload 里 await 它会晚于
 * renderer 脚本开始执行 —— 结果是先渲染错误内容再纠正,视觉上闪一下。
 *
 * 解析失败一律回落到安全默认值,不抛错(否则窗口白屏)。
 */
function readInjected<T>(flag: string, fallback: T): T {
  const prefix = `--${flag}=`
  const arg = process.argv.find((value) => value.startsWith(prefix))
  if (!arg) return fallback

  try {
    return JSON.parse(arg.slice(prefix.length)) as T
  } catch (error) {
    console.error(`[preload] 解析 ${flag} 失败:`, error)
    return fallback
  }
}

const identity = readInjected<WindowIdentity>('window-identity', { kind: 'launcher' })
// 注入失败才会用到这个 fallback,platform 给个中性值即可(真值由主进程算)
const info = readInjected<SystemInfo>('system-info', {
  platform: 'other',
  homeDir: '',
  appVersion: '',
  shouldUseDarkColors: false
})

const bridge: DesktopBridge = {
  identity,
  info,

  /**
   * 主进程推送的唯一入口。所有事件共用一个 IPC 频道,按 `kind` 在渲染进程侧分发
   * (见 shared/bridge/events.ts)。
   *
   * 这里必须把 listener 包一层再转发,不能把渲染进程传来的函数直接交给
   * `ipcRenderer.on` —— contextBridge 两侧的函数身份不同,直接传会导致
   * `off` 时匹配不上、退订失败(内存泄漏 + 卸载后仍被回调)。
   */
  subscribe: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: PushEvent): void =>
      handler(payload)
    ipcRenderer.on(PUSH_CHANNEL, listener)
    return () => ipcRenderer.off(PUSH_CHANNEL, listener)
  },

  system: {
    openExternal: (url) => ipcRenderer.invoke(IPC.systemOpenExternal, url)
  },

  projects: {
    list: () => ipcRenderer.invoke(IPC.projectsList),
    pickDirectory: () => ipcRenderer.invoke(IPC.projectsPickDirectory),
    add: (input: NewProjectInput) => ipcRenderer.invoke(IPC.projectsAdd, input),
    remove: (key: string) => ipcRenderer.invoke(IPC.projectsRemove, key),
    togglePin: (key: string) => ipcRenderer.invoke(IPC.projectsTogglePin, key),
    open: (key: string) => ipcRenderer.invoke(IPC.projectsOpen, key),
    touch: (key: string) => ipcRenderer.invoke(IPC.projectsTouch, key)
  },

  sessions: {
    list: (projectKey: string) => ipcRenderer.invoke(IPC.sessionsList, projectKey),
    adapters: (projectKey: string) => ipcRenderer.invoke(IPC.sessionsAdapters, projectKey),
    create: (projectKey: string, input: CreateSessionRequest) =>
      ipcRenderer.invoke(IPC.sessionsCreate, projectKey, input),
    send: (sessionId: string, input: SendSessionInputRequest) =>
      ipcRenderer.invoke(IPC.sessionsSend, sessionId, input),
    watch: (sessionId: string, afterSequence = 0) =>
      ipcRenderer.invoke(IPC.sessionsWatch, sessionId, afterSequence),
    unwatch: (sessionId: string) => ipcRenderer.invoke(IPC.sessionsUnwatch, sessionId)
  },

  contextProfiles: {
    list: (projectKey: string) => ipcRenderer.invoke(IPC.contextProfilesList, projectKey),
    save: (profile: ContextProfile) => ipcRenderer.invoke(IPC.contextProfilesSave, profile),
    remove: (projectKey: string, profileId: string) =>
      ipcRenderer.invoke(IPC.contextProfilesRemove, projectKey, profileId),
    activate: (projectKey: string, profileId: string | null) =>
      ipcRenderer.invoke(IPC.contextProfilesActivate, projectKey, profileId)
  },

  window: {
    minimize: () => ipcRenderer.invoke(IPC.windowMinimize),
    toggleMaximize: () => ipcRenderer.invoke(IPC.windowToggleMaximize),
    close: () => ipcRenderer.invoke(IPC.windowClose)
  },

  layout: {
    get: (projectKey: string) => ipcRenderer.invoke(IPC.layoutGet, projectKey),
    save: (projectKey: string, layout: WorkspaceLayoutState) =>
      ipcRenderer.invoke(IPC.layoutSave, projectKey, layout)
  }
}

contextBridge.exposeInMainWorld('gateway', bridge)
