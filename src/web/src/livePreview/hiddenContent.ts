/**
 * ライブプレビューでソース範囲をレイアウトから外す replace 装飾を、呼び出し側の配列へ足す
 * エディタ状態は持たず、渡された entries だけを更新する
 * @file
 */
import { Decoration } from '@codemirror/view';
import type { DecorationEntry } from './inlineDecorations';

/**
 * 指定範囲を空の replace 装飾で隠し、レイアウトから除外する
 * from が to 以上のときは何も足さない
 * @param entries - 装飾を追加する配列。この関数が末尾へ push する
 * @param from - 隠す範囲の開始。ドキュメント先頭からの文字位置
 * @param to - 隠す範囲の終端。from 以上なら追加しない
 */
export function pushHiddenReplace(entries: DecorationEntry[], from: number, to: number): void {
	// 開始が終端以上なら隠す文字が無い。空範囲の装飾は足さない
	if (from >= to) {
		return;
	}

	// レイアウトから外す replace。中身が空なので文字も幅も残さない
	entries.push({
		// 隠す範囲の開始。ドキュメント先頭からの文字位置
		from,
		// 隠す範囲の終端。from より大きい
		to,
		// 中身の無い replace。この範囲は行の高さにも残さない
		decoration: Decoration.replace({})
	});
}
