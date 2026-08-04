/**
 * main ↔ preload ↔ renderer 的 IPC 契约。
 *
 * 这个目录(`src/contract/`)被三层同时引用,是唯一的跨进程类型来源。
 * 加 handler 时:先改这里,再改 `main/ipc/*` 与 `preload/index.ts`,类型会强制两边对齐。
 */

import type { ChangeSet, ToolCall } from '@agent-gateway/core';
import type { HostDirectoryResponse, ServerStatus, SubagentRunWire } from '@agent-gateway/shared';
import type {
	ConnectionState,
	HostProfile,
	HostProfileInput,
	RemoteProvisionStage
} from './hosts.js';
import type { ManagedModel, ProviderProfile, ProviderProfileInput } from './providers.js';
import type { ContextProfile, HostType, NewProjectInput, RecentProject } from './project.js';
import type {
	CreateSessionRequest,
	CreateSessionResponse,
	CloseSessionRequest,
	ForkSessionRequest,
	GatewayAdapterAvailability,
	GatewayAdapterId,
	GatewayModelCatalog,
	GatewaySlashCommands,
	GitChangeArea,
	GitCommitResponse,
	GitDiffResponse,
	GitRepositoryState,
	GatewaySession,
	InputAdmissionReceipt,
	ReorderQueuedInputsRequest,
	ReplaceQueuedInputRequest,
	InterruptSessionRequest,
	RewindSessionRequest,
	RewindSessionResultWire,
	ListModelsQuery,
	ResolveInteractionRequest,
	ResumeSessionRequest,
	RuntimeControlReceipt,
	RuntimeEventWire,
	EventsHistoryResponse,
	SessionItemsResponse,
	SendSessionInputRequest,
	SetExecutionSettingsRequest,
	SetSessionModelRequest,
	SetSessionTitleRequest,
	SetWorkModeRequest,
	TerminalDescriptor,
	TerminalServerMessage,
	WorkspaceDirectoryResponse,
	WorkspaceFileContentResponse
} from '@agent-gateway/shared';

/**
 * 通过 `additionalArguments` 注入 preload 的窗口身份。
 * 这样 renderer 首帧就知道该渲染什么,不需要一次 IPC 往返(避免白屏闪烁)。
 */
export type WindowIdentity =
	| { kind: 'launcher' }
	| {
			kind: 'project';
			projectKey: string;
			hostId: string;
			hostType: HostType;
			projectPath: string;
			/**
			 * 展示用主机标签:远程 = hostname(IP/域名),本地 = 空。
			 * hostId 是服务端 UUID,只做内部身份,不展示。
			 */
			hostLabel?: string;
	  }
	/** 新建工程向导窗口。 */
	| { kind: 'new-project'; initialHostType: 'local' | 'ssh' }
	/** 主机管理中心窗口。 */
	| { kind: 'host-manager'; hostProfileId: string }
	/** 设置窗口。 */
	| { kind: 'settings' }
	/** 打开工程的选择器窗口(This Window / New Window,无红绿灯)。 */
	| { kind: 'open-project'; projectKey: string }
	/** 关于窗口。 */
	| { kind: 'about' }
	/** 导出对话框窗口(左预览 + 右选格式)。 */
	| { kind: 'export' }
	/** 后台导出捕获窗口(隐藏,offscreen)。 */
	| { kind: 'capture' };

