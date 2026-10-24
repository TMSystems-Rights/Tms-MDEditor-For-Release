/**
 * 改行マーカーの行装飾が、通常編集では同一オブジェクトを保ち、マップ更新時だけ入れ替わることを検証する
 * 画面への描画は持たず、DecorationSet の範囲と同一性だけを見る
 * @file
 */
import { EditorState } from '@codemirror/state';
import { type Decoration, type DecorationSet } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { createEolMarkerExtensions, eolMarkersField, setLineEolsEffect } from './eolMarkers';

/**
 * テストが比較する行装飾の範囲
 * 本番の Decoration そのものではなく、between で取り出した位置とオブジェクトだけを持つ
 */
type DecorationRange = {
	/** 装飾先頭の文書オフセット（含む） */
	from: number;
	/** 装飾末尾の文書オフセット（含まない） */
	to: number;
	/** 比較する装飾オブジェクト。通常編集では更新前と同一である */
	value: Decoration;
};

/**
 * DecorationSet を、文書全体の範囲配列へ展開する
 * @param decorations - 展開する装飾集合
 * @param length - 文書長。0 からこの位置までを between の範囲にする
 * @returns 出現順の装飾範囲。装飾が無いときは空配列
 */
function collectDecorations(decorations: DecorationSet, length: number): DecorationRange[] {
	const result: DecorationRange[] = [];
	decorations.between(0, length, (from, to, value) => {
		result.push({ from, to, value });
	});
	return result;
}

describe('eolMarkers', () => {
	it('通常の本文入力では行末 Decoration を再生成せずマップする', () => {
		const initial = EditorState.create({
			doc        : '\n',
			extensions: createEolMarkerExtensions(['crlf']),
		});
		const before  = collectDecorations(initial.field(eolMarkersField), initial.doc.length);
		const next    = initial.update({ changes: { from: 0, insert: 'k' } }).state;
		const after   = collectDecorations(next.field(eolMarkersField), next.doc.length);

		expect(before).toHaveLength(1);
		expect(after).toHaveLength(1);
		expect(after[0].from).toBe(0);
		expect(after[0].value).toBe(before[0].value);
	});

	it('行末マップの更新時はウィジェットを再構築する', () => {
		const initial = EditorState.create({
			doc        : 'a\n',
			extensions: createEolMarkerExtensions(['crlf']),
		});
		const before  = collectDecorations(initial.field(eolMarkersField), initial.doc.length);
		const next    = initial.update({ effects: setLineEolsEffect.of(['lf']) }).state;
		const after   = collectDecorations(next.field(eolMarkersField), next.doc.length);

		expect(after).toHaveLength(1);
		expect(after[0].value).not.toBe(before[0].value);
	});
});
