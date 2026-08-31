import { Decoration } from '@codemirror/view';
import type { DecorationEntry } from './inlineDecorations';

/**
 * ライブプレビューでレイアウトから除外する replace Decoration エントリを追加する
 * @param {DecorationEntry[]} entries エントリ配列
 * @param {number} from 開始位置
 * @param {number} to 終了位置
 * @returns {void}
 */
export function pushHiddenReplace(entries: DecorationEntry[], from: number, to: number): void {
	if (from >= to) {
		return;
	}

	entries.push({
		from,
		to,
		decoration: Decoration.replace({}),
	});
}
