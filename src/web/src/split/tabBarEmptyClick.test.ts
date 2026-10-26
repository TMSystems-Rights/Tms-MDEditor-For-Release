/**
 * タブバー空白のダブルクリックと、横スクロールバーの当たりを確認する
 * @file
 */
import { describe, expect, it } from 'vitest';
import { isPointInHorizontalScrollbar, shouldOpenUntitledTabOnTabBarDoubleClick } from './tabBarEmptyClick';

describe('タブバー空白のダブルクリック', () => {
	it('タブ外かつボタン外かつスクロールバー外なら新規タブを開く', () => {
		expect(
			shouldOpenUntitledTabOnTabBarDoubleClick({
				// 既存タブの矩形外。true だと開かない
				onTab: false,
				// 新規タブボタンの矩形外。true だと開かない
				onNewTabButton: false,
				// 横スクロールバーの帯の外。true だと開かない
				inHorizontalScrollbar: false
			})
		).toBe(true);
	});

	it('既存タブ上では開かない', () => {
		expect(
			shouldOpenUntitledTabOnTabBarDoubleClick({
				// 既存タブの上。この 1 つで開かない
				onTab: true,
				// 新規タブボタンの矩形外
				onNewTabButton: false,
				// 横スクロールバーの帯の外
				inHorizontalScrollbar: false
			})
		).toBe(false);
	});

	it('新規タブボタン上では開かない', () => {
		expect(
			shouldOpenUntitledTabOnTabBarDoubleClick({
				// 既存タブの矩形外
				onTab: false,
				// 新規タブボタンの上。この 1 つで開かない
				onNewTabButton: true,
				// 横スクロールバーの帯の外
				inHorizontalScrollbar: false
			})
		).toBe(false);
	});

	it('横スクロールバー上では開かない', () => {
		expect(
			shouldOpenUntitledTabOnTabBarDoubleClick({
				// 既存タブの矩形外
				onTab: false,
				// 新規タブボタンの矩形外
				onNewTabButton: false,
				// 横スクロールバーの上。この 1 つで開かない
				inHorizontalScrollbar: true
			})
		).toBe(false);
	});

	it('横スクロールバー領域の点だけ true になる', () => {
		// 高さが clientHeight より大きい容器。下端の帯がスクロールバー
		const box = {
			// 容器の左端。px
			left: 10,
			// 容器の右端。px
			right: 210,
			// 容器の上端。px
			top: 20,
			// 容器の下端。px。上端との差が clientHeight より大きい
			bottom: 52,
			// 中身の可視高さ。px。下端との差がバーの厚さ
			clientHeight: 24
		};
		expect(isPointInHorizontalScrollbar(box, 100, 48)).toBe(true);
		expect(isPointInHorizontalScrollbar(box, 100, 30)).toBe(false);
		expect(isPointInHorizontalScrollbar(box, 5, 48)).toBe(false);
	});

	it('スクロールバーが無い容器では false になる', () => {
		// 高さと clientHeight が同じ容器。横スクロールバーは無い
		const box = {
			// 容器の左端。px
			left: 0,
			// 容器の右端。px
			right: 200,
			// 容器の上端。px
			top: 0,
			// 容器の下端。px。clientHeight と同じ高さ
			bottom: 24,
			// 中身の可視高さ。px。下端と一致するのでバーは無い
			clientHeight: 24
		};
		expect(isPointInHorizontalScrollbar(box, 100, 20)).toBe(false);
	});
});
