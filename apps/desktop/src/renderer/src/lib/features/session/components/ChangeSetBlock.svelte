<script lang="ts">
	import type { ConversationChangeSet } from '../projection';
	import DiffViewer from './DiffViewer.svelte';

	interface Props {
		item: ConversationChangeSet;
	}

	let { item }: Props = $props();
	const additions = $derived(
		item.changeSet.files.reduce((total, file) => total + file.additions, 0)
	);
	const deletions = $derived(
		item.changeSet.files.reduce((total, file) => total + file.deletions, 0)
	);
</script>

<details class="group my-1 text-xs">
	<summary
		class="flex h-7 cursor-pointer list-none items-center gap-1.5 rounded-default px-1.5 text-muted marker:hidden hover:bg-surface-hover"
	>
		<span class="text-2xs text-faint transition-transform group-open:rotate-90" aria-hidden="true"
			>▶</span
		>
		<span>变更了 {item.changeSet.files.length} 个文件</span>
		<span class="font-mono text-2xs text-status-completed">+{additions}</span>
		<span class="font-mono text-2xs text-status-error">−{deletions}</span>
	</summary>
	<div class="mt-1 ml-6">
		<DiffViewer changeSet={item.changeSet} />
	</div>
</details>
