/**
 * トリプルクリックの行選択が、行末改行を含めず、ドラッグ方向と空行で向きを変えることを検証する
 * 座標は clientX を文書位置として扱うモックビューで見る
 * @file
 */
import { EditorSelection, EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { selectionForTripleClick, selectionRangeForLine, tripleClickMouseSelectionStyle } from './tripleClickSelection';

/** 3 行のサンプル文書。行の内容は alpha、beta、gamma */
const SAMPLE = ['alpha', 'beta', 'gamma'].join('\n');

/**
 * clientX を文書位置として解釈するビューを作る
 * 実 DOM は持たず、posAndSideAtCoords だけを模す
 * @param doc - ビューが持つ文書
 * @param head - 初期キャレットの文書オフセット。未指定時は 0
 * @returns state と posAndSideAtCoords だけを持つ EditorView のモック
 */
function createView(doc: string, head = 0): EditorView {
	// トリプルクリックの対象文書。実 DOM は持たない
	const state = EditorState.create({
		// 呼び出し側の本文
		doc,
		// 初期キャレット。未指定時は文書先頭
		selection: EditorSelection.cursor(head)
	});
	// state と座標変換だけを持つビュー。描画はしない
	return {
		// ビューが持つ文書と初期キャレット
		state,
		/**
		 * clientX を文書位置として返す。assoc は常に 1 の固定値
		 * @param coords - マウス座標。x だけを文書オフセットとして使う
		 * @param coords.x - 文書オフセットとして扱う clientX
		 * @returns pos が coords.x、assoc が 1 の位置
		 */
		posAndSideAtCoords(coords: { x: number }): { pos: number; assoc: 1 } {
			// clientX を文書位置に見立てた結果。assoc は常に 1
			return {
				// 文書オフセット。coords.x をそのまま使う
				pos: coords.x,
				// 文字の右側。このモックでは変えない
				assoc: 1
			};
		}
	} as unknown as EditorView;
}

describe('tripleClickSelection', () => {
	it('論理行の内容だけを選択し、キャレットを行末へ置く', () => {
		// 3 行の文書。2 行目 beta を選ぶ
		const state = EditorState.create({ doc: SAMPLE });
		// 2 行目。改行は line.to の次
		const line  = state.doc.line(2);
		// 行の途中から始めた行選択。改行は含めない
		const range = selectionRangeForLine(state, line.from + 1);

		expect(range.anchor).toBe(line.from);
		expect(range.head).toBe(line.to);
		expect(range.assoc).toBe(-1);
		expect(state.sliceDoc(range.from, range.to)).toBe('beta');
		expect(state.sliceDoc(range.to, range.to + 1)).toBe('\n');
	});

	it('最終行に改行が無いときは文書末尾までを選択する', () => {
		// 最終行に改行が無い文書
		const state = EditorState.create({ doc: SAMPLE });
		// 最終行 gamma
		const line  = state.doc.line(3);
		// 行末位置からの選択。文書末尾まで
		const range = selectionRangeForLine(state, line.to);

		expect(range.from).toBe(line.from);
		expect(range.to).toBe(state.doc.length);
		expect(state.sliceDoc(range.from, range.to)).toBe('gamma');
	});

	it('行区切りが正規化されても選択範囲に改行を含めない', () => {
		// CR+LF は LF 1 文字に正規化される文書
		const state = EditorState.create({ doc: 'alpha\r\nbeta' });
		// 1 行目。行末の次が正規化後の改行
		const line  = state.doc.line(1);
		// 行の途中からの選択。改行は範囲に入らない
		const range = selectionRangeForLine(state, 1);

		expect(state.sliceDoc(range.from, range.to)).toBe('alpha');
		expect(range.to).toBe(line.to);
		expect(state.sliceDoc(line.to, state.doc.line(2).from)).toBe('\n');
	});

	it('空行のトリプルクリックは次行へキャレットを移さない', () => {
		// 2 行目が空の文書。空行の選択は次行へ進まない
		const state = EditorState.create({ doc: 'alpha\n\ngamma' });
		// 空行。from と to は同じ
		const line  = state.doc.line(2);
		// 空行の先頭からの選択。空のキャレットになる
		const range = selectionRangeForLine(state, line.from);

		expect(range.empty).toBe(true);
		expect(range.head).toBe(line.from);
		expect(range.assoc).toBe(1);
		expect(state.doc.lineAt(range.head).number).toBe(2);
	});

	it('同一行で位置がずれてもキャレットは行末のまま', () => {
		// 1 行目の中で開始と終了がずれても行全体になる
		const state = EditorState.create({ doc: SAMPLE });
		// 1 行目 alpha
		const line  = state.doc.line(1);
		// 行の後ろから前へ戻した選択。キャレットは行末
		const range = selectionForTripleClick(state, line.from + 4, line.from + 1);

		expect(range.anchor).toBe(line.from);
		expect(range.head).toBe(line.to);
		expect(state.sliceDoc(range.from, range.to)).toBe('alpha');
	});

	it('下方向のドラッグは最終行の改行を含めない', () => {
		// 1 行目から最終行へドラッグする文書
		const state = EditorState.create({ doc: SAMPLE });
		// ドラッグの開始行
		const first = state.doc.line(1);
		// ドラッグの終了行。この行の改行は文書に無い
		const last  = state.doc.line(3);
		// 下方向の選択。最終行の末尾までで、改行は含めない
		const range = selectionForTripleClick(state, first.from, last.from);

		expect(range.anchor).toBe(first.from);
		expect(range.head).toBe(last.to);
		expect(state.sliceDoc(range.from, range.to)).toBe(SAMPLE);
	});

	it('上方向のドラッグは開始行の改行を含めない', () => {
		// 2 行目から 1 行目へ戻す文書
		const state  = EditorState.create({ doc: SAMPLE });
		// 選択の終点になる行
		const first  = state.doc.line(1);
		// 選択の起点になる行。この行の改行は含めない
		const second = state.doc.line(2);
		// 上方向の選択。2 行目の末尾から 1 行目の先頭まで
		const range  = selectionForTripleClick(state, second.from + 1, first.from);
		// 選択テキスト。末尾が改行なら失敗
		const copied = state.sliceDoc(range.from, range.to);

		expect(range.head).toBe(first.from);
		expect(range.anchor).toBe(second.to);
		expect(copied).toBe('alpha\nbeta');
		expect(copied.endsWith('\n')).toBe(false);
	});

	it('単クリックとダブルクリックは行選択にしない', () => {
		// 行選択にしないクリックを渡すビュー
		const view = createView(SAMPLE);
		// 主ボタンの単クリック。detail が 3 未満
		expect(
			tripleClickMouseSelectionStyle(view, {
				// 主ボタン
				button: 0,
				// クリック回数。1 回
				detail: 1
			} as MouseEvent)
		).toBeNull();
		// 主ボタンのダブルクリック
		expect(
			tripleClickMouseSelectionStyle(view, {
				// 主ボタン
				button: 0,
				// クリック回数。2 回
				detail: 2
			} as MouseEvent)
		).toBeNull();
		// 副ボタンのトリプルクリック。主ボタン以外は行選択にしない
		expect(
			tripleClickMouseSelectionStyle(view, {
				// 副ボタン
				button: 2,
				// クリック回数。3 回でも主ボタンでなければ無効
				detail: 3
			} as MouseEvent)
		).toBeNull();
	});

	it('トリプルクリックの選択テキストに行末改行を含めない', () => {
		// 2 行目をトリプルクリックするビュー
		const view      = createView(SAMPLE);
		// 選択される行。改行は含めない
		const line      = view.state.doc.line(2);
		// 主ボタンのトリプルクリック。clientX は行の途中
		const style     = tripleClickMouseSelectionStyle(view, {
			// 主ボタン
			button: 0,
			// クリック回数。3 回で行選択
			detail: 3,
			// 文書位置に見立てた clientX。行の途中
			clientX: line.from + 2,
			// 使わない縦位置
			clientY: 0
		} as MouseEvent);
		// 同じ位置での選択。Shift も拡張も無し
		const selection = style?.get(
			{
				// 行の途中。clientX は文書位置
				clientX: line.from + 2,
				// 使わない縦位置
				clientY: 0
			} as MouseEvent,
			false,
			false
		);

		expect(selection?.main.head).toBe(line.to);
		expect(view.state.sliceDoc(selection!.main.from, selection!.main.to)).toBe('beta');
	});

	it('Shift+トリプルクリックはクリック行の改行を含めずに拡張する', () => {
		// 初期キャレットが 1 文字目のビュー。Shift でそこから広げる
		const view      = createView(SAMPLE, 1);
		// クリックする 2 行目。この行の改行は含めない
		const line      = view.state.doc.line(2);
		// 主ボタンのトリプルクリック。clientX は行頭
		const style     = tripleClickMouseSelectionStyle(view, {
			// 主ボタン
			button: 0,
			// クリック回数。3 回
			detail: 3,
			// 文書位置に見立てた clientX。行頭
			clientX: line.from,
			// 使わない縦位置
			clientY: 0
		} as MouseEvent);
		// Shift 付きの選択。起点は初期キャレットのまま
		const selection = style?.get(
			{
				// 行頭。clientX は文書位置
				clientX: line.from,
				// 使わない縦位置
				clientY: 0
			} as MouseEvent,
			true,
			false
		);

		expect(selection?.main.anchor).toBe(1);
		expect(selection?.main.head).toBe(line.to);
		expect(view.state.sliceDoc(selection!.main.from, selection!.main.to)).toBe('lpha\nbeta');
	});
});