/** ipcMain.handle 的频道名。集中定义避免拼写漂移。 */
export const IPC = {
	// SystemInfo 不在此列:它随窗口创建注入,不走 IPC(见 main/windows/chrome.ts)
	systemOpenExternal: 'system:openExternal',

	projectsList: 'projects:list',
	projectsPickDirectory: 'projects:pickDirectory',
	projectsAdd: 'projects:add',
	projectsRemove: 'projects:remove',
	projectsTogglePin: 'projects:togglePin',
	projectsOpen: 'projects:open',
	projectsOpenChooser: 'projects:openChooser',
	projectsOpenFromChooser: 'projects:openFromChooser',
	projectsTouch: 'projects:touch',

	hostsList: 'hosts:list',
	hostsSave: 'hosts:save',
	hostsRemove: 'hosts:remove',
	hostsPickKeyFile: 'hosts:pickKeyFile',

	providersList: 'providers:list',
	providersSave: 'providers:save',
	providersRemove: 'providers:remove',
	providersScanModels: 'providers:scanModels',

	previewOpen: 'preview:open',

	remoteStatus: 'remote:status',
	remoteReconnect: 'remote:reconnect',
	remoteDisconnect: 'remote:disconnect',
	remoteLogStart: 'remote:logStart',
	remoteLogStop: 'remote:logStop',
	remoteProbeHosts: 'remote:probeHosts',
	remoteStopServer: 'remote:stopServer',
	remoteHostDetail: 'remote:hostDetail',
	remoteHostStart: 'remote:hostStart',
	remoteHostRestart: 'remote:hostRestart',
	remoteHostReinstall: 'remote:hostReinstall',
	remoteBrowseDirectory: 'remote:browseDirectory',

	sessionsList: 'sessions:list',
	sessionsAdapters: 'sessions:adapters',
	sessionsModels: 'sessions:models',
	sessionsSessionModels: 'sessions:sessionModels',
	sessionsCommands: 'sessions:commands',
	sessionsSessionCommands: 'sessions:sessionCommands',
	sessionsCreate: 'sessions:create',
	sessionsSend: 'sessions:send',
	sessionsQueueReplace: 'sessions:queueReplace',
	sessionsQueueReorder: 'sessions:queueReorder',
	sessionsQueueCancel: 'sessions:queueCancel',
	sessionsQueueSendNow: 'sessions:queueSendNow',
	sessionsGet: 'sessions:get',
	sessionsInterrupt: 'sessions:interrupt',
	sessionsRewind: 'sessions:rewind',
	sessionsResolveInteraction: 'sessions:resolveInteraction',
	sessionsClose: 'sessions:close',
	sessionsResume: 'sessions:resume',
	sessionsFork: 'sessions:fork',
	sessionsSetTitle: 'sessions:setTitle',
	sessionsSetModel: 'sessions:setModel',
	sessionsSetWorkMode: 'sessions:setWorkMode',
	sessionsSetExecution: 'sessions:setExecution',
	sessionsWatch: 'sessions:watch',
	sessionsUnwatch: 'sessions:unwatch',
	sessionsEventsHistory: 'sessions:eventsHistory',
	sessionsItems: 'sessions:items',
	filesCapabilities: 'files:capabilities',
	filesList: 'files:list',
	filesRead: 'files:read',
	filesWatch: 'files:watch',
	filesUpdateWatch: 'files:updateWatch',
	filesUnwatch: 'files:unwatch',
	filesRetry: 'files:retry',
	gitCapabilities: 'git:capabilities',
	gitStatus: 'git:status',
	gitDiff: 'git:diff',
	gitStage: 'git:stage',
	gitUnstage: 'git:unstage',
	gitCommit: 'git:commit',
	gitWatch: 'git:watch',
	gitUnwatch: 'git:unwatch',
	gitRetry: 'git:retry',
	terminalsCapabilities: 'terminals:capabilities',
	terminalsList: 'terminals:list',
	terminalsCreate: 'terminals:create',
	terminalsClose: 'terminals:close',
	terminalsAttach: 'terminals:attach',
	terminalsDetach: 'terminals:detach',
	terminalsInput: 'terminals:input',
	terminalsResize: 'terminals:resize',
	terminalsAck: 'terminals:ack',
	terminalsRetry: 'terminals:retry',

	contextProfilesList: 'contextProfiles:list',
	contextProfilesSave: 'contextProfiles:save',
	contextProfilesRemove: 'contextProfiles:remove',
	contextProfilesActivate: 'contextProfiles:activate',

	windowMinimize: 'window:minimize',
	windowToggleMaximize: 'window:toggleMaximize',
	windowClose: 'window:close',
	windowOpenNewProject: 'window:openNewProject',
	windowOpenHostManager: 'window:openHostManager',
	windowOpenSettings: 'window:openSettings',

	exportConversation: 'export:conversation',
	exportCommit: 'export:commit',
	exportGetData: 'export:getData',
	exportRendered: 'export:rendered',

	layoutGet: 'layout:get',
	layoutSave: 'layout:save'
} as const;

