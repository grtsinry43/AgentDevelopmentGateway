/**
 * 枚举 → 视觉表现的映射表。**这是唯一一处。**
 *
 * 硬规则(AGENTS.md):组件里禁止内联 `status === 'error' ? 'text-red-500'`。
 * core 的枚举加值时,TypeScript 会在这里报缺 key —— 这是有意的编译期保护。
 */

import type { AgentSession, Host, ToolCallStatus, TurnStatus } from '@agent-gateway/core';

type SessionStatus = AgentSession['status'];
type HostStatus = Host['status'];

/** Tailwind 类名片段。语义 token 已在 theme.css 注册成 `status-*` 颜色。 */
interface StatusVisual {
	/** 圆点/条的背景色类 */
	dot: string;
	/** 文字色类 */
	text: string;
	/** 人类可读标签 */
	label: string;
}

export const SESSION_STATUS: Record<SessionStatus, StatusVisual> = {
	starting: { dot: 'bg-status-connecting', text: 'text-status-connecting', label: '启动中' },
	idle: { dot: 'bg-status-idle', text: 'text-status-idle', label: '空闲' },
	running: { dot: 'bg-status-running', text: 'text-status-running', label: '运行中' },
	waiting: { dot: 'bg-status-waiting', text: 'text-status-waiting', label: '等待输入' },
	interrupted: {
		dot: 'bg-status-interrupted',
		text: 'text-status-interrupted',
		label: '已中断'
	},
	error: { dot: 'bg-status-error', text: 'text-status-error', label: '错误' },
	closed: { dot: 'bg-status-offline', text: 'text-status-offline', label: '已关闭' }
};

export const TURN_STATUS: Record<TurnStatus, StatusVisual> = {
	running: { dot: 'bg-status-running', text: 'text-status-running', label: '运行中' },
	completed: { dot: 'bg-status-completed', text: 'text-status-completed', label: '已完成' },
	failed: { dot: 'bg-status-error', text: 'text-status-error', label: '失败' },
	interrupted: {
		dot: 'bg-status-interrupted',
		text: 'text-status-interrupted',
		label: '已中断'
	}
};

export const TOOL_STATUS: Record<ToolCallStatus, StatusVisual> = {
	pending: { dot: 'bg-status-pending', text: 'text-status-pending', label: '待执行' },
	running: { dot: 'bg-status-running', text: 'text-status-running', label: '执行中' },
	completed: { dot: 'bg-status-completed', text: 'text-status-completed', label: '完成' },
	// declined ≠ error:被用户/策略拒绝,不是执行失败(core model/tool-call.ts)
	declined: { dot: 'bg-status-declined', text: 'text-status-declined', label: '已拒绝' },
	error: { dot: 'bg-status-error', text: 'text-status-error', label: '出错' }
};

export const HOST_STATUS: Record<HostStatus, StatusVisual> = {
	online: { dot: 'bg-status-online', text: 'text-status-online', label: '在线' },
	offline: { dot: 'bg-status-offline', text: 'text-status-offline', label: '离线' },
	connecting: { dot: 'bg-status-connecting', text: 'text-status-connecting', label: '连接中' },
	error: { dot: 'bg-status-error', text: 'text-status-error', label: '错误' }
};

/** 状态是否应该显示脉冲动画(只有真正在推进的状态才动)。 */
export function isLiveStatus(status: SessionStatus | TurnStatus | ToolCallStatus): boolean {
	return status === 'starting' || status === 'running';
}
