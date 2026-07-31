<script lang="ts">
	import Button from '$lib/ui/primitives/Button.svelte';
	import type { GatewayAdapterAvailability } from '@agent-gateway/shared';
	import type { SessionWorkspaceState } from '../session-workspace.svelte';

	interface Props {
		workspace: SessionWorkspaceState;
	}

	let { workspace }: Props = $props();
	let text = $state('');
	let adapterOverride = $state<GatewayAdapterAvailability['adapterId'] | undefined>(undefined);
	let installationOverride = $state<string | undefined>(undefined);

	const selectedAdapterId = $derived(
		adapterOverride ?? workspace.availableAdapters[0]?.adapterId ?? ''
	);
	const selectedAdapter = $derived(
		workspace.availableAdapters.find((adapter) => adapter.adapterId === selectedAdapterId)
	);
	const selectedInstallation = $derived(
		installationOverride ?? selectedAdapter?.installations[0]?.path
	);
	const creating = $derived(!workspace.selectedSessionId);
	const canSubmit = $derived(
		text.trim().length > 0 && !workspace.sending && (!creating || Boolean(selectedAdapter))
	);

	async function submit(): Promise<void> {
		const value = text.trim();
		if (!value || !canSubmit) return;

		const accepted = creating
			? selectedAdapter
				? await workspace.createTextSession(
						value,
						selectedAdapter.adapterId,
						selectedAdapter.installations.length > 1 ? selectedInstallation : undefined
					)
				: false
			: await workspace.sendText(value);
		if (accepted) text = '';
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
		event.preventDefault();
		void submit();
	}
</script>

<div class="shrink-0 border-t border-subtle bg-surface-panel p-2.5">
	{#if creating}
		<div class="mb-1.5 flex min-w-0 items-center gap-1.5">
			<label class="shrink-0 text-2xs text-faint" for="session-adapter">Agent</label>
			<select
				id="session-adapter"
				class="h-6 min-w-0 rounded-default border border-line bg-surface-raised px-1.5 text-xs text-strong"
				value={selectedAdapterId}
				disabled={workspace.availableAdapters.length === 0 || workspace.sending}
				onchange={(event) => {
					adapterOverride = event.currentTarget.value as GatewayAdapterAvailability['adapterId'];
					installationOverride = undefined;
				}}
			>
				{#each workspace.availableAdapters as adapter (adapter.adapterId)}
					<option value={adapter.adapterId}>{adapter.descriptor.displayName}</option>
				{/each}
			</select>

			{#if selectedAdapter && selectedAdapter.installations.length > 1}
				<label class="ml-1 shrink-0 text-2xs text-faint" for="session-installation">运行时</label>
				<select
					id="session-installation"
					class="h-6 min-w-0 flex-1 rounded-default border border-line bg-surface-raised px-1.5 font-mono text-2xs text-strong"
					value={selectedInstallation}
					disabled={workspace.sending}
					onchange={(event) => (installationOverride = event.currentTarget.value)}
				>
					{#each selectedAdapter.installations as installation (installation.path)}
						<option value={installation.path}>{installation.path}</option>
					{/each}
				</select>
			{/if}
		</div>
	{/if}

	<div
		class="rounded-panel border border-line bg-surface-raised shadow-subtle focus-within:border-line-accent"
	>
		<textarea
			bind:value={text}
			rows="3"
			placeholder={creating ? '输入第一条指令以创建会话…' : '继续这个会话…'}
			disabled={workspace.sending || (creating && workspace.availableAdapters.length === 0)}
			class="selectable block max-h-40 min-h-16 w-full resize-y bg-transparent px-2.5 py-2 text-sm leading-relaxed text-strong outline-none placeholder:text-faint"
			onkeydown={handleKeydown}></textarea>
		<div class="flex h-7 items-center border-t border-subtle px-2">
			<span class="text-2xs text-faint">Enter 发送 · Shift+Enter 换行</span>
			<Button
				variant="primary"
				size="sm"
				class="ml-auto"
				loading={workspace.sending}
				disabled={!canSubmit}
				onclick={() => void submit()}
			>
				{creating ? '创建并发送' : '发送'}
			</Button>
		</div>
	</div>

	{#if creating && !workspace.loading && workspace.availableAdapters.length === 0}
		<p class="mt-1.5 text-xs text-status-error">当前没有可用的 Agent runtime。</p>
	{/if}
</div>
