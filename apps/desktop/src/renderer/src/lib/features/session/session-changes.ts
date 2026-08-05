import type { ChangeSet, DiffTruncation } from '@agent-gateway/core';
import type { ConversationTimelineItem } from './projection';

/**
 * 会话变更聚合:把 scoped timeline 里所有 change set(独立的 `changes` 项 + 挂在
 * tool 项上的)按文件路径归并,得出「这个会话对每个文件做过的所有修改」。
 *
 * 一个文件可能被多次修改(同一文件多个 tool call),`revisions` 按 sequence 保序,
 * 界面据此逐次展示;`additions/deletions` 是跨修订累计值。
 */

/** 某个文件在某次 change set 里的改动。 */
export interface SessionFileRevision {
	sequence: number;
	changeSetId: string;
	file: ChangeSet['files'][number];
}

/** 当前会话范围里某个文件的全部改动。 */
export interface SessionFileChange {
	path: string;
	pathKind: ChangeSet['files'][number]['pathKind'];
	/** 语义化类型:会话内新建过 → create;最终删除 → delete;重命名 → rename;其余 → modify。 */
	kind: ChangeSet['files'][number]['kind'];
	/** 最近一次 rename 的来源路径。 */
	previousPath?: string;
	/** 跨所有修订累计。 */
	additions: number;
	deletions: number;
	binary: boolean;
	truncation?: DiffTruncation;
	revisions: SessionFileRevision[];
}

/** 从 scoped timeline 收集全部变更,按路径分组(按 path 排序)。 */
export function collectSessionChanges(items: ConversationTimelineItem[]): SessionFileChange[] {
	const byPath = new Map<string, SessionFileChange>();
	for (const item of items) {
		const changeSet =
			item.itemKind === 'changes'
				? item.changeSet
				: item.itemKind === 'tool'
					? item.changeSet
					: undefined;
		if (!changeSet) continue;
		for (const file of changeSet.files) {
			let entry = byPath.get(file.path);
			if (!entry) {
				entry = {
					path: file.path,
					pathKind: file.pathKind,
					kind: file.kind,
					additions: 0,
					deletions: 0,
					binary: file.binary ?? false,
					revisions: []
				};
				byPath.set(file.path, entry);
			}
			entry.additions += file.additions;
			entry.deletions += file.deletions;
			entry.binary = file.binary ?? entry.binary;
			entry.truncation = file.truncation ?? entry.truncation;
			entry.pathKind = file.pathKind;
			// 最近一次 rename 的来源路径用于展示(重命名后继续修改,previousPath 保留 rename 的)。
			if (file.kind === 'rename' && file.previousPath) entry.previousPath = file.previousPath;
			entry.revisions.push({ sequence: item.sequence, changeSetId: changeSet.id, file });
		}
	}
	return [...byPath.values()]
		.map((entry) => ({ ...entry, kind: finalKind(entry) }))
		.sort((left, right) => left.path.localeCompare(right.path));
}

function finalKind(entry: SessionFileChange): SessionFileChange['kind'] {
	const first = entry.revisions[0]?.file;
	const last = entry.revisions[entry.revisions.length - 1]?.file;
	if (last?.kind === 'delete') return 'delete';
	// 会话内新建的文件即使之后被继续修改,语义上仍是「新增」。
	if (first?.kind === 'create') return 'create';
	if (last?.kind === 'rename') return 'rename';
	return 'modify';
}
