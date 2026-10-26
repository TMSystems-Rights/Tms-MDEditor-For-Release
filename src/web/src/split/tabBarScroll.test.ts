/**
 * タブバーのホイールを横スクロールへ変える量と、見切れたタブの移動量を確認する
 * @file
 */
import { describe, expect, it } from 'vitest';
import { applyTabBarWheelScroll, computeTabRevealScrollLeft, getTabBarWheelScrollDelta } from './tabBarScroll';

describe('タブバーの横スクロール', () => {
	it('縦ホイールを横スクロール量として使う', () => {
		expect(
			getTabBarWheelScrollDelta({
				// 横方向の差分は無い。縦だけを採用する
				deltaX: 0,
				// 縦方向の差分。横が 0 なので、この値が横スクロール量になる
				deltaY: 40,
				// Ctrl は押していない。ズームへは譲らない
				ctrlKey: false
			})
		).toBe(40);
	});

	it('横ホイールの方が大きいときはその値を使う', () => {
		expect(
			getTabBarWheelScrollDelta({
				// 横方向の差分。絶対値が縦より大きいので、こちらを採用する
				deltaX: -24,
				// 縦方向の差分。絶対値は横より小さく、採用しない
				deltaY: 8,
				// Ctrl は押していない。ズームへは譲らない
				ctrlKey: false
			})
		).toBe(-24);
	});

	it('溢れているタブバーへホイール差分を適用する', () => {
		// 内容幅が可視幅を超えるタブバー。scrollLeft 10 から 30 進む
		const tabBar = {
			// 適用前の横位置。px
			scrollLeft: 10,
			// 内容の全幅。px。可視幅より広い
			scrollWidth: 400,
			// 可視幅。px。これを超える分が溢れる
			clientWidth: 200,
			// 容器の左端。px。このケースの移動量には使わない
			left: 0,
			// 容器の右端。px。このケースの移動量には使わない
			right: 200
		};
		expect(
			applyTabBarWheelScroll(tabBar, {
				// 横方向の差分は無い
				deltaX: 0,
				// 縦ホイール。横スクロール量として 30px 足す
				deltaY: 30,
				// Ctrl は押していない。適用を拒否しない
				ctrlKey: false
			})
		).toBe(true);
		expect(tabBar.scrollLeft).toBe(40);
	});

	it('Ctrl+ホイールや溢れが無い場合は横スクロールしない', () => {
		// 溢れているが、Ctrl 付きなのでスクロールしない容器
		const overflowing = {
			// 適用前の横位置。px。呼び出し後も 0 のまま
			scrollLeft: 0,
			// 内容の全幅。px。可視幅より広い
			scrollWidth: 400,
			// 可視幅。px
			clientWidth: 200,
			// 容器の左端。px
			left: 0,
			// 容器の右端。px
			right: 200
		};
		// 内容が可視幅に収まり、ホイールを横へ変えない容器
		const fitting     = {
			// 適用前の横位置。px。呼び出し後も 0 のまま
			scrollLeft: 0,
			// 内容の全幅。px。可視幅より狭い
			scrollWidth: 180,
			// 可視幅。px。内容より広いので溢れない
			clientWidth: 200,
			// 容器の左端。px
			left: 0,
			// 容器の右端。px
			right: 200
		};
		expect(
			applyTabBarWheelScroll(overflowing, {
				// 横方向の差分は無い
				deltaX: 0,
				// 縦ホイール。Ctrl があるため適用しない
				deltaY: 30,
				// UI ズームへ譲る。横スクロールはしない
				ctrlKey: true
			})
		).toBe(false);
		expect(
			applyTabBarWheelScroll(fitting, {
				// 横方向の差分は無い
				deltaX: 0,
				// 縦ホイール。溢れが無いため適用しない
				deltaY: 30,
				// Ctrl は押していない。拒否理由は溢れが無いこと
				ctrlKey: false
			})
		).toBe(false);
		expect(overflowing.scrollLeft).toBe(0);
		expect(fitting.scrollLeft).toBe(0);
	});

	it('見切れたタブが可視範囲に入る scrollLeft を返す', () => {
		// 可視範囲が 100〜300 の容器。scrollLeft は 80
		const scroller = {
			// 現在の横位置。px。見えているタブではこの値のまま
			scrollLeft: 80,
			// 内容の全幅。px
			scrollWidth: 400,
			// 可視幅。px
			clientWidth: 200,
			// 可視範囲の左端。px。タブ左端がこれより左なら戻す
			left: 100,
			// 可視範囲の右端。px。タブ右端がこれより右なら進める
			right: 300
		};
		expect(
			computeTabRevealScrollLeft(scroller, {
				// タブ左端。px。可視範囲の左より外側
				left: 60,
				// タブ右端。px。左へ寄せれば可視範囲に入る
				right: 140
			})
		).toBe(40);
		expect(
			computeTabRevealScrollLeft(scroller, {
				// タブ左端。px。右へ寄せないと見切れる
				left: 280,
				// タブ右端。px。可視範囲の右より外側
				right: 360
			})
		).toBe(140);
		expect(
			computeTabRevealScrollLeft(scroller, {
				// タブ左端。px。可視範囲の中
				left: 140,
				// タブ右端。px。可視範囲の中なので scrollLeft は変えない
				right: 220
			})
		).toBe(80);
	});
});
