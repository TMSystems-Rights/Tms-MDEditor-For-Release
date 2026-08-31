import { markdown } from '@codemirror/lang-markdown';
import { EditorState, Transaction, type TransactionSpec } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
	buildOutlineTree,
	collectFoldableOutlineFroms,
	collectOutlineItems,
	computeOutlineTargetScrollTop,
	createOutlineCaretRedrawSpec,
	createOutlineScrollExtension,
	findActiveOutlineItemIndex,
	jumpToOutlineItem,
	planOutlineScrollCorrection,
	preserveEditorFocusOnOutlineMouseDown,
} from './outline';

/** テスト用の Markdown EditorState を生成する。 */
function createMarkdownState(text: string): EditorState {
	return EditorState.create({ doc: text, extensions: [markdown()] });
}

describe('collectOutlineItems', () => {
	it('ATX 見出しと Setext 見出しを文書順に収集する', () => {
		const text = [
			'# 見出し 1',
			'本文',
			'## 見出し 2 ##',
			'Setext 見出し',
			'---',
			'###### 見出し 6',
		].join('\n');

		expect(collectOutlineItems(createMarkdownState(text))).toEqual([
			{ level: 1, title: '見出し 1', from: 0 },
			{ level: 2, title: '見出し 2', from: 11 },
			{ level: 2, title: 'Setext 見出し', from: 23 },
			{ level: 6, title: '見出し 6', from: 38 },
		]);
	});

	it('コードブロックや見出しとして解釈されない # は除外する', () => {
		const text = [
			'```md',
			'# コード内',
			'```',
			'\\# エスケープ',
			'#空白なし',
			'###',
		].join('\n');

		expect(collectOutlineItems(createMarkdownState(text))).toEqual([
			{ level: 3, title: '（無題）', from: 32 },
		]);
	});
});

describe('buildOutlineTree', () => {
	it('浅い見出しの下に深い見出しを入れる', () => {
		const tree = buildOutlineTree([
			{ level: 1, title: 'A', from: 0 },
			{ level: 2, title: 'B', from: 10 },
			{ level: 3, title: 'C', from: 20 },
			{ level: 2, title: 'D', from: 30 },
			{ level: 1, title: 'E', from: 40 },
		]);

		expect(tree.map((node) => node.item.title)).toEqual(['A', 'E']);
		expect(tree[0].children.map((node) => node.item.title)).toEqual(['B', 'D']);
		expect(tree[0].children[0].children.map((node) => node.item.title)).toEqual(['C']);
		expect(tree[1].children).toEqual([]);
		expect(collectFoldableOutlineFroms(tree)).toEqual([0, 10]);
	});

	it('見出しレベルが飛んでも直前のより浅い見出しの子にする', () => {
		const tree = buildOutlineTree([
			{ level: 1, title: 'A', from: 0 },
			{ level: 3, title: 'C', from: 10 },
			{ level: 2, title: 'B', from: 20 },
		]);

		expect(tree).toHaveLength(1);
		expect(tree[0].children.map((node) => node.item.title)).toEqual(['C', 'B']);
		expect(collectFoldableOutlineFroms(tree)).toEqual([0]);
	});

	it('同じレベルの見出しは兄弟にする', () => {
		const tree = buildOutlineTree([
			{ level: 2, title: 'A', from: 0 },
			{ level: 2, title: 'B', from: 10 },
		]);

		expect(tree.map((node) => node.item.title)).toEqual(['A', 'B']);
		expect(collectFoldableOutlineFroms(tree)).toEqual([]);
	});
});

describe('findActiveOutlineItemIndex', () => {
	const items = [
		{ level: 1, title: 'A', from: 5 },
		{ level: 2, title: 'B', from: 20 },
		{ level: 1, title: 'C', from: 40 },
	];

	it.each([
		[0, -1],
		[5, 0],
		[39, 1],
		[40, 2],
		[100, 2],
	])('位置 %i の現在見出しは %i', (position, expected) => {
		expect(findActiveOutlineItemIndex(items, position)).toBe(expected);
	});
});

