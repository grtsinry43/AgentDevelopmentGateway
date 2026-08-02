<script lang="ts">
	import { layout, PANEL_DRAG_MIME } from '$lib/features/workspace/layout.svelte';
	import { cx } from '$lib/shared/utils/cx';

	let hoverRegion = $state<'top' | 'bottom' | null>(null);

	function hasPanelPayload(event: DragEvent): boolean {
		return event.dataTransfer?.types.includes(PANEL_DRAG_MIME) ?? false;
	}

	function onDragOver(event: DragEvent): void {
		if (!hasPanelPayload(event) && !layout.panelDragActive) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
		const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
		const mid = bounds.top + bounds.height / 2;
		hoverRegion = event.clientY < mid ? 'top' : 'bottom';
	}

	function onDragLeave(event: DragEvent): void {
		const related = event.relatedTarget as Node | null;
		if (related && (event.currentTarget as HTMLElement).contains(related)) return;
		hoverRegion = null;
	}

	function onDrop(event: DragEvent): void {
		event.preventDefault();
		const type = event.dataTransfer?.getData(PANEL_DRAG_MIME);
		const region = hoverRegion ?? 'bottom';
		hoverRegion = null;
		layout.endPanelDrag();
		if (!type) return;
		layout.splitPanel(type, region);
	}
</script>

<div
	class={cx(
		'absolute inset-0 z-10',
		layout.panelDragActive ? 'pointer-events-auto' : 'pointer-events-none'
	)}
	ondragover={onDragOver}
	ondragleave={onDragLeave}
	ondrop={onDrop}
	role="presentation"
>
	{#if layout.panelDragActive}
		<div class="absolute inset-0 flex flex-col">
			<div
				class={cx(
					'min-h-0 flex-1 border-b border-dashed transition-colors',
					hoverRegion === 'top'
						? 'border-jade-500/50 bg-jade-500/14'
						: 'border-transparent bg-surface-base/30'
				)}
			></div>
			<div
				class={cx(
					'min-h-0 flex-1 transition-colors',
					hoverRegion === 'bottom'
						? 'bg-jade-500/14 ring-1 ring-inset ring-jade-500/40'
						: 'bg-surface-base/30'
				)}
			></div>
		</div>
	{/if}
</div>
