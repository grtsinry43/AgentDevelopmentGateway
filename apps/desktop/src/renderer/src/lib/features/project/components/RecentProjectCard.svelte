<script lang="ts">
	import { relativeTime } from '$lib/shared/utils/format';
	import { projectLabel } from '$lib/shared/utils/path';
	import { systemInfo } from '$lib/shared/bridge/desktop';
	import { HOST_STATUS } from '$lib/shared/utils/status';
	import Badge from '$lib/ui/primitives/Badge.svelte';
	import GlassSurface from '$lib/ui/common/GlassSurface.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import type { RecentProject } from '../types';

	interface Props {
		project: RecentProject;
		selected: boolean;
		onactivate: () => void;
		onhover: () => void;
	}

	let { project, selected, onactivate, onhover }: Props = $props();

	const label = $derived(projectLabel(project.hostId, project.path, systemInfo.homeDir, 3));
	// 远程工程在 Rust Remote Manager 接入前一律 offline(计划风险条目 3)
	const status = $derived(project.hostType === 'local' ? HOST_STATUS.online : HOST_STATUS.offline);
</script>

<!--
	用 button 而非 div[role=button]:原生按钮自带键盘激活、焦点管理和 a11y 语义。
	卡片本身不抢焦点(tabindex=-1)—— 导航由 keymap 的 ↑↓/jk 统一负责,
	Tab 键在这个界面里应该留给「搜索框 ↔ 新建按钮」这种真正的焦点跳转。
-->
<button
	type="button"
	tabindex="-1"
	class="block w-full text-left"
	onclick={onactivate}
	ondblclick={onactivate}
	onmouseenter={onhover}
>
	<GlassSurface interactive {selected} class="px-3 py-2.5">
		<div class="flex items-start justify-between gap-2">
			<span class="flex min-w-0 items-center gap-1.5">
				<Icon
					name={project.hostType === 'local' ? 'folder' : 'server'}
					class={selected ? 'text-accent' : 'text-faint'}
				/>
				<span class="truncate text-base font-medium text-strong">{project.name}</span>
			</span>

			{#if project.pinned}
				<Icon name="pin" size={11} class="mt-0.5 shrink-0 text-accent" />
			{/if}
		</div>

		<p
			class="mt-1 truncate font-mono text-2xs text-faint"
			title={`${project.path} @${project.hostId}`}
		>
			{label}
		</p>

		<div class="mt-2 flex items-center gap-1.5">
			<Badge dotClass={status.dot} tone="neutral">{status.label}</Badge>
			{#if project.lastAdapterId}
				<Badge tone="accent" mono>{project.lastAdapterId}</Badge>
			{/if}
			{#if project.sessionCount}
				<span class="text-2xs text-faint">{project.sessionCount} 个会话</span>
			{/if}
			<span class="ml-auto text-2xs text-faint">{relativeTime(project.lastOpenedAt)}</span>
		</div>
	</GlassSurface>
</button>
