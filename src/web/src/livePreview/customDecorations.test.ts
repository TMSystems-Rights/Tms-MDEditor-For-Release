/**
 * 利用者が定義した正規表現のコンパイルと、プレビュー行への mark 反映を検証する
 * 不正な正規表現は戻り値の名前で見、DOM は作らない
 * @file
 */
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createTmsMarkdownSupport } from '../editor/createTmsMarkdown';
import { collectCustomDecorationEntries, collectCustomDecorationRangesFromText, compileCustomDecorationRules, createCustomDecorationsExtensions, isSafeCssClassName } from './customDecorations';
import { collectSourceLineNumbers } from './cursorLine';
import { viewModeField } from './livePreviewPlugin';

/**
 * カスタム装飾ルールを載せたテスト用状態を作る
 * @param doc - ドキュメント全文
 * @param options - カーソルと初期ルール。省略時は先頭カーソルでルール無し
 * @returns 表示モードと装飾ルールを持つ状態
 */
function createState(
	doc: string,
	options: {
		cursor?: number;
		rules?: ReturnType<typeof compileCustomDecorationRules>['rules'];
	} = {}
): EditorState {
	return EditorState.create({
		// 装飾対象の本文
		doc,
		// 空のキャレット。省略時は文書先頭で、その行はソース表示
		selection: EditorSelection.cursor(options.cursor ?? 0),
		// ライブプレビューと、渡された装飾ルール
		// ライブプレビュー固定と、省略時は空の装飾ルール
		extensions: [createTmsMarkdownSupport(), viewModeField.init(() => 'live-preview'), ...createCustomDecorationsExtensions(options.rules ?? [])]
	});
}