/**
 * ── 主进程 → 渲染进程的推送事件 ──
 *
 * `invoke/handle` 只能表达「渲染进程问、主进程答」。但很多状态变化的源头在主进程
 * (系统主题变了、另一个窗口改了最近工程列表、将来 Agent Server 的事件流),
 * 渲染进程不该靠轮询去发现 —— 所以走单向广播。
 *
 * 全部事件收敛到**一个** IPC 频道 + 一个 tagged union,而不是每种事件开一个频道:
 *   - preload 只需注册一个 `ipcRenderer.on`,不会随事件增多而膨胀
 *   - 渲染进程侧可以做一次分发 + 按 kind 订阅(见 shared/bridge/events.ts)
 *   - 加事件只改这个 union,类型会强制两端对齐
 */
export const PUSH_CHANNEL = 'gateway:push';

export type PushEvent =
	/** 系统主题变化(nativeTheme 权威值,比渲染进程的 matchMedia 可靠)。 */
	| { kind: 'theme.changed'; isDark: boolean }
	/**
	 * 最近工程列表已变更,附带新列表。
	 * 多窗口场景必需:在 A 窗口新建了工程,Launcher 或其他窗口要立刻反映,
	 * 不能等下次手动刷新。
	 */
	| { kind: 'projects.changed'; projects: RecentProject[] }
	| { kind: 'sessions.changed'; projectKey: string; sessions: GatewaySession[] }
	| { kind: 'session.event'; event: RuntimeEventWire }
	| {
			kind: 'session.stream';
			sessionId: string;
			state: 'connecting' | 'connected' | 'retrying' | 'closed' | 'error';
			message?: string;
			attempt?: number;
			retryAt?: number;
	  }
	| { kind: 'files.invalidated'; projectKey: string; paths: string[] }
	| { kind: 'files.resync'; projectKey: string }
	| {
			kind: 'files.stream';
			projectKey: string;
			state: 'connecting' | 'connected' | 'retrying' | 'closed' | 'error';
			message?: string;
			attempt?: number;
			retryAt?: number;
	  }
	| { kind: 'git.invalidated'; projectKey: string }
	| {
			kind: 'git.stream';
			projectKey: string;
			state: 'connecting' | 'connected' | 'retrying' | 'closed' | 'error';
			message?: string;
			attempt?: number;
			retryAt?: number;
	  }
	| { kind: 'terminal.message'; terminalId: string; message: TerminalServerMessage }
	| {
			kind: 'terminal.stream';
			terminalId: string;
			state: 'connecting' | 'connected' | 'retrying' | 'closed' | 'error';
			message?: string;
			attempt?: number;
			retryAt?: number;
	  }
	/** 某工程的 ContextProfile 集合已变更。 */
	| { kind: 'contextProfiles.changed'; projectKey: string }
	/** 本地 HostProfile 列表已变更(新建/更新/删除)。 */
	| { kind: 'hosts.changed'; hosts: HostProfile[] }
	/** 本地提供商 Profile 列表已变更。 */
	| { kind: 'providers.changed'; providers: ProviderProfile[] }
	/** 远程连接建立进度。Launcher 新建远程工程时据此展示内联状态。 */
	| {
			kind: 'remote.progress';
			hostProfileId: string;
			stage: RemoteProvisionStage;
			message?: string;
	  }
	/** 远程连接稳定状态(已连接/连接中/断开/错误)。标题栏主机 chip 据此显示。 */
	| {
			kind: 'remote.state';
			hostProfileId: string;
			state: ConnectionState;
			message?: string;
	  }
	/** 远程 server 日志行(批量)。右侧日志面板。 */
	| { kind: 'remote.log'; hostProfileId: string; lines: string[] }
	/** 远程日志串流开关状态。 */
	| {
			kind: 'remote.logState';
			hostProfileId: string;
			streaming: boolean;
			error?: string;
	  }
	/** 远程主机在线状态(Launcher 分组显示用)。 */
	| {
			kind: 'remote.hostsProbed';
			hosts: HostProbeResult[];
	  };

