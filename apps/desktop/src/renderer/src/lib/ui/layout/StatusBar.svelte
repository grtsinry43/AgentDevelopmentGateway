<script lang="ts">
	/**
	 * 底部状态栏。展示会话状态 / runtime / 用量。
	 *
	 * 这一阶段还没有真实会话,所以字段都是可选的 —— 有值才显示,不占位。
	 */
	import { cx } from '$lib/shared/utils/cx';
	import { compactCount, costUsd } from '$lib/shared/utils/format';
	import { SESSION_STATUS, isLiveStatus } from '$lib/shared/utils/status';
	import Badge from '$lib/ui/primitives/Badge.svelte';
	import type { AdapterId, AgentSession, Usage } from '@agent-gateway/core';

	interface Props {
		status?: AgentSession['status'];
		adapterId?: AdapterId;
		model?: string;
		usage?: Usage;
		class?: string;
	}

	let { status, adapterId, model, usage, class: className }: Props = $props();

	// 状态 → 颜色的映射只存在于 shared/utils/status,不在组件里内联
	const visual = $derived(status ? SESSION_STATUS[status] : undefined);
	const tokens = $derived(usage?.totalTokens ?? usage?.inputTokens);
</script>

<footer
	class={cx(
		'flex h-6 shrink-0 items-center gap-2.5 border-t border-subtle px-2.5 text-2xs',
		className
	)}
>
	{#if visual && status}
		<Badge dotClass={visual.dot} pulse={isLiveStatus(status)}>{visual.label}</Badge>
	{:else}
		<Badge dotClass="bg-status-idle">未连接</Badge>
	{/if}

	{#if adapterId}
		<span class="font-mono text-faint">{adapterId}</span>
	{/if}

	{#if model}
		<span class="truncate text-faint">{model}</span>
	{/if}

	<div class="ml-auto flex shrink-0 items-center gap-2.5 text-faint">
		{#if tokens !== undefined}
			<span class="font-mono" title="token 用量">{compactCount(tokens)} tok</span>
		{/if}
		{#if usage?.costUsd !== undefined}
			<span class="font-mono">{costUsd(usage.costUsd)}</span>
		{/if}
	</div>
</footer>
