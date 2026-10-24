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
	if (!pattern) {
		return null;
	}

	try {
		// @codemirror/search の RegExpCursor と同じ g/m/u フラグで検証する
		new RegExp(pattern, 'gmu');
		return null;
	} catch (error) {
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
	const matches = getSearchMatches(state, query);
	if (matches.length === 0) {
		return { current: 0, total: 0 };
	}

	const selection  = state.selection.main;
	const exactIndex = matches.findIndex((match) => (
		match.from === selection.from && match.to === selection.to
	));
	if (exactIndex >= 0) {
		return { current: exactIndex + 1, total: matches.length };
	}

	const containingIndex = matches.findIndex((match) => (
		match.from <= selection.head && selection.head <= match.to
	));
	if (containingIndex >= 0) {
		return { current: containingIndex + 1, total: matches.length };
	}

	const nextIndex = matches.findIndex((match) => match.from >= selection.head);
	return {
		current: nextIndex >= 0 ? nextIndex + 1 : 1,
		total  : matches.length,
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
export function findSearchMatch(
	state: EditorState,
	query: SearchQuery,
	direction: SearchMatchDirection,
): SearchMatchRange | null {
	const matches = getSearchMatches(state, query);
	if (matches.length === 0) {
		return null;
	}

	const selection  = state.selection.main;
	const exactIndex = matches.findIndex((match) => (
		match.from === selection.from && match.to === selection.to
	));

	if (direction === 'next') {
		if (exactIndex >= 0) {
			return matches[(exactIndex + 1) % matches.length];
		}

		return matches.find((match) => match.from >= selection.to) ?? matches[0];
	}

	if (exactIndex >= 0) {
		return matches[(exactIndex - 1 + matches.length) % matches.length];
	}

	for (let index = matches.length - 1; index >= 0; index -= 1) {
		const match = matches[index];
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
export function findSearchMatchFromPosition(
	state: EditorState,
	query: SearchQuery,
	position: number,
	direction: SearchMatchDirection,
): SearchMatchRange | null {
	const matches = getSearchMatches(state, query);
	if (matches.length === 0) {
		return null;
	}

	const clampedPosition = Math.min(Math.max(position, 0), state.doc.length);

	if (direction === 'next') {
		return matches.find((match) => match.to >= clampedPosition) ?? matches[0];
	}

	for (let index = matches.length - 1; index >= 0; index -= 1) {
		const match = matches[index];
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
export function findSearchMatchFromRange(
	state: EditorState,
	query: SearchQuery,
	current: SearchMatchRange | null,
	direction: SearchMatchDirection,
): SearchMatchRange | null {
	if (!current) {
		return findSearchMatch(state, query, direction);
	}

	const matches = getSearchMatches(state, query);
	if (matches.length === 0) {
		return null;
	}

	const exactIndex = matches.findIndex((match) => (
		match.from === current.from && match.to === current.to
	));

	if (exactIndex >= 0) {
		return direction === 'next'
			? matches[(exactIndex + 1) % matches.length]
			: matches[(exactIndex - 1 + matches.length) % matches.length];
	}

	if (direction === 'next') {
		return matches.find((match) => match.from >= current.to) ?? matches[0];
	}

	for (let index = matches.length - 1; index >= 0; index -= 1) {
		const match = matches[index];
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
	if (!query.valid) {
		return [];
	}

	const matches: SearchMatchRange[] = [];
	const cursor                      = query.getCursor(state);
	for (let next = cursor.next(); !next.done; next = cursor.next()) {
		matches.push({
			from: next.value.from,
			to  : next.value.to,
		});
	}

	return matches;
}
