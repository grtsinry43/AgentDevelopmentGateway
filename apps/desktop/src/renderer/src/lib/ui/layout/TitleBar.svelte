<script lang="ts">
	/**
	 * 工程窗口标题栏。frameless 窗口靠它提供拖拽区。
	 *
	 * macOS 用原生红绿灯,所以左侧留出 76px;其他平台的窗口控制由
	 * WindowControls 统一自绘(与 Launcher 等窗口共用同一实现)。
	 */
	import type { Snippet } from 'svelte';
	import { cx } from '$lib/shared/utils/cx';
	import { systemInfo } from '$lib/shared/bridge/desktop';
	import WindowControls from './WindowControls.svelte';
	import WindowMenuTrigger from './WindowMenuTrigger.svelte';

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
	<!-- 非 macOS:左上角应用菜单触发(Linux 才渲染,自带 no-drag)。 -->
	<WindowMenuTrigger />

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

		<!-- 非 macOS 的自绘窗口控制;macOS 上它不渲染,交给原生红绿灯。 -->
		<WindowControls />
	</div>
</header>
