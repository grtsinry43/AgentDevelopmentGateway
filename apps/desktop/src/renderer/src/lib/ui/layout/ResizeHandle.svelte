<script lang="ts">
	/**
	 * 可拖拽的分隔条。
	 *
	 * 有两种消费方式,所以回调给的是**位移**而不是绝对尺寸:
	 *   - 侧栏:自己把 delta 累加到宽度上(带 min/max 钳制)
	 *   - dock 内部:把 delta 换算成相邻两面板的权重再分配
	 * 让分隔条去理解「尺寸」会逼它知道太多上下文。
	 *
	 * 拖动期间由调用方更新视觉状态;持久化应在调用方防抖,或只在 `onCommit` 中执行,
	 * 避免一次拖动写盘几十次。
	 */
	import { cx } from '$lib/shared/utils/cx';

	interface Props {
		/** vertical = 竖直的条,左右拖(调宽度);horizontal = 横条,上下拖(调高度)。 */
		orientation?: 'vertical' | 'horizontal';
		/** 每次移动的位移(px)。相对**上一次回调**,不是相对起点。 */
		onDrag: (deltaPx: number) => void;
		/** 松手时触发。持久化在这里做。 */
		onCommit?: () => void;
		/** 键盘调整的步长(px)。 */
		step?: number;
		label?: string;
		class?: string;
	}

	let {
		orientation = 'vertical',
		onDrag,
		onCommit,
		step = 8,
		label,
		class: className
	}: Props = $props();

	let dragging = $state(false);

	function startDrag(event: PointerEvent): void {
		event.preventDefault();
		// 捕获指针:移出条外、甚至移出窗口也能继续跟随
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);

		let last = orientation === 'vertical' ? event.clientX : event.clientY;
		dragging = true;

		const onMove = (move: PointerEvent): void => {
			const current = orientation === 'vertical' ? move.clientX : move.clientY;
			const delta = current - last;
			if (delta === 0) return;
			last = current;
			onDrag(delta);
		};

		const onUp = (): void => {
			dragging = false;
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			window.removeEventListener('pointercancel', onUp);
			onCommit?.();
		};

		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
		window.addEventListener('pointercancel', onUp);
	}

	/** 键盘也能调整 —— 键盘优先的应用里拖拽不该是唯一入口。 */
	function onKeydown(event: KeyboardEvent): void {
		const decrease = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
		const increase = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
		const amount = event.shiftKey ? step * 5 : step;

		let delta: number | undefined;
		if (event.key === decrease) delta = -amount;
		else if (event.key === increase) delta = amount;
		if (delta === undefined) return;

		event.preventDefault();
		onDrag(delta);
		onCommit?.();
	}
</script>

<!--
	视觉 1px,命中区 5px(靠里面的绝对定位伪元素扩大)—— 1px 的目标鼠标抓不准。

	使用可聚焦的 `separator` 语义(WAI-ARIA window splitter 模式),方向键可调。
-->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (The ARIA window splitter pattern requires a focusable separator with pointer and keyboard interaction.) -->
<div
	role="separator"
	tabindex="0"
	aria-orientation={orientation}
	aria-label={label ?? (orientation === 'vertical' ? '调整宽度' : '调整高度')}
	class={cx(
		'relative shrink-0 transition-colors duration-150',
		orientation === 'vertical' ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize',
		dragging ? 'bg-line-accent' : 'bg-subtle hover:bg-line-accent',
		className
	)}
	onpointerdown={startDrag}
	onkeydown={onKeydown}
>
	<span
		class={cx(
			'absolute',
			orientation === 'vertical' ? '-inset-x-[2px] inset-y-0' : 'inset-x-0 -inset-y-[2px]'
		)}
		aria-hidden="true"
	></span>
</div>
