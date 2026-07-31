/**
 * 键位注册表 —— 作用域栈式。
 *
 * 需求 §14.2 要求键盘优先。散落的 `addEventListener('keydown')` 在这种应用里必然
 * 互相打架:弹窗打开后底层的 j/k 还在响应、Esc 被多处抢、快捷键提示无从收集。
 *
 * 所以:
 *   - 全应用**只有一个** keydown 监听(挂在窗口根组件的 `<svelte:window>`)
 *   - 组件通过 `pushScope` 声明自己的绑定,卸载时自动弹出
 *   - 派发从栈顶向下,第一个匹配的绑定胜出并阻止冒泡
 *   - `KeyHintBar` 直接读 `visibleBindings`,提示条永远和真实绑定一致
 *
 * eslint 里有 `no-restricted-syntax` 规则强制这条约束(见 eslint.config.js)。
 */

import { SvelteSet } from 'svelte/reactivity';

export interface Binding {
	/** 归一化组合键,如 `mod+k` / `shift+enter` / `j` / `?`。见 normalizeKeys 的约定。 */
	keys: string;
	/** 提示条展示文本。空串表示不在提示条里露出(但仍可用)。 */
	label: string;
	run: (event: KeyboardEvent) => void;
	/** 动态启用。返回 false 时该绑定视为不存在,派发继续往下找。 */
	when?: () => boolean;
	/**
	 * 匹配后是否阻止默认行为与冒泡。默认 true。
	 * 少数情况(如在输入框里的 Enter)需要放行,才设为 false。
	 */
	preventDefault?: boolean;
}

export interface Scope {
	id: string;
	bindings: Binding[];
	/**
	 * 是否吞掉未匹配的按键。弹窗/命令面板设为 true —— 打开后底层的单键导航
	 * (j/k/⏎)不该再生效,否则用户会在看不见的地方触发操作。
	 */
	modal?: boolean;
}

