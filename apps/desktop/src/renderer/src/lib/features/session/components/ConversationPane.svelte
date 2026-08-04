<script lang="ts">
	import { tick } from 'svelte';
	import type { SessionItem } from '@agent-gateway/shared';
	import type { ExportRawItem } from '$contract/bridge';
	import { appError } from '$lib/features/project/app-error.svelte';
	import { providers } from '$lib/shared/settings/providers.svelte';
	import { desktop } from '$lib/shared/bridge/desktop';
	import { cx } from '$lib/shared/utils/cx';
	import { SESSION_STATUS, isLiveStatus } from '$lib/shared/utils/status';
	import { sessionItems } from '../api';
	import EmptyState from '$lib/ui/common/EmptyState.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import ResizeHandle from '$lib/ui/layout/ResizeHandle.svelte';
	import Badge from '$lib/ui/primitives/Badge.svelte';
	import Spinner from '$lib/ui/primitives/Spinner.svelte';
	import type { SessionWorkspaceState } from '../session-workspace.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import ContextMenu, { type ContextMenuItem } from '$lib/ui/primitives/ContextMenu.svelte';
	import AgentWorkingIndicator from './AgentWorkingIndicator.svelte';
	import ConversationTranscript from './ConversationTranscript.svelte';
	import SessionComposer from './SessionComposer.svelte';
	import RewindView from './RewindView.svelte';
	import { rewind } from '../rewind.svelte';

	interface Props {
		workspace: SessionWorkspaceState;
		projectName?: string;
	}

	let { workspace, projectName = '' }: Props = $props();
	let transcript: HTMLDivElement | undefined = $state();
	let pinnedToBottom = $state(true);
	let composerHeight = $state(160);

	// 回退时间线绑定当前激活会话:切换会话时关闭。注意不能读 rewind.isOpen
	// ($effect 会追踪它,一打开就被自己关掉),只比较 openSessionId。
	$effect(() => {
		const id = workspace.selectedSessionId;
		if (rewind.openSessionId && rewind.openSessionId !== id) rewind.close();
	});

	/** 对话右键菜单:选中文本后 复制 / 引用到输入框。 */
	let selectionMenu = $state<{ x: number; y: number; text: string } | undefined>(undefined);

	function handleContextMenu(event: MouseEvent): void {
		const selected = window.getSelection()?.toString().trim();
		if (!selected) return;
		event.preventDefault();
		selectionMenu = { x: event.clientX, y: event.clientY, text: selected };
	}

	async function copySelection(text: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			/* 剪贴板不可用时静默失败 */
		}
	}

	const selectionMenuItems = $derived.by<ContextMenuItem[]>(() => {
		if (!selectionMenu) return [];
		return [
			{ label: '复制', icon: 'copy', run: () => void copySelection(selectionMenu!.text) },
			{
				label: '引用到输入框',
				icon: 'plus',
				run: () => workspace.appendComposerQuote(selectionMenu!.text)
			}
		];
	});

	// ── 单条消息复制 ─────────────────────────────────────────────────────
	let copiedId = $state<string | undefined>(undefined);
	let copyResetTimer: ReturnType<typeof setTimeout> | undefined;

	async function copyMessage(text: string, id: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			copiedId = id;
			if (copyResetTimer) clearTimeout(copyResetTimer);
			copyResetTimer = setTimeout(() => (copiedId = undefined), 1_200);
		} catch {
			/* 剪贴板不可用 */
		}
	}

	// ── 导出:打开导出对话框窗口(预览 + 选格式) ──────────────────────────
	let exporting = $state(false);

	async function openExport(): Promise<void> {
		if (exporting) return;
		exporting = true;
		try {
			await desktop.export.conversation({
				projectName,
				sessionTitle: workspace.selectedSession?.title,
				adapterId: workspace.selectedSession?.adapterId,
				items: await buildExportItems()
			});
		} catch (cause) {
			appError.show(cause);
		} finally {
			exporting = false;
		}
	}

	/**
	 * 导出全量会话:按 sessionItems 从新到旧分页拉取全部物化块,再逆序拼回升序
	 * timeline。界面只加载尾部窗口,导出不受它限制。
	 */
	const EXPORT_PAGE_SIZE = 500;

	async function buildExportItems(): Promise<ExportRawItem[]> {
		const sessionId = workspace.selectedSessionId;
		if (!sessionId) return [];
		const all: SessionItem[] = [];
		let before: number | undefined;
		let hasMore = true;
		while (hasMore) {
			const page = await sessionItems(sessionId, before, EXPORT_PAGE_SIZE);
			all.unshift(...page.items);
			before = page.oldestSequence;
			hasMore = page.hasMore;
		}
		return all as unknown as ExportRawItem[];
	}

	const sessionVisual = $derived(
		workspace.selectedSession ? SESSION_STATUS[workspace.selectedSession.status] : undefined
	);
	const connectionNotice = $derived.by(() => {
		if (workspace.serverError) {
			return {
				severity: 'error' as const,
				message:
					workspace.loadFailed && workspace.loadRetryAttempt >= 5
						? '与 Gateway Server 的连接仍未恢复'
						: '与 Gateway Server 断开，正在尝试重新连接',
				action: 'server' as const
			};
		}
		if (workspace.streamMessage) {
			return {
				severity: workspace.streamState === 'error' ? ('error' as const) : ('warning' as const),
				message:
					workspace.streamState === 'error'
						? '当前会话的实时连接发生错误'
						: '当前会话的实时连接已断开，正在后台重新连接',
				action: 'stream' as const
			};
		}
		return undefined;
	});
	const showWorkingIndicator = $derived(workspace.selectedSession?.status === 'running');

	/** 会话绑定的提供商 profile(只读展示;创建时在 composer 选择)。 */
	const providerChip = $derived.by(() => {
		const profileId = workspace.selectedSession?.providerProfileId;
		if (!profileId) return undefined;
		const profile = providers.profiles.find((item) => item.id === profileId);
		if (!profile) {
			return { label: '自定义提供商', hint: '提供商 profile 已被删除' };
		}
		return {
			label: profile.name,
			hint: [
				`提供商: ${profile.name}`,
				`中继: ${profile.baseUrl ?? '默认地址'}`,
				profile.hasApiKey ? '已注入 API Key' : '未配置 Key'
			].join('\n')
		};
	});

	function updateScrollPin(): void {
		if (!transcript) return;
		pinnedToBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 48;
	}

	function resizeComposer(delta: number): void {
		const maxHeight = Math.min(520, Math.max(200, window.innerHeight - 220));
		composerHeight = Math.min(maxHeight, Math.max(112, composerHeight - delta));
	}

	async function scrollToBottomWhenStable(): Promise<void> {
		if (!transcript) return;
		// 虚拟列表分批测量:内容高度会在几帧内逐次增长。循环滚到底直到高度稳定,
		// 配合虚拟器的 anchorTo:'end' 保证落点就是最新一条(而非估计高度的中间)。
		for (let attempt = 0; attempt < 10; attempt += 1) {
			const target = transcript.scrollHeight;
			transcript.scrollTop = target;
			await new Promise((resolve) => requestAnimationFrame(resolve));
			if (Math.abs(transcript.scrollHeight - target) < 2) return;
		}
	}

	$effect(() => {
		workspace.timeline.map((item) => {
			if (item.itemKind === 'message') return `${item.id}:${item.text.length}:${item.streaming}`;
			if (item.itemKind === 'subagent') {
				return `${item.id}:${item.run.status}:${item.run.updatedAt}`;
			}
			if (item.itemKind === 'tool') {
				return `${item.id}:${item.toolCall.status}:${item.outputDelta?.length ?? 0}:${item.changeSet?.status ?? ''}`;
			}
			return `${item.id}:${item.changeSet.status}:${item.changeSet.files.length}`;
		});
		if (!pinnedToBottom || (!showWorkingIndicator && workspace.timeline.length === 0)) return;
		void tick().then(() => void scrollToBottomWhenStable());
	});
