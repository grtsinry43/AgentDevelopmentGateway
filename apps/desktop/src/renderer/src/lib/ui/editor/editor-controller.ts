import {
	Annotation,
	Compartment,
	EditorSelection,
	EditorState,
	Transaction,
	type Extension
} from '@codemirror/state';
import { EditorView, placeholder, type ViewUpdate } from '@codemirror/view';
import {
	defaultKeymap,
	history,
	historyKeymap
} from '@codemirror/commands';
import { closeBrackets, autocompletion, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { highlightSelectionMatches } from '@codemirror/search';
import { lintKeymap } from '@codemirror/lint';
import {
	bracketMatching,
	foldGutter,
	foldKeymap,
	indentOnInput,
	syntaxHighlighting,
	defaultHighlightStyle
} from '@codemirror/language';
import {
	crosshairCursor,
	drawSelection,
	dropCursor,
	highlightSpecialChars,
	keymap,
	lineNumbers,
	rectangularSelection
} from '@codemirror/view';
import { gatewayEditorTheme } from './editor-theme';

/**
 * 基础编辑器装配:等于 `codemirror` 的 `basicSetup`,但**去掉** `highlightActiveLine`
 * 与 `highlightActiveLineGutter`。活动行高亮改为按实例注入(见 CodeEditor),
 * 避免多个编辑器共用同一份 document 样式表时互相覆盖。
 */
const baseEditorSetup: Extension = [
	lineNumbers(),
	highlightSpecialChars(),
	history(),
	foldGutter(),
	drawSelection(),
	dropCursor(),
	EditorState.allowMultipleSelections.of(true),
	indentOnInput(),
	syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
	bracketMatching(),
	closeBrackets(),
	autocompletion(),
	rectangularSelection(),
	crosshairCursor(),
	highlightSelectionMatches(),
	keymap.of([
		...closeBracketsKeymap,
		...defaultKeymap,
		...historyKeymap,
		...foldKeymap,
		...completionKeymap,
		...lintKeymap
	])
]

export type EditorChangeHandler = (document: string, update: ViewUpdate) => void;
export type EditorUpdateHandler = (update: ViewUpdate) => void;

export interface EditorControllerOptions {
	document?: string;
	readOnly?: boolean;
	placeholder?: string;
	autofocus?: boolean;
	extensions?: Extension;
	onchange?: EditorChangeHandler;
	onupdate?: EditorUpdateHandler;
}

const externalDocumentUpdate = Annotation.define<boolean>();

/**
 * Framework-neutral owner of a CodeMirror view.
 *
 * CodeMirror owns its DOM and editor state while mounted. Framework adapters only call the
 * explicit setters below; they must never reconcile children inside the host element.
 */
export class EditorController {
	readonly #readOnlyCompartment = new Compartment();
	readonly #placeholderCompartment = new Compartment();
	readonly #extensionsCompartment = new Compartment();

	#view: EditorView | undefined;
	#document: string;
	#readOnly: boolean;
	#placeholder: string;
	#autofocus: boolean;
	#extensions: Extension;
	#onchange: EditorChangeHandler | undefined;
	#onupdate: EditorUpdateHandler | undefined;

	constructor(options: EditorControllerOptions = {}) {
		this.#document = options.document ?? '';
		this.#readOnly = options.readOnly ?? false;
		this.#placeholder = options.placeholder ?? '';
		this.#autofocus = options.autofocus ?? false;
		this.#extensions = options.extensions ?? [];
		this.#onchange = options.onchange;
		this.#onupdate = options.onupdate;
	}

	get view(): EditorView | undefined {
		return this.#view;
	}

	get document(): string {
		return this.#view?.state.doc.toString() ?? this.#document;
	}

	get mounted(): boolean {
		return this.#view !== undefined;
	}

	mount(parent: HTMLElement): EditorView {
		if (this.#view) throw new Error('EditorController is already mounted');

		const state = EditorState.create({
			doc: this.#document,
			extensions: [
				baseEditorSetup,
				gatewayEditorTheme,
				EditorView.lineWrapping,
				this.#readOnlyCompartment.of(readOnlyExtensions(this.#readOnly)),
				this.#placeholderCompartment.of(placeholderExtension(this.#placeholder)),
				this.#extensionsCompartment.of(this.#extensions),
				EditorView.updateListener.of((update) => this.#handleUpdate(update))
			]
		});

		const view = new EditorView({ state, parent });
		this.#view = view;
		if (this.#autofocus) {
			queueMicrotask(() => {
				if (this.#view === view) view.focus();
			});
		}
		return view;
	}

	destroy(): void {
		const view = this.#view;
		if (!view) return;
		this.#document = view.state.doc.toString();
		this.#view = undefined;
		view.destroy();
	}

	setDocument(document: string): void {
		this.#document = document;
		const view = this.#view;
		if (!view || view.state.doc.toString() === document) return;

		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: document },
			selection: EditorSelection.create(
				view.state.selection.ranges.map((range) =>
					EditorSelection.range(
						Math.min(range.anchor, document.length),
						Math.min(range.head, document.length)
					)
				),
				view.state.selection.mainIndex
			),
			annotations: [externalDocumentUpdate.of(true), Transaction.addToHistory.of(false)]
		});
	}

	setReadOnly(readOnly: boolean): void {
		if (this.#readOnly === readOnly) return;
		this.#readOnly = readOnly;
		this.#view?.dispatch({
			effects: this.#readOnlyCompartment.reconfigure(readOnlyExtensions(readOnly))
		});
	}

	setPlaceholder(value: string): void {
		if (this.#placeholder === value) return;
		this.#placeholder = value;
		this.#view?.dispatch({
			effects: this.#placeholderCompartment.reconfigure(placeholderExtension(value))
		});
	}

	setExtensions(extensions: Extension): void {
		if (this.#extensions === extensions) return;
		this.#extensions = extensions;
		this.#view?.dispatch({
			effects: this.#extensionsCompartment.reconfigure(extensions)
		});
	}

	setAutofocus(autofocus: boolean): void {
		if (this.#autofocus === autofocus) return;
		this.#autofocus = autofocus;
		if (autofocus) this.focus();
	}

	setHandlers(handlers: { onchange?: EditorChangeHandler; onupdate?: EditorUpdateHandler }): void {
		this.#onchange = handlers.onchange;
		this.#onupdate = handlers.onupdate;
	}

	focus(): void {
		this.#view?.focus();
	}

	#handleUpdate(update: ViewUpdate): void {
		this.#document = update.state.doc.toString();
		this.#onupdate?.(update);
		if (!update.docChanged) return;

		const originatedExternally = update.transactions.some(
			(transaction) => transaction.annotation(externalDocumentUpdate) === true
		);
		if (!originatedExternally) this.#onchange?.(this.#document, update);
	}
}

function readOnlyExtensions(readOnly: boolean): Extension {
	return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

function placeholderExtension(value: string): Extension {
	return value ? placeholder(value) : [];
}
