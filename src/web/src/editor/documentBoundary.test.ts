import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createDocumentEndSelection } from './documentBoundary';

describe('documentBoundary', () => {
	it('Ctrl+End 用の選択は文書末尾へ折り畳む', () => {
		const state = EditorState.create({
			doc      : ['one', 'two', 'three'].join('\n'),
			selection: EditorSelection.range(1, 6),
		});

		const selection = createDocumentEndSelection(state, false);

		expect(selection.main.anchor).toBe(state.doc.length);
		expect(selection.main.head).toBe(state.doc.length);
		expect(state.doc.lineAt(selection.main.head).number).toBe(3);
	});

	it('Ctrl+Shift+End 用の選択はアンカーを維持して文書末尾まで拡張する', () => {
		const state = EditorState.create({
			doc      : ['one', 'two', 'three'].join('\n'),
			selection: EditorSelection.cursor(2),
		});

		const selection = createDocumentEndSelection(state, true);

		expect(selection.main.anchor).toBe(2);
		expect(selection.main.head).toBe(state.doc.length);
	});
});
