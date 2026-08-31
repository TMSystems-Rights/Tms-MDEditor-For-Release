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
		const state = EditorState.create({
			doc: [
				'plain above',
				'# Heading One',
				'plain below',
			].join('\n'),
		});
		const line3 = state.doc.line(3);
		const up1   = moveByDocumentLine(state, EditorSelection.cursor(line3.from), false, 0);
		expect(state.doc.lineAt(up1.head).number).toBe(2);

		const up2 = moveByDocumentLine(state, up1, false, 0);
		expect(state.doc.lineAt(up2.head).number).toBe(1);

		const down1 = moveByDocumentLine(state, up2, true, 0);
		expect(state.doc.lineAt(down1.head).number).toBe(2);

		const down2 = moveByDocumentLine(state, down1, true, 0);
		expect(state.doc.lineAt(down2.head).number).toBe(3);
	});

	it('moveByDocumentLine は短行を跨いでも文字列ゴールを維持する', () => {
		const state = EditorState.create({
			doc: [
				'abcdefgh',
				'xy',
				'ABCDEFGH',
			].join('\n'),
		});
		const line1 = state.doc.line(1);
		const from  = EditorSelection.cursor(line1.from + 5);
		const down  = moveByDocumentLine(state, from, true, 5);
		expect(down.head).toBe(state.doc.line(2).to);

		const again = moveByDocumentLine(state, down, true, 5);
		expect(again.head).toBe(state.doc.line(3).from + 5);
	});

	it('見出し行ではプレフィックス込みのソース位置に着地する', () => {
		const state = EditorState.create({
			doc: [
				'abcdef',
				'# Hello',
			].join('\n'),
		});
		const line1 = state.doc.line(1);
		const from  = EditorSelection.cursor(line1.from + 2);
		const down  = moveByDocumentLine(state, from, true, 2);

		// ソース位置 (a)=2 → "# Hello" の 'H'（プレビューでは先頭に見える）
		expect(down.head).toBe(state.doc.line(2).from + 2);
		expect(state.doc.sliceString(down.head, down.head + 1)).toBe('H');
	});

	it('選択拡張時も head から 1 行ずつ進める（空でない選択で止まらない）', () => {
		const state = EditorState.create({
			doc: ['line1', 'line2', 'line3', 'line4'].join('\n'),
		});
		const line1 = state.doc.line(1);
		const line2 = state.doc.line(2);
		const line3 = state.doc.line(3);
		// 1行目途中〜2行目途中の選択あり、head は line2
		const range = EditorSelection.range(line1.from + 2, line2.from + 2);
		const next  = moveByDocumentLine(state, EditorSelection.cursor(range.head), true, 2);
		const again = moveByDocumentLine(state, next, true, 2);

		expect(next.head).toBe(line3.from + 2);
		expect(again.head).toBe(state.doc.line(4).from + 2);
	});
});
