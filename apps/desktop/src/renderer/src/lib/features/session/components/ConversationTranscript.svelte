<script lang="ts">
	/**
	 * 对话 timeline 的块渲染。真实对话区与导出页共用 —— 保证导出 PNG/PDF
	 * 和界面长得一模一样(同一批组件与 scoped 样式)。
	 */
	import { cx } from '$lib/shared/utils/cx';
	import type { ConversationTimelineItem } from '../projection';
	import type { SessionWorkspaceState } from '../session-workspace.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import AgentMarkdown from './AgentMarkdown.svelte';
	import ChangeSetBlock from './ChangeSetBlock.svelte';
	import ReasoningBlock from './ReasoningBlock.svelte';
	import SubagentRunBlock from './SubagentRunBlock.svelte';
	import ToolCallBlock from './ToolCallBlock.svelte';

	interface Props {
		items: ConversationTimelineItem[];
		/** 交互式 workspace;导出时省略,子代理块退化为静态展示。 */
		workspace?: SessionWorkspaceState;
		/** 提供时给每条消息加复制按钮。 */
		onCopy?: (text: string, id: string) => void;
		copiedId?: string;
	}

	let { items, workspace, onCopy, copiedId }: Props = $props();
</script>

{#if items.length === 0}
	<p class="py-4 text-center text-2xs text-faint">这个会话还没有内容。</p>
{:else}
	{#each items as item (item.id)}
		{#if item.itemKind === 'subagent'}
			{#if workspace}
				<SubagentRunBlock {item} {workspace} />
			{:else}
				<div class="my-1.5 flex items-center gap-2 rounded-default px-2 py-2 text-2xs text-muted">
					<span class="shrink-0">🤖</span>
					<span class="truncate">{item.run.title ?? '子代理'}</span>
					{#if item.run.agentName}
						<span class="shrink-0 font-mono text-faint">{item.run.agentName}</span>
					{/if}
					<span class="shrink-0 text-faint">{item.run.status}</span>
				</div>
			{/if}
		{:else if item.itemKind === 'tool'}
			<ToolCallBlock {item} />
		{:else if item.itemKind === 'changes'}
			<ChangeSetBlock {item} />
		{:else if item.contentKind === 'reasoning'}
			<ReasoningBlock text={item.text} streaming={item.streaming} durationMs={item.durationMs} />
		{:else}
			<article
				class={cx(
					'content-auto selectable border-b border-subtle py-3 last:border-b-0',
					item.role === 'user' && 'font-mono'
				)}
			>
				<div class="mb-1 flex items-center gap-2 text-2xs tracking-wide text-faint uppercase">
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
				{#if onCopy && item.text}
					<div class="mt-1 flex justify-end">
						<button
							type="button"
							class="flex h-5 items-center gap-1 rounded px-1.5 text-2xs text-faint transition-colors hover:bg-surface-hover hover:text-strong"
							onclick={() => onCopy(item.text, item.id)}
						>
							<Icon name={copiedId === item.id ? 'check' : 'copy'} size={10} />
							{copiedId === item.id ? '已复制' : '复制'}
						</button>
					</div>
				{/if}
			</article>
		{/if}
	{/each}
{/if}
