/**
 * Launcher 的状态容器。
 *
 * 为什么用 class + `$state` 而不是 svatoms 的 `createModelDataContext`:
 * grtblog 用 svatoms 是因为 SvelteKit 的 `+page.server.ts load` 产出一份页面数据,
 * 需要往下分发并配 `equals` 收窄订阅。这里数据来自 IPC、只有一个视图、字段都是标量,
 * 拆成 class 字段本身就是最细粒度的订阅,再套一层 selector 是纯开销。
 *
 * svatoms 留给下一阶段的会话树投影 —— 那里才真正需要 selector + equals
 * (需求 §14.4:block 级更新不得触发会话树重算)。
 *
 * ── 数据流向 ──
 * 写操作(新建/删除/置顶)**不消费返回值**,一律等主进程的 `projects.changed` 推送。
 * 单一到达路径避免了「返回值和推送打架时闪一下旧值」,也让多窗口天然一致
 * (在工程窗口里改了,Launcher 立刻跟上)。
 */

import { pushBus } from '$lib/shared/bridge/events';
import {
	addProject,
	draftToInput,
	listRecentProjects,
	openProject,
	removeProject,
	togglePinProject
} from './api';
import type { ProjectDraft, RecentProject } from './types';

class LauncherStore {
	/** 最近工程。排序由主进程负责(置顶优先 + 最近打开),这里不再排。 */
	projects = $state.raw<RecentProject[]>([]);
	query = $state('');
	/** 选中项在**过滤后**列表里的下标。 */
	cursor = $state(0);
	loading = $state(true);
	error = $state<string | undefined>(undefined);
	/** 有写操作在飞行中。用于禁用重复触发,而不是转圈遮住整个列表。 */
	busy = $state(false);

	/** 过滤后的列表。名称与路径都参与匹配 —— 用户可能记得路径而不记得名字。 */
	readonly filtered = $derived.by(() => {
		const needle = this.query.trim().toLowerCase();
		if (!needle) return this.projects;
		return this.projects.filter(
			(project) =>
				project.name.toLowerCase().includes(needle) ||
				project.path.toLowerCase().includes(needle) ||
				project.hostId.toLowerCase().includes(needle)
		);
	});

	readonly selected = $derived<RecentProject | undefined>(this.filtered[this.cursor]);

	/** 首屏加载。异步,不阻塞渲染 —— UI 先出骨架,数据到了再填。 */
	async load(): Promise<void> {
		this.loading = true;
		this.error = undefined;
		try {
			this.#applyProjects(await listRecentProjects());
		} catch (cause) {
			this.error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			this.loading = false;
		}
	}

	/**
	 * 订阅主进程的列表变更推送。在窗口根组件的 `$effect` 里调用,返回退订函数。
	 * 有了它,任何窗口改了工程列表,这里都会自动跟上,无需轮询。
	 */
	watch(): () => void {
		return pushBus.on('projects.changed', (event) => {
			this.#applyProjects(event.projects);
		});
	}

	/**
	 * 应用新列表,并把光标跟到原来选中的那个工程上(而不是停在旧下标)。
	 * 置顶会改变排序,删除会改变长度 —— 按 key 找回比按下标可靠。
	 *
	 * 注意读写顺序:`selected` 派生自 `projects`,所以必须**先**取旧 key 再赋新值。
	 * (这个函数只在 IPC 回调里跑,不在 `$effect` 里,所以读+写不会自我失效。)
	 */
	#applyProjects(next: RecentProject[]): void {
		const previousKey = this.selected?.key;
		this.projects = next;

		if (previousKey) {
			const index = this.filtered.findIndex((item) => item.key === previousKey);
			if (index >= 0) {
				this.cursor = index;
				return;
			}
		}
		this.clampCursor();
	}

	setQuery(value: string): void {
		this.query = value;
		// 过滤后列表变短,光标可能越界 —— 重置到首项而不是保留一个不存在的下标
		this.cursor = 0;
	}

	/** 移动光标。到边界就停,不循环 —— 循环在长列表里会让人失去位置感。 */
	moveCursor(delta: number): void {
		const count = this.filtered.length;
		if (count === 0) return;
		this.cursor = Math.min(count - 1, Math.max(0, this.cursor + delta));
	}

	setCursor(index: number): void {
		this.cursor = index;
		this.clampCursor();
	}

	/** 包一层:统一 busy 标记与错误呈现,避免每个动作重复 try/catch。 */
	async #run(action: () => Promise<void>): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.error = undefined;
		try {
			await action();
		} catch (cause) {
			this.error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			this.busy = false;
		}
	}

	openSelected(): Promise<void> {
		const project = this.selected;
		if (!project) return Promise.resolve();
		return this.#run(() => openProject(project.key));
	}

	create(draft: ProjectDraft): Promise<void> {
		return this.#run(async () => {
			const created = await addProject(draftToInput(draft));
			// 直接打开,不让用户再点一次 —— 新建的意图就是要进去
			await openProject(created.key);
		});
	}

	removeSelected(): Promise<void> {
		const project = this.selected;
		if (!project) return Promise.resolve();
		// 不在本地删:等 projects.changed 推送。单一数据路径。
		return this.#run(() => removeProject(project.key));
	}

	togglePinSelected(): Promise<void> {
		const project = this.selected;
		if (!project) return Promise.resolve();
		return this.#run(() => togglePinProject(project.key));
	}

	/** 过滤/删除后光标可能越界,收敛到有效范围。 */
	clampCursor(): void {
		const count = this.filtered.length;
		this.cursor = count === 0 ? 0 : Math.min(this.cursor, count - 1);
	}
}

export const launcher = new LauncherStore();
