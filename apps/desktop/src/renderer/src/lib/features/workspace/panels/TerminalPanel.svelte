<script lang="ts">
	import { onMount } from 'svelte';
	import type { TerminalDescriptor } from '@agent-gateway/shared';
	import { desktop, requireProjectKey } from '$lib/shared/bridge/desktop';
	import TerminalView from '$lib/features/terminal/components/TerminalView.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import EmptyState from '$lib/ui/common/EmptyState.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';

	const projectKey = requireProjectKey();
	let terminals = $state<TerminalDescriptor[]>([]);
	let selectedId = $state<string | undefined>(undefined);
	let loading = $state(true);
	let creating = $state(false);
	let available = $state(false);
	let error = $state<string | undefined>(undefined);

	onMount(() => {
		void load();
	});

	async function load(): Promise<void> {
		loading = true;
		error = undefined;
		try {
			const [capabilities, listed] = await Promise.all([
				desktop.terminals.capabilities(projectKey),
				desktop.terminals.list(projectKey)
			]);
			available = capabilities.includes('workspace.terminals.create');
			terminals = listed;
			if (!terminals.some((terminal) => terminal.id === selectedId)) {
				selectedId = terminals[0]?.id;
			}
			// 展开面板时若还没有会话,直接建一个,免得点一次 +
			if (terminals.length === 0 && available) {
				await createTerminal();
			}
		} catch (cause) {
			error = errorMessage(cause);
		} finally {
			loading = false;
		}
	}

	async function createTerminal(): Promise<void> {
		if (!available || creating) return;
		creating = true;
		error = undefined;
		try {
			const created = await desktop.terminals.create(projectKey, 80, 24);
			terminals = [...terminals, created];
			selectedId = created.id;
		} catch (cause) {
			error = errorMessage(cause);
		} finally {
			creating = false;
		}
	}

	async function closeTerminal(terminalId: string): Promise<void> {
		try {
			await desktop.terminals.close(terminalId);
			const index = terminals.findIndex((terminal) => terminal.id === terminalId);
			terminals = terminals.filter((terminal) => terminal.id !== terminalId);
			if (selectedId === terminalId) {
				selectedId = terminals[Math.min(index, Math.max(0, terminals.length - 1))]?.id;
			}
		} catch (cause) {
			error = errorMessage(cause);
		}
	}

	function errorMessage(cause: unknown): string {
		return cause instanceof Error ? cause.message : String(cause);
	}
</script>

<div class="flex h-full min-h-0 flex-col overflow-hidden bg-surface-panel">
	<div class="flex h-7 shrink-0 items-center border-b border-subtle px-1">
		<div class="scroll-thin flex min-w-0 flex-1 items-center overflow-x-auto">
			{#each terminals as terminal (terminal.id)}
				<div
					class="group flex h-6 shrink-0 items-center border-b px-1.5 text-2xs {selectedId ===
					terminal.id
						? 'border-line-accent text-strong'
						: 'border-transparent text-muted'}"
				>
					<button
						type="button"
						class="max-w-28 truncate"
						title={terminal.title}
						onclick={() => (selectedId = terminal.id)}
					>
						{terminal.title}
					</button>
					<button
						type="button"
						class="ml-1 grid h-4 w-4 place-items-center text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-strong"
						title="关闭终端"
						onclick={() => void closeTerminal(terminal.id)}
					>
						<Icon name="close" size={9} />
					</button>
				</div>
			{/each}
		</div>
		<Button
			variant="icon"
			size="sm"
			title={available ? '新建终端' : 'Server 不支持终端'}
			disabled={!available}
			loading={creating}
			onclick={() => void createTerminal()}
		>
			{#snippet icon()}
				<Icon name="plus" size={11} />
			{/snippet}
		</Button>
	</div>

	{#if loading}
		<div class="grid min-h-0 flex-1 place-items-center text-xs text-faint">正在读取终端…</div>
	{:else if error && terminals.length === 0}
		<EmptyState title="终端不可用" description={error} compact>
			{#snippet icon()}<Icon name="terminal" size={16} />{/snippet}
		</EmptyState>
	{:else if terminals.length === 0}
		<EmptyState
			title="没有终端"
			description={available
				? '未能自动创建终端，可点击右上角 + 重试。'
				: '当前 Server 未开放终端能力。'}
			compact
		>
			{#snippet icon()}<Icon name="terminal" size={16} />{/snippet}
		</EmptyState>
	{:else}
		<div class="min-h-0 flex-1 overflow-hidden">
			{#each terminals as terminal (terminal.id)}
				<TerminalView {terminal} active={terminal.id === selectedId} />
			{/each}
		</div>
	{/if}
</div>
