/**
 * Mermaid フェンスを Pele で SVG にし、プレビューのウィジェットと書き出し用の文字列を作る
 * プレビューは Pele の mount で描き、エディタ幅への追従と拡大縮小を Pele に任せる
 * 図のソース保存は持たず、呼び出し側の装飾配列へ replace を足す。図の中のリンクは http(s) だけを外部ブラウザで開く
 * @file
 */
import { Decoration, WidgetType, type EditorView } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import type { Mounted, RenderOptions } from 'pele';
import { BRIDGE_METHOD, invokeBridge } from '../bridge';
import { parseFencedCodeHeader } from './fencedCodeHeaderLabel';
import type { DecorationEntry } from './inlineDecorations';

// ----------------------------------------------
// 描画モジュール
// ----------------------------------------------

/** 遅延ロードした Pele のモジュール。初回の図で import し、以後は同じものを使う */
type PeleModule = typeof import('pele');

/** 図の中のリンクとして許すスキーム。外部ブラウザで開けるものだけに絞る */
const MERMAID_LINK_SCHEMES = ['http', 'https'];

/** 拡大縮小ボタンの読み上げ名と、ホバー時の説明 */
const MERMAID_ZOOM_LABELS = {
	/** 拡大ボタン */
	zoomIn: '拡大',
	/** 縮小ボタン */
	zoomOut: '縮小',
	/** 全体が見える大きさへ戻すボタン */
	reset: '全体を表示'
};

/** フォント サイズが読めないときに使う、図の文字の大きさ（px）。Pele の既定と同じ */
const DEFAULT_MERMAID_FONT_SIZE = 16;

/** 進行中または完了した Pele の読み込み。未ロードなら null */
let peleLoader: Promise<PeleModule> | null = null;

/** 書き出し用の SVG の id 接頭辞に付ける通し番号。1 つの HTML に複数の図があっても id が重ならない */
let exportRenderSeq = 0;

/** ウィジェットの枠から、その中で動いている Pele の mount。destroy で監視を止める */
const mountedByWrap = new WeakMap<HTMLElement, Mounted>();

/**
 * Mermaid を SVG にした結果
 * 失敗しても例外にはせず、ok を false にして理由を持つ
 */
export type MermaidRenderResult =
	| {
		/** 描画できた印 */
		ok: true;
		/** 埋め込む SVG。ルートは class="pele" の svg 要素 */
		svg: string;
	}
	| {
		/** 描画できなかった印 */
		ok: false;
		/** 利用者に見せる失敗理由。図のソースを含むことがあるので、HTML へは文字として出す */
		error: string;
	};

/**
 * 書き出し用に図を描くときの文字の指定
 * 文字幅の計測と SVG の font 指定に同じ値を使い、書き出し先の CSS とそろえる
 */
export type MermaidRenderFont = {
	/** ラベルのフォント。CSS の font-family 形式。省略時は Pele の既定 sans-serif */
	fontFamily?: string;
	/** ラベルの大きさ（px）。省略時、または有限の正の数でないときは 16 */
	fontSize?: number;
};

/**
 * Pele を遅延ロードする
 * 読み込みに失敗したときは次の呼び出しで読み直せるよう、保持している Promise を捨てる
 * @returns 読み込んだ Pele
 * @throws {Error} チャンクを読めない。呼び出し側で図のエラー表示にする
 */
function loadPele(): Promise<PeleModule> {
	// まだ読み始めていないときだけ import を始める
	if (!peleLoader) {
		peleLoader = import('pele').catch((error: unknown) => {
			peleLoader = null;
			throw error;
		});
	}

	return peleLoader;
}

/**
 * 例外を、利用者に見せる失敗理由へ変える
 * @param error - Pele が投げた例外。PeleError は位置付きのメッセージを持つ
 * @returns 失敗理由。メッセージが無いときは固定文
 */
function describeMermaidError(error: unknown): string {
	return error instanceof Error && error.message ? error.message : 'Mermaid の図を描画できませんでした';
}

/**
 * CodeInfo が mermaid か
 * 言語名の後ろに `title:"…"` などの情報があっても、先頭の言語名だけで判定する
 * @param info - CodeInfo 文字列
 * @returns 先頭の言語名が、大文字小文字を区別せず mermaid なら true
 */
export function isMermaidCodeInfo(info: string): boolean {
	return parseFencedCodeHeader(info).language.toLowerCase() === 'mermaid';
}

