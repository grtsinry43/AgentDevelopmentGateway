<script lang="ts">
	/**
	 * dock 里的单个面板。可折叠、可关闭,标题栏本身是折叠开关。
	 */
	import type { Snippet } from 'svelte';
	import { cx } from '$lib/shared/utils/cx';
	import Button from '$lib/ui/primitives/Button.svelte';
	import Icon, { type IconName } from '$lib/ui/icons/Icon.svelte';

	interface Props {
		title: string;
		icon: IconName;
		collapsed?: boolean;
		/** ⌘N 聚焦提示用的序号(1-9);超出不显示。 */
		ordinal?: number;
		focused?: boolean;
		ontoggle: () => void;
		onclose: () => void;
		children: Snippet;
		class?: string;
	}

	let {
		title,
		icon,
		collapsed = false,
		ordinal,
		focused = false,
		ontoggle,
		onclose,
		children,
		class: className
	}: Props = $props();
</script>

<section
	class={cx(
		'flex min-h-0 flex-col overflow-hidden',
		// 折叠时只占标题栏高度,不参与 flex 伸缩
		collapsed ? 'shrink-0' : 'min-h-16',
		focused && 'ring-1 ring-line-accent ring-inset',
		className
	)}
	aria-label={title}
>
	<!-- 标题栏:整条可点击折叠。h-6 是密排下仍可点的下限。 -->
	<header class="flex h-6 shrink-0 items-center gap-1.5 border-b border-subtle px-2">
		<button
			type="button"
			class="flex min-w-0 flex-1 items-center gap-1.5 text-left"
			onclick={ontoggle}
			aria-expanded={!collapsed}
		>
			<Icon
				name={collapsed ? 'chevron-right' : 'chevron-down'}
				size={11}
				class="shrink-0 text-faint"
			/>
			<Icon name={icon} size={11} class="shrink-0 text-faint" />
			<span class="truncate text-2xs tracking-wide text-muted uppercase">{title}</span>
		</button>

		{#if ordinal !== undefined && ordinal <= 9}
			<span class="shrink-0 font-mono text-2xs text-faint">⌘{ordinal}</span>
		{/if}

		<Button variant="icon" size="sm" title="关闭面板" onclick={onclose}>
			{#snippet icon()}
				<Icon name="close" size={10} />
			{/snippet}
		</Button>
	</header>

	{#if !collapsed}
		<div class="scroll-thin min-h-0 flex-1 overflow-y-auto">
			{@render children()}
		</div>
	{/if}
</section>
