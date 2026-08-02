<script lang="ts">
	/**
	 * 「正在打开项目」的小提示层(可复用)。远程项目打开/切换需要连接+provision,
	 * 期间显示一个居中的小卡片 + 动画。pointer-events-none,不挡交互。
	 */
	import Spinner from '$lib/ui/primitives/Spinner.svelte';

	interface Props {
		visible: boolean;
		/** 项目名(可选)。 */
		name?: string;
		/** 说明文字(默认「正在打开项目」)。 */
		label?: string;
	}

	let { visible, name, label = '正在打开项目' }: Props = $props();
</script>

{#if visible}
	<div
		class="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center"
		role="status"
		aria-label={label}
	>
		<div
			class="flex items-center gap-2.5 rounded-default border border-line bg-surface-raised px-4 py-3 shadow-lg"
		>
			<Spinner size="sm" {label} />
			<span class="text-xs text-normal">
				{label}{name ? `: ${name}` : ''}…
			</span>
		</div>
	</div>
{/if}
