import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState, type StateCommand } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
	findTaskMarkerAt,
	isTaskMarkerChecked,
	toggleCheckboxCommand,
} from './checkboxToggle';

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
 * GFM（TaskList 含む）付き EditorState を生成する
 * @param {string} doc ドキュメント
 * @param {number} head カーソル位置
 * @returns {EditorState}
 */
function createState(doc: string, head: number): EditorState {
	return EditorState.create({
		doc,
		selection : { anchor: head, head },
		extensions: [markdown({ base: markdownLanguage })],
	});
}

describe('checkboxToggle', () => {
	it('isTaskMarkerChecked は x / X をチェック済みと判定する', () => {
		expect(isTaskMarkerChecked('[x]')).toBe(true);
		expect(isTaskMarkerChecked('[X]')).toBe(true);
		expect(isTaskMarkerChecked('[ ]')).toBe(false);
	});

	it('findTaskMarkerAt は行内の TaskMarker を返す', () => {
		const state  = createState('- [ ] task', 5);
		const marker = findTaskMarkerAt(state, 5);

		expect(marker).not.toBeNull();
		expect(state.doc.sliceString(marker!.from, marker!.to)).toBe('[ ]');
		expect(marker!.checked).toBe(false);
	});

	it('[ ] を [x] にトグルする', () => {
		const state = createState('- [ ] task', 5);
		const next  = applyCommand(state, toggleCheckboxCommand);

		expect(next.doc.toString()).toBe('- [x] task');
	});

	it('[x] を [ ] にトグルする', () => {
		const state = createState('- [x] task', 5);
		const next  = applyCommand(state, toggleCheckboxCommand);

		expect(next.doc.toString()).toBe('- [ ] task');
	});

	it('[X] を [ ] にトグルする', () => {
		const state = createState('- [X] task', 5);
		const next  = applyCommand(state, toggleCheckboxCommand);

		expect(next.doc.toString()).toBe('- [ ] task');
	});

	it('非タスク行では no-op で false を返す', () => {
		const state  = createState('- plain item', 5);
		let called   = false;
		const result = toggleCheckboxCommand({
			state,
			/**
			 * @returns {void}
			 */
			dispatch: () => {
				called = true;
			},
		});

		expect(result).toBe(false);
		expect(called).toBe(false);
	});
});
