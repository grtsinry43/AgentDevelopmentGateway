<script lang="ts">
	/**
	 * 克制版字符雨 —— 环境装饰。
	 *
	 * 结构仿经典 Matrix 数字雨(列内字符、头亮尾变、块级刷新),
	 * 视觉压到中性灰 + 低存在感,避免霓虹绿或「水珠淌屏」。
	 *
	 * 性能:canvas、约 30fps、不可见停画;只维护活跃列的短缓冲。
	 * 纯装饰,`pointer-events-none` + `aria-hidden`。
	 */
	import { cx } from '$lib/shared/utils/cx';
	import { theme } from '$lib/shared/theme/theme.svelte';

	interface Props {
		rows?: number;
		/** 列宽/字号基准(px)。 */
		cellSize?: number;
		gap?: number;
		/** 兼容旧调用,字符雨忽略圆角。 */
		radius?: number;
		/** 活跃列占比 0-1。 */
		density?: number;
		trailMin?: number;
		trailMax?: number;
		fadeBottom?: boolean;
		active?: boolean;
		tone?: 'neutral' | 'accent';
		class?: string;
	}

	let {
		rows,
		cellSize = 11,
		gap = 2,
		density = 0.35,
		trailMin = 10,
		trailMax = 18,
		fadeBottom = true,
		active = true,
		tone = 'neutral',
		class: className
	}: Props = $props();

	const step = $derived(cellSize + gap);
	const fixedHeight = $derived(rows === undefined ? undefined : rows * step);
	const FRAME_MS = 1000 / 30;

	// 拉丁字母 + 数字 + 少量符号(不用片假名/CJK,避免和 UI 中文抢字形气质)
	const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz0123456789:.=*+<>/\\|';

	const TONE_DARK = [0, 0.2, 0.32, 0.46, 0.7] as const;
	const TONE_LIGHT = [0, 0.8, 0.64, 0.5, 0.34] as const;
	const TONE_ALPHA = [0, 0.38, 0.52, 0.68, 0.88] as const;

	interface Drop {
		col: number;
		headRow: number;
		speed: number;
		/** 每格字符。 */
		glyphs: string[];
		/** 每格明度档 0–4;0 = 空隙。 */
		tones: number[];
		mutateIn: number;
	}

	function hash(col: number, salt: number): number {
		const value = Math.sin(col * 127.1 + salt * 311.7) * 43758.5453;
		return value - Math.floor(value);
	}

	function pickGlyph(col: number, salt: number): string {
		const idx = Math.floor(hash(col, salt) * GLYPHS.length) % GLYPHS.length;
		return GLYPHS[idx] ?? '0';
	}

	function rollTone(col: number, salt: number, forHead: boolean): number {
		const r = hash(col, salt);
		if (forHead) return 4;
		if (r < 0.1) return 0;
		if (r < 0.38) return 1;
		if (r < 0.7) return 2;
		return 3;
	}

	function fill(lightness: number, alpha: number): string {
		const a = Math.max(0, Math.min(1, alpha)).toFixed(3);
		return tone === 'accent'
			? `oklch(${lightness.toFixed(3)} 0.05 180 / ${a})`
			: `oklch(${lightness.toFixed(3)} 0 0 / ${a})`;
	}

	let kick: (() => void) | null = null;

	function paint(node: HTMLCanvasElement) {
		const ctx = node.getContext('2d');
		if (!ctx) return;

		let drops: Drop[] = [];
		let cols = 0;
		let width = 0;
		let height = 0;
		let visible = true;
		let frame = 0;
		let lastTs = 0;
		let accum = 0;
		let tickSalt = 0;

		const seedDrop = (col: number, atTop: boolean): Drop => {
			const h1 = hash(col, 1);
			const h2 = hash(col, 2);
			const h3 = hash(col, 3);
			const span = Math.max(0, trailMax - trailMin);
			const trailLen = trailMin + Math.floor(h1 * (span + 0.999));
			const glyphs: string[] = [];
			const tones: number[] = [];
			for (let i = 0; i < trailLen; i += 1) {
				glyphs.push(pickGlyph(col, 20 + i * 31 + Math.floor(h2 * 50)));
				tones.push(rollTone(col, 40 + i * 17, i === 0));
			}
			const rowsVisible = Math.max(1, Math.ceil(height / step));
			return {
				col,
				headRow: atTop ? -trailLen * (0.25 + h2 * 0.6) : h2 * rowsVisible,
				speed: 1.4 + h3 * 2.2,
				glyphs,
				tones,
				mutateIn: 0.12 + h1 * 0.3
			};
		};

		const rebuildDrops = (nextCols: number): void => {
			const next: Drop[] = [];
			for (let col = 0; col < nextCols; col += 1) {
				if (hash(col, 0) > density) continue;
				next.push(seedDrop(col, false));
			}
			drops = next;
		};

		const advanceHead = (drop: Drop): void => {
			drop.glyphs.pop();
			drop.tones.pop();
			drop.glyphs.unshift(pickGlyph(drop.col, tickSalt + drop.col * 7));
			drop.tones.unshift(4);
			if (drop.tones.length > 2) {
				const idx = 1 + Math.floor(hash(drop.col, tickSalt) * (drop.tones.length - 2));
				drop.tones[idx] = rollTone(drop.col, tickSalt + idx * 13, false);
				drop.glyphs[idx] = pickGlyph(drop.col, tickSalt + idx * 29);
			}
		};

		const mutateTrail = (drop: Drop): void => {
			if (drop.glyphs.length < 2) return;
			const count = 1 + (hash(drop.col, tickSalt) > 0.55 ? 1 : 0);
			for (let n = 0; n < count; n += 1) {
				const idx = 1 + Math.floor(hash(drop.col, tickSalt + n * 41) * (drop.glyphs.length - 1));
				drop.glyphs[idx] = pickGlyph(drop.col, tickSalt + idx * 19 + n);
				drop.tones[idx] = rollTone(drop.col, tickSalt + idx * 23 + n, false);
			}
		};

		const draw = (dt: number): void => {
			tickSalt = (tickSalt + 1) % 10_000;
			const dpr = window.devicePixelRatio || 1;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, width, height);
			ctx.font = `${cellSize}px "Victor Mono", ui-monospace, monospace`;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';

			const isDark = theme.resolved === 'dark';
			const levels = isDark ? TONE_DARK : TONE_LIGHT;
			const rowsVisible = Math.max(1, Math.ceil(height / step));

			for (const drop of drops) {
				const before = Math.floor(drop.headRow);
				drop.headRow += drop.speed * dt;
				const after = Math.floor(drop.headRow);
				for (let row = before; row < after; row += 1) advanceHead(drop);

				drop.mutateIn -= dt;
				if (drop.mutateIn <= 0) {
					mutateTrail(drop);
					drop.mutateIn = 0.14 + hash(drop.col, tickSalt) * 0.35;
				}

				const headCell = Math.floor(drop.headRow);
				const x = drop.col * step + cellSize / 2;

				for (let i = 0; i < drop.tones.length; i += 1) {
					const tier = drop.tones[i] ?? 0;
					if (tier <= 0) continue;
					const y = (headCell - i) * step + cellSize / 2;
					if (y < -cellSize || y > height + cellSize) continue;

					ctx.fillStyle = fill(levels[tier] ?? 0.4, TONE_ALPHA[tier] ?? 0.4);
					ctx.fillText(drop.glyphs[i] ?? '0', x, y);
				}

				if (headCell - drop.tones.length > rowsVisible + 1) {
					const reset = seedDrop(drop.col, true);
					drop.headRow = reset.headRow;
					drop.speed = reset.speed;
					drop.glyphs = reset.glyphs;
					drop.tones = reset.tones;
					drop.mutateIn = reset.mutateIn;
				}
			}

			if (fadeBottom) {
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

		const tick = (ts: number): void => {
			frame = 0;
			if (!visible || !active || width === 0 || height === 0) return;

			if (lastTs === 0) lastTs = ts;
			const rawDt = Math.min(0.05, (ts - lastTs) / 1000);
			lastTs = ts;
			accum += rawDt * 1000;

			if (accum >= FRAME_MS) {
				const dt = Math.min(0.05, accum / 1000);
				accum = 0;
				draw(dt);
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
			height = fixedHeight ?? node.clientHeight;
			if (width === 0 || height === 0) return;

			node.width = Math.round(width * dpr);
			node.height = Math.round(height * dpr);

			const nextCols = Math.ceil(width / step) + 1;
			if (nextCols !== cols) {
				cols = nextCols;
				rebuildDrops(nextCols);
			}
			start();
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
	class={cx(
		'pointer-events-none block w-full select-none',
		fixedHeight === undefined && 'h-full',
		className
	)}
	style:height={fixedHeight === undefined ? undefined : `${fixedHeight}px`}
></canvas>
