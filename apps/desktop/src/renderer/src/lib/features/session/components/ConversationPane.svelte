<script lang="ts">
	import { tick } from 'svelte';
	import { cx } from '$lib/shared/utils/cx';
	import { SESSION_STATUS, isLiveStatus } from '$lib/shared/utils/status';
	import EmptyState from '$lib/ui/common/EmptyState.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import ResizeHandle from '$lib/ui/layout/ResizeHandle.svelte';
	import Badge from '$lib/ui/primitives/Badge.svelte';
	import type { SessionWorkspaceState } from '../session-workspace.svelte';
	import AgentMarkdown from './AgentMarkdown.svelte';
	import AgentWorkingIndicator from './AgentWorkingIndicator.svelte';
	import ChangeSetBlock from './ChangeSetBlock.svelte';
	import ReasoningBlock from './ReasoningBlock.svelte';
	import SessionComposer from './SessionComposer.svelte';
	import SubagentRunBlock from './SubagentRunBlock.svelte';
	import ToolCallBlock from './ToolCallBlock.svelte';

	interface Props {
		workspace: SessionWorkspaceState;
	}

	let { workspace }: Props = $props();
	let transcript: HTMLDivElement | undefined = $state();
	let pinnedToBottom = $state(true);
	let composerHeight = $state(160);

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
	const showWorkingIndicator = $derived(
		workspace.selectedSession?.status === 'running' &&
			!workspace.messages.some((message) => message.streaming) &&
			!workspace.tools.some(
				(item) => item.toolCall.status === 'pending' || item.toolCall.status === 'running'
			)
	);

	function updateScrollPin(): void {
		if (!transcript) return;
		pinnedToBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 48;
	}

	function resizeComposer(delta: number): void {
		const maxHeight = Math.min(520, Math.max(200, window.innerHeight - 220));
		composerHeight = Math.min(maxHeight, Math.max(112, composerHeight - delta));
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
		void tick().then(() => transcript?.scrollTo({ top: transcript.scrollHeight }));
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
			<p class="truncate text-xs text-strong">
				{workspace.selectedSubagent?.title ?? workspace.selectedSession?.title ?? '新建会话'}
			</p>
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
		<div
			bind:this={transcript}
			class="scroll-thin min-h-0 flex-1 overflow-y-auto"
			onscroll={updateScrollPin}
		>
			{#if workspace.timeline.length === 0}
				<EmptyState
					title={workspace.streamState === 'connecting' ? '正在读取事件…' : '这个会话还没有内容'}
					description="发送消息后，文本、思考与工具调用会按实际事件顺序显示在这里。"
					class="h-full"
				>
					{#snippet icon()}
						<Icon name="message" size={20} />
					{/snippet}
				</EmptyState>
			{:else}
				<div class="mx-auto w-full max-w-3xl px-5 py-4">
					{#each workspace.timeline as item (item.id)}
						{#if item.itemKind === 'subagent'}
							<SubagentRunBlock {item} {workspace} />
						{:else if item.itemKind === 'tool'}
							<ToolCallBlock {item} />
						{:else if item.itemKind === 'changes'}
							<ChangeSetBlock {item} />
						{:else if item.contentKind === 'reasoning'}
							<ReasoningBlock
								text={item.text}
								streaming={item.streaming}
								durationMs={item.durationMs}
							/>
						{:else}
							<article
								class={cx(
									'content-auto selectable border-b border-subtle py-3 last:border-b-0',
									item.role === 'user' && 'font-mono'
								)}
							>
								<div
									class="mb-1 flex items-center gap-2 text-2xs tracking-wide text-faint uppercase"
								>
									<span>{item.role === 'user' ? 'You' : 'Agent'}</span>
									{#if item.streaming}
										<span class="h-1.5 w-1.5 animate-pulse rounded-full bg-status-running"></span>
									{/if}
								</div>
								{#if item.role === 'assistant'}
									<AgentMarkdown content={item.text || (item.streaming ? '…' : '')} />
								{:else}
									<p class="text-sm leading-6 whitespace-pre-wrap text-normal">
										{item.text || (item.streaming ? '…' : '')}
									</p>
								{/if}
							</article>
						{/if}
					{/each}
					{#if showWorkingIndicator}
						<AgentWorkingIndicator />
					{/if}
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
