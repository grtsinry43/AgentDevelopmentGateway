<script lang="ts">
	import { markdown } from '@codemirror/lang-markdown';
	import type { Extension } from '@codemirror/state';
	import { GFM } from '@lezer/markdown';
	import CodeEditor, { type CodeEditorProps } from './CodeEditor.svelte';

	type MarkdownEditorProps = CodeEditorProps;

	let { value = $bindable(''), extensions = [], ...props }: MarkdownEditorProps = $props();

	const markdownLanguage = markdown({ extensions: [GFM] });
	const configuredExtensions = $derived<Extension>([markdownLanguage, extensions]);
</script>

<CodeEditor bind:value extensions={configuredExtensions} {...props} />
