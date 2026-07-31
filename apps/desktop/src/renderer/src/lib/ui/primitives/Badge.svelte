<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cx } from '$lib/shared/utils/cx';

	type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

	interface Props {
		tone?: Tone;
		/** 单色圆点前缀。传入 Tailwind 背景色类(通常来自 shared/utils/status)。 */
		dotClass?: string;
		/** 圆点脉冲(仅用于真正在推进的状态)。 */
		pulse?: boolean;
		mono?: boolean;
		class?: string;
		children: Snippet;
	}

	let {
		tone = 'neutral',
		dotClass,
		pulse = false,
		mono = false,
		class: className,
		children
	}: Props = $props();

	const tones = {
		neutral: 'border-subtle bg-surface-hover text-muted',
		accent: 'border-jade-300/50 bg-jade-500/10 text-accent dark:border-jade-700/50',
		success: 'border-bamboo-300/50 bg-bamboo-500/10 text-bamboo-700 dark:text-bamboo-300',
		warning: 'border-amber-300/50 bg-amber-500/10 text-amber-700 dark:text-amber-300',
		danger: 'border-cinnabar-300/50 bg-cinnabar-500/10 text-cinnabar-700 dark:text-cinnabar-300',
		info: 'border-iris-300/50 bg-iris-500/10 text-iris-600 dark:text-iris-300'
	} as const;
</script>

<span
	class={cx(
		'inline-flex h-4 items-center gap-1 rounded-[2px] border px-1.5',
		'text-2xs leading-none whitespace-nowrap',
		mono && 'font-mono',
		tones[tone],
		className
	)}
>
	{#if dotClass}
		<span class="relative flex h-1.5 w-1.5 shrink-0">
			{#if pulse}
				<span
					class={cx('absolute inset-0 animate-ping rounded-full opacity-70', dotClass)}
					aria-hidden="true"
				></span>
			{/if}
			<span class={cx('relative h-1.5 w-1.5 rounded-full', dotClass)}></span>
		</span>
	{/if}
	{@render children()}
</span>
