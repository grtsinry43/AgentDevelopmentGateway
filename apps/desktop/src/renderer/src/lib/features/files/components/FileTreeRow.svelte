<script lang="ts">
	import { normalizeProps } from '@zag-js/svelte';
	import * as tree from '@zag-js/tree-view';
	import type { FileTreeNode } from '$lib/features/files/file-tree.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import Spinner from '$lib/ui/primitives/Spinner.svelte';

	interface Props {
		service: tree.Service<FileTreeNode>;
		visible: tree.VisibleNode<FileTreeNode>;
	}

	let { service, visible }: Props = $props();
	const api = $derived(tree.connect(service, normalizeProps));
	const state = $derived(api.getNodeState(visible));
	const depth = $derived(Math.max(0, visible.indexPath.length - 1));
</script>

{#if visible.node.kind === 'directory'}
	<div {...api.getBranchProps(visible)} class="file-row-shell">
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
		style:padding-left={`${21 + depth * 12}px`}
		title={visible.node.path}
	>
		<Icon name={visible.node.kind === 'symlink' ? 'link' : 'file-text'} size={12} />
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
</style>
