import type { Extension } from '@codemirror/state';
import { RangeSetBuilder } from '@codemirror/state';
import {
	Decoration,
	EditorView,
	ViewPlugin,
	type DecorationSet,
	type ViewUpdate
} from '@codemirror/view';

/** 输入框里的 `/command` token:粗体、主题色、浅绿底纹。 */
const commandMark = Decoration.mark({
	attributes: {
		style:
			'color: var(--text-accent); font-weight: 700; border-radius: 3px; ' +
			'background: rgba(20, 184, 166, 0.10); padding: 0 2px;'
	}
});

/**
 * 匹配行内的 slash 命令调用(`/name`,前面是空白/行首)。只给 `/name` token 染色。
 */
function buildRanges(view: EditorView): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const commandPattern = /(?:^|\s)(\/[\w-]+)/g;
	const { doc } = view.state;
	for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
		const line = doc.line(lineNumber);
		commandPattern.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = commandPattern.exec(line.text)) !== null) {
			const command = match[1] ?? '';
			const from = line.from + match.index + match[0].length - command.length;
			const to = from + command.length;
			builder.add(from, to, commandMark);
		}
	}
	return builder.finish();
}

export function slashCommandDecoration(): Extension {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = buildRanges(view);
			}
			update(update: ViewUpdate): void {
				if (update.docChanged || update.viewportChanged) {
					this.decorations = buildRanges(update.view);
				}
			}
		},
		{ decorations: (value) => value.decorations }
	);
}
