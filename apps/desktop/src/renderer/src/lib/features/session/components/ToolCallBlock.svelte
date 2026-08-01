<script lang="ts">
	import type { ConversationToolCall } from '../projection';
	import FileToolCallBlock from './FileToolCallBlock.svelte';
	import McpToolCallBlock from './McpToolCallBlock.svelte';
	import SemanticToolCallBlock from './SemanticToolCallBlock.svelte';
	import TerminalToolCallBlock from './TerminalToolCallBlock.svelte';

	interface Props {
		item: ConversationToolCall;
	}
	let { item }: Props = $props();
	const fileTool = $derived(
		item.toolCall.kind === 'file-edit' ||
			item.toolCall.kind === 'file-diff' ||
			item.toolCall.kind === 'notebook-edit'
	);
</script>

{#if fileTool}
	<FileToolCallBlock {item} />
{:else if item.toolCall.kind === 'terminal'}
	<TerminalToolCallBlock {item} />
{:else if item.toolCall.kind === 'mcp'}
	<McpToolCallBlock {item} />
{:else}
	<SemanticToolCallBlock {item} />
{/if}