/** 输入类元素:单键绑定(j / k / ?)在这些元素里必须让位给打字。 */
function isTextEntry(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	const tag = target.tagName;
	return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * 把 KeyboardEvent 归一化成 `mod+shift+k` 形态。
 *
 * `mod` = macOS 的 Meta / 其他平台的 Ctrl —— 这样绑定只写一次就跨平台。
 * 修饰键顺序固定为 mod → alt → shift,避免同一组合写法不一致导致匹配不上。
 */
export function eventToKeys(event: KeyboardEvent): string {
	const isMac = navigator.platform.toLowerCase().includes('mac');
	const parts: string[] = [];

	if (isMac ? event.metaKey : event.ctrlKey) parts.push('mod');
	// 非 mod 的另一个修饰键也要区分:macOS 上 Ctrl 与 Cmd 是两个不同键
	if (isMac ? event.ctrlKey : event.metaKey) parts.push('ctrl');
	if (event.altKey) parts.push('alt');
	if (event.shiftKey) parts.push('shift');

	parts.push(normalizeKeyName(event.key));
	return parts.join('+');
}

function normalizeKeyName(key: string): string {
	const map: Record<string, string> = {
		' ': 'space',
		ArrowUp: 'up',
		ArrowDown: 'down',
		ArrowLeft: 'left',
		ArrowRight: 'right',
		Escape: 'escape',
		Enter: 'enter',
		Backspace: 'backspace',
		Delete: 'delete',
		Tab: 'tab'
	};
	return map[key] ?? key.toLowerCase();
}

class KeymapRegistry {
	/**
	 * 作用域栈。**故意不是 `$state`**,由下面的 `#tick` 单独承担响应式。
	 *
	 * ── 这里踩过两次坑,都是同一个成因,记下来别再犯 ──
	 *
	 * 调用方的形态是 `$effect(() => keymap.pushScope(...))`。所以 `pushScope` 里
	 * **任何对 `$state` 的读取都会成为那个 effect 的依赖**,而它同时又在写 →
	 * 自我失效 → `effect_update_depth_exceeded`,mount 阶段整棵组件树的初始化被
	 * 打断(表现为:列表永远「读取中」、快捷键无反应、按钮点了没用)。
	 *
	 *   1. 第一次:`#scopes = $state([])` + `this.#scopes = [...this.#scopes, next]`
	 *      —— 展开运算符读了它。
	 *   2. 第二次:栈改普通数组了,但 `#version = $state(0)` + `this.#version += 1`
	 *      —— 复合赋值同样是「先读再写」。
	 *
	 * 所以现在用对象身份做令牌:`this.#tick = {}` 是**纯赋值**,不读旧值,
	 * 不会被写入方追踪成依赖;而读取方(KeyHintBar)只 `void this.#tick` 建立订阅。
	 */
	#scopes: Scope[] = [];
	/**
	 * 栈结构变更令牌。每次结构变化换一个新对象引用 —— 只赋值,永不读取。
	 * 供派生视图(KeyHintBar / hasModal)订阅。
	 */
	#tick = $state({});
	#counter = 0;

	/** 标记栈已变更。纯写入,不读任何 state。 */
	#bump(): void {
		this.#tick = {};
	}

	/**
	 * 压入一个作用域。返回弹出函数。
	 *
	 * 典型用法(在组件初始化期间):
	 * ```ts
	 * $effect(() => keymap.pushScope('launcher', [...]));
	 * ```
	 * `$effect` 的清理会自动调用返回的弹出函数。
	 */
	pushScope(id: string, bindings: Binding[], options: { modal?: boolean } = {}): () => void {
		// 同名 scope 可能并存(比如两个同类弹窗),用序号保证唯一。
		// #counter 是普通字段而非 $state —— 它不能被读进依赖图。
		const uniqueId = `${id}#${this.#counter++}`;
		this.#scopes.push({ id: uniqueId, bindings, modal: options.modal });
		this.#bump();

		return () => {
			const index = this.#scopes.findIndex((scope) => scope.id === uniqueId);
			if (index === -1) return;
			this.#scopes.splice(index, 1);
			this.#bump();
		};
	}

	/**
	 * 派发一次按键。返回是否被处理。
	 * 窗口根组件挂唯一一个 `<svelte:window onkeydown={(e) => keymap.dispatch(e)} />`。
	 */
	dispatch(event: KeyboardEvent): boolean {
		const keys = eventToKeys(event);
		const inTextEntry = isTextEntry(event.target);
		// 单键(无修饰)绑定在输入框里要让位给打字。Escape 例外 —— 它总是「取消」。
		const isBareKey = !keys.includes('+');

		// 栈顶优先
		for (let i = this.#scopes.length - 1; i >= 0; i -= 1) {
			const scope = this.#scopes[i];
			if (!scope) continue;

			for (const binding of scope.bindings) {
				if (binding.keys !== keys) continue;
				if (inTextEntry && isBareKey && keys !== 'escape') continue;
				if (binding.when && !binding.when()) continue;

				if (binding.preventDefault !== false) {
					event.preventDefault();
					event.stopPropagation();
				}
				binding.run(event);
				return true;
			}

			// modal scope 吞掉一切未匹配的按键,不再往下找
			if (scope.modal) {
				if (inTextEntry) return false; // 但弹窗里的输入框仍要能打字
				return false;
			}
		}

		return false;
	}

	/**
	 * 当前应在提示条里展示的绑定。
	 *
	 * 从栈顶向下收集,遇到 modal scope 就停 —— 弹窗打开时提示条只该显示弹窗内的操作。
	 * 同一 keys 只保留最靠上的那个(它才是真正会被触发的)。
	 */
	get visibleBindings(): Binding[] {
		// 订阅栈结构变更。#scopes 本身不是 state,靠这个令牌建立依赖。
		void this.#tick;

		const seen = new SvelteSet<string>();
		const out: Binding[] = [];

		for (let i = this.#scopes.length - 1; i >= 0; i -= 1) {
			const scope = this.#scopes[i];
			if (!scope) continue;

			for (const binding of scope.bindings) {
				if (!binding.label) continue;
				if (seen.has(binding.keys)) continue;
				if (binding.when && !binding.when()) continue;
				seen.add(binding.keys);
				out.push(binding);
			}

			if (scope.modal) break;
		}

		return out;
	}

	/** 栈里是否有 modal scope。用于给底层内容加 inert / 降低对比度。 */
	get hasModal(): boolean {
		void this.#tick;
		return this.#scopes.some((scope) => scope.modal);
	}
}

export const keymap = new KeymapRegistry();

/**
 * 把 `mod+shift+k` 渲染成平台化的符号:macOS `⌘⇧K`,其他 `Ctrl+Shift+K`。
 * 只做展示,不参与匹配。
 */
export function formatKeys(keys: string): string {
	const isMac = navigator.platform.toLowerCase().includes('mac');
	const symbols: Record<string, string> = isMac
		? {
				mod: '⌘',
				ctrl: '⌃',
				alt: '⌥',
				shift: '⇧',
				enter: '⏎',
				escape: 'Esc',
				backspace: '⌫',
				delete: '⌦',
				up: '↑',
				down: '↓',
				left: '←',
				right: '→',
				space: '␣',
				tab: '⇥'
			}
		: {
				mod: 'Ctrl',
				ctrl: 'Ctrl',
				alt: 'Alt',
				shift: 'Shift',
				enter: 'Enter',
				escape: 'Esc',
				backspace: 'Backspace',
				delete: 'Del',
				up: '↑',
				down: '↓',
				left: '←',
				right: '→',
				space: 'Space',
				tab: 'Tab'
			};

	const parts = keys.split('+').map((part) => symbols[part] ?? part.toUpperCase());
	// macOS 习惯不加连字符,其他平台用 +
	return isMac ? parts.join('') : parts.join('+');
}
