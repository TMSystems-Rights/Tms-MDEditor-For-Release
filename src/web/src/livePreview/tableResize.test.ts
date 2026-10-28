/**
 * 列幅と行高の下限、ヒット判定、レイアウト記憶を検証する
 * CSS と実装ソースは読み取り専用の定数で、ドラッグ中の DOM は作らない
 * @file
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { EXPORT_PREVIEW_CSS } from '../export/exportCss';
import {
	TABLE_RESIZE_DRAG_THRESHOLD_PX, // 4px 未満の移動をドラッグにしない閾値
	TABLE_RESIZE_HANDLE_PX, // 列と行の罫線を掴む幅
	clampColumnWidth, // 細すぎる列幅を下限へ戻す
	clampRowHeight, // 低すぎる行高を下限へ戻す
	clearTableLayouts, // ケース間で残る寸法記憶を空にする
	clearTableScrollPositions, // ケース間で残るスクロール記憶を空にする
	computeColumnRightEdges, // 結合をまたいだ列の右端座標
	computeColumnWidths, // セル幅から列幅の配列を作る
	forgetTableLayout, // 書き戻し後に1表の寸法だけ消す
	getTableLayoutKey, // 開始位置と列数を結んだ保存キー
	hasTableResizePointerMoved, // 閾値以上動いたときだけドラッグ
	isTableHeightConstrained, // none 以外の max-height があるか
	isTableHorizontallyOverflowing, // 表示幅を超えたときだけ横スクロール
	isTableVerticallyOverflowing, // 表示高を超えたときだけ縦スクロール
	recallTableLayout, // キーに紐づく列幅と行高
	recallTableScroll, // 表の開始位置に紐づくスクロール
	rememberTableLayout, // ドラッグ結果の列幅と行高
	rememberTableScroll, // 再フォーカス前の枠スクロール
	resolveActiveTableResizeLayout, // 動かしている軸だけ新しい寸法にする
	resolveFocusedTableScroll, // 先頭へ初期化された位置を操作前へ戻す
	resolveTableResizeHit, // 近い列境界か行境界か
	resolveTableRelativeOffset, // 親の余白とスクロールを足した座標
	shouldKeepTableHorizontalOverflow, // 矩形が外れても進んでいる横位置を残す
	shouldKeepTableVerticalOverflow, // 矩形が外れても進んでいる縦位置を残す
	shouldWrapTableCell // 固定列幅を超えたセルだけ折り返す
} from './tableResize';

/**
 * リサイズ用クラスが載っているかを見る、ライブプレビュー CSS
 * テスト中は読み取るだけで、書き換えない
 */
const livePreviewCss    = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../styles/livePreview.css'), 'utf8');
/**
 * 下限の数値が実装とずれていないかを見る、tableResize のソース
 * テスト中は読み取るだけで、書き換えない
 */
const tableResizeSource = readFileSync(fileURLToPath(new URL('./tableResize.ts', import.meta.url)), 'utf8');

