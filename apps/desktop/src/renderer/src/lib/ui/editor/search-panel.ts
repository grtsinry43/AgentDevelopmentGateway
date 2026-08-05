/**
 * 自定义查找/替换面板。
 *
 * 不用 `@codemirror/search` 的默认面板(它用 `searchState.panel` + `createSearchPanel`
 * 渲染,且 `.cm-search` 样式和所有编辑器共享,难以按编辑器定制)。这里自建:
 *   - 自有的 `panelOpenField`(StateField)控制面板显隐(showPanel.from)
 *   - 自有的匹配高亮 ViewPlugin(用 `SearchQuery.getCursor` 逐可见区间构建)
 *   - 复用包的公开命令(`findNext` / `replaceNext` 等只依赖 searchState.query)
 *   - 面板 DOM 纯命令式构建,样式走 `gateway-search-panel` 类(editor-theme.ts 统一)
 */

import {
	EditorState,
	Prec,
	RangeSetBuilder,
	StateEffect,
	StateField,
	type Extension
} from '@codemirror/state';
import {
	Decoration,
	EditorView,
	keymap,
	showPanel,
	ViewPlugin,
	type DecorationSet,
	type ViewUpdate
} from '@codemirror/view';
import {
	SearchQuery,
	findNext,
	findPrevious,
	getSearchQuery,
	gotoLine,
	replaceAll,
	replaceNext,
	search,
	selectMatches,
	selectNextOccurrence,
	selectSelectionMatches,
	setSearchQuery
} from '@codemirror/search';

const togglePanel = StateEffect.define<boolean>();

const panelOpenField = StateField.define<boolean>({
	create: () => false,
	update: (open, tr) => {
		for (const effect of tr.effects) {
			if (effect.is(togglePanel)) return effect.value;
		}
		return open;
	},
	provide: (f) => showPanel.from(f, (open) => (open ? (view) => new GatewaySearchPanel(view) : null))
});

const matchMark = Decoration.mark({ class: 'gateway-search-match' });
const selectedMatchMark = Decoration.mark({ class: 'gateway-search-match gateway-search-match-selected' });

const searchMatchHighlighter = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet = Decoration.none;

		constructor(view: EditorView) {
			this.decorations = buildMatchDecorations(view);
		}

		update(update: ViewUpdate): void {
			if (
				update.docChanged ||
				update.selectionSet ||
				update.viewportChanged ||
				update.transactions.some((tr) => tr.effects.some((effect) => effect.is(togglePanel) || effect.is(setSearchQuery)))
			) {
				this.decorations = buildMatchDecorations(update.view);
			}
		}
	},
	{ decorations: (view) => view.decorations }
);

function buildMatchDecorations(view: EditorView): DecorationSet {
	if (view.state.field(panelOpenField, false) !== true) return Decoration.none;
	const query = getSearchQuery(view.state);
	if (!query.valid) return Decoration.none;
	const builder = new RangeSetBuilder<Decoration>();
	const ranges = view.visibleRanges;
	for (let i = 0; i < ranges.length; i += 1) {
		const start = ranges[i];
		if (!start) continue;
		const from = start.from;
		let to = start.to;
		while (i < ranges.length - 1) {
			const next = ranges[i + 1];
			if (!next || next.from > to - 250) break;
			to = next.to;
			i += 1;
		}
		const cursor = query.getCursor(view.state, from, to);
		for (let result = cursor.next(); !result.done; result = cursor.next()) {
			const value = result.value;
			if (value === undefined) continue;
			const selected = view.state.selection.ranges.some(
				(range) => range.from === value.from && range.to === value.to
			);
			builder.add(value.from, value.to, selected ? selectedMatchMark : matchMark);
		}
	}
	return builder.finish();
}

function openGatewaySearch(view: EditorView): boolean {
	if (view.state.field(panelOpenField, false) !== true) {
		const selection = view.state.sliceDoc(
			view.state.selection.main.from,
			view.state.selection.main.to
		);
		if (selection && selection.length <= 100) {
			view.dispatch({
				effects: setSearchQuery.of(
					new SearchQuery({ search: selection, caseSensitive: false, regexp: false, wholeWord: false })
				)
			});
		}
		view.dispatch({ effects: togglePanel.of(true) });
	}
	return true;
}

function closeGatewaySearch(view: EditorView): boolean {
	if (view.state.field(panelOpenField, false) === true) {
		view.dispatch({ effects: togglePanel.of(false) });
	}
	return true;
}

class GatewaySearchPanel {
	readonly dom: HTMLElement;
	readonly top = true;
	#view: EditorView;
	#search: HTMLInputElement;
	#replace: HTMLInputElement;
	#counter: HTMLSpanElement;
	#caseBtn: HTMLButtonElement;
	#regexpBtn: HTMLButtonElement;
	#wordBtn: HTMLButtonElement;
	#lastQuery: string | undefined;

