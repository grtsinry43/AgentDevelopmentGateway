<script lang="ts">
	import { onDestroy } from 'svelte';
	/**
	 * Project 窗口根组件。
	 *
	 * 只做编排:挂主题同步、挂唯一的 keydown 派发、组装三栏 + 状态栏。
	 * 业务逻辑在 `features/workspace`,渲染逻辑在 `ui/layout`。
	 */
	import { startThemeSync, theme } from '$lib/shared/theme/theme.svelte';
	import { keymap } from '$lib/shared/keymap/keymap.svelte';
	import { desktop, requireProjectIdentity, systemInfo } from '$lib/shared/bridge/desktop';
	import { railPanels as resolveRailPanels } from '$lib/shared/registry/panels';
	import { notifications } from '$lib/shared/notifications/notifications.svelte';
	import { remoteConnection } from '$lib/features/remote/remote.svelte';
	import { appError } from '$lib/features/project/app-error.svelte';
	import ProjectSwitcher from '$lib/features/project/components/ProjectSwitcher.svelte';
	import { LEFT_TABS, layout } from '$lib/features/workspace/layout.svelte';
	import { webPreview } from '$lib/shared/preview/web-preview.svelte';
	import PerfTools from '$lib/shared/perf/PerfTools.svelte';
	import { perfMonitor } from '$lib/shared/perf/perf-monitor.svelte';
	import { registerWorkspacePanels } from '$lib/features/workspace/panels';
	import LeftSidebar from '$lib/features/workspace/components/LeftSidebar.svelte';
	import RightToolRail from '$lib/features/workspace/components/RightToolRail.svelte';
	import DockDropOverlay from '$lib/features/workspace/components/DockDropOverlay.svelte';
	import ConversationPane from '$lib/features/session/components/ConversationPane.svelte';
	import SessionSidebar from '$lib/features/session/components/SessionSidebar.svelte';
	import FileTree from '$lib/features/files/components/FileTree.svelte';
	import { filePreview } from '$lib/features/files/file-preview.svelte';
	import GitPanel from '$lib/features/git/components/GitPanel.svelte';
	import { GitWorkspace } from '$lib/features/git/git-workspace.svelte';
	import { sessionWorkspace } from '$lib/features/session/session-workspace.svelte';
	import DockStack from '$lib/ui/layout/DockStack.svelte';
	import ResizeHandle from '$lib/ui/layout/ResizeHandle.svelte';
	import StatusBar from '$lib/ui/layout/StatusBar.svelte';
	import TitleBar from '$lib/ui/layout/TitleBar.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import Dialog from '$lib/ui/primitives/Dialog.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import NotificationCenter from '$lib/ui/notifications/NotificationCenter.svelte';

	startThemeSync();
	registerWorkspacePanels();

	const projectIdentity = requireProjectIdentity();
	const projectKey = projectIdentity.projectKey;
	// 展示主机:远程 = hostname,本地 = 无;hostId(服务端 UUID)不展示。
	const hostLabel = $derived(projectIdentity.hostLabel ?? '');
	/** 状态栏 chip 本地显示「Local」。 */
	const statusBarHost = $derived(hostLabel || 'Local');
	const gitWorkspace = new GitWorkspace(projectKey);
	const visibleLeftTabs = $derived(
		gitWorkspace.state ? LEFT_TABS : LEFT_TABS.filter((tab) => tab !== 'git')
	);

	// 布局:异步读回,读回前用默认值渲染 —— 不阻塞首帧
	void layout.load();
	// Session workspace owns push subscriptions and the selected Session SSE registration.
	$effect(() => sessionWorkspace.start(projectKey));
	$effect(() => gitWorkspace.start());
	// agent 调用 preview 工具 → 打开右侧 Web 预览面板并最大化;关闭时移除面板(右栏收起)。
	// 用命令式订阅而非 $effect:避免在 effect 里读写 $state 触发渲染死循环。
	let previewOpened = false;
	onDestroy(
		webPreview.subscribe((entry) => {
			if (entry) {
				previewOpened = true;
				layout.ensurePanel('preview-web');
				layout.maximizeRight();
			} else if (previewOpened) {
				previewOpened = false;
				layout.removePanelsByType('preview-web');
			}
		})
	);

	// 远程工程:连接状态 + 资源占用(本地工程的 status 返回 isRemote=false,chip 不渲染)。
	$effect(() => {
		void remoteConnection.start(projectKey);
		return remoteConnection.watch();
	});

	// 操作失败弹窗:error 置位即打开,关闭即清除。
	$effect(() => {
		if (appError.error) appErrorDialogOpen = true;
	});
	$effect(() => {
		if (!appErrorDialogOpen && appError.error) appError.dismiss();
	});

	// A persisted Git selection must not leave an invisible active tab when the
	// Server has conclusively reported that this project is not a repository.
	$effect(() => {
		if (
			gitWorkspace.state === undefined &&
			(gitWorkspace.status === 'unavailable' || gitWorkspace.status === 'error') &&
			layout.leftTab === 'git'
		) {
			layout.setLeftTab('sessions');
		}
	});

	$effect(() => {
		const detail = sessionWorkspace.serverError;
		if (detail) {
			notifications.notify({
				key: 'server-connection',
				severity: 'error',
				title: '后端连接异常',
				summary: '正在尝试重新连接 Gateway Server',
				detail
			});
		} else {
			notifications.resolve('server-connection');
		}
	});

	$effect(() => {
		const detail = sessionWorkspace.streamMessage;
		const sessionId = sessionWorkspace.selectedSessionId;
		if (detail && sessionId) {
			notifications.notify({
				key: `session-stream:${sessionId}`,
				severity: sessionWorkspace.streamState === 'error' ? 'error' : 'warning',
				title: '实时事件流异常',
				summary: '普通操作仍可能可用，正在后台重新连接',
				detail
			});
		} else if (sessionId) {
			notifications.resolve(`session-stream:${sessionId}`);
		}
	});

	$effect(() => {
		const detail = sessionWorkspace.error;
		if (!detail) return;
		notifications.notify({
			severity: 'error',
			title: '操作失败',
			summary: detail.split(/\r?\n/, 1)[0] ?? '操作未完成',
			detail
		});
	});

	/** 键盘聚焦的面板 id。⌘1..9 设置。 */
	let focusedPanelId = $state<string | undefined>(undefined);
	/** 操作失败弹窗:appError.error 置位即打开,关闭即清除。 */
	let appErrorDialogOpen = $state(false);

	/** 当前会话声明的 runtime capabilities；面板只按能力门控。 */
	const capabilities = $derived(sessionWorkspace.features);
	/** 常驻面板始终上 rail；contextual 仅在有内容或已占槽时显示。 */
	const railPanels = $derived(
		resolveRailPanels(capabilities, {
			openTypes: layout.panels.map((panel) => panel.type),
			remote: projectIdentity.hostType === 'ssh',
			contextualReady: (type) => {
				if (type === 'preview') return filePreview.path !== null;
				if (type === 'tasks') return sessionWorkspace.tasks.length > 0;
				return false;
			}
		})
	);
	const showRightContent = $derived(layout.rightContentOpen || layout.panelDragActive);
	const activeAdapter = $derived(
		sessionWorkspace.adapters.find(
			(adapter) => adapter.adapterId === sessionWorkspace.selectedSession?.adapterId
		)
	);
	const agentLabel = $derived(
		activeAdapter?.descriptor.displayName ?? sessionWorkspace.selectedSession?.adapterId
	);
	const branchLabel = $derived(
		gitWorkspace.state?.branch.name ?? gitWorkspace.state?.branch.oid?.slice(0, 8)
	);

	$effect(() =>
		keymap.pushScope('project', [
			{ keys: 'mod+b', label: '侧栏', run: () => layout.toggleLeft() },
			{ keys: 'mod+alt+b', label: '右侧面板', run: () => layout.toggleRight() },
			// 性能监视 HUD(dev 打点)
			{ keys: 'mod+alt+p', label: '性能监视', run: () => {
				console.log('[perf] ⌥⌘P 触发,enabled 将翻转为', !perfMonitor.enabled);
				perfMonitor.toggle();
			} },
			// ⌘⇧1..4 切左侧 tab
			...visibleLeftTabs.map((tab, index) => ({
				keys: `mod+shift+${index + 1}`,
				label: '',
				run: () => layout.setLeftTab(tab)
			})),
			// ⌘1..9 聚焦第 N 个 dock 槽
			...Array.from({ length: 9 }, (_, index) => ({
				keys: `mod+${index + 1}`,
				label: '',
				run: () => {
					const panel = layout.panelAt(index);
					if (!panel) return;
					focusedPanelId = panel.id;
					layout.ensurePanel(panel.type);
				}
			}))
		])
	);
