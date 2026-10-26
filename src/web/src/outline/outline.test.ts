/**
 * 見出しの収集、現在位置、アウトライン一覧のスクロール計算を検証する
 * @file
 */

import { markdown } from '@codemirror/lang-markdown';
import { EditorState, Transaction, type TransactionSpec } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { buildOutlineTree, collectOutlineAncestorFroms, collectFoldableOutlineFroms, collectOutlineItems, computeOutlineListScrollTop, computeOutlineTargetScrollTop, createOutlineCaretRedrawSpec, createOutlineScrollExtension, findActiveOutlineItemIndex, jumpToOutlineItem, planOutlineScrollCorrection, preserveEditorFocusOnOutlineMouseDown } from './outline';

/**
 * テスト用の Markdown EditorState を生成する
 * @param text - 見出しを含む Markdown
 * @returns 構文解析つきの文書状態
 */
function createMarkdownState(text: string): EditorState {
	return EditorState.create({
		// 見出しを含む本文
		doc: text,
		// 見出しノードを得る言語サポート。TMS 拡張は載せない
		extensions: [markdown()]
	});
}

describe('collectOutlineItems', () => {
	it('ATX 見出しと Setext 見出しを文書順に収集する', () => {
		// ATX と Setext が混ざる文書。閉じの # は見出しに含めない
		const text = ['# 見出し 1', '本文', '## 見出し 2 ##', 'Setext 見出し', '---', '###### 見出し 6'].join('\n');

		// 文書順の見出し。レベル、表示文字列、文書位置
		expect(collectOutlineItems(createMarkdownState(text))).toEqual([
			{
				// # の数。最上位
				level: 1,
				// 表示文字列。# は含まない
				title: '見出し 1',
				// 文書位置。先頭
				from: 0
			},
			{
				// ## 。閉じの # はレベルに数えない
				level: 2,
				// 閉じの # を除いた表示文字列
				title: '見出し 2',
				// 本文の次の文書位置
				from: 11
			},
			{
				// Setext の --- 。レベル 2
				level: 2,
				// 下線の上の文字列
				title: 'Setext 見出し',
				// 下線ではなく見出し行の位置
				from: 23
			},
			{
				// ###### 。レベル 6
				level: 6,
				// 表示文字列
				title: '見出し 6',
				// 文書末尾側の位置
				from: 38
			}
		]);
	});

	it('コードブロックや見出しとして解釈されない # は除外する', () => {
		// コード、エスケープ、空白なし、中身の無い ### 。見出しになるのは最後だけ
		const text = ['```md', '# コード内', '```', '\\# エスケープ', '#空白なし', '###'].join('\n');

		// 中身の無い ### だけ。表示は無題
		expect(collectOutlineItems(createMarkdownState(text))).toEqual([
			{
				// ### のレベル
				level: 3,
				// 文字列が無いときの表示
				title: '（無題）',
				// その ### の文書位置
				from: 32
			}
		]);
	});
});

