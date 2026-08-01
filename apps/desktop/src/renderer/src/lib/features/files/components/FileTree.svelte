<script lang="ts">
	import { createVirtualizer, type SvelteVirtualizer } from '@tanstack/svelte-virtual';
	import { normalizeProps, useMachine } from '@zag-js/svelte';
	import * as tree from '@zag-js/tree-view';
	import type { Unsubscriber } from 'svelte/store';
	import FileTreeRow from '$lib/features/files/components/FileTreeRow.svelte';
	import { FileTreeWorkspace, type FileTreeNode } from '$lib/features/files/file-tree.svelte';
	import { notifications } from '$lib/shared/notifications/notifications.svelte';
	import EmptyState from '$lib/ui/common/EmptyState.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import Spinner from '$lib/ui/primitives/Spinner.svelte';

	interface Props {
		projectKey: string;
	}

	let { projectKey }: Props = $props();
	const workspace = $derived(new FileTreeWorkspace(projectKey));
	let scrollElement = $state<HTMLDivElement>();
	let virtualizerInstance: SvelteVirtualizer<HTMLDivElement, HTMLDivElement> | undefined;
	let stopVirtualizer: Unsubscriber | undefined;

	const collection = $derived(
		tree.collection<FileTreeNode>({
			rootNode: workspace.rootNode,
			nodeToValue: (node) => node.path,
			nodeToString: (node) => node.name,
			nodeToChildren: (node) => node.children ?? [],
			nodeToChildrenCount: (node) =>
				node.kind === 'directory' ? (node.children?.length ?? 0) : undefined
		})
	);

	const service = useMachine(tree.machine as tree.Machine<FileTreeNode>, () => ({
		id: `workspace-files-${projectKey}`,
		collection,
		selectionMode: 'single' as const,
		translations: { treeLabel: '工程文件' },
		loadChildren: ({ node, signal }) => workspace.loadChildren(node, signal),
		onExpandedChange: (details) => void workspace.setExpanded(details.expandedNodes),
		onSelectionChange: (details) => workspace.select(details.selectedNodes[0]?.path),
		onLoadChildrenError: (details) => {
			workspace.error = details.nodes[0]?.error.message ?? '目录加载失败';
		},
		scrollToIndexFn: ({ index }) => virtualizerInstance?.scrollToIndex(index, { align: 'auto' })
	}));
	const api = $derived(tree.connect(service, normalizeProps));
	const visibleNodes = $derived(api.getVisibleNodes());

	const virtualizerStore = createVirtualizer<HTMLDivElement, HTMLDivElement>({
		count: 0,
		getScrollElement: () => scrollElement ?? null,
		estimateSize: () => 22,
		overscan: 8
	});

	$effect(() => workspace.start());

	$effect(() => {
		stopVirtualizer = virtualizerStore.subscribe((instance) => {
			virtualizerInstance = instance;
		});
		return () => stopVirtualizer?.();
	});

	$effect(() => {
		const count = visibleNodes.length;
		virtualizerInstance?.setOptions({
			count,
			getScrollElement: () => scrollElement ?? null,
			getItemKey: (index) => visibleNodes[index]?.node.path ?? index
		});
	});

	$effect(() => {
		const detail = workspace.streamMessage;
		if (detail) {
			notifications.notify({
				key: `files-stream:${projectKey}`,
				severity: workspace.streamState === 'error' ? 'error' : 'warning',
				title: '文件树同步异常',
				summary: '正在后台重新连接文件事件流',
				detail
			});
		} else if (workspace.streamState === 'connected' || workspace.streamState === 'closed') {
			notifications.resolve(`files-stream:${projectKey}`);
		}
	});
</script>

{#if workspace.status === 'loading'}
	<div class="grid min-h-24 flex-1 place-items-center text-faint">
		<Spinner label="加载文件树" />
	</div>
{:else if workspace.status === 'unavailable'}
	<EmptyState
		title="文件服务不可用"
		description="当前 Gateway Server 未提供文件枚举与监听能力。"
		compact
	/>
{:else if workspace.status === 'error'}
	<EmptyState title="文件树加载失败" description={workspace.error ?? '无法读取工程目录。'} compact>
		{#snippet action()}
			<Button size="sm" variant="ghost" onclick={() => void workspace.retry()}>重试</Button>
		{/snippet}
	</EmptyState>
{:else}
	<section {...api.getRootProps()} class="flex min-h-0 flex-1 flex-col">
		<div class="flex h-6 shrink-0 items-center gap-2 border-b border-subtle px-2">
			<span class="mr-auto text-2xs tracking-wide text-faint uppercase">Explorer</span>
			{#if workspace.streamState === 'connecting' || workspace.streamState === 'retrying'}
				<Spinner size="sm" label="同步文件变化" class="text-amber-500" />
			{/if}
			<Button
				size="sm"
				variant="ghost"
				class="h-5 px-1.5 text-2xs"
				onclick={() => void workspace.refresh()}
			>
				刷新
			</Button>
		</div>

		{#if workspace.error}
			<div
				class="flex shrink-0 items-center gap-2 border-b border-cinnabar-500/20 px-2 py-1 text-2xs text-cinnabar-500"
			>
				<span class="min-w-0 flex-1 truncate" title={workspace.error}>{workspace.error}</span>
				<button type="button" class="hover:text-strong" onclick={() => void workspace.refresh()}
					>重试</button
				>
			</div>
		{/if}

		<div bind:this={scrollElement} class="scroll-thin min-h-0 flex-1 overflow-auto">
			{#if visibleNodes.length === 0}
				<div class="grid h-20 place-items-center text-2xs text-faint">目录为空</div>
			{/if}
			<div
				{...api.getTreeProps()}
				class="relative min-w-max outline-none"
				style:height={`${$virtualizerStore.getTotalSize()}px`}
			>
				{#each $virtualizerStore.getVirtualItems() as virtualRow (visibleNodes[virtualRow.index]?.node.path)}
					{@const visible = visibleNodes[virtualRow.index]}
					{#if visible}
						<div
							role="presentation"
							class="absolute top-0 left-0 w-full"
							style:height={`${virtualRow.size}px`}
							style:transform={`translateY(${virtualRow.start}px)`}
						>
							<FileTreeRow {service} {visible} />
						</div>
					{/if}
				{/each}
			</div>
		</div>
	</section>
{/if}
