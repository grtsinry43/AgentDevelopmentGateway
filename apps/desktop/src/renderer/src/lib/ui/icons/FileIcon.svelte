<script lang="ts">
	/**
	 * 文件类型图标:渲染 vscode-icons 图标主题(iconify)。
	 * `kind` 是 features/files/file-icons 解析出的图标名(如 `file-type-json`);
	 * 未匹配时回退 VS Code 的通用文件图标 `default-file`。
	 *
	 * 深浅色跟随应用主题:vscode-icons 为浅色背景提供 `file-type-light-*` 变体,
	 * 浅色主题下存在该变体就用它,否则用标准版。
	 */
	import IconifyIcon, { addCollection, getIcon } from '@iconify/svelte';
	import { icons as vscodeIcons } from '@iconify-json/vscode-icons';
	import { theme } from '$lib/shared/theme/theme.svelte';

	addCollection(vscodeIcons);

	interface Props {
		kind?: string;
		size?: number;
		class?: string;
	}

	let { kind, size = 12, class: className }: Props = $props();

	const iconName = $derived.by(() => {
		const base = kind ?? 'default-file';
		if (theme.resolved !== 'light') return `vscode-icons:${base}`;
		const light = base.replace(/^file-type-/, 'file-type-light-');
		return getIcon(`vscode-icons:${light}`) ? `vscode-icons:${light}` : `vscode-icons:${base}`;
	});
</script>

<IconifyIcon
	icon={iconName}
	width={size}
	height={size}
	class={className}
	aria-hidden="true"
	inline
/>
