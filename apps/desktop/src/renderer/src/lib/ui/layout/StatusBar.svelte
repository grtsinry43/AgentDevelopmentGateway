<script lang="ts">
	import type { Host } from '@agent-gateway/core';
	import type { HostType } from '$contract/project';
	import type { Snippet } from 'svelte';
	import { cx } from '$lib/shared/utils/cx';
	import { HOST_STATUS } from '$lib/shared/utils/status';
	import { perfMonitor } from '$lib/shared/perf/perf-monitor.svelte';
	import { renderScan } from '$lib/shared/perf/render-scan.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';

	interface Props {
		hostType: HostType;
		hostLabel: string;
		branch?: string;
		agentLabel?: string;
		connectionStatus: Host['status'];
		/** 点击设置齿轮。 */
		onSettings?: () => void;
		trailing?: Snippet;
		class?: string;
	}

	let {
		hostType,
		hostLabel,
		branch,
		agentLabel,
		connectionStatus,
		onSettings,
		trailing,
		class: className
	}: Props = $props();

	const connectionVisual = $derived(HOST_STATUS[connectionStatus]);
	const connectionLabel = $derived(
		connectionStatus === 'online'
			? 'Gateway Server 已连接'
			: connectionStatus === 'connecting'
				? '正在连接 Gateway Server'
				: connectionStatus === 'error'
					? 'Gateway Server 连接异常'
					: 'Gateway Server 已断开'
	);
</script>

<footer
	class={cx(
		'flex h-7 shrink-0 items-center overflow-hidden border-t border-subtle text-2xs text-muted',
		className
	)}
>
	<div class="flex h-full min-w-0 items-center overflow-hidden">
		<div class="flex h-full shrink-0 items-center gap-1.5 px-2.5" title={hostLabel}>
			<Icon name={hostType === 'local' ? 'monitor' : 'server'} size={11} />
			<span class="max-w-40 truncate font-mono text-normal">{hostLabel}</span>
		</div>

		{#if branch}
			<div class="flex h-full min-w-0 items-center gap-1.5 px-2" title={`Git: ${branch}`}>
				<Icon name="git-branch" size={11} />
				<span class="max-w-44 truncate font-mono">{branch}</span>
			</div>
		{/if}

		{#if agentLabel}
			<div class="flex h-full min-w-0 items-center gap-1.5 px-2" title={`Agent: ${agentLabel}`}>
				<Icon name="agent" size={11} />
				<span class="max-w-40 truncate">{agentLabel}</span>
			</div>
		{/if}
	</div>

	<div class="ml-auto flex h-full shrink-0 items-center">
		<span
			class="flex h-full w-7 items-center justify-center"
			title={connectionLabel}
			aria-label={connectionLabel}
		>
			<span
				class={cx(
					'size-1.5 rounded-full',
					connectionVisual.dot,
					connectionStatus === 'connecting' && 'animate-pulse'
				)}
			></span>
		</span>

		<span title="渲染热点高亮">
			<button
				type="button"
				class={cx(
					'flex h-7 w-7 items-center justify-center transition-colors',
					renderScan.enabled
						? 'text-status-running hover:text-status-running'
						: 'text-faint hover:text-strong'
				)}
				aria-label="渲染热点高亮"
				onclick={() => (renderScan.enabled = !renderScan.enabled)}
			>
				<Icon name="eye" size={12} />
			</button>
		</span>

		<span title="性能监视 (⌥⌘P)">
			<button
				type="button"
				class={cx(
					'flex h-7 w-7 items-center justify-center transition-colors',
					perfMonitor.enabled
						? 'text-status-running hover:text-status-running'
						: 'text-faint hover:text-strong'
				)}
				aria-label="性能监视"
				onclick={() => perfMonitor.toggle()}
			>
				<Icon name="activity" size={12} />
			</button>
		</span>

		<span title="设置">
			<button
				type="button"
				class="flex h-7 w-7 items-center justify-center text-faint transition-colors hover:text-strong"
				aria-label="设置"
				onclick={onSettings}
			>
				<Icon name="settings" size={12} />
			</button>
		</span>

		{#if trailing}
			{@render trailing()}
		{/if}
	</div>
</footer>
