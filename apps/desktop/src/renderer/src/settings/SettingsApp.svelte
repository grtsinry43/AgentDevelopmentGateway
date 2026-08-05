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

		<main class="min-h-0 flex-1 overflow-y-auto p-6">
			{#if category === 'general'}
				<div class="mx-auto flex max-w-xl flex-col gap-8">
					<!-- 外观:图示化主题选择 -->
					<section class="flex flex-col gap-2">
						<div class="flex flex-col gap-0.5">
							<span class="text-sm font-medium text-strong">外观</span>
							<p class="text-2xs text-faint">
								跟随系统使用 macOS/Windows 的深浅色设置;手动选择后所有窗口保持一致。
							</p>
						</div>
						<div class="grid grid-cols-3 gap-2.5">
							{#each [{ value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }, { value: 'system', label: '跟随系统' }] as const as option (option.value)}
								{@const active = theme.preference === option.value}
								{@const dark = option.value === 'dark'}
								<button
									type="button"
									class={[
										'group flex flex-col gap-1.5 rounded-panel border p-2 transition-colors',
										active
											? 'border-accent/60 bg-surface-active'
											: 'border-subtle hover:border-line-accent hover:bg-surface-hover'
									]}
									onclick={() => theme.set(option.value)}
								>
									{#if option.value === 'system'}
										<div class="flex h-16 overflow-hidden rounded-[4px] border border-subtle">
											<div class="flex-1 border-r border-subtle bg-ink-50">
												<div class="mx-1.5 mt-1.5 h-1.5 w-5 rounded-sm bg-ink-300"></div>
												<div class="mx-1.5 mt-1 h-6 rounded-sm bg-ink-200"></div>
											</div>
											<div class="flex-1 bg-ink-900">
												<div class="mx-1.5 mt-1.5 h-1.5 w-5 rounded-sm bg-ink-600"></div>
												<div class="mx-1.5 mt-1 h-6 rounded-sm bg-ink-700"></div>
											</div>
										</div>
									{:else}
										<div
											class={[
												'h-16 overflow-hidden rounded-[4px] border border-subtle',
												dark ? 'bg-ink-900' : 'bg-ink-50'
											]}
										>
											<div
												class={[
													'h-3.5 border-b',
													dark ? 'border-ink-700 bg-ink-800' : 'border-ink-200 bg-ink-100'
												]}
											></div>
											<div class="flex items-start gap-1.5 px-1.5 pt-1.5">
												<div
													class={['h-6 w-8 rounded-sm', dark ? 'bg-ink-700' : 'bg-ink-200']}
												></div>
												<div class="flex flex-1 flex-col gap-1">
													<div
														class={['h-1 w-full rounded-sm', dark ? 'bg-ink-600' : 'bg-ink-300']}
													></div>
													<div
														class={['h-1 w-3/4 rounded-sm', dark ? 'bg-ink-600' : 'bg-ink-300']}
													></div>
												</div>
											</div>
										</div>
									{/if}
									<span
										class={[
											'flex items-center gap-1.5 text-xs transition-colors',
											active ? 'font-medium text-strong' : 'text-muted group-hover:text-normal'
										]}
									>
										<span
											class={[
												'size-3 shrink-0 rounded-full border',
												active
													? 'border-accent bg-accent shadow-[0_0_0_2px_var(--surface-base),0_0_0_3px_var(--accent)]'
													: 'border-subtle bg-transparent'
											]}
										></span>
										{option.label}
									</span>
								</button>
							{/each}
						</div>
					</section>

					<hr class="border-subtle" />

					<section class="flex flex-col gap-2">
						<div class="flex flex-col gap-0.5">
							<span class="text-sm font-medium text-strong">代码块</span>
							<p class="text-2xs text-faint">
								Agent 输出中的长代码行如何处理,避免把内容区域撑得极宽。全局生效并持久化。
							</p>
						</div>
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
					</section>

					<section class="flex flex-col gap-2">
						<div class="flex flex-col gap-0.5">
							<span class="text-sm font-medium text-strong">对话</span>
							<p class="text-2xs text-faint">会话展示相关的偏好。</p>
						</div>
						<div class="flex flex-col gap-2.5 rounded-panel border border-subtle p-3">
							<Checkbox
								checked={settings.expandFileToolDiff}
								label="文件写入/编辑/删除工具块默认展开 diff"
								onchange={(value) => settings.setExpandFileToolDiff(value)}
							/>
						</div>
					</section>
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
