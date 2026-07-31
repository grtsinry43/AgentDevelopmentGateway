/**
 * 工程与上下文 Profile 的领域类型。
 *
 * 这些**故意不放进 `@agent-gateway/core`**:core 是防腐层,只应容纳已验证的概念。
 * RecentProject / ContextProfile 目前是桌面端本地偏好,形态还在演进。等 Server 也
 * 需要读它们时再上提到 `packages/core/src/domain/`(见计划的风险条目 1)。
 */

import type { AdapterId } from '@agent-gateway/core';

export type HostType = 'local' | 'ssh';

/**
 * 最近工程条目。
 *
 * 主键是 `projectKey(hostId, path)` —— 同一路径在不同 host 上是**不同工程**,
 * 这直接对应 core 的 `ProjectLocation { hostId, path }`。
 */
export interface RecentProject {
	key: string;
	name: string;
	hostId: string;
	hostType: HostType;
	path: string;
	createdAt: number;
	lastOpenedAt: number;
	/** 会话数快照,仅用于卡片展示。权威值来自 Server,这里是缓存(§4.1)。 */
	sessionCount?: number;
	/** 上次使用的 runtime,卡片展示用。 */
	lastAdapterId?: AdapterId;
	/** 置顶。 */
	pinned?: boolean;
}

export interface NewProjectInput {
	name: string;
	hostId: string;
	hostType: HostType;
	path: string;
}

/**
 * 上下文 Profile ——「项目信息同步」的可命名多版本。
 *
 * 一个仓库常同时有多条需求线(重构 adapter / 修 SSE 重连 / 写文档),各自需要不同的
 * 注入内容。所以这不是单份配置,而是一组可切换的 Profile。创建会话时,激活的
 * Profile 参与上下文组合(需求 §13.4)。
 */
export interface ContextProfile {
	id: string;
	projectKey: string;
	name: string;
	description?: string;
	/** 每次会话开头注入的稳定约束(需求 §13.2 的 Always 策略)。 */
	instructions: string;
	/** 关联文件/目录(工程根的相对路径),用于 @ 引用与上下文预热。 */
	pinnedPaths: string[];
	/** 关联的 MemoryItem id(core `MemoryScope='project'`)。 */
	memoryItemIds: string[];
	createdAt: number;
	updatedAt: number;
}

/** 某工程的 Profile 集合 + 当前激活项。 */
export interface ContextProfileSet {
	projectKey: string;
	profiles: ContextProfile[];
	activeProfileId?: string;
}