describe('customDecorations', () => {
	it('isSafeCssClassName は安全なクラス名のみ許可する', () => {
		expect(isSafeCssClassName('tms-underline')).toBe(true);
		expect(isSafeCssClassName('_foo')).toBe(true);
		expect(isSafeCssClassName('a1')).toBe(true);
		expect(isSafeCssClassName('1bad')).toBe(false);
		expect(isSafeCssClassName('has space')).toBe(false);
		expect(isSafeCssClassName('a;alert(1)')).toBe(false);
	});

	it('不正な正規表現・cssClass は invalidNames に入りルールから除外する', () => {
		// 正しいルールだけ残し、不正と無効は名前で返す
		const result = compileCustomDecorationRules([
			{
				// 残すルールの名前
				name: 'ok',
				// 有効。false だとルールから外れる
				enabled: true,
				// キャプチャ付きの区切り
				pattern: '_v(.+?)_v',
				// キャプチャへ付けるクラス
				cssClass: 'tms-underline'
			},
			{
				// 不正な正規表現として名前を返す
				name: 'bad-regex',
				// 閉じていないグループ。コンパイルできない
				pattern: '(',
				// クラスは正しくてもパターンが不正なら除外
				cssClass: 'tms-underline'
			},
			{
				// 不正なクラスとして名前を返す
				name: 'bad-class',
				// パターン自体は正しい
				pattern: 'x(y)z',
				// 空白を含むクラス。ルールに載せない
				cssClass: 'bad class'
			},
			{
				// 無効。invalidNames には入れない
				name: 'disabled',
				// 無効。ルールから外れる
				enabled: false,
				// パターンは正しい
				pattern: 'a(b)c',
				// クラスも正しいが、無効なので使わない
				cssClass: 'ok-class'
			}
		]);

		expect(result.rules.map((rule) => rule.name)).toEqual(['ok']);
		expect(result.invalidNames).toEqual(['bad-regex', 'bad-class']);
	});

	it('テキスト座標でキャプチャと区切りを返す', () => {
		// このケースで使うコンパイル済みルール。不正なら空
		const { rules } = compileCustomDecorationRules([
			{
				// 下線ルールの名前
				name: '下線',
				// 区切りの内側をキャプチャする
				pattern: '_v(.+?)_v',
				// 区切り自体は隠す
				hideDelimiters: true,
				// キャプチャへ付けるクラス
				cssClass: 'tms-underline'
			}
		]);
		// 基準 10 からの範囲。区切りとキャプチャの両方
		const ranges    = collectCustomDecorationRangesFromText('前 _v中_v 後', rules, 10);
		expect(ranges).toHaveLength(1);
		// 基準 10 を足した座標と、隠すかどうか
		expect(ranges[0]).toMatchObject({
			// 区切りを含む開始
			fullFrom: 12,
			// キャプチャの開始
			from: 14,
			// キャプチャの終了
			to: 15,
			// 区切りを含む終了
			fullTo: 17,
			// キャプチャへ付けるクラス
			cssClass: 'tms-underline',
			// 区切りを隠す
			hideDelimiters: true
		});
	});

	it('下線ルールでキャプチャ部分へ mark、デリミタを hide する', () => {
		// このケースで使うコンパイル済みルール。不正なら空
		const { rules } = compileCustomDecorationRules([
			{
				// 下線ルールの名前
				name: '下線',
				// 区切りの内側をキャプチャする
				pattern: '_v(.+?)_v',
				// 区切り自体は隠す
				hideDelimiters: true,
				// キャプチャへ付けるクラス
				cssClass: 'tms-underline'
			}
		]);
		// カーソルは 1 行目。対象は 2 行目（プレビュー行）
		const state     = createState('cursor here\nhello _v装飾サンプル文字列_v end', {
			// 先頭カーソル。その行はソース表示で装飾しない
			cursor: 0,
			// このケースの装飾ルール
			rules
		});
		// プレビュー行の装飾。カーソル行は含まない
		const entries   = collectCustomDecorationEntries(state, collectSourceLineNumbers(state), rules);

		// 下線クラスの mark。区切りは含まない
		const marks = entries.filter((entry) => entry.decoration.spec.class === 'tms-underline');
		expect(marks).toHaveLength(1);
		expect(state.doc.sliceString(marks[0]!.from, marks[0]!.to)).toBe('装飾サンプル文字列');

		// クラスを付けず隠す範囲。空の範囲は含めない
		const hidden = entries.filter((entry) => entry.decoration.spec.class === undefined && entry.to > entry.from);
		expect(hidden.length).toBeGreaterThanOrEqual(2);
		expect(hidden.filter((entry) => state.doc.sliceString(entry.from, entry.to) === '_v')).toHaveLength(2);
	});

	it('_v 区切りの対象が同一行に複数あっても個別に装飾する', () => {
		// このケースで使うコンパイル済みルール。不正なら空
		const { rules } = compileCustomDecorationRules([
			{
				// 下線ルールの名前
				name: '下線',
				// 区切りの内側をキャプチャする
				pattern: '_v(.+?)_v',
				// 区切り自体は隠す
				hideDelimiters: true,
				// キャプチャへ付けるクラス
				cssClass: 'tms-underline'
			}
		]);
		// 先頭カーソル。同じ行の 2 箇所はプレビュー
		const state     = createState('cursor here\n_v下線aa_v と _v下線bb_v', {
			// 先頭カーソル。その行はソース表示で装飾しない
			cursor: 0,
			// このケースの装飾ルール
			rules
		});
		// 同じ行の 2 箇所の装飾
		const entries   = collectCustomDecorationEntries(state, collectSourceLineNumbers(state), rules);

		// 下線クラスの mark。2 件に分かれる
		const marks = entries.filter((entry) => entry.decoration.spec.class === 'tms-underline');
		expect(marks.map((entry) => state.doc.sliceString(entry.from, entry.to))).toEqual(['下線aa', '下線bb']);

		// クラスを付けず隠す範囲。区切り 4 つ
		const hidden = entries.filter((entry) => entry.decoration.spec.class === undefined && entry.to > entry.from);
		expect(hidden.filter((entry) => state.doc.sliceString(entry.from, entry.to) === '_v')).toHaveLength(4);
	});

	it('カーソル行ではカスタム装飾を適用しない', () => {
		// このケースで使うコンパイル済みルール。不正なら空
		const { rules } = compileCustomDecorationRules([
			{
				// 下線ルールの名前
				name: '下線',
				// 区切りの内側をキャプチャする
				pattern: '_v(.+?)_v',
				// 区切り自体は隠す
				hideDelimiters: true,
				// キャプチャへ付けるクラス
				cssClass: 'tms-underline'
			}
		]);
		// 装飾対象と同じ行にカーソルを置く文書
		const doc       = 'hello _v下線aa_v end';
		// キャプチャの開始。この行はソース表示になる
		const cursor    = doc.indexOf('下線aa');
		// カーソル行では装飾を付けない状態
		const state     = createState(doc, {
			// キャプチャ上のカーソル。その行全体をソース表示にする
			cursor,
			// 下線ルール。カーソル行では使わない
			rules
		});
		// その行の装飾。空になる
		const entries   = collectCustomDecorationEntries(state, collectSourceLineNumbers(state), rules);
		expect(entries).toHaveLength(0);
	});

	it('Lezer ツリーが存在する状態でもコンパイル済みルールを読める', () => {
		// このケースで使うコンパイル済みルール。不正なら空
		const { rules } = compileCustomDecorationRules([
			{
				// foo をマークするルールの名前
				name: 'mark-foo',
				// 単語 foo だけをキャプチャする
				pattern: '\\b(foo)\\b',
				// キャプチャへ付けるクラス
				cssClass: 'tms-underline'
			}
		]);
		// 先頭カーソル。foo はプレビュー側
		const state     = createState('cursor\nfoo bar foo', {
			// 先頭カーソル。その行はソース表示で装飾しない
			cursor: 0,
			// このケースの装飾ルール
			rules
		});
		expect(syntaxTree(state).type.name).toBeTruthy();
		// 構文木がある状態で読んだ装飾
		const entries = collectCustomDecorationEntries(state);
		// foo へ付けた mark。2 件
		const marks   = entries.filter((entry) => entry.decoration.spec.class === 'tms-underline');
		expect(marks).toHaveLength(2);
	});
});
