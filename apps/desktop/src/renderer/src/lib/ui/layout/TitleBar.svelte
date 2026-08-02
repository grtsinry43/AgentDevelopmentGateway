<script lang="ts">
	/**
	 * 工程窗口标题栏。frameless 窗口靠它提供拖拽区。
	 *
	 * macOS 用原生红绿灯(titleBarStyle: hiddenInset),所以左侧留出 80px;
	 * 其他平台需要自绘最小化/最大化/关闭按钮。
	 */
	import type { Snippet } from 'svelte';
	import { cx } from '$lib/shared/utils/cx';
	import { desktop, systemInfo } from '$lib/shared/bridge/desktop';
	import Button from '$lib/ui/primitives/Button.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';

	interface Props {
		/** 工程展示名。留空则只渲染 leading(给 JetBrains 式切换器让位)。 */
		title?: string;
		/** `~/path @host` 形态的副标题。 */
		subtitle?: string;
		/** 标题最左侧(标题之前)。JetBrains 式主机/工程切换器。 */
		leading?: Snippet;
		/** 右侧操作区。 */
		actions?: Snippet;
		/** macOS 是否要给红绿灯让位(默认 true)。无红绿灯的窗口(如工程选择器)传 false。 */
		trafficLightInset?: boolean;
		class?: string;
	}

	let {
		title = '',
		subtitle,
		leading,
		actions,
		trafficLightInset = true,
		class: className
	}: Props = $props();

	const isMac = $derived(systemInfo.platform === 'darwin');
</script>

<header
	class={cx(
		'drag-region flex h-9 shrink-0 items-center gap-2 border-b border-subtle px-2',
		// 红绿灯簇 x=12,宽约 52(3×12 + 2×8),文本从 76px 起 → 两侧 12px 对称。
		isMac && trafficLightInset && 'pl-[76px]',
		className
	)}
>
	{#if leading}
		<div class="no-drag flex min-w-0 shrink-0 items-center">{@render leading()}</div>
	{/if}

	{#if title || subtitle}
		<div class="no-drag flex min-w-0 items-baseline gap-2">
			<span class="truncate text-sm font-medium text-strong">{title}</span>
			{#if subtitle}
				<span class="truncate font-mono text-2xs text-faint" {title}>{subtitle}</span>
			{/if}
		</div>
	{/if}

	<div class="no-drag ml-auto flex shrink-0 items-center gap-1">
		{#if actions}
			{@render actions()}
		{/if}

		{#if !isMac}
			<!-- 非 macOS:自绘窗口控制。macOS 交给原生红绿灯。 -->
			<Button
				variant="icon"
				size="sm"
				title="最小化"
				onclick={() => void desktop.window.minimize()}
			>
				{#snippet icon()}
					<span class="block h-px w-2.5 bg-current"></span>
				{/snippet}
			</Button>
			<Button
				variant="icon"
				size="sm"
				title="最大化"
				onclick={() => void desktop.window.toggleMaximize()}
			>
				{#snippet icon()}
					<span class="block h-2 w-2 border border-current"></span>
				{/snippet}
			</Button>
			<Button variant="icon" size="sm" title="关闭" onclick={() => void desktop.window.close()}>
				{#snippet icon()}
					<Icon name="close" size={11} />
				{/snippet}
			</Button>
		{/if}
	</div>
</header>