export type PushEventKind = PushEvent['kind'];

/**
 * 平台标识。不用 `NodeJS.Platform`:这个文件也被渲染进程引用,那里没有 node 类型。
 * `other` 兜住 freebsd/aix 之类我们不特殊处理的平台。
 */
export type Platform = 'darwin' | 'win32' | 'linux' | 'other';

/** 主进程能提供、渲染进程拿不到的系统信息。 */
export interface SystemInfo {
	platform: Platform;
	/** 用于把路径折成 `~`。渲染进程不该猜 home 在哪。 */
	homeDir: string;
	appVersion: string;
	/** 系统当前是否暗色(nativeTheme 权威值)。 */
	shouldUseDarkColors: boolean;
}

/** 右侧 dock 的持久化布局。panel 类型由 renderer 的 PANEL_REGISTRY 定义。 */
export interface DockPanelState {
	id: string;
	/** PANEL_REGISTRY 的 key */
	type: string;
	/** flex 权重,决定高度占比 */
	weight: number;
	collapsed: boolean;
}

export interface WorkspaceLayoutState {
	leftWidth: number;
	rightWidth: number;
	leftCollapsed: boolean;
	/**
	 * @deprecated Prefer `rightContentCollapsed`. Kept for reading older saved layouts.
	 * When true in legacy data, content starts collapsed while the tool rail stays visible.
	 */
	rightCollapsed?: boolean;
	/** When true, the right tool content is hidden; the vertical icon rail remains. */
	rightContentCollapsed: boolean;
	/** Last focused panel type in the right dock (for toggle / highlight). */
	activePanelType?: string;
	/** 左侧当前选中的 tab(SESSIONS/CONTEXT/GIT/FILES 之一) */
	leftTab: string;
	/**
	 * Open right-dock slots (1 = tab mode, 2 = vertical split). Types must be unique.
	 * Empty + content collapsed means only the icon rail is visible.
	 */
	rightPanels: DockPanelState[];
}

/**
 * 会话导出的原始 timeline 项 —— 与渲染进程投影结构一致,带全量字段
 * (推理时长、工具入参/出参、changeSet 等),导出渲染不丢状态。
 */
export type ExportRawItem =
	| {
			itemKind: 'message';
			id: string;
			role: 'user' | 'assistant';
			contentKind: 'text' | 'reasoning';
			text: string;
			sequence: number;
			turnId?: string;
			streaming: boolean;
			startedAt?: number;
			durationMs?: number;
			subagentRunId?: string;
	  }
	| {
			itemKind: 'tool';
			id: string;
			toolCall: ToolCall;
			sequence: number;
			turnId?: string;
			startedAt: number;
			durationMs?: number;
			inputDelta?: string;
			outputDelta?: string;
			changeSet?: ChangeSet;
			subagentRunId?: string;
	  }
	| {
			itemKind: 'changes';
			id: string;
			changeSet: ChangeSet;
			sequence: number;
			turnId?: string;
			subagentRunId?: string;
	  }
	| {
			itemKind: 'subagent';
			id: string;
			run: SubagentRunWire;
			sequence: number;
			turnId?: string;
	  };

export type ExportFormat = 'png' | 'pdf';

/** 导出渲染页拿到的会话数据。PNG/PDF 用真实组件渲染,HTML 自包含。 */
export interface ExportConversationPayload {
	projectName: string;
	sessionTitle?: string;
	adapterId?: string;
	items: ExportRawItem[];
}

/** 主机在线探测结果(Launcher 远程分组)。 */
export interface HostProbeResult {
	hostProfileId: string;
	/** SSH 是否可达。 */
	sshReachable: boolean;
	/** Gateway Server 守护进程是否在运行。 */
	serverRunning: boolean;
}

