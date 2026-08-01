<script lang="ts">
	import Icon from '$lib/ui/icons/Icon.svelte';
	import type { InputQueueEntryWire } from '@agent-gateway/shared';
	import type { SessionWorkspaceState } from '../session-workspace.svelte';

	interface Props {
		workspace: SessionWorkspaceState;
	}

	let { workspace }: Props = $props();
	let editingId = $state<string | undefined>(undefined);
	let draft = $state('');

	function beginEdit(entry: InputQueueEntryWire): void {
		editingId = entry.id;
		draft = entry.input.text;
	}

	async function save(entry: InputQueueEntryWire): Promise<void> {
		const text = draft.trim();
		if (!text) return;
		if (await workspace.editQueuedInput(entry.id, text)) editingId = undefined;
	}
</script>

<section
	class="scroll-thin absolute inset-x-0 bottom-9 z-20 max-h-56 overflow-y-auto border-t border-subtle bg-surface-raised/95 backdrop-blur"
	aria-label="待发送消息"
>
	<header
		class="sticky top-0 flex h-7 items-center gap-2 border-b border-subtle bg-surface-raised/95 px-3"
	>
		<Icon name="list" size={11} class="text-muted" />
		<span class="text-2xs font-medium text-muted">待发送 {workspace.inputQueue.length}</span>
		<span class="ml-auto text-2xs text-faint">Agent 空闲后按顺序继续</span>
	</header>
	{#each workspace.inputQueue as entry, index (entry.id)}
		<div class="flex min-h-9 items-center gap-2 border-b border-subtle px-2 py-1 last:border-b-0">
			<span class="w-4 shrink-0 text-right font-mono text-2xs text-faint">{index + 1}</span>
			{#if editingId === entry.id}
				<input
					class="h-7 min-w-0 flex-1 rounded-default bg-surface-overlay px-2 font-mono text-xs text-normal outline-none focus:ring-1 focus:ring-accent"
					bind:value={draft}
					disabled={workspace.queueBusyId === entry.id}
					onkeydown={(event) => {
						if (event.key === 'Enter') void save(entry);
						if (event.key === 'Escape') editingId = undefined;
					}}
				/>
				<button
					class="px-1 text-2xs text-accent hover:text-strong"
					onclick={() => void save(entry)}
				>
					保存
				</button>
			{:else}
				<button
					type="button"
					class="min-w-0 flex-1 truncate text-left font-mono text-xs text-normal hover:text-strong"
					title={entry.input.text}
					onclick={() => beginEdit(entry)}
				>
					{entry.input.text}
				</button>
			{/if}
			<div class="flex shrink-0 items-center text-faint">
				<button
					type="button"
					class="grid h-6 w-6 place-items-center hover:text-strong disabled:opacity-30"
					title="上移"
					disabled={index === 0 || Boolean(workspace.queueBusyId)}
					onclick={() => void workspace.moveQueuedInput(entry.id, -1)}
				>
					<Icon name="chevron-right" size={10} class="-rotate-90" />
				</button>
				<button
					type="button"
					class="grid h-6 w-6 place-items-center hover:text-strong disabled:opacity-30"
					title="下移"
					disabled={index === workspace.inputQueue.length - 1 || Boolean(workspace.queueBusyId)}
					onclick={() => void workspace.moveQueuedInput(entry.id, 1)}
				>
					<Icon name="chevron-right" size={10} class="rotate-90" />
				</button>
				<button
					type="button"
					class="h-6 px-1.5 text-2xs hover:text-accent disabled:opacity-30"
					title="尝试转向当前 Agent；不支持时保留到下一轮"
					disabled={Boolean(workspace.queueBusyId)}
					onclick={() => void workspace.sendQueuedInputNow(entry.id)}
				>
					现在发送
				</button>
				<button
					type="button"
					class="grid h-6 w-6 place-items-center hover:text-status-error disabled:opacity-30"
					title="删除"
					disabled={Boolean(workspace.queueBusyId)}
					onclick={() => void workspace.cancelQueuedInput(entry.id)}
				>
					<Icon name="close" size={10} />
				</button>
			</div>
		</div>
	{/each}
</section>