</script>

<section class="flex min-h-0 flex-1 flex-col bg-surface-base">
	<header class="flex h-9 shrink-0 items-center gap-2 border-b border-subtle px-3">
		{#if workspace.selectedSubagent}
			<button
				type="button"
				class="grid h-6 w-6 shrink-0 place-items-center rounded-default text-muted hover:bg-surface-hover hover:text-strong"
				title="返回父级会话"
				onclick={() => workspace.closeSubagent()}
			>
				<Icon name="chevron-right" size={12} class="rotate-180" />
			</button>
		{/if}
		<div class="min-w-0 flex-1">
			{#if workspace.selectedSession && workspace.isTitleSyncing(workspace.selectedSession.id)}
				<p class="flex items-center gap-1.5 text-xs text-faint">
					<Spinner size="sm" label="正在生成标题" />
					<span class="truncate">正在生成标题…</span>
				</p>
			{:else}
				<p class="truncate text-xs text-strong">
					{workspace.selectedSubagent?.title ?? workspace.selectedSession?.title ?? '新建会话'}
				</p>
			{/if}
			{#if workspace.selectedSubagent}
				<p class="truncate font-mono text-2xs text-faint">
					子代理 · {workspace.selectedSubagent.agentName ??
						workspace.selectedSubagent.runtimeSubagentId ??
						'Agent'}
				</p>
			{:else if workspace.selectedSession}
				<p class="truncate font-mono text-2xs text-faint">{workspace.selectedSession.adapterId}</p>
			{:else}
				<p class="text-2xs text-faint">首次发送时创建真实 Session</p>
			{/if}
		</div>
		{#if sessionVisual && workspace.selectedSession}
			<Badge dotClass={sessionVisual.dot} pulse={isLiveStatus(workspace.selectedSession.status)}>
				{sessionVisual.label}
			</Badge>
		{/if}
		{#if providerChip && workspace.selectedSession}
			<span
				class="flex h-6 shrink-0 cursor-default items-center gap-1.5 rounded-default border border-line bg-surface-raised px-2 text-2xs text-muted"
				title={providerChip.hint}
			>
				<Icon name="plug" size={10} class="shrink-0" />
				<span class="max-w-32 truncate">{providerChip.label}</span>
			</span>
		{/if}
		<Button
			variant="icon"
			size="sm"
			title="导出对话"
			loading={exporting}
			disabled={workspace.timeline.length === 0}
			onclick={() => void openExport()}
		>
			{#snippet icon()}
				<Icon name="download" size={12} />
			{/snippet}
		</Button>
	</header>

	{#if connectionNotice}
		<div
			class={cx(
				'flex h-7 shrink-0 items-center gap-2 border-b px-3 text-xs',
				connectionNotice.severity === 'error'
					? 'border-cinnabar-500/20 bg-cinnabar-500/8 text-status-error'
					: 'border-amber-500/20 bg-amber-500/8 text-status-waiting'
			)}
		>
			<span class="min-w-0 flex-1 truncate">{connectionNotice.message}</span>
			{#if (connectionNotice.action === 'server' && workspace.loadFailed && workspace.loadRetryAttempt >= 5) || (connectionNotice.action === 'stream' && (workspace.streamState === 'error' || workspace.streamRetryAttempt > 5))}
				<button
					type="button"
					class="shrink-0 px-1.5 py-0.5 text-2xs hover:text-strong"
					onclick={() =>
						connectionNotice.action === 'server'
							? workspace.retryServerConnection()
							: void workspace.retryConnection()}
				>
					立即重试
				</button>
			{/if}
		</div>
	{/if}

	{#if !workspace.selectedSessionId}
		{#key 'new-session'}
			<SessionComposer {workspace} />
		{/key}
	{:else}
		<div class="relative min-h-0 flex-1">
			<!-- transcript 始终挂载:回退视图只是覆盖其上,退出后消息立即可见,虚拟列表不重建。 -->
			<div
				bind:this={transcript}
				class="scroll-thin absolute inset-0 overflow-y-auto"
				role="region"
				aria-label="会话内容"
				onscroll={updateScrollPin}
				oncontextmenu={handleContextMenu}
			>
				{#if workspace.timeline.length === 0}
					{#if workspace.streamState === 'connecting'}
						<div class="flex h-full items-center justify-center">
							<p class="shimmer-text text-base font-bold tracking-wide">
								Agent Development Gateway
							</p>
						</div>
					{:else}
						<EmptyState
							title="这个会话还没有内容"
							description="发送消息后，文本、思考与工具调用会按实际事件顺序显示在这里。"
							class="h-full"
						>
							{#snippet icon()}
								<Icon name="message" size={20} />
							{/snippet}
						</EmptyState>
					{/if}
				{:else}
					<div class="mx-auto w-full max-w-3xl px-5 py-4">
						<ConversationTranscript
							items={workspace.timeline}
							{workspace}
							onCopy={copyMessage}
							{copiedId}
							getScrollElement={() => transcript}
						/>
						{#if showWorkingIndicator}
							<AgentWorkingIndicator />
						{/if}
					</div>
				{/if}
			</div>
			{#if rewind.isOpen}
				<div class="absolute inset-0 z-10">
					<RewindView />
				</div>
			{/if}
		</div>

		<ResizeHandle
			orientation="horizontal"
			label="调整会话输入区高度"
			class="z-10"
			onDrag={resizeComposer}
		/>
		{#key workspace.selectedSessionId}
			<SessionComposer {workspace} height={composerHeight} />
		{/key}
	{/if}
</section>

{#if selectionMenu}
	<ContextMenu
		x={selectionMenu.x}
		y={selectionMenu.y}
		items={selectionMenuItems}
		onclose={() => (selectionMenu = undefined)}
	/>
{/if}
