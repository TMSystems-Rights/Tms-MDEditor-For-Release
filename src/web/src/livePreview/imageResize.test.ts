/**
 * 画像幅の書き戻しが、通常記法と表セルのエスケープで分かれることを検証する
 * EditorView は文書の差し替えだけを持つモックを使う
 * @file
 */
import { EditorState, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { createTmsMarkdownSupport } from '../editor/createTmsMarkdown';
import { applyImageDisplayWidth, applyImageWidthByPath, applyImageWidthOnDocumentLine, findImageMarkupAt, replaceImageWidthInCellText } from './imageResize';
import { bindImageWrapEditorView, persistImageResizeWidth } from './imageWidget';

/**
 * DOM なしで dispatch できるビュー相当を作る
 * @param doc - 本文
 * @returns DOM なしで dispatch できるビュー相当を作る
 */
function createView(doc: string): EditorView {
	// dispatch のたびに差し替える状態。DOM は持たない
	let state = EditorState.create({
		// 画像を含む本文
		doc,
		// 画像ノードを得る Markdown サポート
		extensions: [createTmsMarkdownSupport()]
	});
	return {
		/**
		 * モックが今保持しているエディタ状態を返す
		 * @returns dispatch で差し替えた最新の状態
		 */
		get state() {
			return state;
		},
		/**
		 * @param spec - 更新
		 */
		dispatch(spec: TransactionSpec) {
			// 渡された更新を適用し、次の state 読み出しへ出す
			state = state.update(spec).state;
		}
	} as EditorView;
}

describe('imageResize', () => {
	it('WikiEmbed へ |幅 を書き戻す', () => {
		// 幅の無い Wiki 埋め込み。|320 を書き戻す
		const view = createView('![[C:\\shots\\a.png]]');
		expect(applyImageDisplayWidth(view, 0, 320)).toBe(true);
		expect(view.state.doc.toString()).toBe('![[C:\\shots\\a.png|320]]');
	});

	it('標準画像の alt へ |幅 を書き戻す', () => {
		// 幅の無い標準画像。alt へ |180 を書き戻す
		const view = createView('![図](./a.png)');
		expect(applyImageDisplayWidth(view, 0, 180)).toBe(true);
		expect(view.state.doc.toString()).toBe('![図|180](./a.png)');
	});

	it('表セル内では \\|幅 を書き戻す', () => {
		// 1 列の表の中の Wiki 埋め込み。区切りは \\| になる
		const view = createView('|   |\n|---|\n|![[C:\\\\shots\\\\a.png]]|\n');
		// 画像記法の開始。見つからなければ -1
		const pos  = view.state.doc.toString().indexOf('![[');
		expect(applyImageDisplayWidth(view, pos, 160)).toBe(true);
		expect(view.state.doc.toString()).toContain('![[C:\\\\shots\\\\a.png\\|160]]');
	});

	it('複数列表でも行スキャンで画像記法を見つけ \\|幅 を書き戻す', () => {
		// 3 列の表。画像は中央のセル
		const doc  = '| a | 画像 | b |\n| --- | --- | --- |\n| 1 | ![[C:\\\\shots\\\\a.png]] | 2 |\n';
		// その表。行スキャンで画像を探す
		const view = createView(doc);
		// 画像記法の開始。見つからなければ -1
		const pos  = view.state.doc.toString().indexOf('![[');
		// 閉じ ]] の次。記法の終端
		const end  = view.state.doc.toString().indexOf(']]', pos) + 2;
		expect(findImageMarkupAt(view.state, pos, end)?.kind).toBe('WikiEmbed');
		expect(applyImageDisplayWidth(view, pos, 72, end)).toBe(true);
		expect(view.state.doc.toString()).toContain('![[C:\\\\shots\\\\a.png\\|72]]');
	});

	it('検証表4行目の Windows パスを探して表用 \\|幅 を書く', () => {
		// 4 行目。幅を書く対象の Windows パス
		const princess = '|プリンセス|ユイ(プリンセス)|プリユイ|![[C:\\Users\\tmsys\\Pictures\\TMS-MDEditor\\Screenshots\\clip_image004.png]]|光|';
		// 見出しと 4 行のデータ。対象は最後の行
		const doc      = ['|   |   |   |   |   |', '|---|---|---|---|---|', '|クリスマス|ユイ(クリスマス)|クリユイ|![[C:\\Users\\tmsys\\Pictures\\TMS-MDEditor\\Screenshots\\clip_image001-5.png]]|火|', '|サマー|ユイ(サマー)|水ユイ|![[C:\\Users\\tmsys\\Pictures\\TMS-MDEditor\\Screenshots\\clip_image002.png]]|水|', '|ニューイヤー|ユイ(ニューイヤー)|正月ユイ|![[C:\\Users\\tmsys\\Pictures\\TMS-MDEditor\\Screenshots\\clip_image003.png]]|光|', princess].join('\n');
		// その表
		const view     = createView(doc);
		// 4 行目の画像パス。他の行のパスとは違う
		const path     = 'C:\\Users\\tmsys\\Pictures\\TMS-MDEditor\\Screenshots\\clip_image004.png';
		expect(applyImageWidthByPath(view, path, 430)).toBe(true);
		expect(view.state.doc.toString()).toContain('![[C:\\Users\\tmsys\\Pictures\\TMS-MDEditor\\Screenshots\\clip_image004.png\\|430]]');
		expect(view.state.doc.toString()).toContain('|光|');
		expect(view.state.doc.toString()).not.toContain('png|430]]|光|');
		expect(view.state.doc.toString()).toContain('clip_image003.png]]');
	});

	it('Windows 絶対パスの表行でも行テキストへ \\|幅 を書く', () => {
		// Windows 絶対パスがセルにある 1 行の表
		const doc  = ['|   |   |   |   |   |', '|---|---|---|---|---|', '|クリスマス|ユイ(クリスマス)|クリユイ|![[C:\\Users\\tmsys\\Pictures\\TMS-MDEditor\\Screenshots\\clip_image001-5.png]]|火|'].join('\n');
		// その表。行テキストへ幅を書く
		const view = createView(doc);
		// 画像記法の開始。見つからなければ -1
		const pos  = view.state.doc.toString().indexOf('![[');
		expect(applyImageWidthOnDocumentLine(view, pos, 96)).toBe(true);
		expect(view.state.doc.toString()).toContain('![[C:\\Users\\tmsys\\Pictures\\TMS-MDEditor\\Screenshots\\clip_image001-5.png\\|96]]');
		expect(view.state.doc.toString()).toContain('|火|');
	});

	it('セル文字列の画像へ \\|幅 を書き込む', () => {
		expect(replaceImageWidthInCellText('![[C:\\shots\\a.png]]', 88)).toBe('![[C:\\shots\\a.png\\|88]]');
		expect(replaceImageWidthInCellText('![[C:\\shots\\a.png\\|40]]', 88)).toBe('![[C:\\shots\\a.png\\|88]]');
		expect(replaceImageWidthInCellText('図なし', 88)).toBeNull();
	});

	it('findFromDOM が無くても束縛した view へ表用 \\|幅 を書く', () => {
		// 表セルの画像パス。dataset の区切りはスラッシュ
		const path = 'C:\\Users\\tmsys\\Pictures\\TMS-MDEditor\\Screenshots\\clip_image004.png';
		// そのパスを埋め込んだ 1 行。表の枠は DOM に持たない
		const view = createView(`|プリンセス|ユイ(プリンセス)|プリユイ|![[${path}]]|光|`);
		// パスだけを持つ画像枠。closest は表を返さない
		const wrap = {
			// スラッシュへ揃えたパス。表の枠が無くてもこのパスで書き戻す
			dataset: { imagePath: path.replaceAll('\\', '/') },
			/**
			 * 祖先を探すモック。このケースでは表の枠を持たない
			 * @returns 常に null
			 */
			closest() {
				return null;
			},
			/**
			 * @returns 同一なら true
			 */
			dispatchEvent() {
				return true;
			}
		} as unknown as HTMLElement;
		bindImageWrapEditorView(wrap, view);
		expect(persistImageResizeWidth(wrap, 430)).toBe(true);
		expect(view.state.doc.toString()).toContain('![[C:\\Users\\tmsys\\Pictures\\TMS-MDEditor\\Screenshots\\clip_image004.png\\|430]]');
		expect(view.state.doc.toString()).toContain('|光|');
		expect(view.state.doc.toString()).not.toContain('png|430]]|光|');
	});
});