/** 主机详情(远程管理中心对话框的数据)。 */
export interface HostDetailData {
	profile: HostProfile;
	state: ConnectionState;
	stateMessage?: string;
	/** 远端已安装的 server 版本。 */
	installedVersion?: string;
	installedProtocol?: number;
	/** 已连接时的 server 版本/协议。 */
	connectedVersion?: string;
	protocolVersion?: number;
	/** 资源快照(已连接时)。 */
	status?: ServerStatus;
}

/** 远程连接状态查询结果(标题栏主机 chip 的数据来源)。 */
export interface RemoteStatus {
	isRemote: boolean;
	hostProfileId?: string;
	hostname?: string;
	username?: string;
	state?: ConnectionState;
	stateMessage?: string;
	hostId?: string;
	serverVersion?: string;
	protocolVersion?: number;
	/** 资源占用快照;拉取失败时为 undefined。 */
	status?: ServerStatus;
}

export type GitStatusResult =
	| { available: true; state: GitRepositoryState }
	| {
			available: false;
			reason: 'not-repository' | 'git-unavailable';
			message: string;
	  };

/**
 * `window.gateway` 的完整形状。preload 用 contextBridge 暴露它。
 *
 * 两条硬约定:
 *  1. **一切跨进程调用都是异步的**。只有 `identity` / `info` 是同步的,因为它们
 *     在窗口创建时就注入了 preload,不涉及往返。禁止引入 `sendSync` ——
 *     它会阻塞渲染进程主线程,UI 直接卡住。
 *  2. **状态变化走推送,不轮询**。`subscribe` 订阅主进程广播,返回退订函数
 *     (与 grtblog `realtime-core.ts` 的 listener 约定一致)。
 */
export interface DesktopBridge {
	/** 同步可用:preload 启动时就已注入。 */
	readonly identity: WindowIdentity;
	readonly info: SystemInfo;

	/**
	 * 订阅主进程推送。返回退订函数。
	 *
	 * 这是主进程 → 渲染进程的**唯一**通道。渲染进程不应为了发现状态变化而定时
	 * 调 `list()` —— 变化的源头在主进程,让它说。
	 */
	subscribe(handler: (event: PushEvent) => void): () => void;

	system: {
		openExternal(url: string): Promise<void>;
	};

	projects: {
		list(): Promise<RecentProject[]>;
		/** 打开原生目录选择器。必须在主进程执行。取消返回 null。 */
		pickDirectory(): Promise<string | null>;
		add(input: NewProjectInput): Promise<RecentProject>;
		remove(key: string): Promise<void>;
		togglePin(key: string): Promise<void>;
		/** 打开(或聚焦已存在的)Project 窗口。 */
		open(key: string): Promise<void>;
		/** 弹出「在此窗口 / 新窗口打开」选择器(独立窗口,无红绿灯)。 */
		openChooser(key: string): Promise<void>;
		/** 选择器窗口里确认打开方式。 */
		openFromChooser(mode: 'this' | 'new'): Promise<void>;
		/** 更新 lastOpenedAt。 */
		touch(key: string): Promise<void>;
	};

	/** 本地保存的 SSH 主机。明文密码永远不出主进程。 */
	hosts: {
		list(): Promise<HostProfile[]>;
		save(input: HostProfileInput): Promise<HostProfile>;
		remove(id: string): Promise<void>;
		/** 打开原生文件选择器选私钥。取消返回 null。 */
		pickKeyFile(): Promise<string | null>;
	};

	/** 提供商与模型 Profile。明文 API key 永远不出主进程。 */
	providers: {
		list(): Promise<ProviderProfile[]>;
		save(input: ProviderProfileInput): Promise<ProviderProfile>;
		remove(id: string): Promise<void>;
		/** 用 profile 的 baseUrl+key 探测模型列表(打 /v1/models)并保存进 profile。 */
		scanModels(id: string): Promise<ManagedModel[]>;
	};

	/** Web 预览:把 agent 报告的端口解析成客户端可访问的本地 URL(远程走 SSH 中转)。 */
	preview: {
		open(port: number): Promise<{ url: string; host: string; port: number }>;
	};

