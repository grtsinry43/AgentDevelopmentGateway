<script lang="ts">
	/**
	 * 透视地平面 —— 环境装饰。
	 *
	 * 右下角一块克制的 HUD 线框地板:消失点在上沿,径向线 + 深度线展开。
	 * 鼠标带来轻微视差与近处微亮。无格子填充、无粒子。
	 *
	 * 性能:
	 *   - canvas;线数量封顶
	 *   - 目标约 30fps;静止时只靠极慢呼吸触发重绘
	 *   - 不可见 / 后台停画
	 *
	 * 纯装饰,`pointer-events-none` + `aria-hidden`。
	 */
	import { cx } from '$lib/shared/utils/cx';
	import { theme } from '$lib/shared/theme/theme.svelte';

	interface Props {
		/** 径向线数量(扇形展开)。 */
		radials?: number;
		/** 深度横线数量。 */
		depths?: number;
		/** 鼠标光标影响半径(px)。0 关闭交互提亮。 */
		glowRadius?: number;
		/** 视差最大偏移(px)。 */
		parallax?: number;
		/** 关闭后停止重绘。 */
		active?: boolean;
		class?: string;
	}

	let {
		radials = 12,
		depths = 10,
		glowRadius = 120,
		parallax = 10,
		active = true,
		class: className
	}: Props = $props();

	const FRAME_MS = 1000 / 30;

	let kick: (() => void) | null = null;

	function paint(node: HTMLCanvasElement) {
		const ctx = node.getContext('2d');
		if (!ctx) return;

		let width = 0;
		let height = 0;
		let visible = true;
		let frame = 0;
		let lastTs = 0;
		let accum = 0;
		const mouse = { x: -9999, y: -9999, has: false };

		const stroke = (alpha: number): string => {
			const a = Math.max(0, Math.min(1, alpha)).toFixed(3);
			const isDark = theme.resolved === 'dark';
			// 暗色略亮、亮色略深 —— 线才能压在 vibrancy 上被看见,又不抢内容
			const lightness = isDark ? 0.82 : 0.28;
			return `oklch(${lightness.toFixed(3)} 0 0 / ${a})`;
		};

		const distPointToSegment = (
			px: number,
			py: number,
			x1: number,
			y1: number,
			x2: number,
			y2: number
		): number => {
			const dx = x2 - x1;
			const dy = y2 - y1;
			const lenSq = dx * dx + dy * dy;
			if (lenSq < 1e-6) return Math.hypot(px - x1, py - y1);
			let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
			t = Math.max(0, Math.min(1, t));
			return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
		};

		const lineAlpha = (
			x1: number,
			y1: number,
			x2: number,
			y2: number,
			base: number,
			breath: number
		): number => {
			let alpha = base * breath;
			if (mouse.has && glowRadius > 0) {
				const d = distPointToSegment(mouse.x, mouse.y, x1, y1, x2, y2);
				if (d < glowRadius) {
					const glow = (1 - d / glowRadius) ** 1.4;
					alpha = Math.min(0.75, alpha + glow * 0.42);
				}
			}
			return alpha;
		};

		const drawLine = (
			x1: number,
			y1: number,
			x2: number,
			y2: number,
			base: number,
			breath: number
		): void => {
			const alpha = lineAlpha(x1, y1, x2, y2, base, breath);
			if (alpha < 0.02) return;
			ctx.strokeStyle = stroke(alpha);
			ctx.beginPath();
			ctx.moveTo(x1, y1);
			ctx.lineTo(x2, y2);
			ctx.stroke();
		};

		const draw = (now: number): void => {
			const dpr = window.devicePixelRatio || 1;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, width, height);
			ctx.lineWidth = 1;
			ctx.lineCap = 'round';

			// 极慢呼吸:整场透明度轻微起伏,不动鼠标时也有一点「活着」
			const breath = 0.92 + 0.08 * Math.sin(now * 0.0007);

			const nx = mouse.has ? (mouse.x / width) * 2 - 1 : 0;
			const ny = mouse.has ? (mouse.y / height) * 2 - 1 : 0;
			const vx = width * 0.38 + nx * parallax;
			const vy = height * 0.06 + ny * parallax * 0.55;

			const leftBottom = width * -0.08;
			const rightBottom = width * 1.12;
			const bottomY = height * 1.02;

			// 径向线:从消失点扇向底边
			for (let i = 0; i <= radials; i += 1) {
				const t = i / radials;
				const xBottom = leftBottom + (rightBottom - leftBottom) * t;
				// 越靠扇形边缘越淡;中间略实
				const edge = Math.abs(t - 0.5) * 2;
				const base = 0.1 + (1 - edge) * 0.08;
				drawLine(vx, vy, xBottom, bottomY, base, breath);
			}

			// 深度横线:近处(底)间距大、远处(上)更密 —— 透视压缩
			for (let i = 1; i <= depths; i += 1) {
				const t = i / (depths + 1);
				const depth = Math.pow(t, 1.55);
				const y = vy + (bottomY - vy) * (0.12 + 0.88 * depth);
				const u = (y - vy) / (bottomY - vy);
				const x1 = vx + (leftBottom - vx) * u;
				const x2 = vx + (rightBottom - vx) * u;
				// 近处略实、远处更淡
				const base = 0.06 + depth * 0.12;
				drawLine(x1, y, x2, y, base, breath);
			}

			// 地平细线:给消失点一条锚
			drawLine(vx - width * 0.22, vy, vx + width * 0.34, vy, 0.05, breath);
		};

		const tick = (ts: number): void => {
			frame = 0;
			if (!visible || !active || width === 0 || height === 0) return;

			if (lastTs === 0) lastTs = ts;
			const rawDt = Math.min(0.05, (ts - lastTs) / 1000);
			lastTs = ts;
			accum += rawDt * 1000;

			// 极慢呼吸需要持续低帧刷新;看不见时整条 rAF 已停
			if (accum >= FRAME_MS) {
				accum = 0;
				draw(ts);
			}

			frame = requestAnimationFrame(tick);
		};

		const start = (): void => {
			if (!visible || !active || frame) return;
			lastTs = 0;
			accum = FRAME_MS;
			frame = requestAnimationFrame(tick);
		};

		const stop = (): void => {
			if (frame) cancelAnimationFrame(frame);
			frame = 0;
			lastTs = 0;
			accum = 0;
		};

		const resize = (): void => {
			const dpr = window.devicePixelRatio || 1;
			width = node.clientWidth;
			height = node.clientHeight;
			if (width === 0 || height === 0) return;
			node.width = Math.round(width * dpr);
			node.height = Math.round(height * dpr);
			start();
		};

		const onMouseMove = (event: MouseEvent): void => {
			const rect = node.getBoundingClientRect();
			mouse.x = event.clientX - rect.left;
			mouse.y = event.clientY - rect.top;
			mouse.has = true;
		};

		const onMouseLeave = (): void => {
			mouse.x = -9999;
			mouse.y = -9999;
			mouse.has = false;
		};

		const observer = new ResizeObserver(resize);
		observer.observe(node);

		const intersection = new IntersectionObserver((entries) => {
			visible = entries[0]?.isIntersecting ?? true;
			if (visible) start();
			else stop();
		});
		intersection.observe(node);

		const onVisibility = (): void => {
			visible = document.visibilityState === 'visible';
			if (visible) start();
			else stop();
		};
		document.addEventListener('visibilitychange', onVisibility);

		// 装饰在内容下层,必须跟 window 才能拿到光标
		window.addEventListener('mousemove', onMouseMove);
		window.addEventListener('mouseleave', onMouseLeave);

		resize();
		kick = () => {
			if (visible && active) start();
			else stop();
		};

		return () => {
			kick = null;
			stop();
			observer.disconnect();
			intersection.disconnect();
			document.removeEventListener('visibilitychange', onVisibility);
			window.removeEventListener('mousemove', onMouseMove);
			window.removeEventListener('mouseleave', onMouseLeave);
		};
	}

	$effect(() => {
		void theme.resolved;
		void active;
		kick?.();
	});
</script>

<canvas
	{@attach paint}
	aria-hidden="true"
	class={cx('pointer-events-none block h-full w-full select-none', className)}
></canvas>
