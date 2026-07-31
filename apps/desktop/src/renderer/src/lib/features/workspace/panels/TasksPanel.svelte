<script lang="ts">
	import EmptyState from '$lib/ui/common/EmptyState.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
</script>

<EmptyState title="任务列表（待接入）" description="Agent 的 todo 与 plan 会显示在这里。" compact>
	{#snippet icon()}
		<Icon name="list" size={16} />
	{/snippet}
</EmptyState>
