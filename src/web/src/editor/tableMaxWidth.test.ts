/**
 * 表の最大幅が、表示領域から余白を引き、横スクロールでは変わらず、負にならないことを検証する
 * DOM は測らず、resolveTableMaxWidth の計算だけを見る
 * @file
 */
import { describe, expect, it } from 'vitest';
import { resolveTableMaxWidth } from './tableMaxWidth';

describe('表の最大幅', () => {
	it('表示中の編集領域から余白を引いた幅になる', () => {
		expect(
			resolveTableMaxWidth({
				// 編集領域の右端。px
				visibleRight: 800,
				// 本文の左端。px。スクロールしていない
				contentLeft: 120,
				// 横スクロール。px。0 は先頭
				scrollLeft: 0,
				// 左右の余白。px。表示幅から引く
				horizontalInset: 16
			})
		).toBe(664);
	});

	it('横スクロールしても表示幅は変わらない', () => {
		// スクロール前の最大幅。contentLeft と scrollLeft の和は 120
		const atStart  = resolveTableMaxWidth({
			// 編集領域の右端。px
			visibleRight: 800,
			// 本文の左端。px
			contentLeft: 120,
			// 横スクロール。px。先頭
			scrollLeft: 0,
			// 左右の余白。px
			horizontalInset: 16
		});
		// 80px スクロール後。左端が減った分と scrollLeft が増えた分は同じ
		const scrolled = resolveTableMaxWidth({
			// 編集領域の右端。px。スクロール前と同じ
			visibleRight: 800,
			// 本文の左端。px。スクロールで 80 減った
			contentLeft: 40,
			// 横スクロール。px。左端の減少と同じ量
			scrollLeft: 80,
			// 左右の余白。px。スクロール前と同じ
			horizontalInset: 16
		});
		expect(scrolled).toBe(atStart);
	});

	it('端数は切り下げ、負の幅は 0 にする', () => {
		expect(
			resolveTableMaxWidth({
				// 編集領域の右端。px。端数がある
				visibleRight: 200.9,
				// 本文の左端。px
				contentLeft: 10,
				// 横スクロール。px。先頭
				scrollLeft: 0,
				// 左右の余白。px。端数がある
				horizontalInset: 0.2
			})
		).toBe(190);
		// 余白を引くと負になる寸法。幅は 0 に切り上げる
		expect(
			resolveTableMaxWidth({
				// 編集領域の右端。px。左端より小さい
				visibleRight: 10,
				// 本文の左端。px。右端を超えている
				contentLeft: 40,
				// 横スクロール。px。先頭
				scrollLeft: 0,
				// 左右の余白。px。負の幅をさらに広げる
				horizontalInset: 8
			})
		).toBe(0);
	});
});
