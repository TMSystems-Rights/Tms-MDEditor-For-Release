/**
 * 見出し、引用、リスト、コード、コールアウトの行装飾を検証する
 * 折りたたみの上書きはテストが StateEffect で渡し、描画 DOM は作らない
 * @file
 */
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createTmsMarkdownSupport } from '../editor/createTmsMarkdown';
import { collectSourceLineNumbers } from './cursorLine';
import { buildDecorationSet } from './inlineDecorations';
import { collectLineDecorationEntries, findCalloutContainingRange, findCollapsedCalloutContainingRange } from './lineDecorations';

/**
 * TMS Markdown 付き EditorState を生成する
 * @param doc - ドキュメント
 * @returns TMS Markdown 付き EditorState
 */
function createMarkdownState(doc: string): EditorState {
	return EditorState.create({
		// 行装飾を取る本文。選択は先頭
		doc,
		// 見出しや引用のノードを得る Markdown サポート
		extensions: [createTmsMarkdownSupport()]
	});
}

describe('lineDecorations', () => {
	it('見出し・引用・水平線・リストを含む Markdown でも DecorationSet を構築できる', () => {
		// 見出し、引用、水平線、リストが混ざる文書
		const state = createMarkdownState(['# Title', '> quote', '---', '- item one', '  - nested', '1. ordered', '- [ ] task'].join('\n'));

		expect(() => buildDecorationSet(collectLineDecorationEntries(state))).not.toThrow();
	});

	it('YAML フロントマターを水平線や Setext 見出しとして非表示にしない', () => {
		// 先頭の --- を水平線や Setext にしない文書
		const state       = EditorState.create({
			// フロントマターと、その後ろの見出し
			doc: ['---', 'fileClass: 問題点一覧管理票FileClass', 'プロジェクト名: TMS-MDEditor', '---', '', '# 本文'].join('\n'),
			// 空の選択。カーソルがある行はソース表示
			selection: {
				// 選択の起点。文書先頭
				anchor: 0,
				// 選択の終点。起点と同じなので空
				head: 0
			},
			// 見出しやリストのノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// ソース表示の行。先頭キャレットなので 1 行目
		const sourceLines = collectSourceLineNumbers(state);
		// 行装飾。フロントマター内は空であること
		const entries     = collectLineDecorationEntries(state, sourceLines);
		// 閉じ --- の行。4 行目
		const closingLine = state.doc.line(4);
		// 開きから閉じまでの装飾。1 件も無い
		const frontMatter = entries.filter((entry) => entry.from >= state.doc.line(1).from && entry.from <= closingLine.to);

		expect(frontMatter).toEqual([]);
		expect(() => buildDecorationSet(entries)).not.toThrow();
	});

	it('カーソル行の見出しでは HeaderMark を非表示にしない', () => {
		// キャレットが見出しの中。# は隠さない
		const state = EditorState.create({
			// 1 行の見出し
			doc: '# Title',
			// 空の選択。カーソルがある行はソース表示
			selection: {
				// 選択の起点。# の次
				anchor: 1,
				// 選択の終点。起点と同じなので空
				head: 1
			},
			// 見出しやリストのノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});

		// その行の装飾
		const entries = collectLineDecorationEntries(state);
		// # を隠す範囲。0 件
		const hidden  = entries.filter((entry) => entry.from === 0 && entry.to === 1);
		expect(hidden.length).toBe(0);
	});

	it('箇条書き入力途中の単独ハイフンで前行を Setext 見出し表示にしない', () => {
		// 2 行目が空白付きの単独ハイフン。前行を見出しにしない
		const state             = EditorState.create({
			// 1 行目の本文と、入力途中の箇条書き
			doc: 'aaa\n- ',
			// 空の選択。カーソルがある行はソース表示
			selection: {
				// 選択の起点。2 行目のハイフン側
				anchor: 5,
				// 選択の終点。起点と同じなので空
				head: 5
			},
			// 見出しやリストのノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// その文書の行装飾
		const entries           = collectLineDecorationEntries(state);
		// ハイフンの前の行
		const firstLine         = state.doc.line(1);
		// h2 の装飾。付いていたら失敗
		const heading           = entries.filter((entry) => entry.from === firstLine.from && entry.decoration.spec.class?.includes('cm-md-h2'));
		// 入力途中の箇条書きとして前行へ付けるクラス
		const pendingListSource = entries.filter((entry) => entry.from === firstLine.from && entry.decoration.spec.class?.includes('cm-md-pending-list-source'));

		expect(heading).toEqual([]);
		expect(pendingListSource.length).toBe(1);
	});

	it('空白なしの単独ハイフンでも前行の見出し太字を打ち消すクラスを付与する', () => {
		// 空白の無い単独ハイフン。前行の太字を打ち消す
		const state             = EditorState.create({
			// 1 行目の本文と、空白なしのハイフン
			doc: 'aaa\n-',
			// 空の選択。カーソルがある行はソース表示
			selection: {
				// 選択の起点。2 行目のハイフン側
				anchor: 5,
				// 選択の終点。起点と同じなので空
				head: 5
			},
			// 見出しやリストのノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// その文書の行装飾
		const entries           = collectLineDecorationEntries(state);
		// ハイフンの前の行
		const firstLine         = state.doc.line(1);
		// 前行の見出し太字を打ち消すクラス
		const pendingListSource = entries.filter((entry) => entry.from === firstLine.from && entry.decoration.spec.class?.includes('cm-md-pending-list-source'));

		expect(pendingListSource.length).toBe(1);
	});

	it('複数ハイフンの Setext 見出しは従来どおり h2 として装飾する', () => {
		// ハイフン 2 つ。前行は Setext の h2
		const state     = EditorState.create({
			// 見出しになる本文と、下線
			doc: 'aaa\n--',
			// 空の選択。カーソルがある行はソース表示
			selection: {
				// 選択の起点。2 行目のハイフン側
				anchor: 5,
				// 選択の終点。起点と同じなので空
				head: 5
			},
			// 見出しやリストのノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// その文書の行装飾
		const entries   = collectLineDecorationEntries(state);
		// 下線の前の行
		const firstLine = state.doc.line(1);
		// h2 の装飾。1 件
		const heading   = entries.filter((entry) => entry.from === firstLine.from && entry.decoration.spec.class?.includes('cm-md-h2'));

		expect(heading.length).toBe(1);
	});

	it('プレビュー行の箇条書きはマーカー文字のみ置換する', () => {
		// 2 行目のマーカーだけを widget に置換する
		const state       = EditorState.create({
			// 1 行目はソース、2 行目がプレビュー
			doc: '- item\n- other',
			// 空の選択。カーソルがある行はソース表示
			selection: {
				// 選択の起点。文書先頭
				anchor: 0,
				// 選択の終点。起点と同じなので空
				head: 0
			},
			// 見出しやリストのノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// ソース表示の行。1 行目だけ
		const sourceLines = collectSourceLineNumbers(state);
		// 行装飾
		const entries     = collectLineDecorationEntries(state, sourceLines);
		// プレビュー側の箇条書き
		const line2       = state.doc.line(2);
		// 行頭 1 文字の widget。マーカーだけ
		const previewLine = entries.filter((entry) => entry.from === line2.from && entry.to === line2.from + 1 && entry.decoration.spec.widget);

		expect(previewLine.length).toBe(1);
	});

	it('プレビュー行の TaskMarker はチェックボックス widget に置換する', () => {
		// 2 行目の完了チェックを widget にする
		const state       = EditorState.create({
			// 1 行目はソース、2 行目がプレビュー
			doc: '- [ ] task\n- [x] done',
			// 空の選択。カーソルがある行はソース表示
			selection: {
				// 選択の起点。文書先頭
				anchor: 0,
				// 選択の終点。起点と同じなので空
				head: 0
			},
			// 見出しやリストのノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// ソース表示の行。1 行目だけ
		const sourceLines = collectSourceLineNumbers(state);
		// 行装飾
		const entries     = collectLineDecorationEntries(state, sourceLines);
		// 完了タスクの行
		const line2       = state.doc.line(2);
		// [x] の範囲の widget
		const checkbox    = entries.filter((entry) => entry.from === line2.from + 2 && entry.to === line2.from + 5 && entry.decoration.spec.widget);

		expect(checkbox.length).toBe(1);
	});

	it('タスク行では ListMark の • を出さず ListMark〜TaskMarker 直前を隠す', () => {
		// 2 行目はタスク。箇条書きの点は出さない
		const state       = EditorState.create({
			// 通常の箇条書きと、未完了タスク
			doc: '- item\n- [ ] task',
			// 空の選択。カーソルがある行はソース表示
			selection: {
				// 選択の起点。文書先頭
				anchor: 0,
				// 選択の終点。起点と同じなので空
				head: 0
			},
			// 見出しやリストのノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// ソース表示の行。1 行目だけ
		const sourceLines = collectSourceLineNumbers(state);
		// 行装飾
		const entries     = collectLineDecorationEntries(state, sourceLines);
		// タスクの行
		const line2       = state.doc.line(2);

		// 行頭 1 文字の点。タスク行では出さない
		const bulletAtListMark = entries.filter((entry) => entry.from === line2.from && entry.to === line2.from + 1 && entry.decoration.spec.widget);
		// ハイフンと空白。チェックボックスの直前まで隠す
		const hiddenPrefix     = entries.filter((entry) => entry.from === line2.from && entry.to === line2.from + 2 && !entry.decoration.spec.widget);
		// [ ] の範囲の widget
		const checkbox         = entries.filter((entry) => entry.from === line2.from + 2 && entry.to === line2.from + 5 && entry.decoration.spec.widget);

		expect(bulletAtListMark.length).toBe(0);
		expect(hiddenPrefix.length).toBe(1);
		expect(checkbox.length).toBe(1);
	});

	it('ソース行の TaskMarker はチェックボックスに置換しない', () => {
		// キャレットは 1 行目の TaskMarker の中。その行はソース
		const state    = EditorState.create({
			// 未完了と完了。キャレットは 1 行目
			doc: '- [ ] task\n- [x] done',
			// 空の選択。カーソルがある行はソース表示
			selection: {
				// 選択の起点。] の直後。1 行目がソース
				anchor: 5,
				// 選択の終点。起点と同じなので空
				head: 5
			},
			// 見出しやリストのノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// その文書の行装飾
		const entries  = collectLineDecorationEntries(state);
		// キャレットがある行
		const line1    = state.doc.line(1);
		// [ ] の widget。ソース行では 0 件
		const checkbox = entries.filter((entry) => entry.from === line1.from + 2 && entry.to === line1.from + 5 && entry.decoration.spec.widget);

		expect(checkbox.length).toBe(0);
	});

	it('コールアウト行に種別クラスを付与し [!type] を隠す', () => {
		// 2 行目が warning。種別を隠し、クラスを付ける
		const state       = EditorState.create({
			// 通常行と warning
			doc: 'plain\n> [!warning] Caution',
			// 空の選択。カーソルがある行はソース表示
			selection: {
				// 選択の起点。文書先頭
				anchor: 0,
				// 選択の終点。起点と同じなので空
				head: 0
			},
			// 見出しやリストのノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// ソース表示の行。1 行目だけ
		const sourceLines = collectSourceLineNumbers(state);
		// 行装飾
		const entries     = collectLineDecorationEntries(state, sourceLines);
		// warning の行
		const line2       = state.doc.line(2);
		// 種別クラスが付いた行
		const calloutLine = entries.filter((entry) => entry.from === line2.from && entry.decoration.spec.class?.includes('cm-md-callout-warning'));
		// 隠した種別。[!warning] を含む
		const hiddenType  = entries.filter((entry) => {
			// その装飾が隠している文字列
			const text = state.doc.sliceString(entry.from, entry.to);
			return text === '[!warning]' || text.startsWith('[!warning]');
		});

		expect(calloutLine.length).toBe(1);
		expect(hiddenType.length).toBeGreaterThanOrEqual(1);
	});

	it('コードブロック行はアクティブでも cm-md-fenced-code を維持する', () => {
		// バッククォート 3 つ。テンプレートと衝突しない
		const fence      = String.fromCharCode(96, 96, 96);
		// 前後が plain のフェンス。3 行目がコード
		const doc        = ['plain', fence, 'const value = 1;', fence].join('\n');
		// const の位置。その 1 文字後ろをアクティブにする
		const codeOffset = doc.indexOf('const value');
		// キャレットは外。コード行もフェンスクラス
		const preview    = EditorState.create({
			// 同じフェンス文書
			doc,
			// 空の選択。カーソルがある行はソース表示
			selection: {
				// 選択の起点。文書先頭
				anchor: 0,
				// 選択の終点。起点と同じなので空
				head: 0
			},
			// 見出しやリストのノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// キャレットはコード行の中。クラスは残す
		const active     = EditorState.create({
			// 同じフェンス文書
			doc,
			// コード行の中の空キャレット
			selection: {
				// 選択の起点。const の次
				anchor: codeOffset + 1,
				// 選択の終点。起点と同じなので空
				head: codeOffset + 1
			},
			// 見出しやリストのノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});

		// キャレットが外のときの行装飾
		const previewEntries = collectLineDecorationEntries(preview, collectSourceLineNumbers(preview));
		// キャレットがコード行のときの行装飾
		const activeEntries  = collectLineDecorationEntries(active, collectSourceLineNumbers(active));
		// コード本文の行。プレビュー側
		const previewLine    = preview.doc.line(3);
		// 同じ行。アクティブ側
		const activeLine     = active.doc.line(3);

		expect(previewEntries.some((entry) => entry.from === previewLine.from && entry.decoration.spec.class?.includes('cm-md-fenced-code'))).toBe(true);
		expect(activeEntries.some((entry) => entry.from === activeLine.from && entry.decoration.spec.class?.includes('cm-md-fenced-code'))).toBe(true);
	});

	it('コードブロックの CodeMark はアクティブ行では隠さない', () => {
		// バッククォート 3 つ。開きの行にキャレットを置く
		const fence      = String.fromCharCode(96, 96, 96);
		// 開きと閉じがあるフェンス
		const doc        = ['plain', fence, 'const value = 1;', fence].join('\n');
		// 開きフェンスの位置。その中がソース行
		const fenceLine  = doc.indexOf(fence);
		// 開きの行がアクティブ。CodeMark は隠さない
		const state      = EditorState.create({
			// 同じフェンス文書
			doc,
			// 開きフェンスの中の空キャレット
			selection: {
				// 選択の起点。開きの次
				anchor: fenceLine + 1,
				// 選択の終点。起点と同じなので空
				head: fenceLine + 1
			},
			// 見出しやリストのノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// 行装飾。開きの行はソース
		const entries    = collectLineDecorationEntries(state, collectSourceLineNumbers(state));
		// 開きフェンスの行
		const opening    = state.doc.line(2);
		// 行全体を隠す範囲。アクティブ行では 0 件
		const hiddenMark = entries.filter((entry) => entry.from === opening.from && entry.to === opening.to);

		expect(entries.some((entry) => entry.from === opening.from && entry.decoration.spec.class?.includes('cm-md-fenced-code'))).toBe(true);
		expect(hiddenMark.length).toBe(0);
	});

	it('コールアウト内コードブロックの行頭 > もプレビューでは隠す', () => {
		// バッククォート 3 つ。引用の中のフェンス
		const fence       = String.fromCharCode(96, 96, 96);
		// コールアウトの中にフェンス。行頭の > を隠す
		const state       = EditorState.create({
			// 3〜5 行目がフェンス。キャレットは外
			doc: ['plain', '> [!info] info', `> ${fence}`, '> code line', `> ${fence}`].join('\n'),
			// 空の選択。カーソルがある行はソース表示
			selection: {
				// 選択の起点。文書先頭
				anchor: 0,
				// 選択の終点。起点と同じなので空
				head: 0
			},
			// 見出しやリストのノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// ソース表示の行。1 行目だけ
		const sourceLines = collectSourceLineNumbers(state);
		// 行装飾
		const entries     = collectLineDecorationEntries(state, sourceLines);

		// 3〜5 行目（フェンス内）の行頭 `>` が hidden replace されること
		for (const lineNumber of [3, 4, 5]) {
			// 調べる行。3 が開き、4 が本文、5 が閉じ
			const line   = state.doc.line(lineNumber);
			// 行頭 1 文字を隠す範囲。> が入る
			const hidden = entries.filter((entry) => entry.from === line.from && entry.to === line.from + 1);
			expect(hidden.length, `line ${lineNumber}`).toBeGreaterThanOrEqual(1);
		}
	});

	it('[!info]- は既定で本文を隠し折りたたみボタンを出す', () => {
		// バッククォート 3 つ。折りたたみコールアウトの中
		const fence       = String.fromCharCode(96, 96, 96);
		// - 付き。本文は既定で隠す
		const state       = EditorState.create({
			// タイトル行と、隠すフェンス
			doc: ['plain', '> [!info]- info', `> ${fence}`, '> hello', `> ${fence}`].join('\n'),
			// 空の選択。カーソルがある行はソース表示
			selection: {
				// 選択の起点。文書先頭
				anchor: 0,
				// 選択の終点。起点と同じなので空
				head: 0
			},
			// 見出しやリストのノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// ソース表示の行。1 行目だけ
		const sourceLines = collectSourceLineNumbers(state);
		// 行装飾
		const entries     = collectLineDecorationEntries(state, sourceLines);
		// 折りたたみ印のあるタイトル行
		const line2       = state.doc.line(2);
		// タイトル行の折りたたみボタン
		const foldWidget  = entries.filter((entry) => entry.from >= line2.from && entry.from <= line2.to && entry.decoration.spec.widget);
		// タイトル行末から本文を隠す widget。ブロックではない
		const collapsed   = entries.filter((entry) => entry.from === line2.to && entry.to > line2.to && entry.decoration.spec.widget && entry.decoration.spec.block !== true);
		// タイトル行のクラス
		const titleClass  = entries.filter((entry) => entry.from === line2.from && entry.decoration.spec.class?.includes('cm-md-callout-title'));

		expect(foldWidget.length).toBeGreaterThanOrEqual(1);
		expect(collapsed.length).toBe(1);
		expect(titleClass.length).toBe(1);
		expect(() => buildDecorationSet(entries)).not.toThrow();
	});

	it('折りたたみコールアウト本文内の範囲を検出する', () => {
		// - 付き。target は隠した本文の中
		const state      = EditorState.create({
			// 本文に target がある折りたたみコールアウト
			doc: ['plain', '> [!info]- info', '> hidden target text', '> more'].join('\n'),
			// 空の選択。カーソルがある行はソース表示
			selection: {
				// 選択の起点。文書先頭
				anchor: 0,
				// 選択の終点。起点と同じなので空
				head: 0
			},
			// 見出しやリストのノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// target の開始。見つからなければ -1
		const targetFrom = state.doc.toString().indexOf('target');
		// その範囲を含む折りたたみコールアウト。無ければ undefined
		const callout    = findCollapsedCalloutContainingRange(state, targetFrom, targetFrom + 'target'.length);

		expect(callout?.calloutFrom).toBe(state.doc.line(2).from);
	});

	it('展開中コールアウト本文内の範囲を検出する', () => {
		// + 付き。本文は開いている
		const state      = EditorState.create({
			// タイトルにも target があるが、探すのは本文の visible target
			doc: ['plain', '> [!info]+ info target', '> visible target text', '> more'].join('\n'),
			// 空の選択。カーソルがある行はソース表示
			selection: {
				// 選択の起点。文書先頭
				anchor: 0,
				// 選択の終点。起点と同じなので空
				head: 0
			},
			// 見出しやリストのノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// 本文側の visible target の開始。タイトルの target ではない
		const targetFrom = state.doc.toString().indexOf('visible target');
		// その範囲を含むコールアウト。折りたたみ中かは見ない
		const callout    = findCalloutContainingRange(state, targetFrom, targetFrom + 'visible target'.length);

		expect(callout?.calloutFrom).toBe(state.doc.line(2).from);
	});

	it('>[!success] でも > [!info] と同じ位置にトグルを置く', () => {
		// > の後ろに空白がある info
		const spaced = EditorState.create({
			// 空白ありの折りたたみコールアウト
			doc: 'plain\n> [!info]- info\n> body\n',
			// 空の選択。カーソルがある行はソース表示
			selection: {
				// 選択の起点。文書先頭
				anchor: 0,
				// 選択の終点。起点と同じなので空
				head: 0
			},
			// 見出しやリストのノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});
		// > の直後に [ がある success
		const tight  = EditorState.create({
			// 空白なしの折りたたみコールアウト
			doc: 'plain\n>[!success]- success\n> body\n',
			// 空の選択。カーソルがある行はソース表示
			selection: {
				// 選択の起点。文書先頭
				anchor: 0,
				// 選択の終点。起点と同じなので空
				head: 0
			},
			// 見出しやリストのノードを得る Markdown サポート
			extensions: [createTmsMarkdownSupport()]
		});

		// 空白ありの行装飾
		const spacedEntries = collectLineDecorationEntries(spaced, collectSourceLineNumbers(spaced));
		// 空白なしの行装飾
		const tightEntries  = collectLineDecorationEntries(tight, collectSourceLineNumbers(tight));

		// info のタイトル行
		const spacedLine = spaced.doc.line(2);
		// success のタイトル行
		const tightLine  = tight.doc.line(2);
		// 空白ありの折りたたみボタン。幅 0 の widget
		const spacedFold = spacedEntries.find((entry) => entry.from >= spacedLine.from && entry.from <= spacedLine.to && entry.from === entry.to && entry.decoration.spec.widget && String(entry.decoration.spec.widget.constructor.name).includes('Fold'));
		// 空白なしの折りたたみボタン。位置を比べる
		const tightFold  = tightEntries.find((entry) => entry.from >= tightLine.from && entry.from <= tightLine.to && entry.from === entry.to && entry.decoration.spec.widget && String(entry.decoration.spec.widget.constructor.name).includes('Fold'));

		expect(spacedFold).toBeDefined();
		expect(tightFold).toBeDefined();

		/**
		 * タイトル本文の開始オフセットを返す
		 * @param text - 行テキスト
		 * @returns タイトル本文の開始オフセット
		 */
		const titleStart = (text: string): number => {
			// ] と折りたたみ印と空白。見つからなければタイトル位置は -1
			const match = /\][+-]?\s*/.exec(text);
			return match ? match.index + match[0].length : -1;
		};

		expect(spacedFold!.from - spacedLine.from).toBe(titleStart(spacedLine.text));
		expect(tightFold!.from - tightLine.from).toBe(titleStart(tightLine.text));

		// success の種別クラスがタイトル行にある
		const successClass = tightEntries.some((entry) => entry.from === tightLine.from && entry.decoration.spec.class?.includes('cm-md-callout-success'));
		expect(successClass).toBe(true);
	});
});
