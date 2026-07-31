<script lang="ts">
	import EmptyState from '$lib/ui/common/EmptyState.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
</script>

<EmptyState title="终端（待接入）" description="PTY 会话接入后可在此执行命令。" compact>
	{#snippet icon()}
		<Icon name="terminal" size={16} />
	{/snippet}
</EmptyState>
