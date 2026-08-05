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
		outline: 'none'
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
	},
	// —— 自定义查找/替换面板 ——
	'& .gateway-search-panel': {
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
		padding: '6px 8px',
		borderBottom: '1px solid var(--border-subtle)',
		backgroundColor: 'var(--surface-raised)',
		fontFamily: 'var(--font-mono)'
	},
	'& .gateway-search-panel .gs-row': {
		display: 'flex',
		alignItems: 'center',
		gap: '4px',
		minHeight: '22px'
	},
	'& .gateway-search-panel .gs-replace-row': {
		paddingTop: '4px',
		borderTop: '1px solid var(--border-subtle)'
	},
	'& .gateway-search-panel .gs-input': {
		flex: '1 1 0',
		minWidth: '80px',
		height: '20px',
		padding: '0 6px',
		border: '1px solid var(--border-line)',
		borderRadius: '3px',
		backgroundColor: 'var(--surface-panel)',
		color: 'var(--text-normal)',
		fontFamily: 'inherit',
		fontSize: '11px',
		outline: 'none'
	},
	'& .gateway-search-panel .gs-input:focus': {
		borderColor: 'var(--line-accent)',
		boxShadow: '0 0 0 1px var(--line-accent)'
	},
	'& .gateway-search-panel .gs-counter': {
		minWidth: '44px',
		textAlign: 'right',
		fontSize: '10px',
		color: 'var(--text-faint)'
	},
	'& .gateway-search-panel .gs-btn': {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		height: '20px',
		padding: '0 7px',
		border: '0',
		borderRadius: '3px',
		backgroundColor: 'transparent',
		color: 'var(--text-muted)',
		fontFamily: 'inherit',
		fontSize: '11px',
		cursor: 'pointer'
	},
	'& .gateway-search-panel .gs-btn:hover': {
		backgroundColor: 'var(--surface-hover)',
		color: 'var(--text-strong)'
	},
	'& .gateway-search-panel .gs-btn.gs-close': {
		fontSize: '13px',
		padding: '0 4px'
	},
	'& .gateway-search-panel .gs-toggle': {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		height: '20px',
		minWidth: '24px',
		padding: '0 5px',
		border: '1px solid var(--border-line)',
		borderRadius: '3px',
		backgroundColor: 'transparent',
		color: 'var(--text-faint)',
		fontFamily: 'inherit',
		fontSize: '10px',
		cursor: 'pointer'
	},
	'& .gateway-search-panel .gs-toggle:hover': {
		backgroundColor: 'var(--surface-hover)',
		color: 'var(--text-muted)'
	},
	'& .gateway-search-panel .gs-toggle.active': {
		backgroundColor: 'var(--surface-selected)',
		borderColor: 'var(--line-accent)',
		color: 'var(--text-accent)'
	},
	'.gateway-search-match': {
		backgroundColor: 'rgb(245 158 11 / 0.22)'
	},
	'.gateway-search-match-selected': {
		backgroundColor: 'rgb(45 212 191 / 0.3)'
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
