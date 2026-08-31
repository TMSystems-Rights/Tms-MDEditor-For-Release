import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState, type StateCommand } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { continueListMarkup } from './listContinuation';

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
 * 行末にカーソルを置いた GFM EditorState を生成する
 * @param {string[]} lines 行配列
 * @param {number} lineNumber カーソル行（1始まり）
 * @returns {EditorState}
 */
function createStateAtLineEnd(lines: string[], lineNumber: number): EditorState {
	const doc  = lines.join('\n');
	const line = EditorState.create({ doc }).doc.line(lineNumber);

	return EditorState.create({
		doc,
		selection : { anchor: line.to, head: line.to },
		extensions: [markdown({ base: markdownLanguage })],
	});
}

describe('listContinuation', () => {
	it('箇条書き行の Enter でマーカーを継続する', () => {
		const state = createStateAtLineEnd(['- item'], 1);
		const next  = applyCommand(state, continueListMarkup);

		expect(next.doc.toString()).toBe('- item\n- ');
	});

	it('番号付きリストの Enter で次番号を継続する', () => {
		const state = createStateAtLineEnd(['1. item'], 1);
		const next  = applyCommand(state, continueListMarkup);

		expect(next.doc.toString()).toBe('1. item\n2. ');
	});

	it('引用行の Enter で QuoteMark を継続する', () => {
		const state = createStateAtLineEnd(['> quote'], 1);
		const next  = applyCommand(state, continueListMarkup);

		expect(next.doc.toString()).toBe('> quote\n> ');
	});

	it('チェックボックス行の Enter で未チェック [ ] を継続する', () => {
		const state = createStateAtLineEnd(['- [x] done'], 1);
		const next  = applyCommand(state, continueListMarkup);

		expect(next.doc.toString()).toBe('- [x] done\n- [ ] ');
	});

	it('空の箇条書きマーカー行の Enter でマーカーを解除する', () => {
		const state = createStateAtLineEnd(['- item', '- '], 2);
		const next  = applyCommand(state, continueListMarkup);

		expect(next.doc.toString()).toBe('- item\n');
	});

	it('空のネスト箇条書きの Enter で1レベル解除する', () => {
		const state = createStateAtLineEnd(['- a', '  - '], 2);
		const next  = applyCommand(state, continueListMarkup);

		expect(next.doc.toString()).toBe('- a\n- ');
	});

	it('第2階層の箇条書きを継続する', () => {
		const state = createStateAtLineEnd(['- outer', '  - nested'], 2);
		const next  = applyCommand(state, continueListMarkup);

		expect(next.doc.toString()).toBe('- outer\n  - nested\n  - ');
	});

	it('第3階層の箇条書きを継続する', () => {
		const state = createStateAtLineEnd([
			'- a',
			'  - b',
			'    - c',
		], 3);
		const next  = applyCommand(state, continueListMarkup);

		expect(next.doc.toString()).toBe('- a\n  - b\n    - c\n    - ');
	});

	it('第3階層のチェックボックスを未チェックで継続する', () => {
		const state = createStateAtLineEnd([
			'- [ ] a',
			'  - [x] b',
			'    - [x] c',
		], 3);
		const next  = applyCommand(state, continueListMarkup);

		expect(next.doc.toString()).toBe('- [ ] a\n  - [x] b\n    - [x] c\n    - [ ] ');
	});
});
