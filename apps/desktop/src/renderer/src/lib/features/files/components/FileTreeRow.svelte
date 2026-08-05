<script lang="ts">
	import { normalizeProps } from '@zag-js/svelte';
	import * as tree from '@zag-js/tree-view';
	import type { FileTreeNode } from '$lib/features/files/file-tree.svelte';
	import { fileIconKindForName } from '$lib/features/files/file-icons';
	import FileIcon from '$lib/ui/icons/FileIcon.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import Spinner from '$lib/ui/primitives/Spinner.svelte';

	interface Props {
		service: tree.Service<FileTreeNode>;
		visible: tree.VisibleNode<FileTreeNode>;
		/** 拖拽是否允许(依赖写能力)。 */
		draggableEnabled?: boolean;
		/** 当前被拖拽的节点路径(用于高亮目标)。 */
		draggedPath?: string;
		/** 当前光标悬停的合法目录路径(用于高亮)。 */
		dropTargetPath?: string;
		oncontextmenu?: (event: MouseEvent, node: FileTreeNode) => void;
		onopen?: (node: FileTreeNode) => void;
		ondragstart?: (event: DragEvent, node: FileTreeNode) => void;
		ondragend?: (event: DragEvent, node: FileTreeNode) => void;
		ondragover?: (event: DragEvent, node: FileTreeNode) => void;
		ondrop?: (event: DragEvent, node: FileTreeNode) => void;
	}

	let {
		service,
		visible,
		draggableEnabled = false,
		draggedPath,
		dropTargetPath,
		oncontextmenu,
		onopen,
		ondragstart,
		ondragend,
		ondragover,
		ondrop
	}: Props = $props();

	const api = $derived(tree.connect(service, normalizeProps));
	const state = $derived(api.getNodeState(visible));
	const depth = $derived(Math.max(0, visible.indexPath.length - 1));
	const isDragged = $derived(draggedPath === visible.node.path);

	const isDropTarget = $derived(
		visible.node.kind === 'directory' &&
			dropTargetPath === visible.node.path &&
			!!draggedPath &&
			!isDragged &&
			draggedPath !== undefined &&
			!draggedPath.startsWith(`${visible.node.path}/`)
	);

	const draggable = $derived(draggableEnabled ? 'true' : undefined);
	const fileKind = $derived(fileIconKindForName(visible.node.name));
</script>

{#if visible.node.kind === 'directory'}
	<div
		{...api.getBranchProps(visible)}
		class="file-row-shell"
		data-tree-path={visible.node.path}
		{draggable}
		oncontextmenu={(event) => oncontextmenu?.(event, visible.node)}
		ondragstart={(event) => draggableEnabled && ondragstart?.(event, visible.node)}
		ondragend={(event) => draggableEnabled && ondragend?.(event, visible.node)}
		ondragover={(event) => {
			if (!draggableEnabled) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
			ondragover?.(event, visible.node);
		}}
		ondrop={(event) => {
			if (!draggableEnabled) return;
			event.preventDefault();
			ondrop?.(event, visible.node);
		}}
		class:drop-target={isDropTarget}
	>
		<div
			{...api.getBranchControlProps(visible)}
			class={['file-row', { generated: visible.node.generated }]}
			style:padding-left={`${6 + depth * 12}px`}
			title={visible.node.path}
		>
			<span {...api.getBranchIndicatorProps(visible)} class="grid h-3 w-3 place-items-center">
				{#if state.loading}
					<Spinner size="sm" label="加载目录" />
				{:else}
					<Icon name={state.expanded ? 'chevron-down' : 'chevron-right'} size={10} />
				{/if}
			</span>
			<Icon name="folder" size={12} />
			<span {...api.getBranchTextProps(visible)} class="min-w-0 truncate">{visible.node.name}</span>
		</div>
	</div>
{:else}
	<div
		{...api.getItemProps(visible)}
		class="file-row"
		class:drop-target={isDropTarget}
		style:padding-left={`${21 + depth * 12}px`}
		title={visible.node.path}
		data-tree-path={visible.node.path}
		{draggable}
		oncontextmenu={(event) => oncontextmenu?.(event, visible.node)}
		ondragstart={(event) => draggableEnabled && ondragstart?.(event, visible.node)}
		ondragend={(event) => draggableEnabled && ondragend?.(event, visible.node)}
		ondblclick={() => onopen?.(visible.node)}
		onkeydown={(event) => {
			if (event.key === 'Enter') onopen?.(visible.node);
		}}
	>
		{#if visible.node.kind === 'symlink'}
			<Icon name="link" size={12} />
		{:else}
			<FileIcon kind={fileKind} size={12} class="shrink-0" />
		{/if}
		<span {...api.getItemTextProps(visible)} class="min-w-0 truncate">{visible.node.name}</span>
	</div>
{/if}

<style>
	.file-row-shell {
		height: 22px;
	}

	.file-row {
		display: flex;
		height: 22px;
		min-width: 0;
		align-items: center;
		gap: 4px;
		padding-right: 6px;
		color: var(--text-normal);
		font-size: 11px;
		line-height: 22px;
		outline: none;
		user-select: none;
	}

	.file-row:hover,
	.file-row[data-focus] {
		background: var(--surface-hover);
	}

	.file-row[data-selected] {
		background: var(--surface-selected);
		color: var(--text-strong);
	}

	.file-row:focus-visible {
		box-shadow: inset 2px 0 var(--focus-ring);
	}

	.file-row.generated {
		color: color-mix(in srgb, var(--color-amber-500) 68%, var(--text-faint));
		opacity: 0.72;
	}

	.file-row-shell.drop-target .file-row,
	.file-row.drop-target {
		background: var(--surface-active);
		box-shadow: inset 0 0 0 1px var(--line-accent);
	}

	.file-row[data-selected].drop-target {
		background: color-mix(in srgb, var(--surface-active) 70%, var(--surface-selected));
	}

	.file-row[draggable='true'] {
		cursor: grab;
	}
</style>
