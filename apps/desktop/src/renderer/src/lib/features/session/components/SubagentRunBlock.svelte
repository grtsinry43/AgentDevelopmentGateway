<script lang="ts">
	import { SUBAGENT_STATUS } from '$lib/shared/utils/status';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import type { ConversationSubagentRun } from '../projection';
	import type { SessionWorkspaceState } from '../session-workspace.svelte';

	interface Props {
		item: ConversationSubagentRun;
		workspace: SessionWorkspaceState;
	}

	let { item, workspace }: Props = $props();
	const visual = $derived(SUBAGENT_STATUS[item.run.status]);
	const active = $derived(item.run.status === 'starting' || item.run.status === 'running');
</script>

<button
	type="button"
	class="group my-1.5 flex w-full items-center gap-2 rounded-default px-2 py-2 text-left hover:bg-surface-hover focus-visible:outline-1 focus-visible:outline-accent"
	onclick={() => workspace.openSubagent(item.run.id)}
>
	<span
		class="relative grid h-7 w-7 shrink-0 place-items-center rounded-default bg-surface-overlay text-muted"
	>
		<Icon name="agent" size={14} />
		<span
			class={[
				'absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full ring-2 ring-surface-base',
				visual.dot,
				active && 'animate-pulse'
			]}
		></span>
	</span>
	<span class="min-w-0 flex-1">
		<span class="flex items-center gap-2">
			<span class="truncate text-xs font-medium text-strong">{item.run.title}</span>
			{#if item.run.agentName}
				<span class="shrink-0 font-mono text-2xs text-faint">{item.run.agentName}</span>
			{/if}
		</span>
		<span class="mt-0.5 block truncate text-2xs text-muted">
			{item.run.resultSummary ?? item.run.description ?? visual.label}
		</span>
	</span>
	<span class={['shrink-0 text-2xs', visual.text]}>{visual.label}</span>
	<Icon name="chevron-right" size={11} class="text-faint group-hover:text-muted" />
</button>
