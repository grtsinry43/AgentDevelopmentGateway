<script lang="ts">
	import { relativeTime } from '$lib/shared/utils/format';
	import { projectLabel } from '$lib/shared/utils/path';
	import { systemInfo } from '$lib/shared/bridge/desktop';
	import { HOST_STATUS } from '$lib/shared/utils/status';
	import { cx } from '$lib/shared/utils/cx';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import type { RecentProject } from '../types';

	interface Props {
		project: RecentProject;
		selected: boolean;
		onactivate: () => void;
	}

	let { project, selected, onactivate }: Props = $props();

	const label = $derived(projectLabel(project.hostId, project.path, systemInfo.homeDir, 3));
	// 远程工程在 Rust Remote Manager 接入前一律 offline(计划风险条目 3)
	const status = $derived(project.hostType === 'local' ? HOST_STATUS.online : HOST_STATUS.offline);
</script>

<!--
	用 button 而非 div[role=button]:原生按钮自带键盘激活、焦点管理和 a11y 语义。
	列表行本身不抢焦点(tabindex=-1)—— 导航由 keymap 的 ↑↓/jk 统一负责,
	Tab 键在这个界面里应该留给「搜索框 ↔ 新建按钮」这种真正的焦点跳转。
-->
<button
	type="button"
	tabindex="-1"
	class={cx(
		'group relative flex min-h-13 w-full items-center gap-3 border-b border-subtle px-2.5 py-2 text-left',
		'transition-colors duration-100 hover:bg-surface-hover',
		selected && 'bg-surface-selected'
	)}
	onclick={onactivate}
>
	{#if selected}
		<span class="absolute inset-y-1.5 left-0 w-0.5 bg-line-accent" aria-hidden="true"></span>
	{/if}

	<Icon
		name={project.hostType === 'local' ? 'folder' : 'server'}
		size={15}
		class={selected ? 'text-accent' : 'text-faint'}
	/>

	<span class="min-w-0 flex-1">
		<span class="flex min-w-0 items-center gap-1.5">
			<span class="truncate text-sm font-medium text-strong">{project.name}</span>
			{#if project.pinned}
				<Icon name="pin" size={10} class="shrink-0 text-accent" />
			{/if}
		</span>
		<span
			class="mt-0.5 block truncate font-mono text-2xs text-faint"
			title={`${project.path} @${project.hostId}`}
		>
			{label}
		</span>
	</span>

	<span class="flex shrink-0 items-center gap-1.5 text-2xs text-faint">
		<span class={cx('h-1.5 w-1.5 rounded-full', status.dot)} aria-hidden="true"></span>
		<span>{status.label}</span>
		{#if project.lastAdapterId}
			<span class="font-mono text-muted">{project.lastAdapterId}</span>
		{/if}
		{#if project.sessionCount}
			<span>{project.sessionCount} 会话</span>
		{/if}
	</span>

	<span class="w-14 shrink-0 text-right text-2xs text-faint">
		{relativeTime(project.lastOpenedAt)}
	</span>
</button>
