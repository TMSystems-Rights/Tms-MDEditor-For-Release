import { EditorState } from '@codemirror/state';
import { type Decoration, type DecorationSet } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { createEolMarkerExtensions, eolMarkersField, setLineEolsEffect } from './eolMarkers';

type DecorationRange = {
	from: number;
	to: number;
	value: Decoration;
};

/**
 * EOL Decoration を配列化する
 * @param {DecorationSet} decorations DecorationSet
 * @param {number} length 文書長
 * @returns {DecorationRange[]} Decoration 範囲
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
