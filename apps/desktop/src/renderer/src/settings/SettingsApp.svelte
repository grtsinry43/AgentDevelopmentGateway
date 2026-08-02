<script lang="ts">
	/**
	 * 设置窗口。偏好以独立窗口承载(IDE 风格,不做模态弹窗)。
	 */
	import { startThemeSync } from '$lib/shared/theme/theme.svelte';
	import { settings } from '$lib/shared/settings/settings.svelte';
	import { systemInfo } from '$lib/shared/bridge/desktop';
	import TitleBar from '$lib/ui/layout/TitleBar.svelte';

	startThemeSync();
</script>

<div class="flex h-full flex-col overflow-hidden bg-surface-base">
	<TitleBar title="设置" />

	<main class="min-h-0 flex-1 overflow-y-auto p-5">
		<div class="flex flex-col gap-6">
			<div class="flex flex-col gap-1.5">
				<span class="text-xs text-muted">代码块长行策略</span>
				<p class="text-2xs text-faint">
					Agent 输出中的长代码行如何处理,避免把内容区域撑得极宽。设置全局生效并持久化。
				</p>
				<div class="flex rounded-default border border-line p-0.5">
					{#each [{ value: 'softwrap', label: '软换行' }, { value: 'scroll', label: '横向滚动' }] as const as option (option.value)}
						<button
							type="button"
							class={[
								'flex h-6 flex-1 items-center justify-center rounded-[2px] text-xs transition-colors',
								settings.codeWrap === option.value
									? 'bg-surface-active text-strong'
									: 'text-muted hover:text-strong'
							]}
							onclick={() => settings.setCodeWrap(option.value)}
						>
							{option.label}
						</button>
					{/each}
				</div>
			</div>

			<div class="flex flex-col gap-1.5">
				<span class="text-xs text-muted">文件变更展示</span>
				<label class="flex cursor-pointer items-center gap-2 text-2xs text-muted">
					<input
						type="checkbox"
						checked={settings.expandFileToolDiff}
						onchange={(event) => settings.setExpandFileToolDiff((event.currentTarget as HTMLInputElement).checked)}
						class="accent-current"
					/>
					文件写入/编辑/删除工具块默认展开 diff
				</label>
			</div>
		</div>
	</main>
</div>

{#if systemInfo.platform !== 'darwin'}
	<div class="pointer-events-none fixed inset-0 -z-20 bg-surface-base"></div>
{/if}
