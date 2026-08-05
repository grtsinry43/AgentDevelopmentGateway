/**
 * Vite dev 错误浮窗的自定义实现。
 *
 * @vite/client 只在 `vite-error-overlay` 尚未注册时注册自己的错误浮窗
 * (见 client.mjs:`if (customElements && !customElements.get(overlayId)) customElements.define(...)`)。
 * 本模块在 @vite/client 之前执行(插件 head-prepend 注入),用同名自定义元素覆盖默认实现,
 * 外观走应用的 CSS 变量,贴合亮/暗主题。
 *
 * Vite 通过 `new ErrorOverlayConstructor(err)` 构造浮窗,`clearErrorOverlay()` 调用 `.close()`。
 * 这两个契约都要保持。
 */

const overlayId = 'vite-error-overlay';

if (typeof customElements !== 'undefined' && !customElements.get(overlayId)) {
	const style = `
		:host { all: initial; }
		.backdrop {
			position: fixed; inset: 0; z-index: 2147483000;
			display: flex; justify-content: center; align-items: flex-start;
			padding: 16px;
			background: rgb(0 0 0 / 0.3);
			font-family: var(--font-mono, ui-monospace, monospace);
		}
		.card {
			width: 100%; max-width: 720px; max-height: 60vh;
			display: flex; flex-direction: column; overflow: hidden;
			background: var(--surface-raised, #1c1917);
			border: 1px solid var(--border-line, #44403c);
			border-radius: var(--radius-default, 3px);
			box-shadow: var(--shadow-deep, 0 24px 48px rgb(0 0 0 / 0.4));
			color: var(--text-normal, #d6d3d1);
		}
		.head {
			display: flex; align-items: center; gap: 8px;
			padding: 10px 14px; font-size: 12px;
			border-bottom: 1px solid var(--border-subtle, #292524);
		}
		.dot {
			width: 8px; height: 8px; border-radius: 9999px;
			background: var(--color-cinnabar-500, #ef4444);
		}
		.title { font-weight: 600; color: var(--text-strong, #fafaf9); }
		.close {
			margin-left: auto; background: none; border: 0; cursor: pointer;
			color: var(--text-faint, #78716c); font-size: 14px; line-height: 1; padding: 2px;
		}
		.close:hover { color: var(--text-normal, #d6d3d1); }
		.body {
			padding: 12px 14px; overflow: auto;
			font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word;
			color: var(--text-muted, #a8a29e);
		}
		.body .file { color: var(--text-accent, #5eead4); }
		.foot {
			padding: 8px 14px; font-size: 11px;
			color: var(--text-faint, #78716c); border-top: 1px solid var(--border-subtle, #292524);
		}
	`;

	class GatewayDevErrorOverlay extends HTMLElement {
		constructor(err) {
			super();
			const root = this.attachShadow({ mode: 'open' });
			root.innerHTML = `<style>${style}</style>
				<div class="backdrop" part="backdrop">
					<div class="card" role="alertdialog" aria-label="Vite Dev Error">
						<div class="head">
							<span class="dot"></span>
							<span class="title">Vite Dev Error</span>
							<button class="close" type="button" aria-label="关闭">✕</button>
						</div>
						<div class="body">${renderError(err)}</div>
						<div class="foot">按 Esc 关闭 · 修复代码后自动消失</div>
					</div>
				</div>`;
			root.querySelector('.close').addEventListener('click', () => this.close());
			root.querySelector('.backdrop').addEventListener('click', (event) => {
				if (event.target === event.currentTarget) this.close();
			});
			this.addEventListener('keydown', (event) => {
				if (event.key === 'Escape') this.close();
			});
			this.tabIndex = -1;
			this.focus();
		}

		close() {
			this.remove();
		}
	}

	function escapeHtml(value) {
		return String(value).replace(/[&<>"']/g, (character) => {
			const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
			return map[character];
		});
	}

	function renderError(err) {
		if (!err) return '未知错误';
		const parts = [];
		if (err.loc && err.loc.file) {
			parts.push(
				`<div class="file">${escapeHtml(err.loc.file)}${err.loc.line ? `:${escapeHtml(err.loc.line)}` : ''}</div>`
			);
		} else if (err.file || err.id) {
			parts.push(`<div class="file">${escapeHtml(err.file || err.id)}</div>`);
		}
		if (err.plugin) parts.push(`[${escapeHtml(err.plugin)}]`);
		parts.push(escapeHtml(err.message || err));
		if (err.stack) parts.push(escapeHtml(err.stack));
		return parts.join('\n');
	}

	customElements.define(overlayId, GatewayDevErrorOverlay);
}
