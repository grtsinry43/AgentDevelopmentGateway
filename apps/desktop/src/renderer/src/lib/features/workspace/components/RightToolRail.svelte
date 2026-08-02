<script lang="ts">
	import type { PanelDefinition } from '$lib/shared/registry/panels';
	import { layout, PANEL_DRAG_MIME } from '$lib/features/workspace/layout.svelte';
	import { cx } from '$lib/shared/utils/cx';
	import Icon from '$lib/ui/icons/Icon.svelte';

	interface Props {
		panels: PanelDefinition[];
	}

	let { panels }: Props = $props();

	function onDragStart(event: DragEvent, type: string): void {
		if (!event.dataTransfer) return;
		event.dataTransfer.setData(PANEL_DRAG_MIME, type);
		event.dataTransfer.setData('text/plain', type);
		event.dataTransfer.effectAllowed = 'copyMove';
		layout.beginPanelDrag();
	}

	function onDragEnd(): void {
		layout.endPanelDrag();
	}
</script>

<svelte:window ondragend={onDragEnd} />

<aside
	class="flex h-full w-9 shrink-0 flex-col items-center gap-0.5 border-l border-subtle bg-surface-panel py-1"
	aria-label="右侧工具"
>
	{#each panels as panel (panel.type)}
		{@const active = layout.isPanelActive(panel.type)}
		{@const open = layout.isPanelOpen(panel.type)}
		<button
			type="button"
			class={cx(
				'flex size-7 items-center justify-center rounded-default transition-colors',
				active
					? 'bg-jade-500/16 text-accent'
					: open
						? 'bg-jade-500/10 text-accent'
						: 'text-muted hover:bg-surface-hover hover:text-normal'
			)}
			title={panel.title}
			aria-label={panel.title}
			aria-pressed={active}
			draggable="true"
			ondragstart={(event) => onDragStart(event, panel.type)}
			ondragend={onDragEnd}
			onclick={() => layout.activatePanel(panel.type)}
		>
			<Icon name={panel.icon} size={14} />
		</button>
	{/each}
</aside>
