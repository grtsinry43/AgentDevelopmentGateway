import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

const editorTheme = EditorView.theme({
	'&': {
		height: '100%',
		color: 'var(--text-normal)',
		backgroundColor: 'transparent',
		fontFamily: 'var(--font-mono)',
		fontSize: 'var(--text-sm)'
	},
	'&.cm-focused': {
		outline: '1px solid var(--focus-ring)',
		outlineOffset: '-1px'
	},
	'.cm-scroller': {
		overflow: 'auto',
		fontFamily: 'inherit',
		lineHeight: 'var(--text-sm--line-height)'
	},
	'.cm-content': {
		minHeight: '100%',
		padding: '8px 0'
	},
	'.cm-line': {
		padding: '0 10px'
	},
	'.cm-cursor, .cm-dropCursor': {
		borderLeftColor: 'var(--focus-ring)'
	},
	'&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
		{
			backgroundColor: 'rgb(45 212 191 / 0.22)'
		},
	'.cm-activeLine, .cm-activeLineGutter': {
		backgroundColor: 'var(--surface-active)'
	},
	'.cm-gutters': {
		backgroundColor: 'var(--surface-panel)',
		color: 'var(--text-faint)',
		borderRight: '1px solid var(--border-subtle)'
	},
	'.cm-foldPlaceholder': {
		backgroundColor: 'var(--surface-hover)',
		color: 'var(--text-muted)',
		borderColor: 'var(--border-default)'
	},
	'.cm-placeholder': {
		color: 'var(--text-faint)',
		fontStyle: 'normal'
	},
	'.cm-panels': {
		backgroundColor: 'var(--surface-panel)',
		color: 'var(--text-normal)'
	},
	'.cm-tooltip': {
		backgroundColor: 'var(--surface-raised)',
		color: 'var(--text-normal)',
		border: '1px solid var(--border-default)',
		borderRadius: 'var(--radius-default)',
		boxShadow: 'var(--shadow-float)'
	},
	'.cm-tooltip-autocomplete > ul > li[aria-selected]': {
		backgroundColor: 'var(--surface-selected)',
		color: 'var(--text-strong)'
	},
	'.cm-searchMatch': {
		backgroundColor: 'rgb(245 158 11 / 0.22)'
	},
	'.cm-searchMatch.cm-searchMatch-selected': {
		backgroundColor: 'rgb(45 212 191 / 0.28)'
	}
});

const highlightStyle = HighlightStyle.define([
	{ tag: [tags.keyword, tags.modifier], color: 'var(--text-accent)' },
	{ tag: [tags.name, tags.variableName], color: 'var(--text-normal)' },
	{ tag: [tags.propertyName, tags.attributeName], color: 'var(--color-iris-500)' },
	{ tag: [tags.string, tags.special(tags.string)], color: 'var(--status-completed)' },
	{ tag: [tags.number, tags.bool, tags.null], color: 'var(--status-waiting)' },
	{
		tag: [tags.function(tags.variableName), tags.function(tags.name)],
		color: 'var(--color-iris-500)'
	},
	{ tag: [tags.operator, tags.operatorKeyword], color: 'var(--text-muted)' },
	{ tag: [tags.className, tags.typeName], color: 'var(--color-iris-400)' },
	{ tag: tags.tagName, color: 'var(--status-error)' },
	{ tag: tags.invalid, color: 'var(--status-error)', textDecoration: 'underline wavy' },
	{ tag: tags.comment, color: 'var(--text-faint)', fontStyle: 'italic' },
	{ tag: [tags.punctuation, tags.bracket], color: 'var(--text-muted)' },
	{ tag: tags.heading, color: 'var(--text-strong)', fontWeight: '650' },
	{ tag: tags.strong, color: 'var(--text-strong)', fontWeight: '650' },
	{ tag: tags.emphasis, fontStyle: 'italic' },
	{ tag: tags.link, color: 'var(--text-accent)', textDecoration: 'underline' },
	{ tag: tags.strikethrough, color: 'var(--text-muted)', textDecoration: 'line-through' }
]);

export const gatewayEditorTheme: Extension = [editorTheme, syntaxHighlighting(highlightStyle)];
