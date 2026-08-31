import { type EditorState } from '@codemirror/state';
import { type SearchQuery } from '@codemirror/search';

export type SearchMatchStatus = {
	current: number;
	total: number;
};

export type SearchMatchDirection = 'next' | 'previous';

export type SearchMatchRange = {
	from: number;
	to: number;
};

/**
 * CodeMirror の正規表現検索と同じフラグで構文を検証する
 * @param {string} pattern 正規表現パターン
 * @returns {string | null} エラーメッセージ。妥当な場合は null
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
 * 検索ヒット総数と現在位置を数える
 * @param {EditorState} state エディタ状態
 * @param {SearchQuery} query 検索条件
 * @returns {SearchMatchStatus} 現在位置と総数
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
 * 現在選択から見た次 / 前の検索一致範囲を返す
 * @param {EditorState} state エディタ状態
 * @param {SearchQuery} query 検索条件
 * @param {SearchMatchDirection} direction 検索方向
 * @returns {SearchMatchRange | null} 一致範囲。該当なしの場合 null
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
 * 指定位置から見た次 / 前の検索一致範囲を返す
 * @param {EditorState} state エディタ状態
 * @param {SearchQuery} query 検索条件
 * @param {number} position 検索基準位置
 * @param {SearchMatchDirection} direction 検索方向
 * @returns {SearchMatchRange | null} 一致範囲。該当なしの場合 null
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
 * 現在一致範囲を基準に次 / 前の検索一致範囲を返す
 * @param {EditorState} state エディタ状態
 * @param {SearchQuery} query 検索条件
 * @param {SearchMatchRange | null} current 現在一致範囲
 * @param {SearchMatchDirection} direction 検索方向
 * @returns {SearchMatchRange | null} 一致範囲。該当なしの場合 null
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
 * @param {EditorState} state エディタ状態
 * @param {SearchQuery} query 検索条件
 * @returns {SearchMatchRange[]} 一致範囲一覧
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
