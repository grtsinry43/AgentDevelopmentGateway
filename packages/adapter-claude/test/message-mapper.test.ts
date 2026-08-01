import assert from 'node:assert/strict';
import test from 'node:test';
import { asTurnId } from '@agent-gateway/core';
import type {
	SDKAssistantMessage,
	SDKMessage,
	SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk';
import { ClaudeMessageMapper } from '../src/message-mapper.js';
import { loadFixture } from './fixture-loader.js';

const turnId = asTurnId('gateway-test-turn');

test('maps a recorded text turn to live deltas and authoritative completion', async () => {
	const events = await mapFixture('text-turn');
	const types = events.map((event) => event.type);

	assert.ok(types.includes('session.created'));
	const created = events.find((event) => event.type === 'session.created');
	assert.equal(created?.payload.capabilities.features['task.todo'], true);
	assert.ok(types.includes('content.text.delta'));
	assert.ok(types.includes('content.text.completed'));
	assert.ok(types.includes('usage.updated'));
	assert.ok(types.includes('turn.completed'));

	const completed = events.find((event) => event.type === 'content.text.completed');
	assert.equal(completed?.payload.text, 'gateway fixture');
});

test('does not restart content blocks for the official stream-then-assistant order', async () => {
	const recorded = await loadFixture('text-turn');
	const assistantSnapshots = recorded.filter(
		(message): message is SDKAssistantMessage => message.type === 'assistant'
	);
	assert.equal(assistantSnapshots.length, 2);
	const [reasoningSnapshot, textSnapshot] = assistantSnapshots;
	if (!reasoningSnapshot || !textSnapshot) {
		throw new Error('Expected recorded reasoning and text assistant snapshots');
	}

	const canonicalAssistant: SDKAssistantMessage = {
		...textSnapshot,
		type: 'assistant',
		message: {
			...textSnapshot.message,
			content: [...reasoningSnapshot.message.content, ...textSnapshot.message.content]
		}
	};
	const canonicalMessages: SDKMessage[] = [];
	for (const message of recorded) {
		if (message.type === 'assistant') continue;
		canonicalMessages.push(message);
		if (message.type === 'stream_event' && message.event.type === 'message_stop') {
			canonicalMessages.push(canonicalAssistant);
		}
	}

	const mapper = new ClaudeMessageMapper();
	const events = canonicalMessages.flatMap((message) => mapper.map(message, { turnId }));

	assert.equal(events.filter((event) => event.type === 'content.reasoning.started').length, 1);
	assert.equal(events.filter((event) => event.type === 'content.text.started').length, 1);
	assert.equal(events.filter((event) => event.type === 'content.reasoning.completed').length, 1);
	assert.equal(events.filter((event) => event.type === 'content.text.completed').length, 1);
});

test('maps a recorded denied Bash call without losing its tool lifecycle', async () => {
	const events = await mapFixture('denied-tool-turn');
	const started = events.find((event) => event.type === 'tool.started');
	const completed = events.find((event) => event.type === 'tool.completed');

	assert.equal(started?.payload.toolCall.kind, 'terminal');
	assert.equal(started?.payload.toolCall.name, 'Bash');
	assert.deepEqual(started?.payload.toolCall.presentation?.target, {
		kind: 'command',
		value: 'pwd'
	});
	assert.equal(completed?.payload.toolCall.status, 'error');
	assert.match(completed?.payload.toolCall.presentation?.resultSummary ?? '', /Denied by the fixture/);
	assert.match(completed?.payload.toolCall.error?.message ?? '', /Denied by the fixture recorder/);
	assert.ok(
		events.some((event) => event.type === 'turn.completed' || event.type === 'turn.failed')
	);
});

test('preserves Claude aborted terminal reasons as an interrupted turn', async () => {
	const messages = await loadFixture('text-turn');
	const result = messages.find((message) => message.type === 'result');
	if (!result || result.subtype !== 'success') throw new Error('Fixture has no successful Claude result');

	const mapper = new ClaudeMessageMapper();
	const events = mapper.map(
		{ ...result, terminal_reason: 'aborted_streaming' as const },
		{ turnId }
	);
	const completed = events.find((event) => event.type === 'turn.completed');

	assert.equal(completed?.payload.status, 'interrupted');
});

test('maps Claude Edit structured output to a tool-scoped ChangeSet', async () => {
	const fixture = await loadFixture('denied-tool-turn');
	const assistant = fixture.find((message): message is SDKAssistantMessage =>
		message.type === 'assistant' && message.message.content.some((block) => block.type === 'tool_use')
	);
	const user = fixture.find((message): message is SDKUserMessage => message.type === 'user');
	if (!assistant || !user) throw new Error('Denied tool fixture is missing tool message shells');

	const editAssistant: SDKAssistantMessage = {
		...assistant,
		message: {
			...assistant.message,
			content: [
				{
					type: 'tool_use',
					id: 'edit-tool-1',
					name: 'Edit',
					input: { file_path: '/workspace/src/example.ts' }
				}
			]
		}
	};
	const editResult: SDKUserMessage = {
		...user,
		message: {
			...user.message,
			content: [{ type: 'tool_result', tool_use_id: 'edit-tool-1', content: 'Updated file' }]
		},
		tool_use_result: {
			filePath: '/workspace/src/example.ts',
			oldString: 'const answer = 41;',
			newString: 'const answer = 42;',
			originalFile: 'const answer = 41;\n',
			structuredPatch: [
				{
					oldStart: 1,
					oldLines: 1,
					newStart: 1,
					newLines: 1,
					lines: ['-const answer = 41;', '+const answer = 42;']
				}
			],
			userModified: false,
			replaceAll: false,
			gitDiff: {
				filename: 'src/example.ts',
				status: 'modified',
				additions: 1,
				deletions: 1,
				changes: 2,
				patch: '@@ -1 +1 @@\n-const answer = 41;\n+const answer = 42;'
			}
		}
	};

	const mapper = new ClaudeMessageMapper('/workspace');
	const events = [editAssistant, editResult].flatMap((message) =>
		mapper.map(message, { turnId })
	);
	const completed = events.find((event) => event.type === 'tool.completed');
	const changes = events.find((event) => event.type === 'changes.updated');

	assert.equal(completed?.payload.toolCall.structured, editResult.tool_use_result);
	assert.deepEqual(
		events.find((event) => event.type === 'tool.started')?.payload.toolCall.presentation?.target,
		{ kind: 'path', value: '/workspace/src/example.ts' }
	);
	assert.deepEqual(changes?.payload.changeSet, {
		id: 'tool:edit-tool-1',
		intent: 'applied',
		scope: 'tool',
		status: 'completed',
		toolCallId: 'edit-tool-1',
		files: [
			{
				path: 'src/example.ts',
				pathKind: 'workspace-relative',
				kind: 'modify',
				additions: 1,
				deletions: 1,
				patch: '@@ -1 +1 @@\n-const answer = 41;\n+const answer = 42;',
				hunks: [
					{
						oldStart: 1,
						oldLines: 1,
						newStart: 1,
						newLines: 1,
						lines: [
							{ kind: 'deletion', text: 'const answer = 41;', oldLine: 1 },
							{ kind: 'addition', text: 'const answer = 42;', newLine: 1 }
						]
					}
				]
			}
		]
	});
});

test('derives an applied all-addition diff when Claude Write omits patch data', async () => {
	const fixture = await loadFixture('denied-tool-turn');
	const assistant = fixture.find((message): message is SDKAssistantMessage =>
		message.type === 'assistant' && message.message.content.some((block) => block.type === 'tool_use')
	);
	const user = fixture.find((message): message is SDKUserMessage => message.type === 'user');
	if (!assistant || !user) throw new Error('Denied tool fixture is missing tool message shells');

	const writeAssistant: SDKAssistantMessage = {
		...assistant,
		message: {
			...assistant.message,
			content: [
				{
					type: 'tool_use',
					id: 'write-tool-1',
					name: 'Write',
					input: { file_path: '/workspace/src/new.ts', content: 'export const value = 1\n' }
				}
			]
		}
	};
	const writeResult: SDKUserMessage = {
		...user,
		message: {
			...user.message,
			content: [{ type: 'tool_result', tool_use_id: 'write-tool-1', content: 'Created file' }]
		},
		tool_use_result: {
			type: 'create',
			filePath: '/workspace/src/new.ts',
			content: 'export const value = 1\n',
			originalFile: null,
			structuredPatch: []
		}
	};
	const mapper = new ClaudeMessageMapper('/workspace');
	const changes = [writeAssistant, writeResult]
		.flatMap((message) => mapper.map(message, { turnId }))
		.find((event) => event.type === 'changes.updated');

	assert.equal(changes?.payload.changeSet.files[0]?.kind, 'create');
	assert.deepEqual(changes?.payload.changeSet.files[0]?.hunks[0]?.lines, [
		{ kind: 'addition', text: 'export const value = 1', newLine: 1 }
	]);
});

test('emits a Core task update only after a successful Claude TodoWrite result', async () => {
	const fixture = await loadFixture('denied-tool-turn');
	const assistant = fixture.find((message): message is SDKAssistantMessage =>
		message.type === 'assistant' && message.message.content.some((block) => block.type === 'tool_use')
	);
	const user = fixture.find((message): message is SDKUserMessage => message.type === 'user');
	if (!assistant || !user) throw new Error('Denied tool fixture is missing tool message shells');

	const todoAssistant: SDKAssistantMessage = {
		...assistant,
		message: {
			...assistant.message,
			content: [
				{
					type: 'tool_use',
					id: 'todo-tool-1',
					name: 'TodoWrite',
					input: {
						todos: [
							{
								content: 'Render task panel',
								status: 'in_progress',
								activeForm: 'Rendering task panel'
							}
						]
					}
				}
			]
		}
	};
	const todoResult: SDKUserMessage = {
		...user,
		message: {
			...user.message,
			content: [{ type: 'tool_result', tool_use_id: 'todo-tool-1', content: 'Updated todos' }]
		},
		tool_use_result: {
			oldTodos: [],
			newTodos: [
				{
					content: 'Render task panel',
					status: 'in_progress',
					activeForm: 'Rendering task panel'
				}
			]
		}
	};
	const mapper = new ClaudeMessageMapper();
	const events = [todoAssistant, todoResult].flatMap((message) =>
		mapper.map(message, { turnId })
	);
	const update = events.find((event) => event.type === 'task.updated');

	assert.equal(update?.payload.update.kind, 'replace');
	if (update?.payload.update.kind !== 'replace') throw new Error('Expected task replacement');
	assert.equal(update.payload.update.tasks[0]?.activeText, 'Rendering task panel');
});

async function mapFixture(name: string) {
	const mapper = new ClaudeMessageMapper();
	const messages = await loadFixture(name);
	return messages.flatMap((message) => mapper.map(message, { turnId }));
}
