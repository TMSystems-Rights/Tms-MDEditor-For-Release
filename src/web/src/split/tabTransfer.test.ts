/**
 * タブバーの挿入位置と、最後のタブを移したあとのウィンドウ終了判定を検証する
 * @file
 */

import { describe, expect, it } from 'vitest';
import { calculateTabDropIndex, shouldCloseWindowAfterTabRemoval } from './tabTransfer';

describe('calculateTabDropIndex', () => {
	/** タブ 3 つの左右端。中央を境に挿入位置が変わる */
	const tabRects = [
		{ left: 10, right: 110 },
		{ left: 113, right: 213 },
		{ left: 216, right: 316 }
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
		expect(shouldCloseWindowAfterTabRemoval(0, false, true)).toBe(true);
	});

	it('通常操作では最終タブ終了設定に従う', () => {
		expect(shouldCloseWindowAfterTabRemoval(0, true, false)).toBe(true);
		expect(shouldCloseWindowAfterTabRemoval(0, false, false)).toBe(false);
		expect(shouldCloseWindowAfterTabRemoval(1, true, true)).toBe(false);
	});
});
