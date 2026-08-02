<script lang="ts">
	/**
	 * 渲染热点高亮(自实现)。独立 MutationObserver 观察 body 全子树,
	 * 在变更元素上画一道项目色的描边 + 重渲染计数。
	 *
	 * 性能约束:
	 *  - 每个变更元素 O(1) 记账(map 查 + 时间戳),不做 DOM 写
	 *  - rAF 批量定位/淡出,同时最多 MAX 个,超出的按 FIFO 淘汰
	 *  - overlay 自身的一切改动都忽略(contains 判断),避免自触发级联
	 *  - 只在开启时挂载,关闭即 disconnect + 清理
	 */
	import { onMount } from 'svelte';

	const MAX = 10;
	const TTL_MS = 1200;
	const MARKER = 'perf-scan';

	interface HighlightData {
		box: HTMLDivElement;
		badge: HTMLSpanElement;
		since: number;
		count: number;
		/** 变更原因统计(类型/属性名 → 次数),展示在角标上。 */
		reasons: Record<string, number>;
	}

	onMount(() => {
		const overlay = document.createElement('div');
		overlay.className = MARKER;
		Object.assign(overlay.style, {
			position: 'fixed',
			inset: '0',
			pointerEvents: 'none',
			zIndex: '1000000000',
			overflow: 'hidden'
		});
		document.body.appendChild(overlay);

		// 非响应式内部跟踪表(元素 → 高亮数据):只做 O(1) 记账,不进模板,不该用 SvelteMap。
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const highlights = new Map<Element, HighlightData>();
		let frame = 0;

		function schedule(): void {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(layout);
		}

		function layout(): void {
			const now = performance.now();
			for (const [el, h] of [...highlights]) {
				const rect = el.getBoundingClientRect();
				const age = now - h.since;
				if (rect.width === 0 || rect.height === 0 || age > TTL_MS) {
					h.box.remove();
					highlights.delete(el);
					continue;
				}
				Object.assign(h.box.style, {
					top: `${rect.top}px`,
					left: `${rect.left}px`,
					width: `${rect.width}px`,
					height: `${rect.height}px`,
					opacity: String(Math.max(0.15, 1 - age / TTL_MS))
				});
				const reasons = Object.entries(h.reasons)
					.map(([key, n]) => `${key} (${n})`)
					.join(' ');
				h.badge.textContent = `x${h.count} | ${reasons}`;
			}
			if (highlights.size > 0) schedule();
		}

		const observer = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				const el =
					mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
				if (!el || overlay.contains(el)) continue;
				const reason =
					mutation.type === 'attributes'
						? mutation.attributeName
							? `attribute ${mutation.attributeName}`
							: 'attribute changed'
						: mutation.type === 'childList'
							? 'children changed'
							: 'text changed';
				let h = highlights.get(el);
				if (!h) {
					if (highlights.size >= MAX) {
						const first = highlights.entries().next().value;
						if (first) {
							first[1].box.remove();
							highlights.delete(first[0]);
						}
					}
					const box = document.createElement('div');
					box.className = `${MARKER}__box`;
					const badge = document.createElement('span');
					badge.className = `${MARKER}__badge`;
					box.appendChild(badge);
					overlay.appendChild(box);
					h = { box, badge, since: performance.now(), count: 1, reasons: { [reason]: 1 } };
					highlights.set(el, h);
				} else {
					h.since = performance.now();
					h.count += 1;
					h.reasons[reason] = (h.reasons[reason] ?? 0) + 1;
				}
			}
			schedule();
		});
		observer.observe(document.body, {
			subtree: true,
			childList: true,
			attributes: true,
			characterData: true
		});

		return () => {
			observer.disconnect();
			overlay.remove();
			cancelAnimationFrame(frame);
			highlights.clear();
		};
	});
</script>