/**
 * FencedCode から CodeInfo を取得する
 * @param state - 状態
 * @param node - FencedCode
 * @returns 前後の空白を除いた CodeInfo。無ければ空文字
 */
export function extractFencedCodeInfo(state: EditorState, node: SyntaxNode): string {
	for (let child = node.firstChild; child; child = child.nextSibling) {
		// 言語名ノードだけトリムして返す
		if (child.name === 'CodeInfo') {
			return state.doc.sliceString(child.from, child.to).trim();
		}
	}

	return '';
}

/**
 * FencedCode から本文（CodeText）を取得する
 * @param state - 状態
 * @param node - FencedCode
 * @returns フェンス記号を含まない本文。トリムしない。無ければ空文字
 */
export function extractFencedCodeText(state: EditorState, node: SyntaxNode): string {
	for (let child = node.firstChild; child; child = child.nextSibling) {
		// 本文ノードだけ、トリムせずに返す
		if (child.name === 'CodeText') {
			return state.doc.sliceString(child.from, child.to);
		}
	}

	return '';
}

/**
 * Mermaid フェンスの `title:` の値を取得する
 * @param state - 状態
 * @param node - FencedCode
 * @returns タイトル。指定が無いときや値が空のときは空文字
 */
export function extractMermaidTitle(state: EditorState, node: SyntaxNode): string {
	return parseFencedCodeHeader(extractFencedCodeInfo(state, node)).title;
}

/**
 * FencedCode が Mermaid ブロックか
 * @param state - 状態
 * @param node - FencedCode
 * @returns 言語名が mermaid のフェンスなら true
 */
export function isMermaidFencedCode(state: EditorState, node: SyntaxNode): boolean {
	return isMermaidCodeInfo(extractFencedCodeInfo(state, node));
}

/**
 * プレビューと書き出しで共通にする Pele の描画オプション
 * リンクは外部ブラウザで開ける http(s) だけを残し、その他のスキームは Pele が落とす
 * @returns Pele の RenderOptions。呼び出し側でフォントや id 接頭辞を足す
 */
export function buildMermaidRenderOptions(): RenderOptions {
	// プレビューと書き出しの共通設定
	return {
		// 図のリンク。外部ブラウザで開けるスキームだけ
		linkSchemes: MERMAID_LINK_SCHEMES
	};
}

/**
 * Mermaid ソースを SVG 文字列にする。HTML 書き出し用
 * 呼び出しごとに id 接頭辞を変え、同じ文書に同じ図が複数あっても SVG 内の id が重ならないようにする
 * @param source - 図のソース。前後の空白は除いて描く
 * @param font - ラベルのフォントと大きさ。書き出し先の CSS と同じ値を渡す
 * @returns 成功時は SVG、空や構文エラーのときは理由
 */
export async function renderMermaidSource(source: string, font: MermaidRenderFont = {}): Promise<MermaidRenderResult> {
	// 前後空白を除いたソース。空なら描画しない
	const trimmed = source.trim();
	// 空のブロックは図にできないので、理由だけ返す
	if (!trimmed) {
		// 空ソースの失敗
		return {
			// 描画失敗
			ok: false,
			// 空ブロックの説明
			error: '空の Mermaid ブロックです'
		};
	}

	try {
		// 遅延ロードした Pele。読み込みの失敗は catch へ落ちる
		const pele       = await loadPele();
		exportRenderSeq += 1;
		// 描画結果。構文エラーは PeleError として catch へ落ちる
		const result     = pele.render(trimmed, {
			...buildMermaidRenderOptions(),
			// SVG 内の id の接頭辞。英数字とハイフンだけ
			idPrefix: `tms-mde-mermaid-${exportRenderSeq}`,
			// ラベルのフォント。未指定なら Pele の既定
			...(font.fontFamily?.trim() ? { fontFamily: font.fontFamily.trim() } : {}),
			// ラベルの大きさ（px）。有限の正の数でなければ既定
			fontSize: font.fontSize !== undefined && Number.isFinite(font.fontSize) && font.fontSize > 0 ? font.fontSize : DEFAULT_MERMAID_FONT_SIZE
		});
		// 成功結果
		return {
			// 描画成功
			ok: true,
			// 埋め込む SVG
			svg: result.svg
		};
	} catch (error) {
		// 構文エラーや読み込み失敗の理由
		return {
			// 描画失敗
			ok: false,
			// 例外のメッセージ。無ければ固定文
			error: describeMermaidError(error)
		};
	}
}

