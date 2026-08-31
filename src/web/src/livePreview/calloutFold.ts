import { StateEffect, StateField } from '@codemirror/state';

/**
 * コールアウト折りたたみのユーザ上書き（blockquote 開始位置 → 折りたたみ中）
 */
export const setCalloutFoldEffect = StateEffect.define<{ from: number; collapsed: boolean }>();

/**
 * コールアウト折りたたみ状態
 */
export const calloutFoldField = StateField.define<Map<number, boolean>>({
	/**
	 * @returns {Map<number, boolean>}
	 */
	create() {
		return new Map();
	},
	/**
	 * @param {Map<number, boolean>} value 現在値
	 * @param {import('@codemirror/state').Transaction} transaction トランザクション
	 * @returns {Map<number, boolean>}
	 */
	update(value, transaction) {
		let next: Map<number, boolean> | null = null;

		if (transaction.docChanged) {
			next = new Map();
			for (const [from, collapsed] of value) {
				next.set(transaction.changes.mapPos(from, 1), collapsed);
			}
		}

		for (const effect of transaction.effects) {
			if (!effect.is(setCalloutFoldEffect)) {
				continue;
			}

			if (!next) {
				next = new Map(value);
			}

			next.set(effect.value.from, effect.value.collapsed);
		}

		return next ?? value;
	},
});

/**
 * 折りたたみ状態を取得する（ユーザ上書き → 記法デフォルト）
 * @param {Map<number, boolean>} overrides 上書き
 * @param {number} calloutFrom コールアウト開始位置
 * @param {'none' | 'collapsed' | 'expanded'} foldDefault 記法デフォルト
 * @returns {boolean} 折りたたみ中なら true（none は常に false）
 */
export function isCalloutCollapsed(
	overrides: Map<number, boolean>,
	calloutFrom: number,
	foldDefault: 'none' | 'collapsed' | 'expanded',
): boolean {
	if (foldDefault === 'none') {
		return false;
	}

	if (overrides.has(calloutFrom)) {
		return overrides.get(calloutFrom) === true;
	}

	return foldDefault === 'collapsed';
}
