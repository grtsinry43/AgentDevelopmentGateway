<script lang="ts">
	/**
	 * 打开工程选择器窗口(This Window / New Window)。无红绿灯。
	 * 确认后由主进程完成替换/新开并关闭本窗口。
	 */
	import { onMount } from 'svelte';
	import { startThemeSync } from '$lib/shared/theme/theme.svelte';
	import { desktop, identity, systemInfo } from '$lib/shared/bridge/desktop';
	import { basename } from '$lib/shared/utils/path';
	import { listRecentProjects } from '$lib/features/project/api';
	import OpeningProjectOverlay from '$lib/ui/common/OpeningProjectOverlay.svelte';
	import TitleBar from '$lib/ui/layout/TitleBar.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';

	startThemeSync();

	if (identity.kind !== 'open-project') {
		throw new Error(`当前窗口不是 open-project 窗口(kind=${identity.kind})`);
	}
	const projectKey = identity.projectKey;

	let project = $state<{ name: string; path: string; hostType: string } | undefined>(undefined);
	let busy = $state(false);
	let error = $state<string | undefined>(undefined);

	onMount(() => {
		void listRecentProjects().then((list) => {
			const found = list.find((entry) => entry.key === projectKey);
			if (found) project = found;
		});
	});

	async function choose(mode: 'this' | 'new'): Promise<void> {
		if (busy) return;
		busy = true;
		error = undefined;
		try {
			await desktop.projects.openFromChooser(mode);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
			busy = false;
		}
	}

	function cancel(): void {
		void desktop.window.close();
	}
</script>

<div class="flex h-full flex-col overflow-hidden bg-surface-base">
	<TitleBar title="打开工程" trafficLightInset={false} />

	<!-- 打开远程项目耗时:提示层。 -->
	<OpeningProjectOverlay visible={busy} name={project?.name} label="正在打开项目" />

	<main class="flex min-h-0 flex-1 flex-col gap-3 p-5">
		<div class="flex flex-col gap-1">
			<span class="flex items-center gap-1.5 text-sm font-medium text-strong">
				<Icon name={project?.hostType === 'ssh' ? 'server' : 'folder'} size={14} />
				<span class="truncate">{project?.name ?? basename(projectKey)}</span>
			</span>
			{#if project}
				<span class="truncate font-mono text-2xs text-faint">{project.path}</span>
			{/if}
		</div>

		{#if error}
			<p class="text-2xs text-cinnabar-600 dark:text-cinnabar-400">{error}</p>
		{/if}

		<div class="mt-auto flex items-center justify-end gap-1.5">
			<Button variant="secondary" size="sm" loading={busy} onclick={() => void choose('this')}>
				在此窗口打开
			</Button>
			<Button variant="primary" size="sm" loading={busy} onclick={() => void choose('new')}>
				在新窗口打开
			</Button>
			<Button variant="ghost" size="sm" onclick={cancel}>取消</Button>
		</div>
	</main>
</div>

{#if systemInfo.platform !== 'darwin'}
	<div class="pointer-events-none fixed inset-0 -z-20 bg-surface-base"></div>
{/if}
