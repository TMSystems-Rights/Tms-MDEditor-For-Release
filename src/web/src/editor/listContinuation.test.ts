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
	// dispatch されるまで入力のまま。呼ばれなければこの状態を返す
	let next = state;
	// 主カーソルは state の選択。dispatch は次の状態へ置き換えるだけ
	command({
		// 適用前の文書
		state,
		/**
		 * コマンドが渡したトランザクションを、次の状態として保持する
		 * @param transaction - コマンドが適用しようとしたトランザクション
		 */
		dispatch: (transaction) => {
			// コマンドが適用したあとの状態。未呼び出しなら next は入力のまま
			next = transaction.state;
		}
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
	// 行を LF でつないだ本文。末尾改行は付けない
	const doc  = lines.join('\n');
	// 行番号から末尾オフセットを取るための一時状態。選択はまだ付けない
	const line = EditorState.create({ doc }).doc.line(lineNumber);

	return EditorState.create({
		// 上でつないだ本文
		doc,
		// 指定行の末尾にある空キャレット
		selection: {
			// 選択の起点。行末
			anchor: line.to,
			// 主カーソル。行末と同じ位置
			head: line.to
		},
		// リストと引用を構文木にする言語サポート
		extensions: [markdown({ base: markdownLanguage })]
	});
}

describe('listContinuation', () => {
	it('箇条書き行の Enter でマーカーを継続する', () => {
		// 箇条書き 1 行の末尾。Enter で同じマーカーを続ける
		const state = createStateAtLineEnd(['- item'], 1);
		// 継続後。次の行は空の箇条書き
		const next  = applyCommand(state, continueListMarkup);

		expect(next.doc.toString()).toBe('- item\n- ');
	});

	it('番号付きリストの Enter で次番号を継続する', () => {
		// 番号 1 の行末。Enter で次番号を続ける
		const state = createStateAtLineEnd(['1. item'], 1);
		// 継続後。次の行は 2.
		const next  = applyCommand(state, continueListMarkup);

		expect(next.doc.toString()).toBe('1. item\n2. ');
	});

	it('引用行の Enter で QuoteMark を継続する', () => {
		// 引用 1 行の末尾。Enter で QuoteMark を続ける
		const state = createStateAtLineEnd(['> quote'], 1);
		// 継続後。次の行は空の引用
		const next  = applyCommand(state, continueListMarkup);

		expect(next.doc.toString()).toBe('> quote\n> ');
	});

	it('チェックボックス行の Enter で未チェック [ ] を継続する', () => {
		// チェック済み行の末尾。継続行は未チェックに戻す
		const state = createStateAtLineEnd(['- [x] done'], 1);
		// 継続後。次の行は [ ]
		const next  = applyCommand(state, continueListMarkup);

		expect(next.doc.toString()).toBe('- [x] done\n- [ ] ');
	});

	it('空の箇条書きマーカー行の Enter でマーカーを解除する', () => {
		// 2 行目が空の箇条書き。Enter でマーカーを外す
		const state = createStateAtLineEnd(['- item', '- '], 2);
		// 解除後。2 行目のマーカーは残らない
		const next  = applyCommand(state, continueListMarkup);

		expect(next.doc.toString()).toBe('- item\n');
	});

	it('空のネスト箇条書きの Enter で1レベル解除する', () => {
		// 2 行目が空のネスト。Enter で 1 段だけ上げる
		const state = createStateAtLineEnd(['- a', '  - '], 2);
		// 解除後。ネストは外れ、親のマーカーは残る
		const next  = applyCommand(state, continueListMarkup);

		expect(next.doc.toString()).toBe('- a\n- ');
	});

	it('第2階層の箇条書きを継続する', () => {
		// 第 2 階層の行末。同じ深さで続ける
		const state = createStateAtLineEnd(['- outer', '  - nested'], 2);
		// 継続後。次の行も 2 スペースの箇条書き
		const next  = applyCommand(state, continueListMarkup);

		expect(next.doc.toString()).toBe('- outer\n  - nested\n  - ');
	});

	it('第3階層の箇条書きを継続する', () => {
		// 第 3 階層の行末。同じ深さで続ける
		const state = createStateAtLineEnd(['- a', '  - b', '    - c'], 3);
		// 継続後。次の行も 4 スペースの箇条書き
		const next  = applyCommand(state, continueListMarkup);

		expect(next.doc.toString()).toBe('- a\n  - b\n    - c\n    - ');
	});

	it('第3階層のチェックボックスを未チェックで継続する', () => {
		// 第 3 階層のチェック済み行末。継続行は未チェック
		const state = createStateAtLineEnd(['- [ ] a', '  - [x] b', '    - [x] c'], 3);
		// 継続後。次の行は同じ深さの [ ]
		const next  = applyCommand(state, continueListMarkup);

		expect(next.doc.toString()).toBe('- [ ] a\n  - [x] b\n    - [x] c\n    - [ ] ');
	});
});
