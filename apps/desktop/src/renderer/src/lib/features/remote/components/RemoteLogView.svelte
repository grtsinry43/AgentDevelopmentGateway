<script lang="ts">
	/**
	 * 远程日志的通用渲染(滚动区 + 清空)。工程窗口的面板与主机管理对话框共用。
	 * 串流的启停由宿主(RemoteLogPanel / HostDetailDialog)负责。
	 */
	import { remoteLog } from '../log-store.svelte';
	import { formatLogTime, type LogLevel } from '../log-format';
	import Button from '$lib/ui/primitives/Button.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';

	const levelVisual: Record<LogLevel, { badge: string; text: string }> = {
		trace: { badge: 'bg-surface-subtle text-faint', text: 'text-faint' },
		debug: { badge: 'bg-surface-subtle text-faint', text: 'text-faint' },
		info: { badge: 'bg-surface-subtle text-muted', text: 'text-muted' },
		warn: { badge: 'bg-status-waiting text-black dark:text-black', text: 'text-status-waiting' },
		error: { badge: 'bg-status-error text-white', text: 'text-status-error' },
		fatal: { badge: 'bg-status-error text-white', text: 'text-status-error' }
	};

	const LEVEL_LABEL: Record<LogLevel, string> = {
		trace: 'TRC',
		debug: 'DBG',
		info: 'INF',
		warn: 'WRN',
		error: 'ERR',
		fatal: 'FTL'
	};

	function describeRequest(entry: {
		method?: string;
		url?: string;
		statusCode?: number;
		msg: string;
	}): string {
		if (entry.method && entry.url) {
			const base = `${entry.method} ${entry.url}`;
			return entry.statusCode === undefined ? base : `${base} → ${entry.statusCode}`;
		}
		return entry.msg;
	}

	let viewport: HTMLElement | undefined;
	let stickToBottom = $state(true);

	function onScroll(): void {
		if (!viewport) return;
		const { scrollTop, scrollHeight, clientHeight } = viewport;
		stickToBottom = scrollHeight - scrollTop - clientHeight < 24;
	}

	$effect(() => {
		if (stickToBottom && viewport) viewport.scrollTop = viewport.scrollHeight;
	});
</script>

<div class="flex h-full min-h-0 flex-col">
	<div class="flex h-6 shrink-0 items-center justify-end gap-1">
		<span
			class={[
				'mr-auto inline-block h-1.5 w-1.5 rounded-full',
				remoteLog.streaming ? 'bg-status-online' : 'bg-status-offline'
			]}
			title={remoteLog.streaming ? '串流中' : '已停止'}
		></span>
		<Button
			variant="icon"
			size="sm"
			title="清空"
			disabled={remoteLog.entries.length === 0}
			onclick={() => remoteLog.clear()}
		>
			{#snippet icon()}
				<Icon name="close" size={10} />
			{/snippet}
		</Button>
	</div>

	{#if remoteLog.error}
		<p class="shrink-0 text-2xs text-cinnabar-600 dark:text-cinnabar-400">{remoteLog.error}</p>
	{/if}

	<div
		class="scroll-thin min-h-0 flex-1 overflow-auto border-t border-subtle bg-surface-base px-2 py-1 font-mono text-2xs leading-relaxed"
		bind:this={viewport}
		onscroll={onScroll}
	>
		{#if remoteLog.entries.length === 0}
			<p class="text-faint">暂无日志。串流 ~/.agent-development-gateway/server/server.log。</p>
		{:else}
			{#each remoteLog.entries as entry, index (index)}
				<div class="flex min-w-0 items-baseline gap-1.5 py-px">
					<span class="shrink-0 text-faint">{formatLogTime(entry.time)}</span>
					{#if entry.level}
						<span
							class={['shrink-0 rounded px-1 text-2xs leading-4', levelVisual[entry.level].badge]}
						>
							{LEVEL_LABEL[entry.level]}
						</span>
					{/if}
					{#if entry.reqId}
						<span class="shrink-0 text-faint">[{entry.reqId}]</span>
					{/if}
					<span
						class={[
							'min-w-0 flex-1 break-all',
							entry.level === 'error' || entry.level === 'fatal'
								? levelVisual.error.text
								: entry.level === 'warn'
									? levelVisual.warn.text
									: 'text-muted'
						]}
					>
						{describeRequest(entry)}
						{#if entry.errorMessage}
							<span class="block whitespace-pre-wrap text-status-error">{entry.errorMessage}</span>
						{/if}
						{#if entry.errorStackFirst}
							<span class="block text-faint">{entry.errorStackFirst}</span>
						{/if}
					</span>
				</div>
			{/each}
		{/if}
	</div>
</div>
