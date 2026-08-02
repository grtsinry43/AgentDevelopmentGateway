/**
 * project feature 的类型。
 *
 * 跨进程的领域类型定义在 `$contract/project` 与 `$contract/hosts`(main/preload/renderer
 * 三方共享)。这里只放渲染层自己的视图类型,并把 contract 类型再导出一遍,
 * 让 feature 内部只需从一处 import。
 */

import type { RecentProject } from '$contract/project';

export type { ContextProfile, HostType, NewProjectInput, RecentProject } from '$contract/project';
export type { HostProfile, HostProfileInput, RemoteProvisionStage } from '$contract/hosts';

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

/** 新建/编辑 SSH 主机的表单草稿。 */
export interface HostDraft {
	/** 展示名;留空时自动用 username@hostname。 */
	name: string;
	username: string;
	/** IP 或域名。 */
	hostname: string;
	/** 字符串输入,提交时转 number(默认 22)。 */
	port: string;
	auth: 'key' | 'password';
	keyPath: string;
	password: string;
	rememberPassword: boolean;
}

/** 新建工程表单的草稿状态。 */
export interface ProjectDraft {
	hostType: 'local' | 'ssh';
	/**
	 * ssh 时:'new' 表示用 host 草稿新建主机;否则是已保存 HostProfile 的 id。
	 * local 时为空串。
	 */
	hostProfileId: string;
	host: HostDraft;
	path: string;
	name: string;
}