/**
 * 要素の文字の大きさを px で読む
 * @param element - 文書に繋がった要素
 * @returns 計算済みの font-size（px）。読めないときは 16
 */
function readFontSize(element: HTMLElement): number {
	// 計算済みの font-size。px 表記
	const parsed = Number.parseFloat(getComputedStyle(element).fontSize);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MERMAID_FONT_SIZE;
}

/**
 * 図の中のリンクのクリックを横取りし、http(s) なら外部ブラウザで開く
 * WebView 内での遷移は、どのリンクでも起こさない
 * @param event - 図の枠で受けたクリック
 */
function handleDiagramLinkClick(event: MouseEvent): void {
	// クリックされたリンク。リンクの外なら null
	const anchor = event.target instanceof Element ? event.target.closest('a') : null;
	// リンク以外のクリックは、拡大縮小の操作なので Pele に任せる
	if (!anchor) {
		return;
	}

	event.preventDefault();
	event.stopPropagation();
	// リンク先。SVG の a は href 属性か xlink:href を持つ
	const href = anchor.getAttribute('href') ?? anchor.getAttribute('xlink:href') ?? '';
	// http(s) の絶対 URL だけを外部ブラウザで開く。相対パスやその他は開かない
	if (/^https?:\/\//i.test(href)) {
		void invokeBridge(BRIDGE_METHOD.shellOpenExternal, { url: href });
	}
}

// ----------------------------------------------
// 図ウィジェット
// ----------------------------------------------

/**
 * Mermaid 図ウィジェット
 * Pele の mount が枠の幅に合わせて描き直し、縮んだ図には拡大縮小のボタンを出す
 */
export class MermaidWidget extends WidgetType {
	/** 描く Mermaid ソース。生成後は変えない */
	readonly source: string;
	/** 図の上に出すタイトル。開始フェンスの `title:` の値。空文字のときは見出しを出さない */
	readonly title: string;

	/**
	 * 描くソースを持ったウィジェットを作る。描画は toDOM まで遅らせる
	 * @param source - Mermaid ソース。フェンス記号を含まない
	 * @param title - 図の上に出すタイトル。省略時は見出しを出さない
	 */
	constructor(source: string, title: string = '') {
		super();
		this.source = source;
		this.title  = title;
	}

	/**
	 * 同じソースとタイトルなら DOM を作り直さずに再利用させる
	 * @param other - 比較対象
	 * @returns ソースとタイトルがともに同じ Mermaid ウィジェットなら true
	 */
	eq(other: WidgetType): boolean {
		return other instanceof MermaidWidget && other.source === this.source && other.title === this.title;
	}

