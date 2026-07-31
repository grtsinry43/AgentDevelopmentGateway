<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cx } from '$lib/shared/utils/cx';

	interface Props {
		title: string;
		description?: string;
		/** 图标槽。 */
		icon?: Snippet;
		/** 操作槽(按钮等)。 */
		action?: Snippet;
		/** 紧凑模式:用于面板内的空态,而非整页空态。 */
		compact?: boolean;
		class?: string;
	}

	let { title, description, icon, action, compact = false, class: className }: Props = $props();
</script>

<div
	class={cx(
		'flex flex-col items-center justify-center text-center',
		compact ? 'gap-1 px-4 py-6' : 'gap-2 px-6 py-12',
		className
	)}
>
	{#if icon}
		<span class={cx('text-faint', compact ? 'mb-0.5' : 'mb-1')}>{@render icon()}</span>
	{/if}

	<p class={cx('text-muted', compact ? 'text-xs' : 'text-sm')}>{title}</p>

	{#if description}
		<p class="max-w-xs text-xs leading-relaxed text-faint">{description}</p>
	{/if}

	{#if action}
		<div class="mt-1.5">{@render action()}</div>
	{/if}
</div>