	/** 远程连接状态与操作(仅 hostType = ssh 的工程有意义)。 */
	remote: {
		/** 当前连接状态 + 主机信息 + 资源占用。 */
		status(projectKey: string): Promise<RemoteStatus>;
		/** 断开并重新建立连接(重连)。 */
		reconnect(projectKey: string): Promise<void>;
		/** 断开本地隧道(远程 server 继续运行)。 */
		disconnect(projectKey: string): Promise<void>;
		/** 开始串流远程 server 日志(按主机,工程窗口与主机管理对话框共用)。 */
		logStart(hostProfileId: string): Promise<void>;
		/** 停止串流远程 server 日志。 */
		logStop(hostProfileId: string): Promise<void>;
		/** 探测全部已保存主机的 SSH 可达性与 server 运行状态。 */
		probeHosts(): Promise<HostProbeResult[]>;
		/** 优雅停止远程 server(经 SSH 发送 SIGTERM)。 */
		stopServer(hostProfileId: string): Promise<void>;
		/** 主机详情:连接状态 + 已安装版本 + 资源快照(管理中心对话框)。 */
		hostDetail(hostProfileId: string): Promise<HostDetailData>;
		/** 启动(或复用)后端:确保已安装并运行。 */
		hostStart(hostProfileId: string): Promise<void>;
		/** 重启后端:停止后重新建立连接(不重新安装)。 */
		hostRestart(hostProfileId: string): Promise<void>;
		/** 重装后端:清掉远端安装并强制重新上传当前版本。 */
		hostReinstall(hostProfileId: string): Promise<void>;
		/** 浏览主机目录(新建远程工程选工程根;首次会触发连接)。 */
		browseDirectory(hostProfileId: string, path: string): Promise<HostDirectoryResponse>;
	};

	sessions: {
		list(projectKey: string): Promise<GatewaySession[]>;
		get(sessionId: string): Promise<GatewaySession>;
		adapters(projectKey: string): Promise<GatewayAdapterAvailability[]>;
		models(
			projectKey: string,
			adapterId: GatewayAdapterId,
			query?: ListModelsQuery
		): Promise<GatewayModelCatalog>;
		sessionModels(sessionId: string): Promise<GatewayModelCatalog>;
		commands(
			projectKey: string,
			adapterId: GatewayAdapterId,
			query?: ListModelsQuery
		): Promise<GatewaySlashCommands>;
		sessionCommands(sessionId: string): Promise<GatewaySlashCommands>;
		create(projectKey: string, input: CreateSessionRequest): Promise<CreateSessionResponse>;
		send(sessionId: string, input: SendSessionInputRequest): Promise<InputAdmissionReceipt>;
		replaceQueuedInput(
			sessionId: string,
			inputId: string,
			input: ReplaceQueuedInputRequest
		): Promise<void>;
		reorderQueuedInputs(sessionId: string, input: ReorderQueuedInputsRequest): Promise<void>;
		cancelQueuedInput(sessionId: string, inputId: string): Promise<void>;
		sendQueuedInputNow(sessionId: string, inputId: string): Promise<void>;
		interrupt(sessionId: string, input?: InterruptSessionRequest): Promise<void>;
		rewind(sessionId: string, input: RewindSessionRequest): Promise<RewindSessionResultWire>;
		resolveInteraction(
			sessionId: string,
			interactionId: string,
			input: ResolveInteractionRequest
		): Promise<void>;
		close(sessionId: string, input?: CloseSessionRequest): Promise<RuntimeControlReceipt>;
		resume(sessionId: string, input?: ResumeSessionRequest): Promise<GatewaySession>;
		fork(sessionId: string, input?: ForkSessionRequest): Promise<GatewaySession>;
		setTitle(sessionId: string, input: SetSessionTitleRequest): Promise<RuntimeControlReceipt>;
		setModel(sessionId: string, input: SetSessionModelRequest): Promise<RuntimeControlReceipt>;
		setWorkMode(sessionId: string, input: SetWorkModeRequest): Promise<RuntimeControlReceipt>;
		setExecutionSettings(
			sessionId: string,
			input: SetExecutionSettingsRequest
		): Promise<RuntimeControlReceipt>;
		watch(sessionId: string, afterSequence?: number): Promise<void>;
		unwatch(sessionId: string): Promise<void>;
		/** 渐进加载:取 sequence < before 的最多 limit 条持久化事件。 */
		eventsHistory(
			sessionId: string,
			before: number | undefined,
			limit: number
		): Promise<EventsHistoryResponse>;
		/** 渐进加载:物化成品块分页。 */
		items(
			sessionId: string,
			before: number | undefined,
			limit: number
		): Promise<SessionItemsResponse>;
	};

