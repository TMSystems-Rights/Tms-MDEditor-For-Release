/**
 * タブ選択履歴の更新と、選択中のタブを外したあとの選択先を検証する
 * @file
 */

import { describe, expect, it } from 'vitest';
import { pickTabAfterRemoval, recordTabFocus } from './tabFocusHistory';

describe('recordTabFocus', () => {
	it('選択したタブを末尾へ足す', () => {
		expect(recordTabFocus(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
	});

	it('既にあるタブは前の位置から除いて末尾へ移す', () => {
		expect(recordTabFocus(['a', 'b', 'c'], 'a')).toEqual(['b', 'c', 'a']);
	});

	it('引数の履歴は書き換えない', () => {
		// 呼び出し前の履歴。戻り値とは別の配列のまま残る
		const history = ['a', 'b'];
		recordTabFocus(history, 'a');
		expect(history).toEqual(['a', 'b']);
	});
});

describe('pickTabAfterRemoval', () => {
	it('直前に選んでいたタブを選ぶ', () => {
		// a b c d e から e を閉じた。選んだ順は b、d、e
		expect(pickTabAfterRemoval(['a', 'b', 'c', 'd'], ['b', 'd'], 4)).toBe('d');
	});

	it('並びから消えたタブは飛ばして、残っている中で直近のものを選ぶ', () => {
		// x は別ペインへ移った後で、並びには無い
		expect(pickTabAfterRemoval(['a', 'b', 'c'], ['b', 'x'], 1)).toBe('b');
	});

	it('履歴に残るタブが無ければ、閉じたタブの1つ左を選ぶ', () => {
		// a b c d から c を閉じた。履歴は空
		expect(pickTabAfterRemoval(['a', 'b', 'd'], [], 2)).toBe('b');
	});

	it('左端のタブを閉じたときは、新しい左端を選ぶ', () => {
		// a b c から a を閉じた。右隣だった b が左端になる
		expect(pickTabAfterRemoval(['b', 'c'], [], 0)).toBe('b');
	});

	it('位置が並びより右にあるときは、右端を選ぶ', () => {
		expect(pickTabAfterRemoval(['a', 'b'], [], 9)).toBe('b');
	});

	it('残るタブが無ければ null を返す', () => {
		expect(pickTabAfterRemoval([], ['a'], 0)).toBeNull();
	});
});