describe('jumpToOutlineItem', () => {
	it('フォーカスを先に戻し、スクロール効果なしでキャレットだけを移動する', () => {
		const state                               = createMarkdownState('# 先頭\n本文\n### 移動先');
		const item                                = collectOutlineItems(state)[1];
		const calls: string[]                     = [];
		const transactionSpecs: TransactionSpec[] = [];

		jumpToOutlineItem({
			/** フォーカス呼出を記録する。 */
			focus: () => calls.push('focus'),
			/** dispatch呼出と指定内容を記録する。 */
			dispatch: (spec) => {
				calls.push('dispatch');
				transactionSpecs.push(spec);
			},
		}, item);

		expect(calls).toEqual(['focus', 'dispatch']);
		expect(transactionSpecs).toHaveLength(1);
		const transactionSpec = transactionSpecs[0];
		expect((transactionSpec.selection as { assoc?: number }).assoc).toBe(1);
		expect(transactionSpec.effects).toBeUndefined();
		const transaction = state.update(transactionSpec);
		expect(transaction.newSelection.main.head).toBe(item.from);
		expect(transaction.isUserEvent('select.outline')).toBe(true);
		expect(transaction.effects).toHaveLength(0);
	});
});

describe('computeOutlineTargetScrollTop', () => {
	it('見出し行を上端余白分だけ下げた位置へスクロールする', () => {
		expect(computeOutlineTargetScrollTop(400, 200, 2000, 12)).toBe(388);
	});

	it('文書先頭より上へはスクロールしない', () => {
		expect(computeOutlineTargetScrollTop(8, 200, 2000, 12)).toBe(0);
	});

	it('文書末尾を超えてスクロールしない', () => {
		expect(computeOutlineTargetScrollTop(1900, 200, 2000, 12)).toBe(1800);
	});
});

describe('planOutlineScrollCorrection', () => {
	it('上端余白に揃っていて見えていれば追加スクロールしない', () => {
		expect(planOutlineScrollCorrection({ top: 112, bottom: 140 }, 100, 300, 80, 1800, 12)).toEqual({
			delta  : 0,
			aligned: true,
		});
	});

	it('見出しが下にずれていれば下方向へ追加スクロールする', () => {
		expect(planOutlineScrollCorrection({ top: 180, bottom: 208 }, 100, 300, 80, 1800, 12)).toEqual({
			delta  : 68,
			aligned: false,
		});
	});

	it('末尾で上端合わせできなくても行が見えていれば到達とみなす', () => {
		expect(planOutlineScrollCorrection({ top: 220, bottom: 248 }, 100, 300, 1800, 1800, 12)).toEqual({
			delta  : 0,
			aligned: true,
		});
	});

	it('まだ見えておらずこれ以上スクロールできない場合は再試行対象にする', () => {
		expect(planOutlineScrollCorrection({ top: 320, bottom: 348 }, 100, 300, 1800, 1800, 12)).toEqual({
			delta  : 0,
			aligned: false,
		});
	});
});

describe('createOutlineScrollExtension', () => {
	it('エディタへ組み込む補正プラグインを返す', () => {
		expect(createOutlineScrollExtension()).toBeTruthy();
	});
});

describe('createOutlineCaretRedrawSpec', () => {
	it('位置は変えず、アウトラインジャンプとは別イベントでキャレット再計測を指示する', () => {
		const state       = createMarkdownState('# 先頭\n本文\n### 移動先');
		const from        = collectOutlineItems(state)[1].from;
		const spec        = createOutlineCaretRedrawSpec(from);
		const transaction = state.update(spec);

		expect(transaction.newSelection.main.head).toBe(from);
		expect(transaction.isUserEvent('select.caret')).toBe(true);
		expect(transaction.annotation(Transaction.userEvent)).not.toBe('select.outline');
	});
});

describe('preserveEditorFocusOnOutlineMouseDown', () => {
	it('主ボタンのマウスダウンではアウトラインボタンへのフォーカス移動を防ぐ', () => {
		let prevented = false;
		preserveEditorFocusOnOutlineMouseDown({
			button: 0,
			/** preventDefault 呼び出しを記録する。 */
			preventDefault: () => {
				prevented = true;
			},
		});

		expect(prevented).toBe(true);
	});

	it('主ボタン以外のマウスダウンは妨げない', () => {
		let prevented = false;
		preserveEditorFocusOnOutlineMouseDown({
			button: 2,
			/** preventDefault 呼び出しを記録する。 */
			preventDefault: () => {
				prevented = true;
			},
		});

		expect(prevented).toBe(false);
	});
});
