<script lang="ts">
	/**
	 * 左侧侧栏。tab 切换 + 内容区。
	 *
	 * 四个 tab 对应需求 §14.1 的左侧信息:会话列表、项目上下文(ContextProfile)、
	 * Git 状态、文件树。这一阶段内容都是空态占位。
	 */
	import type { Snippet } from 'svelte';
	import { cx } from '$lib/shared/utils/cx';
	import { LEFT_TABS, layout, type LeftTab } from '$lib/features/workspace/layout.svelte';
	import EmptyState from '$lib/ui/common/EmptyState.svelte';
	import Icon, { type IconName } from '$lib/ui/icons/Icon.svelte';

	interface Props {
		sessions?: Snippet;
		git?: Snippet;
		files?: Snippet;
	}

	let { sessions, git, files }: Props = $props();

	/**
	 * tab 定义。用 Record 而不是数组 + find:后者在 `noUncheckedIndexedAccess` 下
	 * 返回 `T | undefined`,要么到处加断言,要么写不必要的兜底分支。
	 * Record 以 LeftTab 为 key,查表必有值,类型上就是确定的。
	 */
	const TABS: Record<LeftTab, { label: string; icon: IconName; hint: string }> = {
		sessions: { label: '会话', icon: 'message', hint: '同一工程可以并行多个 Agent 会话。' },
		context: {
			label: '上下文',
			icon: 'layers',
			hint: '为不同需求线维护多份可切换的注入配置。'
		},
		git: { label: 'Git', icon: 'git-branch', hint: '分支、变更与 diff。' },
		files: { label: '文件', icon: 'file-text', hint: '工程文件树。' }
	};

	const active = $derived(TABS[layout.leftTab]);
</script>

<div class="flex min-h-0 flex-1 flex-col">
	<!-- tab 条:图标 + 文字,密排。⌘⇧1..4 可切换(绑定在 ProjectApp)。 -->
	<nav class="flex h-7 shrink-0 items-stretch border-b border-subtle" aria-label="侧栏">
		{#each LEFT_TABS as tab, index (tab)}
			<button
				type="button"
				class={cx(
					'flex flex-1 items-center justify-center gap-1 text-2xs transition-colors duration-150',
					'-mb-px border-b',
					layout.leftTab === tab
						? 'border-line-accent text-strong'
						: 'border-transparent text-muted hover:text-strong'
				)}
				title="{TABS[tab].label} (⌘⇧{index + 1})"
				aria-current={layout.leftTab === tab ? 'page' : undefined}
				onclick={() => layout.setLeftTab(tab)}
			>
				<Icon name={TABS[tab].icon} size={11} />
				{TABS[tab].label}
			</button>
		{/each}
	</nav>

	{#if layout.leftTab === 'sessions' && sessions}
		{@render sessions()}
	{:else if layout.leftTab === 'git' && git}
		{@render git()}
	{:else if layout.leftTab === 'files' && files}
		{@render files()}
	{:else}
		<div class="scroll-thin min-h-0 flex-1 overflow-y-auto">
			<EmptyState title="{active.label}（待接入）" description={active.hint} compact>
				{#snippet icon()}
					<Icon name={active.icon} size={18} />
				{/snippet}
			</EmptyState>
		</div>
	{/if}
</div>
