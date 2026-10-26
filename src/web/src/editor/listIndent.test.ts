/**
 * リストのインデントと番号の振り直し、タスクマーカー直後へのキャレット移動を検証する
 * 描画は持たず、コマンド適用後の行テキストと選択位置だけを見る
 * @file
 */
import { EditorState, type StateCommand } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { dedentListItem, indentListItem, parseListLine, taskMarkerPrefixLength } from './listIndent';

/**
 * コマンドを 1 回適用し、dispatch 後の状態を返す
 * dispatch が呼ばれないときは、渡した状態をそのまま返す
 * @param state - 適用前の文書
 * @param command - 適用するコマンド。カーソルは state の選択を使う
 * @returns dispatch されたあとの状態。未適用なら state と同じ
 */
function applyCommand(state: EditorState, command: StateCommand): EditorState {
	// dispatch されるまで入力のまま。呼ばれなければこの状態を返す
	let next = state;
	// カーソルは state の選択。dispatch は次の状態へ置き換えるだけ
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
 * 指定行の先頭にカーソルを置いた EditorState を作る
 * タブ幅は 4。Markdown 言語は付けない
 * @param lines - 改行でつなぐ行
 * @param lineNumber - カーソルを置く行番号。1 始まり。行頭のオフセットに anchor と head を置く
 * @returns タブ幅 4 の状態
 */
function createListState(lines: string[], lineNumber: number): EditorState {
	// 行を LF でつないだ本文。末尾改行は付けない
	const doc  = lines.join('\n');
	// 指定行の先頭オフセット。1 行目は 0、それ以外は直前までの長さに改行 1 文字を足す
	const head = lines.slice(0, lineNumber - 1).join('\n').length + (lineNumber > 1 ? 1 : 0);

	return EditorState.create({
		// 上でつないだ本文
		doc,
		// 指定行の先頭にある空キャレット
		selection: {
			// 選択の起点。行頭
			anchor: head,
			// 主カーソル。行頭と同じ位置
			head
		},
		// タブ幅 4。Markdown 言語は付けない
		extensions: [EditorState.tabSize.of(4)]
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
		// 2 行目をインデントする番号付きリスト。ネストの兄弟は無い
		const state = createListState(['1. aa', '2. bb'], 2);
		// インデント後。2 行目は新しい階層の 1 になる
		const next  = applyCommand(state, indentListItem);

		expect(next.doc.line(2).text).toBe('    1. bb');
	});

	it('Tab で既存のネスト兄弟がある場合は次番号で付番する', () => {
		// 4 行目をさらにインデントする。同じ深さの次番号がある
		const state = createListState(['1. qq', '    1. qq1', '        1. qq2-1', '    2. qq2-2', '2. bb'], 4);
		// インデント後。4 行目は深い階層の 2 になる
		const next  = applyCommand(state, indentListItem);

		expect(next.doc.line(4).text).toBe('        2. qq2-2');
		expect(next.doc.line(5).text).toBe('2. bb');
	});

	it('Shift+Tab で親階層の連番へ戻し、両階層の後続番号を振り直す', () => {
		// 2 行目を親階層へ戻す。後続の番号も振り直す
		const state = createListState(['1. aa', '    2. bb', '    3. cc', '2. dd'], 2);
		// デデント後。2 行目は親の 2 になる
		const next  = applyCommand(state, dedentListItem);

		expect(next.doc.line(2).text).toBe('2. bb');
		expect(next.doc.line(3).text).toBe('    2. cc');
		expect(next.doc.line(4).text).toBe('3. dd');
	});

	it('Shift+Tab でネスト先頭の 1. を親階層へ移す', () => {
		// ネスト先頭の 1. を親へ移す。残った兄弟は 1 から振り直す
		const state = createListState(['1. aa', '    1. bb', '    2. cc', '2. dd'], 2);
		// デデント後。移した行は親の 2 になる
		const next  = applyCommand(state, dedentListItem);

		expect(next.doc.line(2).text).toBe('2. bb');
		expect(next.doc.line(3).text).toBe('    1. cc');
		expect(next.doc.line(4).text).toBe('3. dd');
	});

	it('Tab 後のキャレットは - [ ] の直後（本文先頭）に置く', () => {
		// 2 行目の未チェック項目をインデントする
		const state = createListState(['- [ ] parent', '- [ ] child'], 2);
		// インデント後。キャレットはマーカー直後へ寄る
		const next  = applyCommand(state, indentListItem);
		// キャレットを見る 2 行目
		const line  = next.doc.line(2);
		// 主カーソルの文書オフセット
		const head  = next.selection.main.head;

		expect(line.text).toBe('    - [ ] child');
		expect(line.text.slice(0, head - line.from)).toBe('    - [ ] ');
		expect(line.text.slice(head - line.from)).toBe('child');
	});

	it('Shift+Tab 後のキャレットも - [ ] の直後に置く', () => {
		// ネストしたチェック済み項目を親階層へ戻す
		const state = createListState(['- [ ] parent', '    - [x] child'], 2);
		// デデント後。チェックは [x] のまま
		const next  = applyCommand(state, dedentListItem);
		// キャレットを見る 2 行目
		const line  = next.doc.line(2);
		// 主カーソルの文書オフセット
		const head  = next.selection.main.head;

		expect(line.text).toBe('- [x] child');
		expect(line.text.slice(0, head - line.from)).toBe('- [x] ');
		expect(line.text.slice(head - line.from)).toBe('child');
	});
});
