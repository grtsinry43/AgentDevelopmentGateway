<script lang="ts">
	/**
	 * 设置窗口。左侧类目导航 + 右侧内容(IDE 风格)。
	 * 偏好以独立窗口承载,不做模态弹窗。
	 */
	import { startThemeSync, theme } from '$lib/shared/theme/theme.svelte';
	import { settings } from '$lib/shared/settings/settings.svelte';
	import ProviderProfilesPanel from '$lib/shared/settings/ProviderProfilesPanel.svelte';
	import Checkbox from '$lib/ui/primitives/Checkbox.svelte';
	import { systemInfo } from '$lib/shared/bridge/desktop';
	import TitleBar from '$lib/ui/layout/TitleBar.svelte';
	import { cx } from '$lib/shared/utils/cx';

	type SettingsCategory = 'general' | 'providers';

	let category = $state<SettingsCategory>('general');

	const CATEGORIES: Array<{ id: SettingsCategory; label: string }> = [
		{ id: 'general', label: '通用' },
		{ id: 'providers', label: '提供商与模型' }
	];

	startThemeSync();
</script>

<div class="flex h-full flex-col overflow-hidden bg-surface-base">
	<TitleBar title="设置" />

	<div class="flex min-h-0 flex-1">
		<nav class="flex w-36 shrink-0 flex-col gap-0.5 border-r border-subtle p-2">
			{#each CATEGORIES as item (item.id)}
				<button
					type="button"
					class={cx(
						'flex h-7 items-center rounded-default px-2 text-xs transition-colors',
						category === item.id
							? 'bg-surface-active text-strong'
							: 'text-muted hover:bg-surface-hover hover:text-strong'
					)}
					onclick={() => (category = item.id)}
				>
					{item.label}
				</button>
			{/each}
		</nav>

		<main class="min-h-0 flex-1 overflow-y-auto p-5">
			{#if category === 'general'}
				<div class="flex flex-col gap-6">
					<div class="flex flex-col gap-1.5">
						<span class="text-xs text-muted">外观</span>
						<p class="text-2xs text-faint">
							跟随系统时使用 macOS/Windows 的深浅色设置;手动选择后所有窗口保持一致。
						</p>
						<div class="flex rounded-default border border-line p-0.5">
							{#each [
								{ value: 'system', label: '跟随系统' },
								{ value: 'light', label: '浅色' },
								{ value: 'dark', label: '深色' }
							] as const as option (option.value)}
								<button
									type="button"
									class={[
										'flex h-6 flex-1 items-center justify-center rounded-[2px] text-xs transition-colors',
										theme.preference === option.value
											? 'bg-surface-active text-strong'
											: 'text-muted hover:text-strong'
									]}
									onclick={() => theme.set(option.value)}
								>
									{option.label}
								</button>
							{/each}
						</div>
					</div>

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
						<Checkbox
							checked={settings.expandFileToolDiff}
							label="文件写入/编辑/删除工具块默认展开 diff"
							onchange={(value) => settings.setExpandFileToolDiff(value)}
						/>
					</div>
				</div>
			{:else}
				<ProviderProfilesPanel />
			{/if}
		</main>
	</div>
</div>

{#if systemInfo.platform !== 'darwin'}
	<div class="pointer-events-none fixed inset-0 -z-20 bg-surface-base"></div>
{/if}
