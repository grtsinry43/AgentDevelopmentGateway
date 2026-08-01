/**
 * main ↔ preload ↔ renderer 的 IPC 契约。
 *
 * 这个目录(`src/contract/`)被三层同时引用,是唯一的跨进程类型来源。
 * 加 handler 时:先改这里,再改 `main/ipc/*` 与 `preload/index.ts`,类型会强制两边对齐。
 */

import type { ContextProfile, HostType, NewProjectInput, RecentProject } from './project.js';
import type {
	CreateSessionRequest,
	CreateSessionResponse,
	CloseSessionRequest,
	ForkSessionRequest,
	GatewayAdapterAvailability,
	GitChangeArea,
	GitCommitResponse,
	GitDiffResponse,
	GitRepositoryState,
	GatewaySession,
	InputAdmissionReceipt,
	ReorderQueuedInputsRequest,
	ReplaceQueuedInputRequest,
	InterruptSessionRequest,
	ResolveInteractionRequest,
	ResumeSessionRequest,
	RuntimeControlReceipt,
	RuntimeEventWire,
	SendSessionInputRequest,
	SetExecutionSettingsRequest,
	SetSessionModelRequest,
	SetSessionTitleRequest,
	SetWorkModeRequest,
	TerminalDescriptor,
	TerminalServerMessage,
	WorkspaceDirectoryResponse
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
	  };

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
	projectsTouch: 'projects:touch',

	sessionsList: 'sessions:list',
	sessionsAdapters: 'sessions:adapters',
	sessionsCreate: 'sessions:create',
	sessionsSend: 'sessions:send',
	sessionsQueueReplace: 'sessions:queueReplace',
	sessionsQueueReorder: 'sessions:queueReorder',
	sessionsQueueCancel: 'sessions:queueCancel',
	sessionsQueueSendNow: 'sessions:queueSendNow',
	sessionsGet: 'sessions:get',
	sessionsInterrupt: 'sessions:interrupt',
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
	filesCapabilities: 'files:capabilities',
	filesList: 'files:list',
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
	| { kind: 'contextProfiles.changed'; projectKey: string };

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
	rightCollapsed: boolean;
	/** 左侧当前选中的 tab(SESSIONS/CONTEXT/GIT/FILES 之一) */
	leftTab: string;
	rightPanels: DockPanelState[];
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
		/** 更新 lastOpenedAt。 */
		touch(key: string): Promise<void>;
	};

	sessions: {
		list(projectKey: string): Promise<GatewaySession[]>;
		get(sessionId: string): Promise<GatewaySession>;
		adapters(projectKey: string): Promise<GatewayAdapterAvailability[]>;
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
	};

	files: {
		capabilities(projectKey: string): Promise<string[]>;
		list(projectKey: string, path: string): Promise<WorkspaceDirectoryResponse>;
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
	};

	layout: {
		get(projectKey: string): Promise<WorkspaceLayoutState | null>;
		save(projectKey: string, layout: WorkspaceLayoutState): Promise<void>;
	};
}
