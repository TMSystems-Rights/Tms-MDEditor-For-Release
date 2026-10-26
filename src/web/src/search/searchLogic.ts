/**
 * 文書内の検索一致を数える、または前後へ移動する範囲を返す
 * パネルの描画とスクロールは持たない
 * @file
 */
import { type EditorState } from '@codemirror/state';
import { type SearchQuery } from '@codemirror/search';

/**
 * 検索ヒットの現在位置と総数
 * ヒットが無いときは両方 0。現在位置は 1 始まり
 */
export type SearchMatchStatus = {
	/** 現在位置。1 始まり。ヒットが無いときは 0 */
	current: number;
	/** 文書内のヒット総数。無いときは 0 */
	total: number;
};

/**
 * 一致を辿る方向
 * `next` は文書の後ろ、`previous` は前。端では反対の端へ戻る
 */
export type SearchMatchDirection = 'next' | 'previous';

/**
 * 文書上の 1 件の一致
 * `from` は含み、`to` は含まない
 */
export type SearchMatchRange = {
	/** 一致の開始位置。文書先頭からの文字数 */
	from: number;
	/** 一致の終了位置。この位置は含まない */
	to: number;
};

/**
 * CodeMirror の正規表現検索と同じフラグで構文を検証する
 * 空のパターンはエラーにしない。不正なときは日本語の説明を返す
 * @param pattern - 検証する正規表現。空文字は妥当とみなす
 * @returns 日本語のエラーメッセージ。妥当なときは null
 */
export function getRegularExpressionError(pattern: string): string | null {
	// 空のパターンは検索式として妥当。構文エラーにしない
	if (!pattern) {
		return null;
	}

	try {
		// @codemirror/search の RegExpCursor と同じ g/m/u フラグで検証する
		new RegExp(pattern, 'gmu');
		return null;
	} catch (error) {
		// Error なら message、それ以外は文字列化した説明
		const detail = error instanceof Error ? error.message : String(error);
		return `正規表現が正しくありません: ${detail}`;
	}
}

/**
 * 検索ヒット総数と、選択から見た現在位置を数える
 * 選択と完全一致、選択を含む一致、次の一致の順で現在位置を決める。次が無いときは 1 件目を現在とする
 * @param state - 検索対象のエディタ状態。主選択を現在位置の基準にする
 * @param query - 検索条件。無効なクエリは 0 件
 * @returns 1 始まりの現在位置と総数。ヒットが無いときは両方 0
 */
export function countSearchMatches(state: EditorState, query: SearchQuery): SearchMatchStatus {
	// 文書順の一致。無効クエリは空
	const matches = getSearchMatches(state, query);
	// ヒットが無い。現在位置も総数も 0
	if (matches.length === 0) {
		// 件数 0 の現在位置
		return {
			// 1 始まりの現在位置。件数 0 のときは 0
			current: 0,
			// 総数。ヒットが無い
			total: 0
		};
	}

	// 主選択。現在位置の基準
	const selection  = state.selection.main;
	// 選択と端が一致するヒットの位置。無ければ -1
	const exactIndex = matches.findIndex((match) => match.from === selection.from && match.to === selection.to);
	// 選択と完全一致するヒットがある。現在位置はその番号（1 始まり）
	if (exactIndex >= 0) {
		// 完全一致を現在位置にした件数
		return {
			// 1 始まりの番号
			current: exactIndex + 1,
			// 文書内の総数
			total: matches.length
		};
	}

	// 選択位置を内側に含むヒット。完全一致が無いときの候補。無ければ -1
	const containingIndex = matches.findIndex((match) => match.from <= selection.head && selection.head <= match.to);
	// キャレットがヒットの内側。完全一致が無いときの現在位置
	if (containingIndex >= 0) {
		// 内側一致を現在位置にした件数
		return {
			// 1 始まりの番号
			current: containingIndex + 1,
			// 文書内の総数
			total: matches.length
		};
	}

	// 選択位置以降で始まる最初のヒット。無ければ -1 で 1 件目を現在にする
	const nextIndex = matches.findIndex((match) => match.from >= selection.head);
	// 後ろに次が無いときは 1 件目を現在にする
	return {
		// 次のヒットの番号。後ろに無ければ 1
		current: nextIndex >= 0 ? nextIndex + 1 : 1,
		// 文書内の総数。この時点では 1 件以上
		total: matches.length
	};
}

/**
 * 現在選択から見た次または前の検索一致範囲を返す
 * 選択と完全一致するヒットがあればその隣へ進み、端では反対の端へ戻る
 * @param state - 検索対象のエディタ状態。主選択を基準にする
 * @param query - 検索条件。無効なクエリは一致なし
 * @param direction - `next` は後ろ、`previous` は前
 * @returns 移動先の一致。ヒットが無いときは null
 */
