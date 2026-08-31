import { EditorState, type StateCommand } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
	dedentListItem,
	indentListItem,
	parseListLine,
	taskMarkerPrefixLength,
} from './listIndent';

/**
 * StateCommand を適用した後の EditorState を返す
 * @param {EditorState} state 初期状態
 * @param {StateCommand} command コマンド
 * @returns {EditorState}
 */
function applyCommand(state: EditorState, command: StateCommand): EditorState {
	let next = state;
	command({
		state,
		/**
		 * トランザクションを適用する
		 * @param {import('@codemirror/state').Transaction} transaction トランザクション
		 * @returns {void}
		 */
		dispatch: (transaction) => {
			next = transaction.state;
		},
	});
	return next;
}

/**
 * 指定行の EditorState を生成する
 * @param {string[]} lines 行配列
 * @param {number} lineNumber カーソル行
 * @returns {EditorState}
 */
function createListState(lines: string[], lineNumber: number): EditorState {
	const doc  = lines.join('\n');
	const head = lines.slice(0, lineNumber - 1).join('\n').length + (lineNumber > 1 ? 1 : 0);

	return EditorState.create({
		doc,
		selection : { anchor: head, head },
		extensions: [EditorState.tabSize.of(4)],
	});
}

describe('listIndent', () => {
	it('parseListLine は番号付き・箇条書きを解析する', () => {
		expect(parseListLine('1. item')?.isOrdered).toBe(true);
		expect(parseListLine('  2. nested')?.indent).toBe('  ');
		expect(parseListLine('- bullet')?.bullet).toBe('-');
		expect(parseListLine('plain')).toBeNull();
	});

	it('taskMarkerPrefixLength は [ ] / [x] と直後空白の長さを返す', () => {
		expect(taskMarkerPrefixLength('[ ] task')).toBe(4);
		expect(taskMarkerPrefixLength('[x] done')).toBe(4);
		expect(taskMarkerPrefixLength('[X] done')).toBe(4);
		expect(taskMarkerPrefixLength('plain')).toBe(0);
	});

	it('Tab で番号付きリストをインデントすると新階層の連番になる（兄弟なしなら 1）', () => {
		const state = createListState([
			'1. aa',
			'2. bb',
		], 2);
		const next  = applyCommand(state, indentListItem);

		expect(next.doc.line(2).text).toBe('    1. bb');
	});

	it('Tab で既存のネスト兄弟がある場合は次番号で付番する', () => {
		const state = createListState([
			'1. qq',
			'    1. qq1',
			'        1. qq2-1',
			'    2. qq2-2',
			'2. bb',
		], 4);
		const next  = applyCommand(state, indentListItem);

		expect(next.doc.line(4).text).toBe('        2. qq2-2');
		expect(next.doc.line(5).text).toBe('2. bb');
	});

	it('Shift+Tab で親階層の連番へ戻し、両階層の後続番号を振り直す', () => {
		const state = createListState([
			'1. aa',
			'    2. bb',
			'    3. cc',
			'2. dd',
		], 2);
		const next  = applyCommand(state, dedentListItem);

		expect(next.doc.line(2).text).toBe('2. bb');
		expect(next.doc.line(3).text).toBe('    2. cc');
		expect(next.doc.line(4).text).toBe('3. dd');
	});

	it('Shift+Tab でネスト先頭の 1. を親階層へ移す', () => {
		const state = createListState([
			'1. aa',
			'    1. bb',
			'    2. cc',
			'2. dd',
		], 2);
		const next  = applyCommand(state, dedentListItem);

		expect(next.doc.line(2).text).toBe('2. bb');
		expect(next.doc.line(3).text).toBe('    1. cc');
		expect(next.doc.line(4).text).toBe('3. dd');
	});

	it('Tab 後のキャレットは - [ ] の直後（本文先頭）に置く', () => {
		const state = createListState([
			'- [ ] parent',
			'- [ ] child',
		], 2);
		const next  = applyCommand(state, indentListItem);
		const line  = next.doc.line(2);
		const head  = next.selection.main.head;

		expect(line.text).toBe('    - [ ] child');
		expect(line.text.slice(0, head - line.from)).toBe('    - [ ] ');
		expect(line.text.slice(head - line.from)).toBe('child');
	});

	it('Shift+Tab 後のキャレットも - [ ] の直後に置く', () => {
		const state = createListState([
			'- [ ] parent',
			'    - [x] child',
		], 2);
		const next  = applyCommand(state, dedentListItem);
		const line  = next.doc.line(2);
		const head  = next.selection.main.head;

		expect(line.text).toBe('- [x] child');
		expect(line.text.slice(0, head - line.from)).toBe('- [x] ');
		expect(line.text.slice(head - line.from)).toBe('child');
	});
});
