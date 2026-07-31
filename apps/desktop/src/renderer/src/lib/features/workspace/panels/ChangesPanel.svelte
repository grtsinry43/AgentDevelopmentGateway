<script lang="ts">
	import EmptyState from '$lib/ui/common/EmptyState.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
</script>

<EmptyState title="变更（待接入）" description="本轮修改的文件与 diff。" compact>
	{#snippet icon()}
		<Icon name="file-text" size={16} />
	{/snippet}
</EmptyState>
