<script lang="ts">
	/**
	 * 关于窗口:应用名、版本、简介与功能概览。
	 */
	import { startThemeSync } from '$lib/shared/theme/theme.svelte';
	import { systemInfo } from '$lib/shared/bridge/desktop';
	import TitleBar from '$lib/ui/layout/TitleBar.svelte';

	startThemeSync();

	const APP_NAME = 'Agent Development Gateway';

	const features = [
		'Claude Code / Codex / OpenCode 统一适配',
		'本地与 SSH 远程开发',
		'多窗口 IDE 工作区',
		'远程主机管理与后端运维'
	];
</script>

<div class="flex h-full flex-col overflow-hidden bg-surface-base">
	<TitleBar title="关于" />

	<main class="scroll-thin min-h-0 flex-1 overflow-y-auto p-6">
		<div class="flex flex-col items-center gap-4">
			<!-- 图标:与 build/icon 一致的 sparkle 标记(内联绘制) -->
			<div
				class="flex size-24 items-center justify-center rounded-[22px] bg-gradient-to-b from-ink-50 to-ink-200"
			>
				<svg width="64" height="64" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
					<circle cx="512" cy="512" r="330" fill="#2dd4bf" fill-opacity="0.14" />
					<rect
						x="188"
						y="188"
						width="648"
						height="648"
						rx="176"
						fill="none"
						stroke="#78716c"
						stroke-opacity="0.5"
						stroke-width="20"
					/>
					<path
						d="M512 222 L620 404 L802 512 L620 620 L512 802 L404 620 L222 512 L404 404 Z"
						fill="#0d9488"
					/>
					<path
						d="M742 268 L780 330 L842 368 L780 406 L742 468 L704 406 L642 368 L704 330 Z"
						fill="#57534e"
						fill-opacity="0.85"
					/>
				</svg>
			</div>

			<div class="flex flex-col items-center gap-1">
				<h1 class="text-base font-medium text-strong">{APP_NAME}</h1>
				<p class="font-mono text-2xs text-faint">版本 {systemInfo.appVersion}</p>
			</div>

			<p class="max-w-72 text-center text-xs leading-5 text-muted">
				连接开发者、IDE、开发主机与多种 Coding Agent Runtime 的网关。
			</p>

			<div class="flex w-full flex-col gap-1 rounded-default border border-subtle p-3">
				<span class="text-2xs text-faint">功能</span>
				{#each features as feature (feature)}
					<span class="text-xs text-normal">· {feature}</span>
				{/each}
			</div>

			<p class="text-2xs text-faint">© 2026 Agent Development Gateway</p>
		</div>
	</main>
</div>

{#if systemInfo.platform !== 'darwin'}
	<div class="pointer-events-none fixed inset-0 -z-20 bg-surface-base"></div>
{/if}
