<script lang="ts">
	/**
	 * 抖色圆角格阵 —— 环境装饰。
	 *
	 * 参考 cradle-app 的 `DitheredGradientDecoration`(canvas-art.tsx),用 Svelte 5 重写。
	 * 关键取舍(与 cradle 一致的部分,都是有理由的):
	 *
	 *   - **canvas 而非 DOM**:上千个格子用 div 会造出上千个布局节点,滚动与 blur
	 *     会立刻掉帧。canvas 一次性绘制,且鼠标光晕只需重绘不需回流。
	 *   - **位置稳定的抖色**:格子的明暗由 `(col,row)` 的确定性哈希决定,而不是
	 *     `Math.random()`。否则窗口一 resize 整片图案就会重新洗牌,像故障。
	 *   - **底部渐隐**:用 `destination-out` 合成擦掉底部,让格阵融进内容区,
	 *     而不是硬生生截断。
	 *   - **不可见就不画**:IntersectionObserver + visibilitychange,窗口切后台
	 *     就停手 —— 装饰不该在用户看不见的时候烧 CPU。
	 *
	 * 纯装饰,`pointer-events-none` + `aria-hidden`。
	 */
	import { cx } from '$lib/shared/utils/cx';
	import { theme } from '$lib/shared/theme/theme.svelte';

	interface Props {
		/**
		 * 行数。给定时画布高度固定为 `rows * (cellSize + gap)`;
		 * 省略则铺满父容器高度(父容器需要有确定高度,比如 `absolute inset-0`)。
		 */
		rows?: number;
		cellSize?: number;
		gap?: number;
		/** 格子圆角。这是「圆角矩形格」观感的来源。 */
		radius?: number;
		/** 鼠标光晕半径(px)。0 表示不响应鼠标。 */
		glowRadius?: number;
		/** 可见格子占比 0-1。越低越稀疏。 */
		density?: number;
		/** 底部渐隐。外层已用 mask 收边时应关掉,免得叠两层衰减。 */
		fadeBottom?: boolean;
		/** 从 window 而非 canvas 取鼠标位置 —— 格阵在底层且被内容盖住时需要。 */
		trackGlobal?: boolean;
		/** 关闭后停止重绘(比如窗口失焦)。 */
		active?: boolean;
		/** 色调。accent 会带上主色的色度。 */
		tone?: 'neutral' | 'accent';
		class?: string;
	}

	let {
		rows,
		cellSize = 10,
		gap = 3,
		radius = 2.5,
		glowRadius = 130,
		density = 0.45,
		fadeBottom = true,
		trackGlobal = false,
		active = true,
		tone = 'neutral',
		class: className
	}: Props = $props();

	const step = $derived(cellSize + gap);
	/** 固定高度模式下的 CSS 高度;自适应模式为 undefined(由父容器决定)。 */
	const fixedHeight = $derived(rows === undefined ? undefined : rows * step);

	/** 明度阶梯。索引 0 = 不绘制。 */
	const LIGHTNESS = {
		light: [0, 0.9, 0.82, 0.72, 0.62],
		dark: [0, 0.22, 0.3, 0.4, 0.52]
	} as const;

	interface Cell {
		x: number;
		y: number;
		cx: number;
		cy: number;
		light: number;
		dark: number;
	}

	/**
	 * 确定性哈希。同样的 (col,row) 永远得到同样的值 —— 这是「resize 不洗牌」的关键。
	 * 经典的 sin-fract 技巧,够随机且无需存种子表。
	 */
	function hash(col: number, row: number): number {
		const value = Math.sin(col * 127.1 + row * 311.7) * 43758.5453;
		return value - Math.floor(value);
	}

	function buildCells(cols: number, rowCount: number): Cell[] {
		const out: Cell[] = [];
		const levels = LIGHTNESS.light.length - 1;

		for (let row = 0; row < rowCount; row += 1) {
			for (let col = 0; col < cols; col += 1) {
				const roll = hash(col, row);
				if (roll > density) continue;

				// 在可见的格子里再分明度档位,制造抖色质感而不是均匀一片
				const level = 1 + Math.floor((roll / density) * levels * 0.999);
				const x = col * step;
				const y = row * step;

				out.push({
					x,
					y,
					cx: x + cellSize / 2,
					cy: y + cellSize / 2,
					light: LIGHTNESS.light[level] ?? 0,
					dark: LIGHTNESS.dark[level] ?? 0
				});
			}
		}
		return out;
	}

	function fill(lightness: number): string {
		// oklch:明度与色度解耦,光晕过渡不会串色。accent 带一点主色色度。
		return tone === 'accent'
			? `oklch(${lightness.toFixed(3)} 0.06 180)`
			: `oklch(${lightness.toFixed(3)} 0 0)`;
	}

	/**
	 * attachment 内部的重绘触发器。canvas 的像素不是响应式的,主题切换时必须显式
	 * 重画一次 —— 把 schedule 提出来给下面的 `$effect` 用,比往元素上 dispatch
	 * 假事件干净。
	 */
	let requestRepaint: (() => void) | null = null;

	/**
	 * 绘制与生命周期。用 `{@attach}` 而不是 `$effect` + bind:this —— attachment 的
	 * 生命周期直接绑在元素上,元素换了自动重建,不用手动比对。
	 */
	function paint(node: HTMLCanvasElement) {
		const ctx = node.getContext('2d');
		if (!ctx) return;

		let cells: Cell[] = [];
		let cols = 0;
		let rowCount = 0;
		let width = 0;
		let height = 0;
		let visible = true;
		let frame = 0;
		const mouse = { x: -9999, y: -9999 };

		const render = (): void => {
			frame = 0;
			const dpr = window.devicePixelRatio || 1;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, width, height);

			const isDark = theme.resolved === 'dark';
			const hasMouse = mouse.x > -9998 && glowRadius > 0;
			const glowSq = glowRadius * glowRadius;

			for (const cell of cells) {
				let lightness = isDark ? cell.dark : cell.light;

				if (hasMouse) {
					const dx = mouse.x - cell.cx;
					const dy = mouse.y - cell.cy;
					const distSq = dx * dx + dy * dy;
					if (distSq < glowSq) {
						// 1.5 次幂让光晕边缘更柔和,线性衰减看起来像个硬边圆盘
						const glow = Math.max(0, 1 - Math.sqrt(distSq) / glowRadius) ** 1.5;
						lightness = isDark
							? Math.min(0.95, lightness + glow * 0.33)
							: Math.max(0.05, lightness - glow * 0.3);
					}
				}

				ctx.fillStyle = fill(lightness);
				ctx.beginPath();
				ctx.roundRect(cell.x, cell.y, cellSize, cellSize, radius);
				ctx.fill();
			}

			if (fadeBottom) {
				// destination-out:用渐变擦除已绘制内容,底部彻底透明
				const gradient = ctx.createLinearGradient(0, 0, 0, height);
				gradient.addColorStop(0, 'rgba(0,0,0,0)');
				gradient.addColorStop(0.35, 'rgba(0,0,0,0)');
				gradient.addColorStop(1, 'rgba(0,0,0,1)');
				ctx.globalCompositeOperation = 'destination-out';
				ctx.fillStyle = gradient;
				ctx.fillRect(0, 0, width, height);
				ctx.globalCompositeOperation = 'source-over';
			}
		};

		const schedule = (): void => {
			if (!visible || !active || frame) return;
			frame = requestAnimationFrame(render);
		};

		const resize = (): void => {
			const dpr = window.devicePixelRatio || 1;
			width = node.clientWidth;
			// 自适应模式下高度来自父容器;固定模式下由 rows 决定
			height = fixedHeight ?? node.clientHeight;
			if (width === 0 || height === 0) return;

			node.width = Math.round(width * dpr);
			node.height = Math.round(height * dpr);

			const nextCols = Math.ceil(width / step) + 1;
			const nextRows = Math.ceil(height / step) + 1;
			// 行列数没变就复用已建好的格子 —— 重建要重跑上千次 hash
			if (nextCols !== cols || nextRows !== rowCount) {
				cols = nextCols;
				rowCount = nextRows;
				cells = buildCells(nextCols, nextRows);
			}
			schedule();
		};

		const onMouseMove = (event: MouseEvent): void => {
			const rect = node.getBoundingClientRect();
			mouse.x = event.clientX - rect.left;
			mouse.y = event.clientY - rect.top;
			schedule();
		};

		const onMouseLeave = (): void => {
			mouse.x = -9999;
			mouse.y = -9999;
			schedule();
		};

		const observer = new ResizeObserver(resize);
		observer.observe(node);

		// 不可见就别画。装饰在用户看不见时烧 CPU 是纯粹的浪费。
		const intersection = new IntersectionObserver((entries) => {
			visible = entries[0]?.isIntersecting ?? true;
			schedule();
		});
		intersection.observe(node);

		const onVisibility = (): void => {
			visible = document.visibilityState === 'visible';
			schedule();
		};
		document.addEventListener('visibilitychange', onVisibility);

		if (glowRadius > 0) {
			if (trackGlobal) {
				window.addEventListener('mousemove', onMouseMove);
				window.addEventListener('mouseleave', onMouseLeave);
			} else {
				node.addEventListener('mousemove', onMouseMove);
				node.addEventListener('mouseleave', onMouseLeave);
			}
		}

		resize();
		requestRepaint = schedule;

		return () => {
			requestRepaint = null;
			cancelAnimationFrame(frame);
			observer.disconnect();
			intersection.disconnect();
			document.removeEventListener('visibilitychange', onVisibility);
			if (glowRadius > 0) {
				if (trackGlobal) {
					window.removeEventListener('mousemove', onMouseMove);
					window.removeEventListener('mouseleave', onMouseLeave);
				} else {
					node.removeEventListener('mousemove', onMouseMove);
					node.removeEventListener('mouseleave', onMouseLeave);
				}
			}
		};
	}

	// 主题切换 / active 变化要重绘 —— canvas 像素不参与 Svelte 的响应式更新。
	$effect(() => {
		void theme.resolved;
		void active;
		requestRepaint?.();
	});
</script>

<!--
	自适应模式(未传 rows)靠 h-full 撑满父容器,父容器必须有确定高度
	(比如 `absolute inset-0`)。固定模式用 rows 算出的像素高度。
-->
<canvas
	{@attach paint}
	aria-hidden="true"
	class={cx(
		'pointer-events-none block w-full select-none',
		fixedHeight === undefined && 'h-full',
		className
	)}
	style:height={fixedHeight === undefined ? undefined : `${fixedHeight}px`}
></canvas>
