/**
 * タスクマーカーの判定とトグルを、描画なしの EditorState で検証する
 * コマンドの dispatch はテスト内で次の状態へ置き換えるだけで、ビューは持たない
 * @file
 */
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState, type StateCommand } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { findTaskMarkerAt, isTaskMarkerChecked, toggleCheckboxCommand } from './checkboxToggle';

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
 * GFM のタスクリストを解釈できる EditorState を作る
 * @param doc - 文書本文
 * @param head - 主カーソルの文書オフセット。anchor も同じ位置にする
 * @returns タスクリスト付き Markdown を有効にした状態
 */
function createState(doc: string, head: number): EditorState {
	return EditorState.create({
		// 呼び出し側の本文
		doc,
		// anchor と head が同じ空キャレット
		selection: {
			// 選択の起点。head と同じ位置
			anchor: head,
			// 主カーソル。引数の文書オフセット
			head
		},
		// タスクリストを構文木にする言語サポート
		extensions: [markdown({ base: markdownLanguage })]
	});
}

describe('checkboxToggle', () => {
	it('isTaskMarkerChecked は x / X をチェック済みと判定する', () => {
		expect(isTaskMarkerChecked('[x]')).toBe(true);
		expect(isTaskMarkerChecked('[X]')).toBe(true);
		expect(isTaskMarkerChecked('[ ]')).toBe(false);
	});

	it('findTaskMarkerAt は行内の TaskMarker を返す', () => {
		// 未チェックのタスク。カーソルはマーカーの中
		const state  = createState('- [ ] task', 5);
		// その位置の TaskMarker。無ければ null
		const marker = findTaskMarkerAt(state, 5);

		expect(marker).not.toBeNull();
		expect(state.doc.sliceString(marker!.from, marker!.to)).toBe('[ ]');
		expect(marker!.checked).toBe(false);
	});

	it('[ ] を [x] にトグルする', () => {
		// 未チェックのタスク。カーソルはマーカーの中
		const state = createState('- [ ] task', 5);
		// トグル後。マーカーは [x] になる
		const next  = applyCommand(state, toggleCheckboxCommand);

		expect(next.doc.toString()).toBe('- [x] task');
	});

	it('[x] を [ ] にトグルする', () => {
		// 小文字 x のチェック済み。外すと空白になる
		const state = createState('- [x] task', 5);
		// トグル後。マーカーは [ ] になる
		const next  = applyCommand(state, toggleCheckboxCommand);

		expect(next.doc.toString()).toBe('- [ ] task');
	});

	it('[X] を [ ] にトグルする', () => {
		// 大文字 X のチェック済み。小文字と同じく外す
		const state = createState('- [X] task', 5);
		// トグル後。マーカーは [ ] になる
		const next  = applyCommand(state, toggleCheckboxCommand);

		expect(next.doc.toString()).toBe('- [ ] task');
	});

	it('非タスク行では no-op で false を返す', () => {
		// タスクマーカーの無い箇条書き。コマンドは何もしない
		const state  = createState('- plain item', 5);
		// dispatch が呼ばれた印。呼ばれなければ false のまま
		let called   = false;
		// コマンドの戻り値。非タスクでは false
		const result = toggleCheckboxCommand({
			// 適用前の文書
			state,
			/**
			 * 非タスク行では呼ばれないことの確認用。呼ばれたら印を付ける
			 */
			dispatch: () => {
				// 呼ばれたら true。このケースでは true にならない
				called = true;
			}
		});

		expect(result).toBe(false);
		expect(called).toBe(false);
	});
});
