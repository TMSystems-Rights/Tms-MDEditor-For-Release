import { describe, expect, it } from 'vitest';
import { isPointInHorizontalScrollbar, shouldOpenUntitledTabOnTabBarDoubleClick } from './tabBarEmptyClick';

describe('タブバー空白のダブルクリック', () => {
	it('タブ外かつボタン外かつスクロールバー外なら新規タブを開く', () => {
		expect(shouldOpenUntitledTabOnTabBarDoubleClick({
			onTab                 : false,
			onNewTabButton        : false,
			inHorizontalScrollbar : false
		})).toBe(true);
	});

	it('既存タブ上では開かない', () => {
		expect(shouldOpenUntitledTabOnTabBarDoubleClick({
			onTab                 : true,
			onNewTabButton        : false,
			inHorizontalScrollbar : false
		})).toBe(false);
	});

	it('新規タブボタン上では開かない', () => {
		expect(shouldOpenUntitledTabOnTabBarDoubleClick({
			onTab                 : false,
			onNewTabButton        : true,
			inHorizontalScrollbar : false
		})).toBe(false);
	});

	it('横スクロールバー上では開かない', () => {
		expect(shouldOpenUntitledTabOnTabBarDoubleClick({
			onTab                 : false,
			onNewTabButton        : false,
			inHorizontalScrollbar : true
		})).toBe(false);
	});

	it('横スクロールバー領域の点だけ true になる', () => {
		const box = { left: 10, right: 210, top: 20, bottom: 52, clientHeight: 24 };
		expect(isPointInHorizontalScrollbar(box, 100, 48)).toBe(true);
		expect(isPointInHorizontalScrollbar(box, 100, 30)).toBe(false);
		expect(isPointInHorizontalScrollbar(box, 5, 48)).toBe(false);
	});

	it('スクロールバーが無い容器では false になる', () => {
		const box = { left: 0, right: 200, top: 0, bottom: 24, clientHeight: 24 };
		expect(isPointInHorizontalScrollbar(box, 100, 20)).toBe(false);
	});
});