	/**
	 * 図の枠を作り、文書へ繋がった後に Pele で描く
	 * 読み込み中は文言を出し、Pele を読めないときは枠へ理由を出す。構文エラーの表示は Pele に任せる
	 * @param view - ビュー。描画後の高さの再計測に使う
	 * @returns 図の枠。まだ中身は空
	 */
	toDOM(view: EditorView): HTMLElement {
		// 図と状態表示を入れる枠。まだ文書へは繋がっていない
		const wrap     = document.createElement('div');
		wrap.className = 'cm-md-mermaid-wrap';
		wrap.setAttribute('contenteditable', 'false');

		// タイトルが指定されたときだけ、図の上に見出しを置く。コードブロックの開始フェンス行と同じ見た目
		if (this.title) {
			// 図の見出し。タイトルの文字だけを入れる
			const titleElement       = document.createElement('div');
			titleElement.className   = 'cm-md-mermaid-title';
			titleElement.textContent = this.title;
			wrap.appendChild(titleElement);
		}

		// 状態表示と図を入れる場所。見出しは置き換えない
		const body     = document.createElement('div');
		body.className = 'cm-md-mermaid-body';
		wrap.appendChild(body);

		// 読み込み中の表示。描画が始まると置き換える
		const status       = document.createElement('div');
		status.className   = 'cm-md-mermaid-status';
		status.textContent = 'Mermaid を読み込み中…';
		body.appendChild(status);

		// 図の中のリンクを WebView で開かせず、http(s) だけ外部ブラウザへ渡す
		wrap.addEventListener('click', handleDiagramLinkClick);

		// 前後空白を除いたソース。描画のたびに変えない
		const source = this.source.trim();

		void (async () => {
			try {
				// Pele は枠の幅を測って描くので、文書へ繋がるまで最大 12 フレーム待つ
				for (let attempt = 0; attempt < 12 && !wrap.isConnected; attempt += 1) {
					await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
				}

				// 枠が文書へ繋がらないままなら描画しない。破棄済みの枠もここで止まる
				if (!wrap.isConnected) {
					return;
				}

				// 遅延ロードした Pele。読み込みの失敗は catch へ落ちる
				const pele = await loadPele();
				// 読み込みのあいだに枠が外れたときは描かない
				if (!wrap.isConnected) {
					return;
				}

				// Pele が描く先。中身は Pele が SVG とボタンで置き換える
				const host     = document.createElement('div');
				host.className = 'cm-md-mermaid';
				body.replaceChildren(host);
				// 図の描画と、幅とフォントの変化への追従。構文エラーは host の中へ Pele が出す
				const mounted = pele.mount(host, source, {
					...buildMermaidRenderOptions(),
					// ラベルの大きさ（px）。エディタの文字の大きさに合わせる
					fontSize: readFontSize(host),
					// 縮んだ図だけ拡大縮小を有効にする。ボタンの名前は日本語
					zoom: {
						// ボタンの読み上げ名と説明
						labels: MERMAID_ZOOM_LABELS
					},
					/**
					 * 描き直しのたびに、変わった高さをエディタへ測り直させる
					 */
					onRender: () => view.requestMeasure(),
					/**
					 * 構文エラーの表示で高さが変わるので、エディタへ測り直させる
					 */
					onError: () => view.requestMeasure()
				});
				mountedByWrap.set(wrap, mounted);
				view.requestMeasure();
			} catch (error) {
				// 枠が外れていればエラー表示も出さない
				if (!wrap.isConnected) {
					return;
				}

				// Pele を読み込めなかった理由。図の代わりに枠へ入れる
				const errorElement       = document.createElement('div');
				errorElement.className   = 'cm-md-mermaid-error';
				errorElement.textContent = describeMermaidError(error);
				body.replaceChildren(errorElement);
				view.requestMeasure();
			}
		})();

		return wrap;
	}

	/**
	 * 枠が外れるときに、Pele の幅とフォントの監視と拡大縮小を止める
	 * 図の DOM は CodeMirror が取り除くので、ここでは消さない
	 * @param dom - toDOM が返した枠
	 */
	destroy(dom: HTMLElement): void {
		mountedByWrap.get(dom)?.destroy();
		mountedByWrap.delete(dom);
		dom.removeEventListener('click', handleDiagramLinkClick);
	}

	/**
	 * 描画前の高さの見積もり。ソースの行数から決め、160〜640px に収める
	 * @returns 見積もった高さ（px）
	 */
	get estimatedHeight(): number {
		// ソースの行数。高さの見積もりに使う
		const lines = this.source.split(/\r\n|\r|\n/).length;
		return Math.max(160, Math.min(640, lines * 22 + 64));
	}

	/**
	 * 図の中のマウス、ホイール、キー操作を CodeMirror に渡さない
	 * ドラッグでの移動とダブルクリックでの拡大を Pele が受け取れるようにする
	 * @returns 常に true
	 */
	ignoreEvent(): boolean {
		return true;
	}
}

/**
 * Mermaid ブロックをウィジェットへ置換する
 * @param entries - 装飾を足す配列。この関数が末尾へ追加する
 * @param from - フェンスの開始位置
 * @param to - フェンスの終了位置。from 以下なら何もしない
 * @param source - 図のソース。フェンス記号を含まない
 * @param title - 図の上に出すタイトル。省略時は見出しを出さない
 */
export function pushMermaidReplace(entries: DecorationEntry[], from: number, to: number, source: string, title: string = ''): void {
	// 空範囲は置換しない
	if (from >= to) {
		return;
	}

	// フェンス全体を図ウィジェットへ置き換える
	entries.push({
		// フェンスの開始
		from,
		// フェンスの終端
		to,
		// 図ウィジェット。ソースが同じなら再利用する
		decoration: Decoration.replace({
			// このソースを描き、タイトルを上に出すウィジェット
			widget: new MermaidWidget(source, title)
		})
	});
}
