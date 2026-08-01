<script lang="ts">
	import type { Extension } from '@codemirror/state';
	import type { ViewUpdate } from '@codemirror/view';
	import { untrack } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import {
		EditorController,
		type EditorChangeHandler,
		type EditorUpdateHandler
	} from './editor-controller';

	export interface CodeEditorProps {
		value?: string;
		readOnly?: boolean;
		placeholder?: string;
		autofocus?: boolean;
		extensions?: Extension;
		class?: string;
		onchange?: EditorChangeHandler;
		onupdate?: EditorUpdateHandler;
		onready?: (controller: EditorController) => void;
	}

	let {
		value = $bindable(''),
		readOnly = false,
		placeholder = '',
		autofocus = false,
		extensions = [],
		class: className = '',
		onchange,
		onupdate,
		onready
	}: CodeEditorProps = $props();

	const controller = new EditorController({
		document: untrack(() => value),
		readOnly: untrack(() => readOnly),
		placeholder: untrack(() => placeholder),
		autofocus: untrack(() => autofocus),
		extensions: untrack(() => extensions),
		onchange: (document, update) => {
			value = document;
			onchange?.(document, update);
		},
		onupdate: (update: ViewUpdate) => onupdate?.(update)
	});

	const attachEditor: Attachment<HTMLDivElement> = (element) => {
		controller.mount(element);
		untrack(() => onready?.(controller));
		return () => controller.destroy();
	};

	$effect(() => controller.setDocument(value));
	$effect(() => controller.setReadOnly(readOnly));
	$effect(() => controller.setPlaceholder(placeholder));
	$effect(() => controller.setAutofocus(autofocus));
	$effect(() => controller.setExtensions(extensions));
</script>

<div
	class={[
		'selectable min-h-0 overflow-hidden rounded-default border border-line bg-surface-raised focus-within:border-line-accent',
		className
	]}
	data-readonly={readOnly || undefined}
	{@attach attachEditor}
></div>
