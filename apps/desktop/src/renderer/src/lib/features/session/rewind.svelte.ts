import type { RewindSessionResultWire } from '@agent-gateway/shared';
import { rewindSession } from './api';
import { sessionWorkspace } from './session-workspace.svelte';

/** 时间线里的一个回退点(用户消息)。 */
export interface RewindPoint {
	/** Gateway 物化消息 item id(`input-<seq>`),作为回退目标。 */
	id: string;
	clientMessageId?: string;
	text: string;
	startedAt?: number;
	/** 该消息之后、下一条用户消息之前触发的工具数。 */
	toolCount: number;
}

class RewindWorkspace {
	isOpen = $state(false);
	/** 打开时绑定的会话 id:切换会话时据此关闭视图。 */
	openSessionId = $state<string | undefined>(undefined);
	selectedIndex = $state(0);
	preview = $state<RewindSessionResultWire | null>(null);
	/** 二次确认时选择的回退行为(原地回退 / 分支回退)。 */
	behavior = $state<'native' | 'fork'>('native');
	busy = $state(false);
	error = $state<string | undefined>(undefined);
	#behaviorTouched = false;

	/** 时间线回退点:物化 items 里的用户消息(按顺序),附该回合工具数。 */
	readonly points = $derived.by<RewindPoint[]>(() => {
		const items = sessionWorkspace.items;
		const out: RewindPoint[] = [];
		let pendingTools = 0;
		for (const item of items) {
			if (item.itemKind === 'tool') {
				pendingTools += 1;
				continue;
			}
			if (item.itemKind === 'message' && item.role === 'user' && item.contentKind === 'text') {
				out.push({
					id: item.id,
					...(item.clientMessageId ? { clientMessageId: item.clientMessageId } : {}),
					text: item.text,
					...(item.startedAt !== undefined ? { startedAt: item.startedAt } : {}),
					toolCount: pendingTools
				});
				pendingTools = 0;
			}
		}
		return out;
	});

	readonly selectedPoint = $derived(
		this.points[Math.min(this.selectedIndex, this.points.length - 1)] ?? null
	);

	open(): void {
		if (this.points.length === 0) return;
		this.openSessionId = sessionWorkspace.selectedSessionId;
		this.selectedIndex = this.points.length - 1;
		this.preview = null;
		this.behavior = 'native';
		this.#behaviorTouched = false;
		this.error = undefined;
		this.isOpen = true;
	}

	close(): void {
		this.isOpen = false;
		this.openSessionId = undefined;
		this.preview = null;
		this.busy = false;
		this.error = undefined;
	}

	select(index: number): void {
		if (index < 0 || index >= this.points.length) return;
		this.selectedIndex = index;
		this.preview = null;
		this.behavior = 'native';
		this.#behaviorTouched = false;
		this.error = undefined;
	}

	/** 切换回退行为并重新预览(原生/分支的预览信息不同)。 */
	setBehavior(next: 'native' | 'fork'): void {
		if (this.behavior === next) return;
		this.behavior = next;
		this.#behaviorTouched = true;
		void this.previewAt();
	}

	async previewAt(): Promise<void> {
		const point = this.selectedPoint;
		const sessionId = sessionWorkspace.selectedSessionId;
		if (!point || !sessionId) return;
		this.busy = true;
		this.error = undefined;
		try {
			// 历史会话先在 Server 进程内活跃(resume 注入 providerConfig),否则回退会 502。
			if (!(await sessionWorkspace.ensureSelectedSessionLive())) return;
			this.preview = await rewindSession(sessionId, {
				target: {
					by: 'message',
					messageUuid: point.id,
					...(point.clientMessageId ? { clientMessageId: point.clientMessageId } : {})
				},
				mode: 'preview',
				...(this.behavior === 'fork' ? { preferFork: true } : {})
			});
			if (!this.#behaviorTouched && this.preview) {
				this.behavior = this.preview.strategy;
			}
		} catch (error) {
			this.error = error instanceof Error ? error.message : '预览回退失败';
		} finally {
			this.busy = false;
		}
	}

	/** 确认回退:原生原地截断;fork 建新会话并自动切过去。 */
	async apply(): Promise<void> {
		const point = this.selectedPoint;
		const sessionId = sessionWorkspace.selectedSessionId;
		if (!point || !sessionId) return;
		this.busy = true;
		this.error = undefined;
		try {
			if (!(await sessionWorkspace.ensureSelectedSessionLive())) return;
			const result = await rewindSession(sessionId, {
				target: {
					by: 'message',
					messageUuid: point.id,
					...(point.clientMessageId ? { clientMessageId: point.clientMessageId } : {})
				},
				mode: 'apply',
				...(this.behavior === 'fork' ? { preferFork: true } : {})
			});
			if (result.strategy === 'fork' && result.forkSessionId) {
				this.close();
				await sessionWorkspace.load();
				await sessionWorkspace.select(result.forkSessionId);
				sessionWorkspace.composerDraft = point.text;
				return;
			}
			// 原生:重建当前会话视图(截断后的记录已由服务端落库),对话立刻回到切点,
			// 并把切点消息文本回填到输入框(Claude /rewind 语义,方便继续/编辑重试)。
			this.close();
			await sessionWorkspace.rebuildAfterRewind();
			sessionWorkspace.composerDraft = point.text;
		} catch (error) {
			this.error = error instanceof Error ? error.message : '回退失败';
		} finally {
			this.busy = false;
		}
	}
}

export const rewind = new RewindWorkspace();

/** 从 RewindSessionResult 提取「移除 N 条消息」文案的数据。 */
export function removedSummary(result: RewindSessionResultWire | null): string {
	if (!result || result.removedMessageCount <= 0) return '';
	return `移除 ${result.removedMessageCount} 条消息`;
}

/** 从 RewindSessionResult 提取文件 diff 行。 */
export function fileDiffLines(
	result: RewindSessionResultWire | null
): { file: string; insertions: number; deletions: number }[] {
	if (!result) return [];
	return result.fileDiff ?? [];
}
