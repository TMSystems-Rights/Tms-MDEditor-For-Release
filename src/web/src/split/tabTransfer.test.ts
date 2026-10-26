/**
 * タブバーの挿入位置と、最後のタブを移したあとのウィンドウ終了判定を検証する
 * @file
 */

import { describe, expect, it } from 'vitest';
import { calculateTabDropIndex, shouldCloseWindowAfterTabRemoval } from './tabTransfer';

describe('calculateTabDropIndex', () => {
	// タブ 3 つの左右端。各タブの中央を境に挿入位置が変わる
	const tabRects = [
		// 左端のタブ。中央より左なら先頭へ入る
		{
			// タブ左端。px
			left: 10,
			// タブ右端。px。中央は 60
			right: 110
		},
		// 中央のタブ。中央より左なら 1、右なら 2 へ入る
		{
			// タブ左端。px
			left: 113,
			// タブ右端。px。中央は 163
			right: 213
		},
		// 右端のタブ。中央より右なら末尾の 3 へ入る
		{
			// タブ左端。px
			left: 216,
			// タブ右端。px。中央は 266
			right: 316
		}
	];

	it('各タブの中央を境に前後の挿入位置を返す', () => {
		expect(calculateTabDropIndex(tabRects, 20)).toBe(0);
		expect(calculateTabDropIndex(tabRects, 80)).toBe(1);
		expect(calculateTabDropIndex(tabRects, 180)).toBe(2);
		expect(calculateTabDropIndex(tabRects, 300)).toBe(3);
	});

	it('対象タブがない場合は先頭を返す', () => {
		expect(calculateTabDropIndex([], 100)).toBe(0);
	});
});

describe('shouldCloseWindowAfterTabRemoval', () => {
	it('転送によって最後のタブがなくなる場合は設定にかかわらず閉じる', () => {
		// 残タブ 0、最終タブでは閉じない設定、転送あり。引数順は残数、設定、転送
		expect(shouldCloseWindowAfterTabRemoval(0, false, true)).toBe(true);
	});

	it('通常操作では最終タブ終了設定に従う', () => {
		// 残タブ 0、閉じる設定、転送ではない。設定どおり閉じる
		expect(shouldCloseWindowAfterTabRemoval(0, true, false)).toBe(true);
		// 残タブ 0、閉じない設定、転送ではない。どちらも無いので閉じない
		expect(shouldCloseWindowAfterTabRemoval(0, false, false)).toBe(false);
		// 残タブが 1 ある。設定と転送が両方真でも、残数があるときは閉じない
		expect(shouldCloseWindowAfterTabRemoval(1, true, true)).toBe(false);
	});
});
