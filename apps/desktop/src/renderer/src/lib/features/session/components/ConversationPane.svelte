<script lang="ts">
	import { tick } from 'svelte';
	import { cx } from '$lib/shared/utils/cx';
	import { SESSION_STATUS, isLiveStatus } from '$lib/shared/utils/status';
	import EmptyState from '$lib/ui/common/EmptyState.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import Badge from '$lib/ui/primitives/Badge.svelte';
	import type { SessionWorkspaceState } from '../session-workspace.svelte';
	import AgentMarkdown from './AgentMarkdown.svelte';
	import AgentWorkingIndicator from './AgentWorkingIndicator.svelte';
	import ReasoningBlock from './ReasoningBlock.svelte';
	import SessionComposer from './SessionComposer.svelte';

	interface Props {
		workspace: SessionWorkspaceState;
	}

	let { workspace }: Props = $props();
	let transcript: HTMLDivElement | undefined = $state();
	let pinnedToBottom = $state(true);

	const sessionVisual = $derived(
		workspace.selectedSession ? SESSION_STATUS[workspace.selectedSession.status] : undefined
	);
	const showWorkingIndicator = $derived(
		workspace.selectedSession?.status === 'running' &&
			!workspace.messages.some((message) => message.streaming)
	);

	function updateScrollPin(): void {
		if (!transcript) return;
		pinnedToBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 48;
	}

	$effect(() => {
		workspace.messages.map(
			(message) => `${message.id}:${message.text.length}:${message.streaming}`
		);
		if (!pinnedToBottom || (!showWorkingIndicator && workspace.messages.length === 0)) return;
		void tick().then(() => transcript?.scrollTo({ top: transcript.scrollHeight }));
	});
</script>

<section class="flex min-h-0 flex-1 flex-col bg-surface-base">
	<header class="flex h-9 shrink-0 items-center gap-2 border-b border-subtle px-3">
		<div class="min-w-0 flex-1">
			<p class="truncate text-xs text-strong">
				{workspace.selectedSession?.title ?? '新建会话'}
			</p>
			{#if workspace.selectedSession}
				<p class="truncate font-mono text-2xs text-faint">{workspace.selectedSession.adapterId}</p>
			{:else}
				<p class="text-2xs text-faint">首次发送时创建真实 Session</p>
			{/if}
		</div>
		{#if sessionVisual && workspace.selectedSession}
			<Badge dotClass={sessionVisual.dot} pulse={isLiveStatus(workspace.selectedSession.status)}>
				{sessionVisual.label}
			</Badge>
		{/if}
	</header>

	{#if workspace.error}
		<div
			class="shrink-0 border-b border-cinnabar-500/20 bg-cinnabar-500/8 px-3 py-1.5 text-xs text-status-error"
		>
			{workspace.error}
		</div>
	{/if}

	<div
		bind:this={transcript}
		class="scroll-thin min-h-0 flex-1 overflow-y-auto"
		onscroll={updateScrollPin}
	>
		{#if !workspace.selectedSessionId}
			<EmptyState
				title="准备新会话"
				description="选择 Agent，在下方输入第一条指令。Session 会在发送时创建。"
				class="h-full"
			>
				{#snippet icon()}
					<Icon name="message" size={22} />
				{/snippet}
			</EmptyState>
		{:else if workspace.messages.length === 0}
			<EmptyState
				title={workspace.streamState === 'connecting' ? '正在读取事件…' : '这个会话还没有文本'}
				description="工具与交互事件已保留，但当前视图只展示用户和 Agent 文本。"
				class="h-full"
			>
				{#snippet icon()}
					<Icon name="message" size={20} />
				{/snippet}
			</EmptyState>
		{:else}
			<div class="mx-auto w-full max-w-3xl px-5 py-4">
				{#each workspace.messages as message (message.id)}
					{#if message.contentKind === 'reasoning'}
						<ReasoningBlock
							text={message.text}
							streaming={message.streaming}
							durationMs={message.durationMs}
						/>
					{:else}
						<article
							class={cx(
								'content-auto selectable border-b border-subtle py-3 last:border-b-0',
								message.role === 'user' && 'font-mono'
							)}
						>
							<div class="mb-1 flex items-center gap-2 text-2xs tracking-wide text-faint uppercase">
								<span>{message.role === 'user' ? 'You' : 'Agent'}</span>
								{#if message.streaming}
									<span class="h-1.5 w-1.5 animate-pulse rounded-full bg-status-running"></span>
								{/if}
							</div>
							{#if message.role === 'assistant'}
								<AgentMarkdown content={message.text || (message.streaming ? '…' : '')} />
							{:else}
								<p class="text-sm leading-6 whitespace-pre-wrap text-normal">
									{message.text || (message.streaming ? '…' : '')}
								</p>
							{/if}
						</article>
					{/if}
				{/each}
				{#if showWorkingIndicator}
					<AgentWorkingIndicator />
				{/if}
			</div>
		{/if}
	</div>

	{#key workspace.selectedSessionId ?? 'new-session'}
		<SessionComposer {workspace} />
	{/key}
</section>
