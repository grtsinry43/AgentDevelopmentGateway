<script lang="ts">
	import EmptyState from '$lib/ui/common/EmptyState.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
</script>

<EmptyState title="端口（待接入）" description="开发服务与转发端口。" compact>
	{#snippet icon()}
		<Icon name="server" size={16} />
	{/snippet}
</EmptyState>