	constructor(view: EditorView) {
		this.#view = view;
		const readOnly = view.state.facet(EditorState.readOnly);

		this.#search = input('查找', 'gs-search');
		this.#replace = input('替换为', 'gs-replace');
		this.#counter = el('span', 'gs-counter');
		this.#caseBtn = toggle('Aa', '区分大小写');
		this.#regexpBtn = toggle('.*', '正则表达式');
		this.#wordBtn = toggle('ab', '整词匹配');

		const searchRow = el('div', 'gs-row', [
			this.#search,
			this.#counter,
			button('↑', '上一个 (Shift+Enter)', () => findPrevious(view)),
			button('↓', '下一个 (Enter)', () => findNext(view)),
			button('全部', '选择全部匹配', () => selectMatches(view)),
			this.#caseBtn,
			this.#regexpBtn,
			this.#wordBtn,
			button('×', '关闭 (Esc)', () => closeGatewaySearch(view), 'gs-close')
		]);

		const replaceRow = el('div', 'gs-row gs-replace-row', [
			this.#replace,
			button('替换', '替换当前匹配', () => replaceNext(view)),
			button('全部替换', '替换所有匹配', () => replaceAll(view))
		]);

		this.dom = el('div', 'gateway-search-panel', readOnly ? [searchRow] : [searchRow, replaceRow]);

		this.#search.addEventListener('input', () => this.commit());
		this.#replace.addEventListener('input', () => this.commit());
		// eslint-disable-next-line no-restricted-syntax -- CodeMirror 面板输入框的 Enter 路由:窗口级 keymap 作用域栈到不了 CM 面板 DOM,这里与上游 @codemirror/search 面板一致,在面板 DOM 上做局部 Enter→findNext/replaceNext 处理。
		this.#search.addEventListener('keydown', (event) => this.onKeydown(event, false));
		// eslint-disable-next-line no-restricted-syntax -- 同上:替换输入框的 Enter 触发 replaceNext。
		this.#replace.addEventListener('keydown', (event) => this.onKeydown(event, true));
		for (const btn of [this.#caseBtn, this.#regexpBtn, this.#wordBtn]) {
			btn.addEventListener('click', () => {
				btn.classList.toggle('active');
				this.commit();
			});
		}
		this.sync();
	}

	mount(): void {
		this.#search.focus();
		this.#search.select();
	}

	update(): void {
		this.sync();
	}

	destroy(): void {
		// 元素由 CodeMirror 移除,无需额外清理。
	}

	private onKeydown(event: KeyboardEvent, isReplace: boolean): void {
		if (event.key !== 'Enter') return;
		event.preventDefault();
		if (isReplace) replaceNext(this.#view);
		else if (event.shiftKey) findPrevious(this.#view);
		else findNext(this.#view);
	}

	private commit(): void {
		this.#view.dispatch({
			effects: setSearchQuery.of(
				new SearchQuery({
					search: this.#search.value,
					replace: this.#replace.value,
					caseSensitive: this.#caseBtn.classList.contains('active'),
					regexp: this.#regexpBtn.classList.contains('active'),
					wholeWord: this.#wordBtn.classList.contains('active')
				})
			)
		});
	}

	private sync(): void {
		const query = getSearchQuery(this.#view.state);
		if (this.#lastQuery !== query.search) {
			this.#lastQuery = query.search;
			this.#search.value = query.search;
			this.#replace.value = query.replace;
			this.#caseBtn.classList.toggle('active', query.caseSensitive);
			this.#regexpBtn.classList.toggle('active', query.regexp);
			this.#wordBtn.classList.toggle('active', query.wholeWord);
		}
		this.updateCounter(query);
	}

	private updateCounter(query: SearchQuery): void {
		if (!query.valid) {
			this.#counter.textContent = '';
			return;
		}
		const state = this.#view.state;
		const head = state.selection.main.head;
		let total = 0;
		let current = 0;
		let overflow = false;
		const cursor = query.getCursor(state);
		for (let result = cursor.next(); !result.done; result = cursor.next()) {
			const value = result.value;
			if (value === undefined) continue;
			total += 1;
			if (value.from <= head) current = total;
			if (total >= 10_000) {
				overflow = true;
				break;
			}
		}
		const totalText = overflow ? '9999+' : String(total);
		this.#counter.textContent = current > 0 ? `${current}/${totalText}` : `0/${totalText}`;
	}
}

function el(tag: string, className: string, children: Array<HTMLElement | string> = []): HTMLElement {
	const node = document.createElement(tag);
	node.className = className;
	for (const child of children) node.append(child);
	return node;
}

function input(placeholder: string, className: string): HTMLInputElement {
	const node = document.createElement('input');
	node.type = 'text';
	node.className = `gs-input ${className}`;
	node.placeholder = placeholder;
	node.spellcheck = false;
	node.autocomplete = 'off';
	return node;
}

function button(label: string, title: string, onclick: () => void, extra = ''): HTMLButtonElement {
	const node = document.createElement('button');
	node.type = 'button';
	node.className = `gs-btn ${extra}`.trim();
	node.title = title;
	node.textContent = label;
	node.addEventListener('click', onclick);
	return node;
}

function toggle(label: string, title: string): HTMLButtonElement {
	const node = document.createElement('button');
	node.type = 'button';
	node.className = 'gs-toggle';
	node.title = title;
	node.textContent = label;
	return node;
}

/** 接入编辑器的扩展:搜索状态 + 匹配高亮 + 快捷键。 */
export function gatewaySearchExtensions(): Extension {
	return [
		search(),
		panelOpenField,
		searchMatchHighlighter,
		Prec.highest(
			keymap.of([
				{ key: 'Mod-f', run: openGatewaySearch },
				{ key: 'Escape', run: closeGatewaySearch },
				{ key: 'F3', run: findNext, shift: findPrevious },
				{ key: 'Mod-g', run: findNext, shift: findPrevious },
				{ key: 'Mod-Shift-l', run: selectSelectionMatches },
				{ key: 'Mod-d', run: selectNextOccurrence },
				{ key: 'Mod-Alt-g', run: gotoLine }
			])
		)
	];
}