describe('tableResize', () => {
	afterEach(() => {
		clearTableLayouts();
		clearTableScrollPositions();
	});

	it('表位置と列数でレイアウトキーを作る', () => {
		expect(getTableLayoutKey(12, 3)).toBe('12:3');
	});

	it('列幅と行高を覚えて取り出す', () => {
		// 2 列の幅と 2 行の高さ。キー 10:2 に紐づく
		rememberTableLayout('10:2', {
			// 列幅。左から 80、120
			widths: [80, 120],
			// 行高。上から 40、48
			heights: [40, 48]
		});
		// 同じキーで取り出した幅と高さ
		expect(recallTableLayout('10:2')).toEqual({
			// 覚えた列幅
			widths: [80, 120],
			// 覚えた行高
			heights: [40, 48]
		});
		forgetTableLayout('10:2');
		expect(recallTableLayout('10:2')).toBeUndefined();
	});

	it('結合セルでも列ごとの右端と幅を出す', () => {
		// 3 列をまたぐセルと、分割後の 1 列セル。右端は列ごとに揃う
		const boxes = [
			{
				// またぎセルの開始列。先頭
				column: 0,
				// またぐ列数。右端は 3 列目の終わり
				colspan: 3,
				// 左端。表の左
				left: 0,
				// 3 列分の幅
				width: 300
			},
			{
				// 1 列目
				column: 0,
				// またがない
				colspan: 1,
				// 左端。表の左
				left: 0,
				// 1 列目の幅
				width: 90
			},
			{
				// 2 列目
				column: 1,
				// またがない
				colspan: 1,
				// 1 列目の右端
				left: 90,
				// 2 列目の幅
				width: 110
			},
			{
				// 3 列目
				column: 2,
				// またがない
				colspan: 1,
				// 2 列目の右端
				left: 200,
				// 3 列目の幅
				width: 100
			}
		];
		expect(computeColumnRightEdges(boxes, 3)).toEqual([90, 200, 300]);
		expect(
			computeColumnWidths(
				[
					{
						// 3 列をまたぐセルの開始列
						column: 0,
						// またぐ列数。幅を等分する
						colspan: 3,
						// 左端。表の左
						left: 0,
						// 3 列分の幅。1 列あたり 100
						width: 300
					}
				],
				3
			)
		).toEqual([100, 100, 100]);
	});

	it('列と行の近い罫線を選ぶ', () => {
		// 列の方が近い。列 0 を選ぶ
		expect(
			resolveTableResizeHit(
				{
					// 近い列。先頭
					index: 0,
					// ポインタからの距離。行より近い
					distance: 2
				},
				{
					// 近い行
					index: 1,
					// 列より遠い
					distance: 5
				}
			)
		).toEqual({
			// 選んだ軸。列
			kind: 'col',
			// 選んだ列
			index: 0
		});
		// 行の方が近い。行 1 を選ぶ
		expect(
			resolveTableResizeHit(
				{
					// 近い列
					index: 0,
					// 行より遠い
					distance: 5
				},
				{
					// 近い行
					index: 1,
					// 列より近い
					distance: 2
				}
			)
		).toEqual({
			// 選んだ軸。行
			kind: 'row',
			// 選んだ行
			index: 1
		});
		// 行候補が無い。列だけを返す
		expect(
			resolveTableResizeHit(
				{
					// 近い列。3 列目の罫線
					index: 2,
					// ポインタからの距離
					distance: 1
				},
				null
			)
		).toEqual({
			// 選んだ軸。列
			kind: 'col',
			// 選んだ列
			index: 2
		});
		// 列候補が無い。行だけを返す
		expect(
			resolveTableResizeHit(null, {
				// 近い行。先頭
				index: 0,
				// ポインタからの距離
				distance: 1
			})
		).toEqual({
			// 選んだ軸。行
			kind: 'row',
			// 選んだ行
			index: 0
		});
		expect(resolveTableResizeHit(null, null)).toBeNull();
	});

	it('列幅と行高の下限を適用する', () => {
		expect(clampColumnWidth(10)).toBe(32);
		expect(clampColumnWidth(80.4)).toBe(80);
		expect(clampRowHeight(8)).toBe(24);
		expect(clampRowHeight(40.6)).toBe(41);
	});

	it('親の余白とスクロール量を含む表位置を求める', () => {
		expect(resolveTableRelativeOffset(64, 103, 0)).toBe(39);
		expect(resolveTableRelativeOffset(64, 83, 20)).toBe(39);
	});

	it('表本体が表示幅を超えた場合だけ横スクロールを必要とする', () => {
		expect(isTableHorizontallyOverflowing(26, 973, 1000)).toBe(false);
		expect(isTableHorizontallyOverflowing(26, 974.5, 1000)).toBe(false);
		expect(isTableHorizontallyOverflowing(26, 976, 1000)).toBe(true);
	});

	it('高さ制限があり表本体が表示高を超えた場合だけ縦スクロールを必要とする', () => {
		expect(isTableHeightConstrained('none')).toBe(false);
		expect(isTableHeightConstrained('')).toBe(false);
		expect(isTableHeightConstrained('0px')).toBe(false);
		expect(isTableHeightConstrained('720px')).toBe(true);
		expect(isTableVerticallyOverflowing(26, 119, 146)).toBe(false);
		expect(isTableVerticallyOverflowing(26, 120.5, 146)).toBe(false);
		expect(isTableVerticallyOverflowing(26, 122, 146)).toBe(true);
	});

	it('フォーカスで先頭へ戻ったスクロールだけ、操作前の位置を保つ', () => {
		// 480px 進んでいた枠が、フォーカスで先頭へ戻った。元の位置を保つ
		expect(resolveFocusedTableScroll(480, 0)).toBe(480);
		// 1px 以内の先頭も、同じ飛びとして戻す
		expect(resolveFocusedTableScroll(480, 1)).toBe(480);
		// セルを見せるための少しの移動は、そのまま使う
		expect(resolveFocusedTableScroll(480, 40)).toBe(40);
		// もともと先頭付近なら、フォーカス後の 0 をそのまま使う
		expect(resolveFocusedTableScroll(48, 0)).toBe(0);
		// 数でない位置は、次の値が数ならそれを使う
		expect(resolveFocusedTableScroll(Number.NaN, 12)).toBe(12);
	});

	it('すでにスクロールしている表は、矩形が外れても縦位置を維持する', () => {
		// 高さ制限が無い表は、中身が高くても縦スクロールにしない
		expect(shouldKeepTableVerticalOverflow(false, true, 800, 200, 120)).toBe(false);
		// 矩形が枠を超えていれば、先頭にいても維持する
		expect(shouldKeepTableVerticalOverflow(true, true, 200, 200, 0)).toBe(true);
		// 矩形は収まって見えても、中身が高く、すでに 120px 進んでいれば維持する
		expect(shouldKeepTableVerticalOverflow(true, false, 800, 200, 120)).toBe(true);
		// 先頭にいる 1px 差では、縦スクロールを出さない
		expect(shouldKeepTableVerticalOverflow(true, false, 201, 200, 0)).toBe(false);
		// 中身が表示高に収まっているなら、残っている位置は維持しない
		expect(shouldKeepTableVerticalOverflow(true, false, 200, 200, 120)).toBe(false);
	});

	it('すでに横へ進んでいる表は、矩形が外れても横位置を維持する', () => {
		// 矩形が枠を超えていれば維持する
		expect(shouldKeepTableHorizontalOverflow(true, 400, 400, 0)).toBe(true);
		// 中身が広く、すでに 80px 進んでいれば維持する
		expect(shouldKeepTableHorizontalOverflow(false, 900, 400, 80)).toBe(true);
		// 先頭の 1px 差では横スクロールを出さない
		expect(shouldKeepTableHorizontalOverflow(false, 401, 400, 0)).toBe(false);
	});

	it('表の開始位置ごとにスクロール位置を覚える', () => {
		rememberTableScroll('120', {
			// 横に 16px
			left: 16,
			// 縦に 480px
			top: 480
		});
		expect(recallTableScroll('120')).toEqual({
			// 覚えた横位置
			left: 16,
			// 覚えた縦位置
			top: 480
		});
		// 空の開始位置は覚えず、他の表の位置も返さない
		rememberTableScroll('', {
			// 空キーには残さない横位置
			left: 4,
			// 空キーには残さない縦位置
			top: 8
		});
		expect(recallTableScroll('')).toBeUndefined();
		expect(recallTableScroll('999')).toBeUndefined();
	});

	it('表に編集領域の 40% 下限を付けない', () => {
		expect(livePreviewCss).not.toMatch(/\.cm-md-table\s*\{[^}]*min-width:\s*40%/s);
		expect(EXPORT_PREVIEW_CSS).not.toMatch(/\.cm-md-table\s*\{[^}]*min-width:\s*40%/s);
	});

	it('リサイズ対象軸を4px以上動かした場合だけドラッグとして扱う', () => {
		expect(TABLE_RESIZE_DRAG_THRESHOLD_PX).toBe(4);
		// 列方向は 3px。閾値 4px 未満なのでドラッグにしない
		expect(
			hasTableResizePointerMoved(
				{
					// 動かしている軸。列
					kind: 'col',
					// 対象の列。先頭
					index: 0
				},
				{
					// 開始の横位置
					x: 100,
					// 開始の縦位置。縦の移動は列の判定に使わない
					y: 100
				},
				{
					// 現在の横位置。開始から 3px
					x: 103,
					// 現在の縦位置。横だけを見る
					y: 140
				}
			)
		).toBe(false);
		// 列方向が 4px。ドラッグとして扱う
		expect(
			hasTableResizePointerMoved(
				{
					// 動かしている軸。列
					kind: 'col',
					// 対象の列。先頭
					index: 0
				},
				{
					// 開始の横位置
					x: 100,
					// 開始の縦位置
					y: 100
				},
				{
					// 現在の横位置。開始から 4px
					x: 104,
					// 現在の縦位置。動いていない
					y: 100
				}
			)
		).toBe(true);
		// 行方向は 3px。閾値未満
		expect(
			hasTableResizePointerMoved(
				{
					// 動かしている軸。行
					kind: 'row',
					// 対象の行。先頭
					index: 0
				},
				{
					// 開始の横位置。横の移動は行の判定に使わない
					x: 100,
					// 開始の縦位置
					y: 100
				},
				{
					// 現在の横位置
					x: 140,
					// 現在の縦位置。開始から 3px
					y: 103
				}
			)
		).toBe(false);
		// 行方向が上へ 4px。ドラッグとして扱う
		expect(
			hasTableResizePointerMoved(
				{
					// 動かしている軸。行
					kind: 'row',
					// 対象の行。先頭
					index: 0
				},
				{
					// 開始の横位置。動いていない
					x: 100,
					// 開始の縦位置
					y: 100
				},
				{
					// 現在の横位置
					x: 100,
					// 現在の縦位置。開始から上へ 4px
					y: 96
				}
			)
		).toBe(true);
	});

	it('セル編集中のリサイズ開始時にフォーカスを外さない', () => {
		expect(tableResizeSource).not.toMatch(/activeElement\.blur\(\)/);
	});

	it('行高変更では未保存の列幅を固定レイアウトへ取り込まない', () => {
		// 測った列幅と行高。まだどちらの軸も保存していない
		const measured = {
			// 測った列幅。行の変更では固定レイアウトへ入れない
			widths: [100, 120],
			// 測った行高
			heights: [40, 48]
		};
		// 行を動かしている。未保存の列幅は捨てる
		expect(
			resolveActiveTableResizeLayout(
				{
					// 動かしている軸。行
					kind: 'row',
					// 対象の行。2 行目
					index: 1
				},
				measured,
				false,
				false
			)
		).toEqual({
			// 列幅は未保存なので持たない
			widths: undefined,
			// 動かしている行高だけ残す
			heights: [40, 48]
		});
		// 列を動かしている。未保存の行高は捨てる
		expect(
			resolveActiveTableResizeLayout(
				{
					// 動かしている軸。列
					kind: 'col',
					// 対象の列。2 列目
					index: 1
				},
				measured,
				false,
				false
			)
		).toEqual({
			// 動かしている列幅だけ残す
			widths: [100, 120],
			// 行高は未保存なので持たない
			heights: undefined
		});
	});

	it('既に保存済みの列幅・行高は別軸の変更中も維持する', () => {
		// 測った列幅と行高。別軸はすでに保存済み
		const measured = {
			// 保存済みの列幅。行を動かしても残す
			widths: [100, 120],
			// 保存済みの行高。列を動かしても残す
			heights: [40, 48]
		};
		// 行を動かしても、保存済みの列幅は残す
		expect(
			resolveActiveTableResizeLayout(
				{
					// 動かしている軸。行
					kind: 'row',
					// 対象の行。2 行目
					index: 1
				},
				measured,
				true,
				false
			)
		).toEqual({
			// 保存済みの列幅
			widths: [100, 120],
			// 動かしている行高
			heights: [40, 48]
		});
		// 列を動かしても、保存済みの行高は残す
		expect(
			resolveActiveTableResizeLayout(
				{
					// 動かしている軸。列
					kind: 'col',
					// 対象の列。2 列目
					index: 1
				},
				measured,
				false,
				true
			)
		).toEqual({
			// 動かしている列幅
			widths: [100, 120],
			// 保存済みの行高
			heights: [40, 48]
		});
	});

	it('固定列幅から実際にはみ出すセルだけを折り返す', () => {
		expect(shouldWrapTableCell(88, 88)).toBe(false);
		expect(shouldWrapTableCell(89, 88)).toBe(false);
		expect(shouldWrapTableCell(90, 88)).toBe(true);
	});

	it('CodeMirror Widget 前後の表余白を0.5行分にする', () => {
		expect(livePreviewCss).toMatch(/div\.cm-md-table-wrap,[\s\S]*?div\.cm-md-html-table-wrap\s*\{[^}]*margin:\s*-0\.7em 0;[^}]*overflow-y:\s*hidden;/s);
	});

	it('テーブルWidgetの末尾へ重なる改行記号を非表示にする', () => {
		expect(livePreviewCss).toMatch(/\.cm-line\.cm-eol-marker-line:has\(> \.cm-md-table-wrap\)::after,[\s\S]*?\.cm-line\.cm-eol-marker-line:has\(> \.cm-md-html-table-wrap\)::after\s*\{[^}]*content:\s*none;/s);
	});

	it('列ごとの罫線ハンドルを14pxで置く', () => {
		expect(TABLE_RESIZE_HANDLE_PX).toBe(14);
		expect(livePreviewCss).toMatch(/\.cm-md-table-col-resizer\s*\{[^}]*width:\s*14px;/s);
		expect(livePreviewCss).toMatch(/\.cm-md-table-row-resizer\s*\{[^}]*height:\s*14px;/s);
	});

	it('長い表は表示中の編集領域幅で横スクロールする', () => {
		expect(livePreviewCss).toMatch(/div\.cm-md-table-wrap,[\s\S]*?max-width:\s*var\(--tms-mde-table-max-width,\s*100%\);/);
		expect(livePreviewCss).toMatch(/div\.cm-md-html-table-wrap\s*\{[^}]*overflow-x:\s*auto;/s);
		expect(livePreviewCss).toMatch(/div\.cm-md-html-table-wrap\s*\{[^}]*overflow-y:\s*hidden;/s);
		expect(livePreviewCss).toMatch(/div\.cm-md-table-wrap\s*\{[^}]*overflow-x:\s*hidden;/s);
		expect(livePreviewCss).toMatch(/div\.cm-md-table-wrap\.cm-md-table-horizontal-overflow,[\s\S]*?overflow-x:\s*auto;/s);
		expect(livePreviewCss).toMatch(/div\.cm-md-table-wrap\.cm-md-table-vertical-overflow,[\s\S]*?div\.cm-md-html-table-wrap\.cm-md-table-vertical-overflow\s*\{[^}]*overflow-y:\s*auto;/s);
		expect(livePreviewCss).toMatch(/div\.cm-md-table-wrap,[\s\S]*?div\.cm-md-html-table-wrap\s*\{[^}]*overflow-anchor:\s*none;/s);
	});

	it('行列選択ヘッダーの余白は表示中だけ確保する', () => {
		expect(livePreviewCss).toMatch(/div\.cm-md-table-wrap\.cm-md-table-structure-controls-visible\s*\{[^}]*max-width:\s*max\(0px,\s*calc\([^}]*padding-top:\s*26px;[^}]*padding-left:\s*26px;/s);
		expect(livePreviewCss).not.toMatch(/\.cm-md-table-has-structure-controls/);
	});

	it('HTML出力でも表本体を縮めずラッパーで横スクロールする', () => {
		expect(EXPORT_PREVIEW_CSS).toMatch(/\.cm-md-table-wrap,[\s\S]*?\.cm-md-html-table-wrap\s*\{[^}]*width:\s*max-content;[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto;/s);
		expect(EXPORT_PREVIEW_CSS).toMatch(/\.cm-md-table\s*\{[^}]*width:\s*max-content;[^}]*line-height:\s*1\.4;/s);
		expect(EXPORT_PREVIEW_CSS).not.toMatch(/\.cm-md-table\s*\{[^}]*max-width:\s*100%;/s);
	});

	it('HTML出力のノート幅を表示領域へ追従させる', () => {
		expect(EXPORT_PREVIEW_CSS).toMatch(/\.tms-mde-export\s*\{[^}]*box-sizing:\s*border-box;[^}]*width:\s*100%;/s);
		expect(EXPORT_PREVIEW_CSS).not.toMatch(/\.tms-mde-export\s*\{[^}]*max-width:\s*52rem;/s);
	});

	it('固定列幅からはみ出すセルだけを列内で折り返す', () => {
		expect(livePreviewCss).not.toMatch(/\.cm-md-table\.is-resized th/);
		expect(livePreviewCss).toMatch(/\.cm-md-table-cell-wrap\s*\{[^}]*white-space:\s*pre-wrap;/s);
		expect(livePreviewCss).toMatch(/\.cm-md-table-cell-wrap\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
	});
});
