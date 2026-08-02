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
import type { HostProfile } from '$contract/hosts';
import {
	createProjectFromDraft,
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

	/** 「最近工程」区只放本地工程;远程工程按 host 分组放远程区。 */
	readonly localProjects = $derived(
		this.filtered.filter((project) => project.hostType === 'local')
	);
	readonly remoteProjects = $derived(this.filtered.filter((project) => project.hostType === 'ssh'));

	readonly selected = $derived<RecentProject | undefined>(this.localProjects[this.cursor]);

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
			const index = this.localProjects.findIndex((item) => item.key === previousKey);
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
		const count = this.localProjects.length;
		if (count === 0) return;
		this.cursor = Math.min(count - 1, Math.max(0, this.cursor + delta));
	}

	setCursor(index: number): void {
		this.cursor = index;
		this.clampCursor();
	}

	/** 操作类错误(打开工程/连接失败/删除失败等)。弹窗展示,不占列表区。 */
	actionError = $state<string | undefined>(undefined);

	dismissActionError(): void {
		this.actionError = undefined;
	}

	/**
	 * 包一层:统一 busy 标记与错误呈现,避免每个动作重复 try/catch。
	 * 动作失败进 actionError(弹窗),不写 this.error —— 列表区的 error 只属于首屏读取。
	 */
	async #run(action: () => Promise<void>): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			await action();
		} catch (cause) {
			this.actionError = cause instanceof Error ? cause.message : String(cause);
		} finally {
			this.busy = false;
		}
	}

	openSelected(): Promise<void> {
		const project = this.selected;
		if (!project) return Promise.resolve();
		return this.#run(() => this.#open(project.key, project.name));
	}

	/** 正在打开的工程(远程项目连接/provision 期间显示提示层)。 */
	openingProject = $state<string | undefined>(undefined);

	async #open(key: string, name: string | undefined): Promise<void> {
		this.openingProject = name;
		try {
			await openProject(key);
		} finally {
			this.openingProject = undefined;
		}
	}

	create(draft: ProjectDraft): Promise<void> {
		return this.#run(async () => {
			// ssh + 新主机时会先保存主机,再 provision(探测/上传/启动/隧道),最后建工程。
			const created = await createProjectFromDraft(draft);
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
		const count = this.localProjects.length;
		this.cursor = count === 0 ? 0 : Math.min(this.cursor, count - 1);
	}

	// ── 右键上下文菜单 ────────────────────────────────────────────────

	context = $state.raw<
		| { x: number; y: number; kind: 'project'; project: RecentProject }
		| { x: number; y: number; kind: 'remote-project'; project: RecentProject }
		| { x: number; y: number; kind: 'host'; host: HostProfile }
		| undefined
	>(undefined);

	openProjectMenu(event: MouseEvent, project: RecentProject, remote = false): void {
		event.preventDefault();
		this.context = {
			x: event.clientX,
			y: event.clientY,
			kind: remote ? 'remote-project' : 'project',
			project
		};
	}

	openHostMenu(event: MouseEvent, host: HostProfile): void {
		event.preventDefault();
		this.context = { x: event.clientX, y: event.clientY, kind: 'host', host };
	}

	closeContextMenu(): void {
		this.context = undefined;
	}

	/** 打开任意工程(远程区点项目也用这个)。 */
	openProject(key: string): Promise<void> {
		return this.#run(async () => {
			const project = this.projects.find((entry) => entry.key === key);
			await this.#open(key, project?.name);
		});
	}

	/** 删除任意工程。 */
	removeProject(key: string): Promise<void> {
		return this.#run(() => removeProject(key));
	}

	/** 置顶/取消置顶任意工程。 */
	togglePinProject(key: string): Promise<void> {
		return this.#run(() => togglePinProject(key));
	}
}

export const launcher = new LauncherStore();
