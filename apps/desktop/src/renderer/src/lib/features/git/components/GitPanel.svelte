<script lang="ts">
	import { GitWorkspace } from '$lib/features/git/git-workspace.svelte';
	import { notifications } from '$lib/shared/notifications/notifications.svelte';
	import EmptyState from '$lib/ui/common/EmptyState.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import Spinner from '$lib/ui/primitives/Spinner.svelte';
	import GitChangeGroup from './GitChangeGroup.svelte';

	interface Props {
		workspace: GitWorkspace;
	}

	let { workspace }: Props = $props();
	const projectKey = $derived(workspace.projectKey);
	let commitMessage = $state('');

	const conflicts = $derived(
		workspace.state?.changes.filter((change) => change.area === 'conflict') ?? []
	);
	const staged = $derived(
		workspace.state?.changes.filter((change) => change.area === 'staged') ?? []
	);
	const working = $derived(
		workspace.state?.changes.filter(
			(change) => change.area === 'unstaged' || change.area === 'untracked'
		) ?? []
	);
	const changeCount = $derived(workspace.state?.changes.length ?? 0);
	const canCommit = $derived(
		staged.length > 0 && commitMessage.trim().length > 0 && workspace.activeOperation === undefined
	);

	$effect(() => {
		const detail = workspace.streamMessage;
		if (detail) {
			notifications.notify({
				key: `git-stream:${projectKey}`,
				severity: workspace.streamState === 'error' ? 'error' : 'warning',
				title: 'Git 状态同步异常',
				summary: '正在后台重新连接 Git 事件流',
				detail
			});
		} else if (workspace.streamState === 'connected' || workspace.streamState === 'closed') {
			notifications.resolve(`git-stream:${projectKey}`);
		}
	});

	$effect(() => {
		const detail = workspace.error;
		if (!detail) return;
		notifications.notify({
			severity: 'error',
			title: 'Git 操作失败',
			summary: detail.split(/\r?\n/, 1)[0] ?? 'Git 操作未完成',
			detail
		});
	});

	async function commit(): Promise<void> {
		if (!canCommit) return;
		const result = await workspace.commit(commitMessage);
		if (result) commitMessage = '';
	}

	function handleCommitKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return;
		event.preventDefault();
		void commit();
	}
</script>

{#if workspace.status === 'loading' || workspace.status === 'idle'}
	<div class="grid min-h-24 flex-1 place-items-center text-faint">
		<Spinner label="读取 Git 状态" />
	</div>
{:else if workspace.status === 'unavailable'}
	<EmptyState
		title="Git 不可用"
		description={workspace.unavailableMessage ?? '当前工程不是 Git 仓库。'}
		compact
	/>
{:else if workspace.status === 'error' || !workspace.state}
	<EmptyState
		title="Git 状态加载失败"
		description={workspace.error ?? '无法读取仓库状态。'}
		compact
	>
		{#snippet action()}
			<Button size="sm" variant="ghost" onclick={() => void workspace.retry()}>重试</Button>
		{/snippet}
	</EmptyState>
{:else}
	<section class="flex min-h-0 flex-1 flex-col overflow-hidden">
		<header class="flex h-7 shrink-0 items-center gap-1.5 border-b border-subtle px-2">
			<span class="text-accent">⌘</span>
			<code class="min-w-0 flex-1 truncate font-mono text-2xs text-normal">
				{workspace.state.branch.name ?? workspace.state.branch.oid?.slice(0, 8) ?? 'HEAD'}
			</code>
			{#if workspace.state.branch.upstream}
				<span
					class="max-w-20 truncate text-[9px] text-faint"
					title={workspace.state.branch.upstream}
				>
					{workspace.state.branch.upstream}
				</span>
			{/if}
			{#if workspace.state.branch.ahead > 0}
				<span class="font-mono text-[9px] text-status-completed"
					>↑{workspace.state.branch.ahead}</span
				>
			{/if}
			{#if workspace.state.branch.behind > 0}
				<span class="font-mono text-[9px] text-status-waiting"
					>↓{workspace.state.branch.behind}</span
				>
			{/if}
			{#if workspace.streamState === 'connecting' || workspace.streamState === 'retrying'}
				<Spinner size="sm" label="同步 Git 状态" class="text-status-waiting" />
			{/if}
			<button
				type="button"
				class="rounded-default px-1 text-2xs text-muted hover:bg-surface-hover hover:text-strong"
				title="刷新 Git 状态"
				onclick={() => void workspace.refresh()}
			>
				↻
			</button>
		</header>

		<div class="shrink-0 border-b border-subtle p-2">
			<textarea
				bind:value={commitMessage}
				rows="2"
				maxlength="100000"
				placeholder={staged.length > 0 ? '提交消息  ⌘Enter' : '请先暂存更改'}
				class="scroll-thin block max-h-28 min-h-12 w-full resize-y rounded-default border border-line bg-surface-base px-2 py-1.5 text-xs text-normal outline-none placeholder:text-faint focus:border-line-accent"
				disabled={workspace.activeOperation !== undefined}
				onkeydown={handleCommitKeydown}></textarea>
			<div class="mt-1.5 flex items-center gap-2">
				<span class="min-w-0 flex-1 truncate text-[9px] text-faint">
					{staged.length} staged · {changeCount} changes
				</span>
				<Button
					size="sm"
					variant="primary"
					class="h-5 px-2 text-2xs"
					disabled={!canCommit}
					loading={workspace.activeOperation === 'commit'}
					onclick={() => void commit()}
				>
					提交
				</Button>
			</div>
		</div>

		<div class="scroll-thin min-h-0 flex-1 overflow-auto">
			{#if changeCount === 0}
				<div class="grid h-24 place-items-center text-2xs text-faint">工作树干净</div>
			{:else}
				<GitChangeGroup title="合并冲突" changes={conflicts} {workspace} />
				<GitChangeGroup title="已暂存的更改" changes={staged} {workspace} />
				<GitChangeGroup title="更改" changes={working} {workspace} />
			{/if}
		</div>
	</section>
{/if}
