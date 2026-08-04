import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { desktop } from '$lib/shared/bridge/desktop';

/** 把拖入/粘贴的文件解析成磁盘路径,插入到光标/落点处。 */
function insertFilePaths(view: EditorView, files: File[], pos: number): void {
	const paths = files
		.map((file) => desktop.files.pathOf(file))
		.filter((path) => path.length > 0);
	if (paths.length === 0) return;
	const text = `${paths.join('\n')}\n`;
	view.dispatch({
		changes: { from: pos, to: pos, insert: text },
		selection: { anchor: pos + text.length },
		scrollIntoView: true
	});
}

/**
 * 文件附件:拖拽/粘贴文件时插入文件路径(不做上传)。仅 Project 渲染进程可用,
 * preload 通过 `webUtils.getPathForFile` 解析路径。
 */
export function fileAttachment(): Extension {
	return EditorView.domEventHandlers({
		drop(event, view) {
			const files = Array.from(event.dataTransfer?.files ?? []);
			if (files.length === 0) return false;
			event.preventDefault();
			const pos =
				view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
				view.state.selection.main.head;
			insertFilePaths(view, files, pos);
			return true;
		},
		paste(event, view) {
			const files = Array.from(event.clipboardData?.files ?? []);
			if (files.length === 0) return false;
			event.preventDefault();
			insertFilePaths(view, files, view.state.selection.main.head);
			return true;
		}
	});
}
