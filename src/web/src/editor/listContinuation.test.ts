/**
 * Enter によるリスト・引用・チェックボックスの継続と、空マーカー行の解除を検証する
 * 描画は持たず、コマンド適用後の文書文字列だけを見る
 * @file
 */
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState, type StateCommand } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { continueListMarkup } from './listContinuation';

/**
 * コマンドを 1 回適用し、dispatch 後の状態を返す
 * dispatch が呼ばれないときは、渡した状態をそのまま返す
 * @param state - 適用前の文書
 * @param command - 適用するコマンド。主カーソルは state の選択を使う
 * @returns dispatch されたあとの状態。未適用なら state と同じ
 */
function applyCommand(state: EditorState, command: StateCommand): EditorState {
	let next = state;
	command({
		state,
		/**
		 * コマンドが渡したトランザクションを、次の状態として保持する
		 * @param transaction - コマンドが適用しようとしたトランザクション
		 */
		dispatch: (transaction) => {
			next = transaction.state;
		},
	});
	return next;
}

/**
 * 指定行の末尾にカーソルを置いた、GFM の EditorState を作る
 * @param lines - 改行でつなぐ行。末尾改行は付けない
 * @param lineNumber - カーソルを置く行番号。1 始まり
 * @returns その行の line.to に anchor と head を置いた状態
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
