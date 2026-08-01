import type { SvmdMarkdownItPlugin, SvmdParseOptions } from 'svmarkdown';

const TASK_MARKER = /^\[([ xX])\]\s+/;
type MarkdownItInstance = NonNullable<SvmdParseOptions['markdownIt']>;
type CoreRule = Parameters<MarkdownItInstance['core']['ruler']['after']>[2];
type CoreState = Parameters<CoreRule>[0];

export const taskListPlugin = ((markdownIt: MarkdownItInstance) => {
	markdownIt.core.ruler.after('inline', 'agent_task_list', (state: CoreState) => {
		const listStack: Array<(typeof state.tokens)[number]> = [];
		let listItem: (typeof state.tokens)[number] | undefined;

		for (const token of state.tokens) {
			if (token.type === 'bullet_list_open') listStack.push(token);
			else if (token.type === 'bullet_list_close') listStack.pop();
			else if (token.type === 'list_item_open') listItem = token;
			else if (token.type === 'list_item_close') listItem = undefined;
			else if (token.type === 'inline' && listItem) {
				const first = token.children?.[0];
				if (!first || first.type !== 'text') continue;
				const marker = TASK_MARKER.exec(first.content);
				if (!marker) continue;

				first.content = first.content.slice(marker[0].length);
				listItem.attrSet('data-task', 'true');
				listItem.attrSet('data-checked', marker[1]?.toLowerCase() === 'x' ? 'true' : 'false');
				listStack.at(-1)?.attrSet('data-task-list', 'true');
			}
		}
	});
}) satisfies SvmdMarkdownItPlugin;
