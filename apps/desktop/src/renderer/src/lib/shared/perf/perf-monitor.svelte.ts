/**
 * 渲染层性能监视器(dev 打点工具)。
 *
 * 采样:每 1s 一次 —— FPS(rAF 计数)、长任务(PerformanceObserver longtask)、
 * DOM 节点数、JS 堆内存。环形缓冲保留最近 ~120 个样本,暴露实时值 + min/avg/max。
 * 用 `⌥⌘P`(project 窗口)开关;只在前端 dev 有意义,生产不挂。
 */
export interface PerfSample {
	t: number;
	fps: number;
	longTasks: number;
	longestTaskMs: number;
	domNodes: number;
	heapMB: number;
}

const RING_CAPACITY = 120;

function heapMB(): number {
	const memory = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
	return Math.round((memory?.usedJSHeapSize ?? 0) / 1048576);
}

class PerfMonitor {
	enabled = $state(false);
	fps = $state(0);
	longTasks = $state(0);
	longestTaskMs = $state(0);
	domNodes = $state(0);
	heapMB = $state(0);
	samples = $state.raw<PerfSample[]>([]);

	#frameCount = 0;
	#longTaskCount = 0;
	#maxLongTaskMs = 0;
	#lastSampleAt = 0;
	#rafId = 0;
	#interval: ReturnType<typeof setInterval> | undefined;
	#observer: PerformanceObserver | undefined;

	/** 累计统计(自启动以来的会话值)。 */
	readonly sessionMaxFps = $derived(
		this.samples.length ? Math.max(...this.samples.map((s) => s.fps)) : 0
	);
	readonly sessionMinFps = $derived(
		this.samples.length ? Math.min(...this.samples.map((s) => s.fps)) : 0
	);
	readonly sessionAvgFps = $derived(
		this.samples.length
			? Math.round(this.samples.reduce((sum, s) => sum + s.fps, 0) / this.samples.length)
			: 0
	);

	toggle(): void {
		console.log('[perf] toggle →', this.enabled ? 'stop' : 'start');
		if (this.enabled) this.stop();
		else this.start();
	}

	start(): void {
		if (this.enabled) return;
		this.enabled = true;
		this.samples = [];
		this.#frameCount = 0;
		this.#longTaskCount = 0;
		this.#maxLongTaskMs = 0;
		this.#lastSampleAt = performance.now();

		this.#observer = new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				this.#longTaskCount += 1;
				if (entry.duration > this.#maxLongTaskMs) this.#maxLongTaskMs = entry.duration;
			}
		});
		this.#observer.observe({ entryTypes: ['longtask'] });

		const frameLoop = (): void => {
			this.#frameCount += 1;
			this.#rafId = requestAnimationFrame(frameLoop);
		};
		this.#rafId = requestAnimationFrame(frameLoop);

		this.#interval = setInterval(() => {
			const now = performance.now();
			const elapsedSec = Math.max((now - this.#lastSampleAt) / 1000, 0.001);
			const sample: PerfSample = {
				t: now,
				fps: Math.round(this.#frameCount / elapsedSec),
				longTasks: this.#longTaskCount,
				longestTaskMs: Math.round(this.#maxLongTaskMs),
				domNodes: document.getElementsByTagName('*').length,
				heapMB: heapMB()
			};
			this.fps = sample.fps;
			this.longTasks = sample.longTasks;
			this.longestTaskMs = sample.longestTaskMs;
			this.domNodes = sample.domNodes;
			this.heapMB = sample.heapMB;
			this.samples = [...this.samples.slice(-(RING_CAPACITY - 1)), sample];
			this.#frameCount = 0;
			this.#longTaskCount = 0;
			this.#maxLongTaskMs = 0;
			this.#lastSampleAt = now;
		}, 1000);
	}

	stop(): void {
		if (!this.enabled) return;
		this.enabled = false;
		cancelAnimationFrame(this.#rafId);
		if (this.#interval) clearInterval(this.#interval);
		this.#observer?.disconnect();
		this.#observer = undefined;
	}
}

export const perfMonitor = new PerfMonitor();
