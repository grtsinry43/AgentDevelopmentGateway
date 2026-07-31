<script lang="ts">
	/**
	 * 底部快捷键提示条。
	 *
	 * 数据来自 keymap registry,而不是手写一份 —— 手写的提示条一定会和真实绑定
	 * 漂移(改了键位忘改提示)。这里读 `visibleBindings`,弹窗打开时自动只显示
	 * 弹窗内的操作。
	 */
	import { cx } from '$lib/shared/utils/cx';
	import { keymap } from '$lib/shared/keymap/keymap.svelte';
	import Kbd from '$lib/ui/primitives/Kbd.svelte';

	interface Props {
		class?: string;
		/** 最多展示几条。密排 UI 里超过 6 条就开始拥挤。 */
		limit?: number;
	}

	let { class: className, limit = 6 }: Props = $props();

	const bindings = $derived(keymap.visibleBindings.slice(0, limit));
</script>

<div
	class={cx(
		'flex h-7 shrink-0 items-center gap-3 overflow-hidden px-3',
		'border-t border-subtle text-2xs text-faint',
		className
	)}
>
	{#each bindings as binding (binding.keys)}
		<span class="flex shrink-0 items-center gap-1 whitespace-nowrap">
			<Kbd keys={binding.keys} />
			{binding.label}
		</span>
	{/each}
</div>
