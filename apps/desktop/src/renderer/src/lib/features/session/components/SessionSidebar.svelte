<script lang="ts">
	import { relativeTime } from '$lib/shared/utils/format';
	import { cx } from '$lib/shared/utils/cx';
	import { SESSION_STATUS, isLiveStatus } from '$lib/shared/utils/status';
	import EmptyState from '$lib/ui/common/EmptyState.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import Badge from '$lib/ui/primitives/Badge.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import Input from '$lib/ui/primitives/Input.svelte';
	import Spinner from '$lib/ui/primitives/Spinner.svelte';
	import type { SessionFilter, SessionWorkspaceState } from '../session-workspace.svelte';
	import ContextMenu, { type ContextMenuItem } from '$lib/ui/primitives/ContextMenu.svelte';

	interface Props {
		workspace: SessionWorkspaceState;
	}

	let { workspace }: Props = $props();

	/** 右键菜单:编辑标题 / 归档选中的会话。 */
	let menu = $state<{ x: number; y: number; sessionId: string; closed: boolean } | undefined>(
		undefined
	);

	/** 行内重命名状态(会话 id + 输入框草稿)。 */
	let editing = $state<{ sessionId: string; value: string } | undefined>(undefined);
	let editInput = $state<HTMLInputElement | null>(null);

	function openSessionMenu(event: MouseEvent, sessionId: string, closed: boolean): void {
		event.preventDefault();
		menu = { x: event.clientX, y: event.clientY, sessionId, closed };
	}

	function beginRename(sessionId: string, currentTitle: string): void {
		menu = undefined;
		editing = { sessionId, value: currentTitle === '未命名会话' ? '' : currentTitle };
	}

	function commitRename(): void {
		const target = editing;
		if (!target) return;
		editing = undefined;
		if (target.value.trim()) void workspace.renameSession(target.sessionId, target.value);
	}

	function cancelRename(): void {
		editing = undefined;
	}

	function onRenameKeydown(event: KeyboardEvent): void {
		event.stopPropagation();
		if (event.key === 'Enter') commitRename();
		else if (event.key === 'Escape') cancelRename();
	}

	$effect(() => {
		if (editing && editInput) editInput.focus();
	});

	const sessionMenuItems = $derived.by<ContextMenuItem[]>(() => {
		if (!menu) return [];
		const session = workspace.sessions.find((item) => item.id === menu!.sessionId);
		return [
			{
				label: '编辑标题',
				icon: 'pencil',
				run: () => beginRename(menu!.sessionId, session?.title ?? '')
			},
			menu.closed
				? {
						label: '恢复会话',
						icon: 'refresh',
						run: () => void workspace.unarchiveSession(menu!.sessionId)
					}
				: {
						label: '归档',
						icon: 'file-text',
						run: () => void workspace.archiveSession(menu!.sessionId)
					}
		];
	});

	const FILTERS: Array<{ id: SessionFilter; label: string }> = [
		{ id: 'all', label: '全部' },
		{ id: 'active', label: '进行中' },
		{ id: 'waiting', label: '等待' },
		{ id: 'ended', label: '已结束' },
		{ id: 'archived', label: '已归档' }
	];
</script>

<div class="flex min-h-0 flex-1 flex-col">
	<div class="flex shrink-0 items-center gap-1 border-b border-subtle p-1.5">
		<Input
			bind:value={workspace.search}
			type="search"
			placeholder="筛选会话"
			class="min-w-0 flex-1"
		>
			{#snippet icon()}
				<Icon name="search" size={11} />
			{/snippet}
		</Input>
		<Button
			variant="icon"
			size="md"
			title="新建会话"
			onclick={() => void workspace.beginNewSession()}
		>
			{#snippet icon()}
				<Icon name="plus" size={12} />
			{/snippet}
		</Button>
	</div>

	<div class="flex h-7 shrink-0 items-center gap-0.5 border-b border-subtle px-1.5">
		{#each FILTERS as filter (filter.id)}
			<button
				type="button"
				class={cx(
					'rounded-default px-1.5 py-0.5 text-2xs transition-colors',
					workspace.filter === filter.id
						? 'bg-surface-active text-strong'
						: 'text-faint hover:bg-surface-hover hover:text-muted'
				)}
				aria-pressed={workspace.filter === filter.id}
				onclick={() => (workspace.filter = filter.id)}
			>
				{filter.label}
			</button>
		{/each}
	</div>

	<div class="scroll-thin min-h-0 flex-1 overflow-y-auto py-1">
		{#if workspace.loading}
			<div class="flex items-center justify-center gap-1.5 py-8 text-xs text-faint">
				<Spinner />
				读取会话
			</div>
		{:else if workspace.filteredSessions.length === 0}
			<EmptyState
				title={workspace.sessions.length === 0 ? '还没有会话' : '没有匹配的会话'}
				description={workspace.sessions.length === 0 ? '在中间输入第一条指令即可创建。' : undefined}
				compact
			>
				{#snippet icon()}
					<Icon name="message" size={17} />
				{/snippet}
			</EmptyState>
		{:else}
			{#each workspace.filteredSessions as session (session.id)}
				{@const visual = SESSION_STATUS[session.status]}
				{#if editing?.sessionId === session.id}
					<div
						class="flex w-full items-center gap-2 border-l-2 border-line-accent bg-surface-selected px-2 py-2"
					>
						<Input
							type="text"
							bind:value={editing.value}
							element={editInput}
							placeholder="会话标题"
							class="w-full"
							onkeydown={onRenameKeydown}
						/>
					</div>
				{:else}
					<button
						type="button"
						class={cx(
							'flex w-full items-start gap-2 border-l-2 px-2 py-2 text-left',
							'transition-colors hover:bg-surface-hover',
							workspace.selectedSessionId === session.id
								? 'border-line-accent bg-surface-selected'
								: 'border-transparent'
						)}
						aria-current={workspace.selectedSessionId === session.id ? 'true' : undefined}
						onclick={() => void workspace.select(session.id)}
						oncontextmenu={(event) =>
							openSessionMenu(event, session.id, session.status === 'closed')}
					>
						<span class="min-w-0 flex-1">
							{#if workspace.isTitleSyncing(session.id)}
								<span class="flex items-center gap-1.5 text-xs text-faint">
									<Spinner size="sm" label="正在生成标题" />
									<span class="truncate">正在生成标题…</span>
								</span>
							{:else}
								<span class="block truncate text-xs text-strong"
									>{session.title ?? '未命名会话'}</span
								>
							{/if}
							<span class="mt-0.5 flex min-w-0 items-center gap-1.5 text-2xs text-faint">
								<span class="truncate font-mono">{session.adapterId}</span>
								<span aria-hidden="true">·</span>
								<span class="shrink-0">{relativeTime(session.updatedAt)}</span>
							</span>
						</span>
						<Badge dotClass={visual.dot} pulse={isLiveStatus(session.status)}>{visual.label}</Badge>
					</button>
				{/if}
			{/each}
		{/if}
	</div>
</div>

{#if menu}
	<ContextMenu x={menu.x} y={menu.y} items={sessionMenuItems} onclose={() => (menu = undefined)} />
{/if}
