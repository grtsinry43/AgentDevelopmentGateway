<script lang="ts">
	import type { Host } from '@agent-gateway/core';
	import type { HostType } from '$contract/project';
	import type { Snippet } from 'svelte';
	import { cx } from '$lib/shared/utils/cx';
	import { HOST_STATUS } from '$lib/shared/utils/status';
	import Icon from '$lib/ui/icons/Icon.svelte';

	interface Props {
		hostType: HostType;
		hostLabel: string;
		branch?: string;
		agentLabel?: string;
		connectionStatus: Host['status'];
		trailing?: Snippet;
		class?: string;
	}

	let {
		hostType,
		hostLabel,
		branch,
		agentLabel,
		connectionStatus,
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

		<span title="设置（未开放）">
			<button
				type="button"
				class="flex h-7 w-7 items-center justify-center text-faint disabled:opacity-45"
				disabled
				aria-label="设置（未开放）"
			>
				<Icon name="settings" size={12} />
			</button>
		</span>

		{#if trailing}
			{@render trailing()}
		{/if}
	</div>
</footer>
