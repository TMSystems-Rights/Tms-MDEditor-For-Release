/**
 * 見出し接頭辞の長さと、論理行単位の上下移動が文字列上の列を維持することを検証する
 * ピクセル移動と表ウィジェットは持たず、EditorState 上の位置だけを見る
 * @file
 */
import { EditorState, EditorSelection } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { headingPrefixLength, moveByDocumentLine } from './verticalMotion';

describe('verticalMotion', () => {
	it('headingPrefixLength は # + 空白の長さを返す', () => {
		expect(headingPrefixLength('# title')).toBe(2);
		expect(headingPrefixLength('## title')).toBe(3);
		expect(headingPrefixLength('##### abc')).toBe(6);
		expect(headingPrefixLength('plain')).toBe(0);
	});

	it('moveByDocumentLine はソース文字位置 (a) で 1 行ずつ移動する', () => {
		// 見出しを挟む 3 行。論理行の上下で行番号だけが変わる
		const state = EditorState.create({
			doc: ['plain above', '# Heading One', 'plain below'].join('\n')
		});
		// 3 行目。上方向の開始位置
		const line3 = state.doc.line(3);
		// 3 行目先頭から 1 行上。列記憶は 0
		const up1   = moveByDocumentLine(state, EditorSelection.cursor(line3.from), false, 0);
		expect(state.doc.lineAt(up1.head).number).toBe(2);

		// さらに 1 行上。1 行目に着く
		const up2 = moveByDocumentLine(state, up1, false, 0);
		expect(state.doc.lineAt(up2.head).number).toBe(1);

		// 1 行目から 1 行下。見出し行へ戻る
		const down1 = moveByDocumentLine(state, up2, true, 0);
		expect(state.doc.lineAt(down1.head).number).toBe(2);

		// さらに 1 行下。開始した 3 行目へ戻る
		const down2 = moveByDocumentLine(state, down1, true, 0);
		expect(state.doc.lineAt(down2.head).number).toBe(3);
	});

	it('moveByDocumentLine は短行を跨いでも文字列ゴールを維持する', () => {
		// 短い 2 行目を挟む 3 行。列 5 は短行では行末に落ちる
		const state = EditorState.create({
			doc: ['abcdefgh', 'xy', 'ABCDEFGH'].join('\n')
		});
		// 列 5 の起点になる 1 行目
		const line1 = state.doc.line(1);
		// 1 行目の 6 文字目。列記憶はまだ付けていない
		const from  = EditorSelection.cursor(line1.from + 5);
		// 下へ 1 行。列 5 は 2 文字の行では行末になる
		const down  = moveByDocumentLine(state, from, true, 5);
		expect(down.head).toBe(state.doc.line(2).to);

		// 短行の次。列 5 が再び本文の中に戻る
		const again = moveByDocumentLine(state, down, true, 5);
		expect(again.head).toBe(state.doc.line(3).from + 5);
	});

	it('見出し行ではプレフィックス込みのソース位置に着地する', () => {
		// プレーン行から見出し行へ下りる文書
		const state = EditorState.create({
			doc: ['abcdef', '# Hello'].join('\n')
		});
		// 下りる前の 1 行目
		const line1 = state.doc.line(1);
		// 1 行目の 3 文字目。列記憶 2 で見出しへ下りる
		const from  = EditorSelection.cursor(line1.from + 2);
		// 見出し行へ 1 行下。`# ` の分だけソース位置がずれる
		const down  = moveByDocumentLine(state, from, true, 2);

		// ソース位置 (a)=2 → "# Hello" の 'H'（プレビューでは先頭に見える）
		expect(down.head).toBe(state.doc.line(2).from + 2);
		expect(state.doc.sliceString(down.head, down.head + 1)).toBe('H');
	});

	it('選択拡張時も head から 1 行ずつ進める（空でない選択で止まらない）', () => {
		// 4 行の本文。空でない選択でも head から 1 行ずつ進む
		const state = EditorState.create({
			doc: ['line1', 'line2', 'line3', 'line4'].join('\n')
		});
		// 選択の anchor がある行
		const line1 = state.doc.line(1);
		// 選択の head がある行。移動の起点
		const line2 = state.doc.line(2);
		// head を 1 行進めた着地行
		const line3 = state.doc.line(3);
		// 1行目途中〜2行目途中の選択あり、head は line2
		const range = EditorSelection.range(line1.from + 2, line2.from + 2);
		// 範囲そのものではなく、head の空キャレットから下へ進める
		const next  = moveByDocumentLine(state, EditorSelection.cursor(range.head), true, 2);
		// もう 1 行下。4 行目の同じ列
		const again = moveByDocumentLine(state, next, true, 2);

		expect(next.head).toBe(line3.from + 2);
		expect(again.head).toBe(state.doc.line(4).from + 2);
	});
});