describe('buildOutlineTree', () => {
	it('浅い見出しの下に深い見出しを入れる', () => {
		// 1 の下に 2 と 3、同レベルの 2、次の 1。子を持つ位置を見る
		const tree = buildOutlineTree([
			{
				// 根。A
				level: 1,
				// 表示文字列
				title: 'A',
				// 文書位置。折りたたみのキーにも使う
				from: 0
			},
			{
				// A の子
				level: 2,
				// 表示文字列
				title: 'B',
				// A より後ろ
				from: 10
			},
			{
				// B の子
				level: 3,
				// 表示文字列
				title: 'C',
				// B より後ろ
				from: 20
			},
			{
				// A の子。B の兄弟
				level: 2,
				// 表示文字列
				title: 'D',
				// C より後ろ
				from: 30
			},
			{
				// 次の根。子は無い
				level: 1,
				// 表示文字列
				title: 'E',
				// 文書の後ろ
				from: 40
			}
		]);

		expect(tree.map((node) => node.item.title)).toEqual(['A', 'E']);
		expect(tree[0].children.map((node) => node.item.title)).toEqual(['B', 'D']);
		expect(tree[0].children[0].children.map((node) => node.item.title)).toEqual(['C']);
		expect(tree[1].children).toEqual([]);
		expect(collectFoldableOutlineFroms(tree)).toEqual([0, 10]);
	});

	it('見出しレベルが飛んでも直前のより浅い見出しの子にする', () => {
		// レベルが 1 から 3 へ飛び、そのあと 2。3 も 2 も 1 の子
		const tree = buildOutlineTree([
			{
				// 根
				level: 1,
				// 表示文字列
				title: 'A',
				// 文書位置
				from: 0
			},
			{
				// 2 を飛ばして 3。直前の 1 の子
				level: 3,
				// 表示文字列
				title: 'C',
				// A より後ろ
				from: 10
			},
			{
				// 3 より浅いが 1 より深い。A の子
				level: 2,
				// 表示文字列
				title: 'B',
				// C より後ろ
				from: 20
			}
		]);

		expect(tree).toHaveLength(1);
		expect(tree[0].children.map((node) => node.item.title)).toEqual(['C', 'B']);
		expect(collectFoldableOutlineFroms(tree)).toEqual([0]);
	});

	it('同じレベルの見出しは兄弟にする', () => {
		// 同じレベルが続く。親子にならず、折りたたみ対象も無い
		const tree = buildOutlineTree([
			{
				// 根。子を持たない
				level: 2,
				// 表示文字列
				title: 'A',
				// 文書位置
				from: 0
			},
			{
				// A と同じレベル。兄弟
				level: 2,
				// 表示文字列
				title: 'B',
				// A より後ろ
				from: 10
			}
		]);

		expect(tree.map((node) => node.item.title)).toEqual(['A', 'B']);
		expect(collectFoldableOutlineFroms(tree)).toEqual([]);
	});
});

describe('findActiveOutlineItemIndex', () => {
	/** 現在見出しの判定に使う、開始位置つきの見出し */
	const items = [
		{
			// 最初の見出し。位置 5 未満は現在見出しが無い
			level: 1,
			// 表示文字列
			title: 'A',
			// この位置から B の手前までが A
			from: 5
		},
		{
			// A の次。位置 39 までは B
			level: 2,
			// 表示文字列
			title: 'B',
			// この位置から C の手前まで
			from: 20
		},
		{
			// 最後。位置 40 以降はずっと C
			level: 1,
			// 表示文字列
			title: 'C',
			// 文書の後ろ側
			from: 40
		}
	];

	it.each([
		[0, -1],
		[5, 0],
		[39, 1],
		[40, 2],
		[100, 2]
	])('位置 %i の現在見出しは %i', (position, expected) => {
		expect(findActiveOutlineItemIndex(items, position)).toBe(expected);
	});
});

describe('collectOutlineAncestorFroms', () => {
	/** 祖先判定に使う見出し。レベルが親子関係を表す */
	const items = [
		{
			// 一番外。B と C と D の祖先
			level: 1,
			// 表示文字列
			title: 'A',
			// 祖先として返す位置
			from: 0
		},
		{
			// A の内側。C の祖先
			level: 3,
			// 表示文字列
			title: 'B',
			// C から見て祖先になる位置
			from: 10
		},
		{
			// B の内側。自身の祖先は A と B
			level: 4,
			// 表示文字列
			title: 'C',
			// アクティブにする位置
			from: 20
		},
		{
			// B より浅い。祖先は A だけ
			level: 2,
			// 表示文字列
			title: 'D',
			// 文書の後ろ
			from: 30
		}
	];

	it('アクティブ見出しの祖先を外側から返す', () => {
		expect(collectOutlineAncestorFroms(items, 2)).toEqual([0, 10]);
		expect(collectOutlineAncestorFroms(items, 3)).toEqual([0]);
	});

	it('アクティブ見出しがない場合は空配列を返す', () => {
		expect(collectOutlineAncestorFroms(items, -1)).toEqual([]);
		expect(collectOutlineAncestorFroms(items, items.length)).toEqual([]);
	});
});

