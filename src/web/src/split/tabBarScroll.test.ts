import { describe, expect, it } from 'vitest';
import { applyTabBarWheelScroll, computeTabRevealScrollLeft, getTabBarWheelScrollDelta } from './tabBarScroll';

describe('タブバーの横スクロール', () => {
	it('縦ホイールを横スクロール量として使う', () => {
		expect(getTabBarWheelScrollDelta({ deltaX: 0, deltaY: 40, ctrlKey: false })).toBe(40);
	});

	it('横ホイールの方が大きいときはその値を使う', () => {
		expect(getTabBarWheelScrollDelta({ deltaX: -24, deltaY: 8, ctrlKey: false })).toBe(-24);
	});

	it('溢れているタブバーへホイール差分を適用する', () => {
		const tabBar = { scrollLeft: 10, scrollWidth: 400, clientWidth: 200, left: 0, right: 200 };
		expect(applyTabBarWheelScroll(tabBar, { deltaX: 0, deltaY: 30, ctrlKey: false })).toBe(true);
		expect(tabBar.scrollLeft).toBe(40);
	});

	it('Ctrl+ホイールや溢れが無い場合は横スクロールしない', () => {
		const overflowing = { scrollLeft: 0, scrollWidth: 400, clientWidth: 200, left: 0, right: 200 };
		const fitting     = { scrollLeft: 0, scrollWidth: 180, clientWidth: 200, left: 0, right: 200 };
		expect(applyTabBarWheelScroll(overflowing, { deltaX: 0, deltaY: 30, ctrlKey: true })).toBe(false);
		expect(applyTabBarWheelScroll(fitting, { deltaX: 0, deltaY: 30, ctrlKey: false })).toBe(false);
		expect(overflowing.scrollLeft).toBe(0);
		expect(fitting.scrollLeft).toBe(0);
	});

	it('見切れたタブが可視範囲に入る scrollLeft を返す', () => {
		const scroller = { scrollLeft: 80, scrollWidth: 400, clientWidth: 200, left: 100, right: 300 };
		expect(computeTabRevealScrollLeft(scroller, { left: 60, right: 140 })).toBe(40);
		expect(computeTabRevealScrollLeft(scroller, { left: 280, right: 360 })).toBe(140);
		expect(computeTabRevealScrollLeft(scroller, { left: 140, right: 220 })).toBe(80);
	});
});
