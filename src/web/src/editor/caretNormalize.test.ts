import { EditorState, EditorSelection } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { normalizeCaretRange, normalizeCaretSelection } from './caretNormalize';

describe('caretNormalize', () => {
	it('行末を超える head を当該行の line.to にクランプする', () => {
		const state = EditorState.create({ doc: 'abc' });
		const line  = state.doc.line(1);
		const bad   = EditorSelection.cursor(line.to + 10);
		const next  = normalizeCaretRange(state, bad);

		expect(next?.head).toBe(line.to);
		expect(next?.assoc).toBe(-1);
	});

	it('行末キャレットは assoc=-1（EOL マーカーより左）にする', () => {
		const state  = EditorState.create({ doc: 'heading\nnext' });
		const line   = state.doc.line(1);
		const atEnd  = EditorSelection.cursor(line.to, 1);
		const next   = normalizeCaretRange(state, atEnd);
		const result = next ?? atEnd;

		expect(result.head).toBe(line.to);
		expect(result.assoc).toBe(-1);
	});

	it('goalColumn は短行でも保持する（縦移動の列記憶）', () => {
		const state = EditorState.create({ doc: 'ab' });
		const line  = state.doc.line(1);
		const wide  = EditorSelection.cursor(line.to, -1, undefined, 40);
		const next  = normalizeCaretRange(state, wide);

		expect(next).toBeNull();
		expect(wide.goalColumn).toBe(40);
	});

	it('normalizeCaretSelection は変更不要なら null', () => {
		const state = EditorState.create({
			doc      : 'abc',
			selection: EditorSelection.cursor(1, -1),
		});
		expect(normalizeCaretSelection(state)).toBeNull();
	});
});