describe('computeOutlineListScrollTop', () => {
	it('項目が表示範囲内なら現在位置を維持する', () => {
		// 項目がビューポートの中。スクロールは動かさない
		expect(
			computeOutlineListScrollTop({
				// 項目の上端。px。ビューポートの中
				itemTop: 130,
				// 項目の下端。px。ビューポートの中
				itemBottom: 150,
				// 見えている範囲の上端。px
				viewportTop: 100,
				// 見えている範囲の下端。px
				viewportBottom: 200,
				// 今のスクロール。px。このまま返す
				scrollTop: 300,
				// スクロールの上限。px。今回は当たらない
				maxScrollTop: 900
			})
		).toBe(300);
	});

	it('項目が上側に隠れていれば余白付きで上へ移動する', () => {
		// 項目が上にはみ出す。余白 6px を空けて上へ動かす
		expect(
			computeOutlineListScrollTop({
				// 項目の上端。px。ビューポートより上
				itemTop: 80,
				// 項目の下端。px。ビューポートの上端と同じ
				itemBottom: 100,
				// 見えている範囲の上端。px
				viewportTop: 100,
				// 見えている範囲の下端。px
				viewportBottom: 200,
				// 今のスクロール。px
				scrollTop: 300,
				// スクロールの上限。px。上方向では当たらない
				maxScrollTop: 900,
				// 項目の外側に空ける余白。px
				margin: 6
			})
		).toBe(274);
	});

	it('項目が下側に隠れていれば余白付きで下へ移動する', () => {
		// 項目が下にはみ出す。余白 6px を空けて下へ動かす
		expect(
			computeOutlineListScrollTop({
				// 項目の上端。px。ビューポートの下端付近
				itemTop: 195,
				// 項目の下端。px。ビューポートより下
				itemBottom: 220,
				// 見えている範囲の上端。px
				viewportTop: 100,
				// 見えている範囲の下端。px
				viewportBottom: 200,
				// 今のスクロール。px
				scrollTop: 300,
				// スクロールの上限。px。今回は当たらない
				maxScrollTop: 900,
				// 項目の外側に空ける余白。px
				margin: 6
			})
		).toBe(326);
	});

	it('スクロール可能範囲を超えない', () => {
		// 下へ動かしたいが上限 900 で止まる
		expect(
			computeOutlineListScrollTop({
				// 項目の上端。px
				itemTop: 195,
				// 項目の下端。px。ビューポートより大きく下
				itemBottom: 260,
				// 見えている範囲の上端。px
				viewportTop: 100,
				// 見えている範囲の下端。px
				viewportBottom: 200,
				// 今のスクロール。px。上限に近い
				scrollTop: 880,
				// スクロールの上限。px。これを超えない
				maxScrollTop: 900
			})
		).toBe(900);
	});
});

