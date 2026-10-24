/**
 * アウトライン幅が左右の境界と最低幅を守ることを確認する
 * @file
 */
import { describe, expect, it } from 'vitest';
import { calculateOutlineWidth, clampOutlineWidth } from './outlineResize';

describe('outlineResize', () => {
	it('左右配置に応じて境界からアウトライン幅を求める', () => {
		expect(calculateOutlineWidth(350, 100, 900, 'left')).toBe(250);
		expect(calculateOutlineWidth(750, 100, 900, 'right')).toBe(250);
	});

	it('最小幅と本文の最低幅を守る', () => {
		expect(clampOutlineWidth(40, 900)).toBe(180);
		expect(clampOutlineWidth(850, 900)).toBe(660);
	});
});
