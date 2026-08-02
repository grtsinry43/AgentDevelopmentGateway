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
import type { HostProfileInput } from '../contract/hosts.js'
import type { ProviderProfileInput } from '../contract/providers.js'
import type {
  CloseSessionRequest,
  CreateSessionRequest,
  ForkSessionRequest,
  GatewayAdapterId,
  GitChangeArea,
  InterruptSessionRequest,
  ListModelsQuery,
	ReorderQueuedInputsRequest,
	ReplaceQueuedInputRequest,
  ResolveInteractionRequest,
  ResumeSessionRequest,
  SendSessionInputRequest,
  SetExecutionSettingsRequest,
  SetSessionModelRequest,
  SetSessionTitleRequest,
  SetWorkModeRequest
} from '@agent-gateway/shared'

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
    openChooser: (key: string) => ipcRenderer.invoke(IPC.projectsOpenChooser, key),
    openFromChooser: (mode: 'this' | 'new') =>
      ipcRenderer.invoke(IPC.projectsOpenFromChooser, mode),
    touch: (key: string) => ipcRenderer.invoke(IPC.projectsTouch, key)
  },

  hosts: {
    list: () => ipcRenderer.invoke(IPC.hostsList),
    save: (input: HostProfileInput) => ipcRenderer.invoke(IPC.hostsSave, input),
    remove: (id: string) => ipcRenderer.invoke(IPC.hostsRemove, id),
    pickKeyFile: () => ipcRenderer.invoke(IPC.hostsPickKeyFile)
  },

  providers: {
    list: () => ipcRenderer.invoke(IPC.providersList),
    save: (input: ProviderProfileInput) => ipcRenderer.invoke(IPC.providersSave, input),
    remove: (id: string) => ipcRenderer.invoke(IPC.providersRemove, id),
    scanModels: (id: string) => ipcRenderer.invoke(IPC.providersScanModels, id)
  },

  preview: {
    open: (port: number) => ipcRenderer.invoke(IPC.previewOpen, port)
  },

  remote: {
    status: (projectKey: string) => ipcRenderer.invoke(IPC.remoteStatus, projectKey),
    reconnect: (projectKey: string) => ipcRenderer.invoke(IPC.remoteReconnect, projectKey),
    disconnect: (projectKey: string) => ipcRenderer.invoke(IPC.remoteDisconnect, projectKey),
    logStart: (hostProfileId: string) => ipcRenderer.invoke(IPC.remoteLogStart, hostProfileId),
    logStop: (hostProfileId: string) => ipcRenderer.invoke(IPC.remoteLogStop, hostProfileId),
    probeHosts: () => ipcRenderer.invoke(IPC.remoteProbeHosts),
    stopServer: (hostProfileId: string) => ipcRenderer.invoke(IPC.remoteStopServer, hostProfileId),
    hostDetail: (hostProfileId: string) => ipcRenderer.invoke(IPC.remoteHostDetail, hostProfileId),
    hostStart: (hostProfileId: string) => ipcRenderer.invoke(IPC.remoteHostStart, hostProfileId),
    hostRestart: (hostProfileId: string) => ipcRenderer.invoke(IPC.remoteHostRestart, hostProfileId),
    hostReinstall: (hostProfileId: string) =>
      ipcRenderer.invoke(IPC.remoteHostReinstall, hostProfileId),
    browseDirectory: (hostProfileId: string, path: string) =>
      ipcRenderer.invoke(IPC.remoteBrowseDirectory, hostProfileId, path)
  },

  sessions: {
    list: (projectKey: string) => ipcRenderer.invoke(IPC.sessionsList, projectKey),
    get: (sessionId: string) => ipcRenderer.invoke(IPC.sessionsGet, sessionId),
    adapters: (projectKey: string) => ipcRenderer.invoke(IPC.sessionsAdapters, projectKey),
    models: (projectKey: string, adapterId: GatewayAdapterId, query: ListModelsQuery = {}) =>
      ipcRenderer.invoke(IPC.sessionsModels, projectKey, adapterId, query),
    sessionModels: (sessionId: string) =>
      ipcRenderer.invoke(IPC.sessionsSessionModels, sessionId),
    create: (projectKey: string, input: CreateSessionRequest) =>
      ipcRenderer.invoke(IPC.sessionsCreate, projectKey, input),
    send: (sessionId: string, input: SendSessionInputRequest) =>
      ipcRenderer.invoke(IPC.sessionsSend, sessionId, input),
    replaceQueuedInput: (
      sessionId: string,
      inputId: string,
      input: ReplaceQueuedInputRequest
    ) => ipcRenderer.invoke(IPC.sessionsQueueReplace, sessionId, inputId, input),
    reorderQueuedInputs: (sessionId: string, input: ReorderQueuedInputsRequest) =>
      ipcRenderer.invoke(IPC.sessionsQueueReorder, sessionId, input),
    cancelQueuedInput: (sessionId: string, inputId: string) =>
      ipcRenderer.invoke(IPC.sessionsQueueCancel, sessionId, inputId),
    sendQueuedInputNow: (sessionId: string, inputId: string) =>
      ipcRenderer.invoke(IPC.sessionsQueueSendNow, sessionId, inputId),
    interrupt: (sessionId: string, input: InterruptSessionRequest = {}) =>
      ipcRenderer.invoke(IPC.sessionsInterrupt, sessionId, input),
    resolveInteraction: (
      sessionId: string,
      interactionId: string,
      input: ResolveInteractionRequest
    ) => ipcRenderer.invoke(IPC.sessionsResolveInteraction, sessionId, interactionId, input),
    close: (sessionId: string, input: CloseSessionRequest = {}) =>
      ipcRenderer.invoke(IPC.sessionsClose, sessionId, input),
    resume: (sessionId: string, input: ResumeSessionRequest = {}) =>
      ipcRenderer.invoke(IPC.sessionsResume, sessionId, input),
    fork: (sessionId: string, input: ForkSessionRequest = {}) =>
      ipcRenderer.invoke(IPC.sessionsFork, sessionId, input),
    setTitle: (sessionId: string, input: SetSessionTitleRequest) =>
      ipcRenderer.invoke(IPC.sessionsSetTitle, sessionId, input),
    setModel: (sessionId: string, input: SetSessionModelRequest) =>
      ipcRenderer.invoke(IPC.sessionsSetModel, sessionId, input),
    setWorkMode: (sessionId: string, input: SetWorkModeRequest) =>
      ipcRenderer.invoke(IPC.sessionsSetWorkMode, sessionId, input),
    setExecutionSettings: (sessionId: string, input: SetExecutionSettingsRequest) =>
      ipcRenderer.invoke(IPC.sessionsSetExecution, sessionId, input),
    watch: (sessionId: string, afterSequence = 0) =>
      ipcRenderer.invoke(IPC.sessionsWatch, sessionId, afterSequence),
    unwatch: (sessionId: string) => ipcRenderer.invoke(IPC.sessionsUnwatch, sessionId),
    eventsHistory: (sessionId: string, before: number | undefined, limit: number) =>
      ipcRenderer.invoke(IPC.sessionsEventsHistory, sessionId, before, limit),
    items: (sessionId: string, before: number | undefined, limit: number) =>
      ipcRenderer.invoke(IPC.sessionsItems, sessionId, before, limit)
  },

  files: {
    capabilities: (projectKey: string) => ipcRenderer.invoke(IPC.filesCapabilities, projectKey),
    list: (projectKey: string, path: string) =>
      ipcRenderer.invoke(IPC.filesList, projectKey, path),
    read: (projectKey: string, path: string) =>
      ipcRenderer.invoke(IPC.filesRead, projectKey, path),
    watch: (projectKey: string, directories: string[]) =>
      ipcRenderer.invoke(IPC.filesWatch, projectKey, directories),
    updateWatch: (projectKey: string, directories: string[]) =>
      ipcRenderer.invoke(IPC.filesUpdateWatch, projectKey, directories),
    unwatch: (projectKey: string) => ipcRenderer.invoke(IPC.filesUnwatch, projectKey),
    retry: (projectKey: string) => ipcRenderer.invoke(IPC.filesRetry, projectKey)
  },

  git: {
    capabilities: (projectKey: string) => ipcRenderer.invoke(IPC.gitCapabilities, projectKey),
    status: (projectKey: string) => ipcRenderer.invoke(IPC.gitStatus, projectKey),
    diff: (projectKey: string, path: string, area: GitChangeArea) =>
      ipcRenderer.invoke(IPC.gitDiff, projectKey, path, area),
    stage: (projectKey: string, paths: string[]) =>
      ipcRenderer.invoke(IPC.gitStage, projectKey, paths),
    unstage: (projectKey: string, paths: string[]) =>
      ipcRenderer.invoke(IPC.gitUnstage, projectKey, paths),
    commit: (projectKey: string, message: string) =>
      ipcRenderer.invoke(IPC.gitCommit, projectKey, message),
    watch: (projectKey: string) => ipcRenderer.invoke(IPC.gitWatch, projectKey),
    unwatch: (projectKey: string) => ipcRenderer.invoke(IPC.gitUnwatch, projectKey),
    retry: (projectKey: string) => ipcRenderer.invoke(IPC.gitRetry, projectKey)
  },

  terminals: {
    capabilities: (projectKey: string) =>
      ipcRenderer.invoke(IPC.terminalsCapabilities, projectKey),
    list: (projectKey: string) => ipcRenderer.invoke(IPC.terminalsList, projectKey),
    create: (projectKey: string, cols: number, rows: number) =>
      ipcRenderer.invoke(IPC.terminalsCreate, projectKey, { cols, rows }),
    close: (terminalId: string) => ipcRenderer.invoke(IPC.terminalsClose, terminalId),
    attach: (
      terminalId: string,
      afterSequence: number | undefined,
      cols: number,
      rows: number
    ) => ipcRenderer.invoke(IPC.terminalsAttach, terminalId, afterSequence, cols, rows),
    detach: (terminalId: string) => ipcRenderer.invoke(IPC.terminalsDetach, terminalId),
    input: (terminalId: string, data: string) =>
      ipcRenderer.invoke(IPC.terminalsInput, terminalId, data),
    resize: (terminalId: string, cols: number, rows: number) =>
      ipcRenderer.invoke(IPC.terminalsResize, terminalId, cols, rows),
    acknowledge: (terminalId: string, sequence: number) =>
      ipcRenderer.invoke(IPC.terminalsAck, terminalId, sequence),
    retry: (terminalId: string) => ipcRenderer.invoke(IPC.terminalsRetry, terminalId)
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
    close: () => ipcRenderer.invoke(IPC.windowClose),
    openNewProject: (initialHostType: 'local' | 'ssh') =>
      ipcRenderer.invoke(IPC.windowOpenNewProject, initialHostType),
    openHostManager: (hostProfileId: string) =>
      ipcRenderer.invoke(IPC.windowOpenHostManager, hostProfileId),
    openSettings: () => ipcRenderer.invoke(IPC.windowOpenSettings)
  },

  layout: {
    get: (projectKey: string) => ipcRenderer.invoke(IPC.layoutGet, projectKey),
    save: (projectKey: string, layout: WorkspaceLayoutState) =>
      ipcRenderer.invoke(IPC.layoutSave, projectKey, layout)
  },

  export: {
    conversation: (payload) => ipcRenderer.invoke(IPC.exportConversation, payload),
    commit: (format) => ipcRenderer.invoke(IPC.exportCommit, format),
    getData: () => ipcRenderer.invoke(IPC.exportGetData),
    rendered: (height: number) => ipcRenderer.invoke(IPC.exportRendered, height)
  }
}

contextBridge.exposeInMainWorld('gateway', bridge)