describe('jumpToOutlineItem', () => {
	it('フォーカスを先に戻し、スクロール効果なしでキャレットだけを移動する', () => {
		// 2 件目が移動先。フォーカスの後にキャレットだけを動かす
		const state                               = createMarkdownState('# 先頭\n本文\n### 移動先');
		// 移動先の見出し。文書位置をキャレットにする
		const item                                = collectOutlineItems(state)[1];
		// focus と dispatch の呼出順。空ならまだ動いていない
		const calls: string[]                     = [];
		// dispatch へ渡した仕様。スクロール効果が無いことを見る
		const transactionSpecs: TransactionSpec[] = [];

		// フォーカスと dispatch の順を記録するビュー
		jumpToOutlineItem(
			{
				/** フォーカス呼出を記録する */
				focus: () => calls.push('focus'),
				/** dispatch呼出と指定内容を記録する */
				dispatch: (spec) => {
					calls.push('dispatch');
					transactionSpecs.push(spec);
				}
			},
			item
		);

		expect(calls).toEqual(['focus', 'dispatch']);
		expect(transactionSpecs).toHaveLength(1);
		// 1 件だけ渡された仕様。選択とユーザイベントを見る
		const transactionSpec = transactionSpecs[0];
		expect((transactionSpec.selection as { assoc?: number }).assoc).toBe(1);
		expect(transactionSpec.effects).toBeUndefined();
		// 仕様を適用したトランザクション。キャレットは見出し位置
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
		// 上端余白に揃って見えている。追加スクロールは 0
		expect(
			planOutlineScrollCorrection(
				{
					// 見出し行の上端。px。余白込みの目標と一致
					top: 112,
					// 見出し行の下端。px。見えている範囲の中
					bottom: 140
				},
				100,
				300,
				80,
				1800,
				12
			)
		).toEqual({
			// 追加で動かす量。px。0 は動かさない
			delta: 0,
			// 上端余白に揃い、見えている
			aligned: true
		});
	});

	it('見出しが下にずれていれば下方向へ追加スクロールする', () => {
		// 見出しが目標より下。下方向へ追加スクロールする
		expect(
			planOutlineScrollCorrection(
				{
					// 見出し行の上端。px。目標より下
					top: 180,
					// 見出し行の下端。px
					bottom: 208
				},
				100,
				300,
				80,
				1800,
				12
			)
		).toEqual({
			// 下へ動かす量。px
			delta: 68,
			// まだ上端余白には揃っていない
			aligned: false
		});
	});

	it('末尾で上端合わせできなくても行が見えていれば到達とみなす', () => {
		// 末尾で上端合わせはできないが、行は見えている
		expect(
			planOutlineScrollCorrection(
				{
					// 見出し行の上端。px。見えている範囲の中
					top: 220,
					// 見出し行の下端。px。見えている範囲の中
					bottom: 248
				},
				100,
				300,
				1800,
				1800,
				12
			)
		).toEqual({
			// これ以上動かさない
			delta: 0,
			// 見えていれば到達とみなす
			aligned: true
		});
	});

	it('まだ見えておらずこれ以上スクロールできない場合は再試行対象にする', () => {
		// まだ見えておらず、スクロールも上限。再試行の対象
		expect(
			planOutlineScrollCorrection(
				{
					// 見出し行の上端。px。見えている範囲より下
					top: 320,
					// 見出し行の下端。px。見えていない
					bottom: 348
				},
				100,
				300,
				1800,
				1800,
				12
			)
		).toEqual({
			// 動かせる量は 0
			delta: 0,
			// 揃っていない。再試行する
			aligned: false
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
		// 再計測の対象文書。位置は 2 件目の見出し
		const state       = createMarkdownState('# 先頭\n本文\n### 移動先');
		// キャレットを置く文書位置。ジャンプの位置と同じ
		const from        = collectOutlineItems(state)[1].from;
		// 位置を変えず再計測だけを指示する仕様
		const spec        = createOutlineCaretRedrawSpec(from);
		// 仕様を適用したトランザクション。ユーザイベントは select.caret
		const transaction = state.update(spec);

		expect(transaction.newSelection.main.head).toBe(from);
		expect(transaction.isUserEvent('select.caret')).toBe(true);
		expect(transaction.annotation(Transaction.userEvent)).not.toBe('select.outline');
	});
});

describe('preserveEditorFocusOnOutlineMouseDown', () => {
	it('主ボタンのマウスダウンではアウトラインボタンへのフォーカス移動を防ぐ', () => {
		// フォーカス移動を防いだ印。主ボタンなら true になる
		let prevented = false;
		// 主ボタンのマウスダウン。preventDefault を呼ぶ
		preserveEditorFocusOnOutlineMouseDown({
			// 主ボタン。これ以外は妨げない
			button: 0,
			/** preventDefault 呼び出しを記録する */
			preventDefault: () => {
				prevented = true;
			}
		});

		expect(prevented).toBe(true);
	});

	it('主ボタン以外のマウスダウンは妨げない', () => {
		// フォーカス移動を防いだ印。副ボタンでは false のまま
		let prevented = false;
		// 副ボタンのマウスダウン。preventDefault は呼ばない
		preserveEditorFocusOnOutlineMouseDown({
			// 副ボタン
			button: 2,
			/** preventDefault 呼び出しを記録する */
			preventDefault: () => {
				prevented = true;
			}
		});

		expect(prevented).toBe(false);
	});
});
