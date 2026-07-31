/**
 * 全项目唯一一份 class 拼接工具。
 *
 * grtblog 在每个组件里重定义 `cx`,这里修正为集中一份。
 * 支持 clsx 风格的数组与对象,因为 Svelte 5 的 `class` 属性也接受这些形态。
 */

export type ClassValue =
	| string
	| number
	| false
	| null
	| undefined
	| ClassValue[]
	| Record<string, boolean | null | undefined>;

export function cx(...values: ClassValue[]): string {
	const out: string[] = [];

	for (const value of values) {
		if (!value) continue;

		if (typeof value === 'string' || typeof value === 'number') {
			out.push(String(value));
			continue;
		}

		if (Array.isArray(value)) {
			const nested = cx(...value);
			if (nested) out.push(nested);
			continue;
		}

		for (const [key, enabled] of Object.entries(value)) {
			if (enabled) out.push(key);
		}
	}

	return out.join(' ');
}
