<script lang="ts">
	import type { Extension } from '@codemirror/state';
	import {
		EditorView,
		highlightActiveLine as activeLinePlugin,
		highlightActiveLineGutter as activeLineGutterPlugin,
		type ViewUpdate
	} from '@codemirror/view';
	import { untrack } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import {
		EditorController,
		type EditorChangeHandler,
		type EditorUpdateHandler
	} from './editor-controller';
	import { gatewaySearchExtensions } from './search-panel';

	export interface CodeEditorProps {
		value?: string;
		readOnly?: boolean;
		placeholder?: string;
		autofocus?: boolean;
		appearance?: 'outlined' | 'bare';
		extensions?: Extension;
		/** 光标所在行是否高亮。默认开;聊天输入等场景可关掉。 */
		highlightActiveLine?: boolean;
		class?: string;
		onchange?: EditorChangeHandler;
		onupdate?: EditorUpdateHandler;
		onready?: (controller: EditorController) => void;
	}

	/**
	 * 活动行高亮按实例注入:base 装配里已去掉 `highlightActiveLine`(否则多个编辑器
	 * 共用一份 document 样式表,规则互相覆盖)。开 = 加高亮插件 + 主题色;
	 * 关 = 什么都不加,`cm-activeLine` 类根本不会出现。
	 */
	function activeLineExtensions(): Extension {
		return [
			activeLinePlugin(),
			activeLineGutterPlugin(),
			EditorView.baseTheme({
				'.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--text-accent) 14%, transparent) !important' },
				'.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--text-accent) 14%, transparent) !important' }
			})
		];
	}

	let {
		value = $bindable(''),
		readOnly = false,
		placeholder = '',
		autofocus = false,
		appearance = 'outlined',
		extensions = [],
		highlightActiveLine = true,
		class: className = '',
		onchange,
		onupdate,
		onready
	}: CodeEditorProps = $props();

	const controllerExtensions = $derived<Extension>([
		extensions,
		highlightActiveLine ? activeLineExtensions() : [],
		gatewaySearchExtensions()
	]);

	const controller = new EditorController({
		document: untrack(() => value),
		readOnly: untrack(() => readOnly),
		placeholder: untrack(() => placeholder),
		autofocus: untrack(() => autofocus),
		extensions: untrack(() => controllerExtensions),
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
	$effect(() => controller.setExtensions(controllerExtensions));
</script>

<div
	class={[
		'selectable min-h-0 overflow-hidden bg-surface-raised',
		appearance === 'outlined' &&
			'rounded-default border border-line focus-within:border-line-accent',
		className
	]}
	data-appearance={appearance}
	data-readonly={readOnly || undefined}
	{@attach attachEditor}
></div>
