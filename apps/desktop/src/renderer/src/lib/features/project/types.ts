/**
 * project feature 的类型。
 *
 * 跨进程的领域类型定义在 `$contract/project`(main/preload/renderer 三方共享)。
 * 这里只放渲染层自己的视图类型,并把 contract 类型再导出一遍,
 * 让 feature 内部只需从一处 import。
 */

import type { RecentProject } from '$contract/project';

export type { ContextProfile, HostType, NewProjectInput, RecentProject } from '$contract/project';

/** Launcher 的页面模型。svatoms context 承载的就是这个。 */
export interface LauncherModel {
	projects: RecentProject[];
	/** 过滤关键字。 */
	query: string;
	/** 键盘选中项在**过滤后**列表中的下标。 */
	cursor: number;
	loading: boolean;
	error?: string;
}

/** 新建工程表单的草稿状态。 */
export interface ProjectDraft {
	hostType: 'local' | 'ssh';
	/** local 固定为 'local';ssh 是用户填的 host 别名(对应 ~/.ssh/config 的 Host)。 */
	hostId: string;
	path: string;
	name: string;
}
