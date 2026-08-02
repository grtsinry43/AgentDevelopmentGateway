<script lang="ts">
	/**
	 * 新建工程向导窗口根组件。IDE 风格多步流程(见 NewProjectWizard)。
	 * 创建成功会打开工程窗口,然后关闭本向导。
	 */
	import { startThemeSync } from '$lib/shared/theme/theme.svelte';
	import { hostsStore } from '$lib/features/project/hosts.svelte';
	import NewProjectWizard from '$lib/features/project/components/NewProjectWizard.svelte';
	import { desktop, identity, systemInfo } from '$lib/shared/bridge/desktop';
	import TitleBar from '$lib/ui/layout/TitleBar.svelte';

	startThemeSync();
	void hostsStore.load();

	if (identity.kind !== 'new-project') {
		throw new Error(`当前窗口不是 new-project 窗口(kind=${identity.kind})`);
	}
	const initialHostType = identity.initialHostType;
</script>

<div class="flex h-full flex-col overflow-hidden bg-surface-base">
	<TitleBar title="新建工程" subtitle="按步骤创建本地或远程工程" />
	<NewProjectWizard
		{initialHostType}
		ondone={() => void desktop.window.close()}
		oncancel={() => void desktop.window.close()}
	/>
</div>

{#if systemInfo.platform !== 'darwin'}
	<div class="pointer-events-none fixed inset-0 -z-20 bg-surface-base"></div>
{/if}
