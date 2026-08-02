<script lang="ts">
	/**
	 * 对话 timeline 的块渲染。真实对话区(交互)用虚拟列表,导出页(无滚动容器)全量渲染
	 * —— 两者共用同一批块组件,保证导出和界面长得一样。
	 *
	 * 死循环防线:@tanstack 的 `setOptions` 每次都会强制写 store,所以凡是在 effect 里
	 * 调用它/measureElement 都必须用 `untrack` 包住,否则 effect 订阅 store → 无限重跑。
	 */
	import { createVirtualizer } from '@tanstack/svelte-virtual';
	import { tick, untrack } from 'svelte';
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
		/** 交互模式传入滚动容器;导出(无滚动)时全量渲染不虚拟化。 */
		getScrollElement?: () => HTMLElement | null | undefined;
	}

	let { items, workspace, onCopy, copiedId, getScrollElement }: Props = $props();

	/** 不同块类型的预估高度(measureElement 会修正实际值)。 */
	function estimateSize(index: number): number {
		const item = items[index];
		if (!item) return 64;
		switch (item.itemKind) {
			case 'tool':
				return item.changeSet ? 140 : 96;
			case 'changes':
				return 120;
			case 'subagent':
				return 48;
			case 'message':
				return item.contentKind === 'reasoning' ? 72 : Math.min(item.text.length / 4 + 48, 320);
			default:
				return 64;
		}
	}

	const virtualizer = createVirtualizer<HTMLElement, HTMLElement>({
		count: 0,
		getScrollElement: () => null,
		estimateSize: () => 64,
		overscan: 8,
		getItemKey: (index) => index,
		// 聊天式底部锚定:靠近底部时内容增长/测量修正都自动钉在最新一条,不往上跳。
		anchorTo: 'end',
		scrollEndThreshold: 48
	});

	// 必须 untrack:setOptions 强制写 store,订阅 store 会让本 effect 无限重跑。
	$effect(() => {
		const count = items.length;
		const scrollGetter = () => getScrollElement?.() ?? null;
		const keyOf = (index: number) => items[index]?.id ?? index;
		untrack(() => {
			$virtualizer.setOptions({
				count,
				getScrollElement: scrollGetter,
				getItemKey: keyOf,
				estimateSize
			});
		});
	});

	/**
	 * 行测量:挂载时量一次,ResizeObserver 跟进内容尺寸变化。尺寸按 getItemKey(id)
	 * 缓存,前插导致 index 变化时布局用缓存尺寸,不需要在 index 变化时重测。
	 */
	function measureRow(node: HTMLElement): { destroy: () => void } {
		untrack(() => $virtualizer.measureElement(node));
		return {
			destroy() {
				untrack(() => $virtualizer.measureElement(null));
			}
		};
	}

	// 触顶翻页:滚动事件直接驱动(不依赖虚拟器 store 的重跑时机,那个链在翻页后不可靠)。
	// userScrolled 是普通变量:防止进入会话时初始 scrollTop=0 被当成「用户滚到顶」误翻页
	// (进入时的自动滚底会先触发一次滚动事件把它置 true,但此时 scrollTop 很大,不会触发)。
	let userScrolled = false;
	let pendingOlder = false;

	function measurementsOf(virtualizer: unknown): { start: number }[] | undefined {
		return (virtualizer as { getMeasurements?: () => { start: number }[] }).getMeasurements?.();
	}

	// 触顶翻页 + 滚动锚定:滚到顶部附近且还有更早的块时取更早一页前插。
	// pendingOlder 守卫串行化;锚定优先用 getMeasurements()(private,运行时存在)按 index
	// 精确算前插增量,失败则退回 scrollHeight 差值近似 —— 避免「找不到锚点 → 恒触顶 → 连翻」。
	async function loadOlderPage(
		scrollEl: HTMLElement,
		first: { index: number; start: number }
	): Promise<void> {
		if (!workspace || pendingOlder) return;
		pendingOlder = true;
		const anchorIndex = first.index;
		const anchorStart = first.start;
		const anchorScrollTop = scrollEl.scrollTop;
		const scrollHeightBefore = scrollEl.scrollHeight;
		const itemsLengthBefore = items.length;
		try {
			await workspace.loadOlder();
			await tick();
			await new Promise((resolve) => requestAnimationFrame(resolve));
			const anchorNow =
				measurementsOf($virtualizer)?.[anchorIndex + (items.length - itemsLengthBefore)];
			if (anchorNow) {
				scrollEl.scrollTop = anchorScrollTop + (anchorNow.start - anchorStart);
			} else {
				scrollEl.scrollTop = anchorScrollTop + (scrollEl.scrollHeight - scrollHeightBefore);
			}
		} finally {
			pendingOlder = false;
		}
	}

	function maybeLoadOlder(): void {
		if (!workspace || pendingOlder || !getScrollElement) return;
		const scrollEl = getScrollElement();
		if (!scrollEl) return;
		if (workspace.loadingOlder || !workspace.hasMoreOlder || !userScrolled) return;
		if (scrollEl.scrollTop > 48) return;
		const first = $virtualizer.getVirtualItems()[0];
		if (!first || first.index > 3) return;
		void loadOlderPage(scrollEl, first);
	}

	$effect(() => {
		if (!getScrollElement) return;
		// 依赖 store:mount 后 setOptions / 滚动都会重跑本 effect,确保滚动容器绑定后挂上监听。
		void $virtualizer.getVirtualItems();
		const el = getScrollElement();
		if (!el) return;
		const onScroll = () => {
			userScrolled = true;
			maybeLoadOlder();
		};
		el.addEventListener('scroll', onScroll);
		return () => el.removeEventListener('scroll', onScroll);
	});

	// 滚动瞬间虚拟器 range 可能还没更新(first.index 还是旧值),store 变化后再补查一次触顶。
	$effect(() => {
		if (!workspace || !getScrollElement) return;
		void $virtualizer.getVirtualItems();
		maybeLoadOlder();
	});
</script>

{#snippet block(item: ConversationTimelineItem)}
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
{/snippet}

{#if items.length === 0}
	<p class="py-4 text-center text-2xs text-faint">这个会话还没有内容。</p>
{:else if getScrollElement}
	<div style="position: relative; height: {$virtualizer.getTotalSize()}px; width: 100%;">
		{#each $virtualizer.getVirtualItems() as row (row.key)}
			{@const item = items[row.index]}
			{#if item}
				<div
					use:measureRow
					data-index={row.index}
					style="position: absolute; top: 0; left: 0; width: 100%; transform: translateY({row.start}px);"
				>
					{@render block(item)}
				</div>
			{/if}
		{/each}
	</div>
{:else}
	{#each items as item (item.id)}
		{@render block(item)}
	{/each}
{/if}
