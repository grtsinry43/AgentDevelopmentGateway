/**
 * slash 命令补全源 —— CodeMirror 原生 autocomplete(grtblog 同款思路)。
 *
 * 直接在编辑器状态里读光标位置,输入行内 `/query`(前面是空白/行首)即激活,
 * 返回 `from`(含斜线)到光标的补全项。比手写浮层可靠:不依赖外部光标追踪。
 * 命令列表由 SessionComposer 拉取后写入 `setSlashCommands`。
 *
 * UX:按 kind 分组 —— 命令 / 技能各一个 section 标题,不再混在一起。
 */
import type {
	Completion,
	CompletionContext,
	CompletionResult,
	CompletionSection
} from '@codemirror/autocomplete';
import type { GatewaySlashCommand } from '@agent-gateway/shared';

const holder: { commands: GatewaySlashCommand[] } = { commands: [] };

export function setSlashCommands(commands: GatewaySlashCommand[]): void {
	holder.commands = commands;
}

const COMMAND_SECTION: CompletionSection = { name: '命令', rank: 0 };
const SKILL_SECTION: CompletionSection = { name: '技能', rank: 1 };

export const slashCommandSource = (context: CompletionContext): CompletionResult | null => {
	const { state, pos } = context;
	const line = state.doc.lineAt(pos);
	const textBefore = line.text.slice(0, pos - line.from);
	const match = /(?:^|\s)\/([\w-]*)$/.exec(textBefore);
	if (!match) return null;
	const query = match[1] ?? '';
	const lower = query.toLowerCase();
	const matches = holder.commands.filter(
		(command) =>
			command.name.toLowerCase().includes(lower) ||
			(command.argumentHint ?? '').toLowerCase().includes(lower)
	);
	if (matches.length === 0) return null;

	const toCompletion = (command: GatewaySlashCommand, section: CompletionSection): Completion => ({
		label: command.invoke,
		detail: command.description,
		type: command.kind === 'skill' ? 'variable' : 'keyword',
		apply: command.invoke + ' ',
		section
	});

	const options: Completion[] = [
		...matches
			.filter((command) => command.kind === 'command')
			.map((command) => toCompletion(command, COMMAND_SECTION)),
		...matches
			.filter((command) => command.kind === 'skill')
			.map((command) => toCompletion(command, SKILL_SECTION))
	];
	if (options.length === 0) return null;

	const from = line.from + match.index + (match[0].startsWith(' ') ? 1 : 0);
	return { from, to: pos, options, filter: false };
};