	files: {
		capabilities(projectKey: string): Promise<string[]>;
		list(projectKey: string, path: string): Promise<WorkspaceDirectoryResponse>;
		read(projectKey: string, path: string): Promise<WorkspaceFileContentResponse>;
		watch(projectKey: string, directories: string[]): Promise<void>;
		updateWatch(projectKey: string, directories: string[]): Promise<void>;
		unwatch(projectKey: string): Promise<void>;
		retry(projectKey: string): Promise<void>;
	};

	git: {
		capabilities(projectKey: string): Promise<string[]>;
		status(projectKey: string): Promise<GitStatusResult>;
		diff(projectKey: string, path: string, area: GitChangeArea): Promise<GitDiffResponse>;
		stage(projectKey: string, paths: string[]): Promise<void>;
		unstage(projectKey: string, paths: string[]): Promise<void>;
		commit(projectKey: string, message: string): Promise<GitCommitResponse>;
		watch(projectKey: string): Promise<void>;
		unwatch(projectKey: string): Promise<void>;
		retry(projectKey: string): Promise<void>;
	};

	terminals: {
		capabilities(projectKey: string): Promise<string[]>;
		list(projectKey: string): Promise<TerminalDescriptor[]>;
		create(projectKey: string, cols: number, rows: number): Promise<TerminalDescriptor>;
		close(terminalId: string): Promise<void>;
		attach(
			terminalId: string,
			afterSequence: number | undefined,
			cols: number,
			rows: number
		): Promise<void>;
		detach(terminalId: string): Promise<void>;
		input(terminalId: string, data: string): Promise<void>;
		resize(terminalId: string, cols: number, rows: number): Promise<void>;
		acknowledge(terminalId: string, sequence: number): Promise<void>;
		retry(terminalId: string): Promise<void>;
	};

	contextProfiles: {
		list(projectKey: string): Promise<{
			profiles: ContextProfile[];
			activeProfileId?: string;
		}>;
		save(profile: ContextProfile): Promise<ContextProfile>;
		remove(projectKey: string, profileId: string): Promise<void>;
		activate(projectKey: string, profileId: string | null): Promise<void>;
	};

	window: {
		minimize(): Promise<void>;
		toggleMaximize(): Promise<void>;
		close(): Promise<void>;
		/** 打开新建工程向导窗口。 */
		openNewProject(initialHostType: 'local' | 'ssh'): Promise<void>;
		/** 打开主机管理中心窗口。 */
		openHostManager(hostProfileId: string): Promise<void>;
		/** 打开设置窗口。 */
		openSettings(): Promise<void>;
	};

	layout: {
		get(projectKey: string): Promise<WorkspaceLayoutState | null>;
		save(projectKey: string, layout: WorkspaceLayoutState): Promise<void>;
	};

	/** 会话导出。 */
	export: {
		/** 打开导出对话框(预览 + 选格式)。 */
		conversation(payload: ExportConversationPayload): Promise<void>;
		/** 对话框确认导出(PNG / PDF)。 */
		commit(format: ExportFormat): Promise<void>;
		/** 导出页/捕获页取数据。 */
		getData(): Promise<ExportConversationPayload | null>;
		/** 导出页/捕获页渲染完成,报告内容高度。 */
		rendered(height: number): Promise<void>;
	};
}