</script>

<!-- 全应用唯一的 keydown 监听。业务组件一律通过 keymap.pushScope 注册。 -->
<svelte:window onkeydown={(event) => keymap.dispatch(event)} />

<div class="flex h-full flex-col overflow-hidden">
	<TitleBar>
		{#snippet leading()}
			<ProjectSwitcher />
		{/snippet}
		{#snippet actions()}
			<Button variant="icon" size="sm" title="切换侧栏 (⌘B)" onclick={() => layout.toggleLeft()}>
				{#snippet icon()}
					<Icon name="layers" size={12} />
				{/snippet}
			</Button>
			<Button
				variant="icon"
				size="sm"
				title={`主题:${theme.preference}`}
				onclick={() => theme.toggle()}
			>
				{#snippet icon()}
					<Icon name={theme.resolved === 'dark' ? 'moon' : 'sun'} size={12} />
				{/snippet}
			</Button>
		{/snippet}
	</TitleBar>

	<div class="flex min-h-0 flex-1">
		<!-- 左侧栏 -->
		{#if !layout.leftCollapsed}
			<aside
				class="flex min-h-0 shrink-0 flex-col bg-surface-panel"
				style:width="{layout.leftWidth}px"
			>
				<LeftSidebar tabs={visibleLeftTabs}>
					{#snippet sessions()}
						<SessionSidebar workspace={sessionWorkspace} />
					{/snippet}
					{#snippet files()}
						<FileTree {projectKey} />
					{/snippet}
					{#snippet git()}
						<GitPanel workspace={gitWorkspace} />
					{/snippet}
				</LeftSidebar>
			</aside>
			<ResizeHandle
				label="调整侧栏宽度"
				onDrag={(delta) =>
					layout.setLeftWidth(Math.min(480, Math.max(180, layout.leftWidth + delta)))}
			/>
		{/if}

		<!-- 中间主区:Session 投影只展示用户文本、Agent 文本与状态边界。 -->
		<main class="flex min-h-0 min-w-0 flex-1 flex-col">
			<ConversationPane workspace={sessionWorkspace} />
		</main>

		<!-- 右侧工具内容（可折叠）；图标条始终在最右 -->
		{#if showRightContent}
			<ResizeHandle
				label="调整右侧面板宽度"
				onDrag={(delta) =>
					layout.setRightWidth(Math.min(640, Math.max(220, layout.rightWidth - delta)))}
			/>
			<aside
				class="relative flex min-h-0 shrink-0 flex-col bg-surface-panel"
				style:width="{layout.rightWidth}px"
			>
				<DockStack focusedId={focusedPanelId} />
				<DockDropOverlay />
			</aside>
		{/if}

		<RightToolRail panels={railPanels} />
	</div>

	<StatusBar
		hostType={projectIdentity.hostType}
		hostLabel={statusBarHost}
		branch={branchLabel}
		{agentLabel}
		connectionStatus={sessionWorkspace.serverConnectionStatus}
		onSettings={() => void desktop.window.openSettings()}
	>
		{#snippet trailing()}
			<NotificationCenter />
		{/snippet}
	</StatusBar>
</div>

<!-- 操作失败(如切换工程失败)弹窗展示,可取消。 -->
<Dialog bind:open={appErrorDialogOpen} title="操作失败" description="打开或管理工程时出错。">
	<p
		class="max-h-56 overflow-y-auto font-mono text-xs break-words whitespace-pre-wrap text-cinnabar-600 dark:text-cinnabar-400"
	>
		{appError.error}
	</p>
	{#snippet footer()}
		<Button variant="primary" onclick={() => appError.dismiss()}>关闭</Button>
	{/snippet}
</Dialog>

<!-- 非 macOS 平台没有原生 vibrancy,窗口底色必须不透明以免露出桌面 -->
{#if systemInfo.platform !== 'darwin'}
	<div class="pointer-events-none fixed inset-0 -z-20 bg-surface-base"></div>
{/if}

<!-- 性能监视 HUD:⌥⌘P 开关,生产构建也可用(render-scan 在 PerfTools 内部按 DEV 门控)。 -->
<PerfTools />