export function findSearchMatch(state: EditorState, query: SearchQuery, direction: SearchMatchDirection): SearchMatchRange | null {
	// 文書順の一致。無効クエリは空
	const matches = getSearchMatches(state, query);
	// ヒットが無いので移動先も無い
	if (matches.length === 0) {
		return null;
	}

	// 主選択。隣を決める基準
	const selection  = state.selection.main;
	// 選択と端が一致するヒットの位置。無ければ -1
	const exactIndex = matches.findIndex((match) => match.from === selection.from && match.to === selection.to);

	// 後ろへ進む。完全一致の次、無ければ選択終端以降、それも無ければ先頭へ戻る
	if (direction === 'next') {
		// 選択と一致するヒットの次。末尾の次は先頭
		if (exactIndex >= 0) {
			return matches[(exactIndex + 1) % matches.length];
		}

		return matches.find((match) => match.from >= selection.to) ?? matches[0];
	}

	// 前へ進み、選択と一致するヒットがある。先頭の前は末尾
	if (exactIndex >= 0) {
		return matches[(exactIndex - 1 + matches.length) % matches.length];
	}

	for (let index = matches.length - 1; index >= 0; index -= 1) {
		// 後ろから見ているヒット
		const match = matches[index];
		// ヒットの終端が選択開始以前。前方向で最も近い
		if (match.to <= selection.from) {
			return match;
		}
	}

	return matches[matches.length - 1];
}

/**
 * 指定位置から見た次または前の検索一致範囲を返す
 * 位置は文書長へ収め、次は終了が位置以降の最初、前は開始が位置以前の最後を返す
 * @param state - 検索対象のエディタ状態
 * @param query - 検索条件。無効なクエリは一致なし
 * @param position - 基準の文書位置。範囲外は 0 から文書長へ収める
 * @param direction - `next` は後ろ、`previous` は前
 * @returns 移動先の一致。ヒットが無いときは null
 */
export function findSearchMatchFromPosition(state: EditorState, query: SearchQuery, position: number, direction: SearchMatchDirection): SearchMatchRange | null {
	// 文書順の一致。無効クエリは空
	const matches = getSearchMatches(state, query);
	// ヒットが無いので移動先も無い
	if (matches.length === 0) {
		return null;
	}

	// 文書長へ収めた基準位置。負や文書外は 0 から文書長
	const clampedPosition = Math.min(Math.max(position, 0), state.doc.length);

	// 後ろへ進む。終了が基準以降の最初、無ければ先頭へ戻る
	if (direction === 'next') {
		return matches.find((match) => match.to >= clampedPosition) ?? matches[0];
	}

	for (let index = matches.length - 1; index >= 0; index -= 1) {
		// 後ろから見ているヒット
		const match = matches[index];
		// 開始が基準以前。前方向で最も近い
		if (match.from <= clampedPosition) {
			return match;
		}
	}

	return matches[matches.length - 1];
}

/**
 * 現在の一致範囲を基準に、次または前の検索一致範囲を返す
 * 現在範囲が無いときは選択基準の `findSearchMatch` へ委譲する。端では反対の端へ戻る
 * @param state - 検索対象のエディタ状態
 * @param query - 検索条件。無効なクエリは一致なし
 * @param current - いま表示している一致。null のときは選択を基準にする
 * @param direction - `next` は後ろ、`previous` は前
 * @returns 移動先の一致。ヒットが無いときは null
 */
export function findSearchMatchFromRange(state: EditorState, query: SearchQuery, current: SearchMatchRange | null, direction: SearchMatchDirection): SearchMatchRange | null {
	// 基準範囲が無いので、選択基準の移動へ任せる
	if (!current) {
		return findSearchMatch(state, query, direction);
	}

	// 文書順の一致。無効クエリは空
	const matches = getSearchMatches(state, query);
	// ヒットが無いので移動先も無い
	if (matches.length === 0) {
		return null;
	}

	// 基準範囲と同じヒットの位置。無ければ -1
	const exactIndex = matches.findIndex((match) => match.from === current.from && match.to === current.to);

	// 基準範囲と同じヒットがある。隣へ進み、端では反対の端へ戻る
	if (exactIndex >= 0) {
		return direction === 'next' ? matches[(exactIndex + 1) % matches.length] : matches[(exactIndex - 1 + matches.length) % matches.length];
	}

	// 一致が無いときの後ろ方向。基準の終端以降、無ければ先頭
	if (direction === 'next') {
		return matches.find((match) => match.from >= current.to) ?? matches[0];
	}

	for (let index = matches.length - 1; index >= 0; index -= 1) {
		// 後ろから見ているヒット
		const match = matches[index];
		// 終端が基準の開始以前。前方向で最も近い
		if (match.to <= current.from) {
			return match;
		}
	}

	return matches[matches.length - 1];
}

/**
 * 検索条件に一致する範囲を文書全体から列挙する
 * 無効なクエリは空配列。並びは文書順
 * @param state - 検索対象のエディタ状態
 * @param query - 検索条件。`valid` が false なら列挙しない
 * @returns 文書順の一致範囲。無いときは空配列
 */
function getSearchMatches(state: EditorState, query: SearchQuery): SearchMatchRange[] {
	// クエリが無効。列挙せず空
	if (!query.valid) {
		return [];
	}

	// 文書順に積む一致。無効クエリは上で空配列
	const matches: SearchMatchRange[] = [];
	// 検索カーソル。done まで next で進む
	const cursor                      = query.getCursor(state);
	for (let next = cursor.next(); !next.done; next = cursor.next()) {
		// 1 件の一致範囲。終了位置は含まない
		matches.push({
			// 一致の開始。文書先頭からの文字数
			from: next.value.from,
			// 一致の終了。この位置は含まない
			to: next.value.to
		});
	}

	return matches;
}
