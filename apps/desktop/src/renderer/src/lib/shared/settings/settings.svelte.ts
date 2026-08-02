/**
 * 应用偏好设置。localStorage 持久化(与 theme 同一模式)。
 *
 * 目前两项:
 *  - codeWrap:代码块长行策略('softwrap' 软换行 / 'scroll' 横向滚动);
 *  - expandFileToolDiff:文件读写工具块的 diff 默认是否展开。
 */

export type CodeWrapPreference = 'softwrap' | 'scroll';

const CODE_WRAP_KEY = 'agent-gateway:codeWrap';
const EXPAND_FILE_DIFF_KEY = 'agent-gateway:expandFileToolDiff';

function readStoredCodeWrap(): CodeWrapPreference {
	const raw = localStorage.getItem(CODE_WRAP_KEY);
	return raw === 'softwrap' || raw === 'scroll' ? raw : 'scroll';
}

function readStoredExpandFileDiff(): boolean {
	const raw = localStorage.getItem(EXPAND_FILE_DIFF_KEY);
	if (raw === '1' || raw === 'true') return true;
	if (raw === '0' || raw === 'false') return false;
	return true;
}

class SettingsStore {
	/** 代码块长行策略。组件读这个值决定渲染方式。 */
	codeWrap = $state<CodeWrapPreference>(readStoredCodeWrap());
	/** 文件读写工具块的 diff 默认展开。 */
	expandFileToolDiff = $state<boolean>(readStoredExpandFileDiff());

	setCodeWrap(value: CodeWrapPreference): void {
		this.codeWrap = value;
		localStorage.setItem(CODE_WRAP_KEY, value);
	}

	setExpandFileToolDiff(value: boolean): void {
		this.expandFileToolDiff = value;
		localStorage.setItem(EXPAND_FILE_DIFF_KEY, value ? '1' : '0');
	}
}

export const settings = new SettingsStore();
