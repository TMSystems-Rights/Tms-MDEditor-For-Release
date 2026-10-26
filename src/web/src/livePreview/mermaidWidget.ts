/**
 * Mermaid フェンスをウィジェットで描き、描画結果をプロセス内にキャッシュする
 * 図のソース保存は持たず、呼び出し側の装飾配列へ replace を足す
 * @file
 */
import { Decoration, WidgetType, type EditorView } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import type { DecorationEntry } from './inlineDecorations';

// ----------------------------------------------
// 描画モジュールとキャッシュ
// ----------------------------------------------
/** 遅延ロードする Mermaid の、このエディタが使う面。描画と初期化だけ */
type MermaidModule = {
	/** テーマなどの初期化。同じ設定では繰り返さない */
	initialize: (config: Record<string, unknown>) => void;
	/** ソースを SVG 文字列へ描く。container が無いと寸法計測が潰れることがある */
	render: (id: string, text: string, container?: Element) => Promise<{ svg: string }>;
	/** 既存 DOM の mermaid 要素をその場で描く */
	run: (options?: { nodes?: ArrayLike<HTMLElement>; suppressErrors?: boolean }) => Promise<void>;
};

/** ラベルの描き方。html は装飾、plain は計測失敗時のフォールバック */
type MermaidLabelMode = 'html' | 'plain';

/** ソースごとの描画結果。失敗は error を持ち、成功は SVG 文字列を持つ */
type MermaidCacheEntry = { ok: true; svg: string; mode: MermaidLabelMode } | { ok: false; error: string };

/** キャッシュキーから描画結果。失敗も覚え、同じ失敗を繰り返さない */
const mermaidCache = new Map<string, MermaidCacheEntry>();

/** 図の幅をこれより小さく固定しない下限（px） */
const MIN_LOCKED_MERMAID_WIDTH = 120;

/** 進行中の Mermaid 読み込み。未ロードなら null */
let mermaidLoader: Promise<MermaidModule> | null = null;
/** 描画要素の id に使う通し番号。実行のたびに増やす */
let mermaidRenderSeq                             = 0;
/** 最後に initialize した設定のキー。同じなら再初期化しない */
let lastInitKey: string | null                   = null;
/** テストが差し替えた Mermaid。本番は null */
let mermaidModuleOverride: MermaidModule | null  = null;

/** SVG の viewBox から読んだ幅と高さ。px ではなく viewBox の単位 */
type SvgViewBoxSize = {
	/** viewBox の幅。読めなければ使わない */
	width: number;
	/** viewBox の高さ。読めなければ使わない */
	height: number;
};

/**
 * テスト用にキャッシュをクリアする
 */
export function clearMermaidCache(): void {
	mermaidCache.clear();
	lastInitKey = null;
}

/**
 * テスト用に Mermaid モジュールを差し替える
 * @param module - 差し替えモジュール
 */
export function setMermaidModuleForTest(module: MermaidModule | null): void {
	mermaidModuleOverride = module;
	mermaidLoader         = null;
	lastInitKey           = null;
}

/**
 * CodeInfo が mermaid か
 * @param info - CodeInfo 文字列
 * @returns CodeInfo が mermaid かなら true
 */
export function isMermaidCodeInfo(info: string): boolean {
	return info.trim().toLowerCase() === 'mermaid';
}

/**
 * ラベル内 HTML を SVG テキスト計測可能な形へ正規化する（フォールバック用）
 * @param source - 生ソース
 * @returns ラベル内 HTML を SVG テキスト計測可能な形へ正規化する（フォールバック用）
 */
export function preprocessMermaidSource(source: string): string {
	return source
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/?(?:b|strong|i|em|u|span)(?:\s[^>]*)?>/gi, '')
		.replace(/<font\b[^>]*>/gi, '')
		.replace(/<\/font>/gi, '');
}

/**
 * viewBox の幅・高さが極小か
 * @param viewBox - viewBox 属性
 * @returns viewBox の幅・高さが極小かなら true
 */
function isTinyViewBox(viewBox: string | null): boolean {
	// viewBox が無い SVG は極小判定にしない
	if (!viewBox) {
		return false;
	}

	// viewBox の 4 数。区切りは空白かカンマ
	const parts = viewBox
		.trim()
		.split(/[\s,]+/)
		.map(Number);
	// 4 数でない、またはどれかが数値でないときは極小とみなさない。どちらか一方でも false
	if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
		return false;
	}

	return parts[2] <= 24 && parts[3] <= 24;
}

/**
 * viewBox から自然サイズを取得する
 * @param viewBox - viewBox 属性
 * @returns 自然サイズ
 */
function getViewBoxSize(viewBox: string | null): SvgViewBoxSize | null {
	// viewBox が無い SVG は自然サイズを返さない
	if (!viewBox) {
		return null;
	}

	// viewBox の 4 数。幅と高さは後半の 2 つ
	const parts = viewBox
		.trim()
		.split(/[\s,]+/)
		.map(Number);
	// 4 数でない、またはどれかが数値でないときはサイズにしない。どちらか一方でも null
	if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
		return null;
	}

	// 幅と高さ。原点は使わない
	const [, , width, height] = parts;
	// 幅と高さがどちらも 1 より大きいときだけ採用する。どちらか一方が欠けても null
	if (!(width > 1 && height > 1)) {
		return null;
	}

	// 固定表示に使う自然サイズ。単位は viewBox
	return {
		// viewBox の幅。1 以下ではここに来ない
		width,
		// viewBox の高さ。1 以下ではここに来ない
		height
	};
}

/**
 * CSS px 値を数値化する
 * @param value - CSS 値
 * @returns CSS px 値を数値化する
 */
function parseCssPx(value: string): number {
	// px 表記から読んだ数値。単位や空文字は NaN
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 要素のコンテンツ幅を取得する
 * @param element - 要素
 * @returns 要素のコンテンツ幅
 */
function getElementContentWidth(element: HTMLElement): number {
	// 要素の内側を含む幅。clientWidth が 0 なら矩形の幅
	const clientWidth = element.clientWidth || element.getBoundingClientRect().width;
	// 1px 以下はまだレイアウト前とみて 0 を返す
	if (!(clientWidth > 1)) {
		return 0;
	}

	// 計算スタイルが無い環境ではパディングを引かず、読んだ幅を返す
	if (typeof getComputedStyle !== 'function') {
		return clientWidth;
	}

	// 左右パディングを引くための計算スタイル
	const style = getComputedStyle(element);
	return Math.max(0, clientWidth - parseCssPx(style.paddingLeft) - parseCssPx(style.paddingRight));
}

/**
 * HTML ラベル計測失敗で潰れた SVG 文字列か判定する
 * Mermaid 11 は正常図でも一部 foreignObject が width=0 になるため、FO 単独では判定しない
 * @param svg - SVG 文字列
 * @returns HTML ラベル計測失敗で潰れた SVG 文字列なら true
 */
export function isCollapsedMermaidSvg(svg: string): boolean {
	// 空白だけの結果は潰れた図として扱う
	if (!svg.trim()) {
		return true;
	}

	// 高さ 0 の属性がある SVG は潰れている
	if (/\bheight="0"/.test(svg)) {
		return true;
	}

	// 幅 16 と高さ 16 が同じタグにあるときだけ、既定の潰れサイズとみなす。どちらか一方では潰れていない
	if (/\bwidth="16"(?=[^>]*>)/.test(svg) && /\bheight="16"(?=[^>]*>)/.test(svg)) {
		return true;
	}

	// viewBox 属性の中身。無ければ null
	const viewBox = (svg.match(/\bviewBox="([^"]+)"/) || [])[1] ?? null;
	// 幅と高さが 24 以下の viewBox は潰れている
	if (isTinyViewBox(viewBox)) {
		return true;
	}

	return false;
}

/**
 * DOM 上の SVG が潰れているか判定する
 * @param svg - SVG
 * @returns DOM 上の SVG が潰れているなら true
 */
export function isCollapsedMermaidSvgElement(svg: SVGSVGElement | null): boolean {
	// 要素が無い描画は潰れている
	if (!svg) {
		return true;
	}

	// 高さ属性が 0 の SVG は潰れている
	if (svg.getAttribute('height') === '0') {
		return true;
	}

	// 幅 16 かつ高さ 16 のときだけ既定の潰れサイズとみなす。どちらか一方では次の判定へ進む
	if (svg.getAttribute('width') === '16' && svg.getAttribute('height') === '16') {
		return true;
	}

	try {
		// 内容の外接矩形。取れない環境は catch へ落ちる
		const bbox = svg.getBBox();
		// 幅と高さがどちらも 24 より大きい内容は潰れていない。どちらか一方が欠けても次へ進む
		if (bbox.width > 24 && bbox.height > 24) {
			return false;
		}
	} catch {
		// getBBox 不可時は viewBox 判定へ
	}

	// viewBox 属性。無ければ null
	const viewBox = svg.getAttribute('viewBox');
	// viewBox があるときだけ極小判定を結果にする
	if (viewBox) {
		return isTinyViewBox(viewBox);
	}

	return false;
}

/**
 * 描画後の潰れた viewBox / height=0 を内容の bbox で補正する
 * @param svg - SVG 要素
 * @returns 補正できたか
 */
export function fixMermaidSvgViewport(svg: SVGSVGElement | null): boolean {
	// 要素が無い描画は補正しない
	if (!svg) {
		return false;
	}

	try {
		// 内容の外接矩形。取れなければ補正しない
		const bbox = svg.getBBox();
		// 幅と高さがどちらも 1 より大きいときだけ補正する。どちらか一方が欠けても false
		if (!(bbox.width > 1 && bbox.height > 1)) {
			return false;
		}

		// viewBox の余白。上下左右に同じだけ足す
		const pad = 8;
		svg.setAttribute('viewBox', `${bbox.x - pad} ${bbox.y - pad} ${bbox.width + pad * 2} ${bbox.height + pad * 2}`);
		svg.setAttribute('width', '100%');
		svg.removeAttribute('height');
		svg.style.width    = '100%';
		svg.style.height   = 'auto';
		svg.style.maxWidth = '100%';
		return true;
	} catch {
		return false;
	}
}

/**
 * Mermaid SVG の表示サイズを現在のエディタ幅で固定する
 * Obsidian 風に、初回表示幅へ収めた後はウィンドウ拡縮で図を伸縮させず横スクロールへ逃がす
 * @param svg - SVG 要素
 * @param container - スクロールコンテナ
 * @returns 固定できたか
 */
export function lockMermaidSvgDisplaySize(svg: SVGSVGElement | null, container: HTMLElement | null): boolean {
	// 図かコンテナが無いときは幅を固定しない。どちらか一方でも false
	if (!svg || !container) {
		return false;
	}

	// viewBox から読んだ自然サイズ。読めなければ null
	const viewBoxSize = getViewBoxSize(svg.getAttribute('viewBox'));
	// 自然サイズが無い図は固定しない
	if (!viewBoxSize) {
		return false;
	}

	// コンテナの内容幅（px）。まだ 0 なら固定しない
	const contentWidth = getElementContentWidth(container);
	// 内容幅が 1px 以下のときは、レイアウト前なので固定しない
	if (!(contentWidth > 1)) {
		return false;
	}

	// 表示幅（px）。下限より小さくせず、内容幅も超えない
	const displayWidth  = Math.max(MIN_LOCKED_MERMAID_WIDTH, Math.min(Math.ceil(viewBoxSize.width), Math.floor(contentWidth)));
	// 表示高さ（px）。幅に合わせた viewBox 比
	const displayHeight = Math.ceil((displayWidth / viewBoxSize.width) * viewBoxSize.height);

	svg.setAttribute('width', String(displayWidth));
	svg.setAttribute('height', String(displayHeight));
	svg.style.width    = `${displayWidth}px`;
	svg.style.height   = 'auto';
	svg.style.maxWidth = 'none';
	return true;
}

/**
 * Mermaid 図は classDef 色を優先するため既定テーマを使う
 * ダーク外観は CSS（Obsidian 同様の invert）で合わせる
 * @returns Mermaid 図は classDef 色を優先するため既定テーマを使う
 */
export function resolveMermaidTheme(): 'default' {
	return 'default';
}

/**
 * キャッシュキー
 * @param source - ソース
 * @param theme - テーマ
 * @returns キャッシュキー
 */
function cacheKeyFor(source: string, theme: string): string {
	return `v7-mmd1141-pad\n${theme}\n${source}`;
}

/**
 * Mermaid を遅延ロードする
 * @returns Mermaid を遅延ロードする
 */
async function loadMermaid(): Promise<MermaidModule> {
	// テスト差し替えがあるときは動的 import をしない
	if (mermaidModuleOverride) {
		return mermaidModuleOverride;
	}

	// まだ読み始めていないときだけ import を始める
	if (!mermaidLoader) {
		mermaidLoader = import('mermaid').then((mod) => mod.default as MermaidModule);
	}

	return mermaidLoader;
}

/**
 * 次フレームまで待つ
 * @returns 完了時に解決する Promise
 */
function nextFrame(): Promise<void> {
	return new Promise((resolve) => {
		requestAnimationFrame(() => resolve());
	});
}

/**
 * ラベルモードに合わせて initialize する
 * @param mermaid - モジュール
 * @param theme - テーマ
 * @param mode - ラベルモード
 */
function ensureMermaidInitialized(mermaid: MermaidModule, theme: 'default' | 'dark', mode: MermaidLabelMode): void {
	// Obsidian 1.12.x 同梱の Mermaid 11.4.1 相当設定
	// テーマ、セキュリティ、ラベル方式をまとめた再初期化の判定キー
	const initKey = `${theme}:loose:${mode}:mmd1141:pad15`;
	// 直前と同じ設定なら initialize もキャッシュ破棄もしない
	if (lastInitKey === initKey) {
		return;
	}

	// 設定が変わった 2 回目以降だけ、古い描画結果を捨てる
	if (lastInitKey !== null) {
		mermaidCache.clear();
	}

	// HTML ラベルを使うか。plain は計測失敗時のフォールバック
	const htmlLabels = mode === 'html';
	// 図の初期設定。startOnLoad はエディタ側で描くので切る
	mermaid.initialize({
		// ページ読み込み時の自動描画は使わない
		startOnLoad: false,
		// ラベル内 HTML を許す緩い設定
		securityLevel: 'loose',
		// HTML ラベルを使うか。plain のときは false
		htmlLabels,
		// 図のテーマ。外観の反転は CSS 側
		theme,
		// エディタ字体と切り離し、HTML ラベル計測の見切れを防ぐ
		themeVariables: {
			// ラベル計測に使う字体
			fontFamily: '"trebuchet ms", verdana, arial, "Segoe UI", Meiryo, sans-serif',
			// ラベル計測に使うサイズ
			fontSize: '16px'
		},
		// フローチャートだけ幅と余白を固定する
		flowchart: {
			// フローチャートでも同じラベル方式を使う
			htmlLabels,
			// Obsidian 同様。幅は CSS 側で 100% にする
			useMaxWidth: false,
			// ノード周りの余白
			padding: 15
		}
	});
	lastInitKey = initKey;
}

/**
 * 指定モードで文字列描画する（テスト / フォールバック用）
 * @param mermaid - モジュール
 * @param text - ソース
 * @param theme - テーマ
 * @param mode - モード
 * @returns 指定モードで文字列描画する（テスト / フォールバック用）
 */
async function renderWithMode(mermaid: MermaidModule, text: string, theme: 'default' | 'dark', mode: MermaidLabelMode): Promise<string> {
	ensureMermaidInitialized(mermaid, theme, mode);
	mermaidRenderSeq += 1;
	// この描画の要素 id。連番で衝突しない
	const id          = `tms-mde-mermaid-${mermaidRenderSeq}`;
	// 描画結果の SVG 文字列。失敗は呼び出し側の catch へ落ちる
	const { svg }     = await mermaid.render(id, text);
	return svg;
}

/**
 * 表示中のホストへ in-place 描画する（FO 計測が効く）
 * @param mermaid - モジュール
 * @param host - ホスト
 * @param text - ソース
 * @param theme - テーマ
 * @param mode - モード
 * @returns 表示中のホストへ in-place 描画する（FO 計測が効く）。無ければ null
 */
async function runIntoHost(mermaid: MermaidModule, host: HTMLElement, text: string, theme: 'default' | 'dark', mode: MermaidLabelMode): Promise<SVGSVGElement | null> {
	ensureMermaidInitialized(mermaid, theme, mode);
	host.className   = 'mermaid';
	host.textContent = text;
	host.removeAttribute('data-processed');

	// CJK フォント読込前の計測ずれ（下端見切れ）を避ける
	// document とフォント待ちがあるときだけ、描画前にフォントを待つ。どちらか一方が欠けても描画へ進む
	if (typeof document !== 'undefined' && document.fonts?.ready) {
		try {
			await document.fonts.ready;
		} catch {
			// fonts API 失敗時はそのまま描画
		}
	}

	await nextFrame();
	// ホスト要素の中をその場で描く。エラーは呼び出し側へ返す
	await mermaid.run({
		// 描画対象。このホストだけ
		nodes: [host],
		// 失敗を握りつぶさず、呼び出し側の catch へ渡す
		suppressErrors: false
	});
	return host.querySelector('svg');
}

/**
 * FencedCode から CodeInfo を取得する
 * @param state - 状態
 * @param node - FencedCode
 * @returns FencedCode から CodeInfo
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
 * @returns FencedCode から本文（CodeText）
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
 * FencedCode が Mermaid ブロックか
 * @param state - 状態
 * @param node - FencedCode
 * @returns FencedCode が Mermaid ブロックかなら true
 */
export function isMermaidFencedCode(state: EditorState, node: SyntaxNode): boolean {
	return isMermaidCodeInfo(extractFencedCodeInfo(state, node));
}

/**
 * Mermaid ソースを描画する（キャッシュ付き・主にテスト用）
 * @param source - ソース
 * @param theme - テーマ。省略可
 * @returns Mermaid ソースを描画する（キャッシュ付き・主にテスト用）
 */
export async function renderMermaidSource(source: string, theme: 'default' | 'dark' = resolveMermaidTheme()): Promise<MermaidCacheEntry> {
	// 前後空白を除いたソース。空なら描画しない
	const trimmed = source.trim();
	// 空のブロックは失敗として返し、キャッシュには入れない
	if (!trimmed) {
		// 空ソースの失敗。キャッシュしない
		return {
			// 描画失敗
			ok: false,
			// 空ブロックの説明
			error: '空の Mermaid ブロックです'
		};
	}

	// テーマとソースを含むキャッシュキー
	const key    = cacheKeyFor(trimmed, theme);
	// 同じキーの結果。無ければ undefined
	const cached = mermaidCache.get(key);
	// 成功も失敗も、一度描いた結果は再描画しない
	if (cached) {
		return cached;
	}

	try {
		// 遅延ロードした Mermaid。失敗は catch へ落ちる
		const mermaid = await loadMermaid();

		// 最初は HTML ラベル。潰れたら plain へ替える
		let mode: MermaidLabelMode = 'html';
		// HTML ラベルで描いた SVG。空や潰れは次で判定する
		let svg                    = await renderWithMode(mermaid, trimmed, theme, mode);
		// 寸法が潰れた SVG だけ、装飾を外した plain で描き直す
		if (isCollapsedMermaidSvg(svg)) {
			svg  = await renderWithMode(mermaid, preprocessMermaidSource(trimmed).trim(), theme, 'plain');
			mode = 'plain';
		}

		// 描き直しても空白だけの結果は失敗として覚える
		if (!svg.trim()) {
			// 空結果の失敗。同じソースでは繰り返さない
			const entry: MermaidCacheEntry = {
				// 描画失敗
				ok: false,
				// 空結果の説明
				error: 'Mermaid の描画結果が空でした（構文を確認してください）'
			};
			mermaidCache.set(key, entry);
			return entry;
		}

		// 成功結果。モードは最後に使ったラベル方式
		const entry: MermaidCacheEntry = {
			// 描画成功
			ok: true,
			// 表示する SVG 文字列
			svg,
			// html か plain。潰れたときは plain
			mode
		};
		mermaidCache.set(key, entry);
		return entry;
	} catch (error) {
		// 例外メッセージ。Error でない、または空なら固定文
		const message                  = error instanceof Error && error.message ? error.message : 'Mermaid の描画に失敗しました';
		// 例外の失敗。同じソースでは繰り返さない
		const entry: MermaidCacheEntry = {
			// 描画失敗
			ok: false,
			// 例外メッセージ。空にはしない
			error: message
		};
		mermaidCache.set(key, entry);
		return entry;
	}
}

// ----------------------------------------------
// 図ウィジェット
// ----------------------------------------------
/**
 * Mermaid 図ウィジェット
 */
export class MermaidWidget extends WidgetType {
	/** 描く Mermaid ソース。生成後は変えない */
	readonly source: string;

	/**
	 * @param source - Mermaid ソース
	 */
	constructor(source: string) {
		super();
		this.source = source;
	}

	/**
	 * @param other - 比較対象
	 * @returns 同一なら true
	 */
	eq(other: WidgetType): boolean {
		return other instanceof MermaidWidget && other.source === this.source;
	}

	/**
	 * @param view - ビュー
	 * @returns 生成した要素
	 */
	toDOM(view: EditorView): HTMLElement {
		// 図と状態表示を入れる枠。まだ文書へは繋がっていない
		const wrap     = document.createElement('div');
		wrap.className = 'cm-md-mermaid-wrap';
		wrap.setAttribute('contenteditable', 'false');

		// 読み込み中の表示。描画が始まると置き換える
		const status       = document.createElement('div');
		status.className   = 'cm-md-mermaid-status';
		status.textContent = 'Mermaid を読み込み中…';
		wrap.appendChild(status);

		// 図のテーマ。外観の反転は CSS 側
		const theme  = resolveMermaidTheme();
		// 前後空白を除いたソース。描画のたびに変えない
		const source = this.source.trim();

		void (async () => {
			try {
				for (let attempt = 0; attempt < 12 && !wrap.isConnected; attempt += 1) {
					await nextFrame();
				}

				// 枠が文書へ繋がらないままなら描画しない
				if (!wrap.isConnected) {
					return;
				}

				// 遅延ロードした Mermaid。失敗は catch へ落ちる
				const mermaid = await loadMermaid();
				// その場描画のホスト。読み込み表示と置き換える
				const host    = document.createElement('div');
				wrap.replaceChildren(host);

				// HTML ラベルで描いた SVG。潰れたら plain で描き直す
				let svg = await runIntoHost(mermaid, host, source, theme, 'html');
				// 寸法が潰れたときだけ、装飾を外した plain で描き直す
				if (isCollapsedMermaidSvgElement(svg)) {
					svg = await runIntoHost(mermaid, host, preprocessMermaidSource(source).trim(), theme, 'plain');
				}

				// 描き直しても潰れているときはエラー表示へ替える
				if (isCollapsedMermaidSvgElement(svg)) {
					wrap.replaceChildren();
					// 寸法不正の説明。キャッシュはしない
					const error       = document.createElement('div');
					error.className   = 'cm-md-mermaid-error';
					error.textContent = 'Mermaid の描画に失敗しました（寸法が不正です）';
					wrap.appendChild(error);
					view.requestMeasure();
					return;
				}

				/**
				 * viewBox 補正
				 */
				const applyViewportFix = (): void => {
					fixMermaidSvgViewport(svg);
					lockMermaidSvgDisplaySize(svg, wrap);
					view.requestMeasure();
				};

				applyViewportFix();
				await nextFrame();
				applyViewportFix();
				await nextFrame();
				applyViewportFix();
			} catch (error) {
				// 枠が外れていればエラー表示も出さない
				if (!wrap.isConnected) {
					return;
				}

				wrap.replaceChildren();
				// 例外メッセージ。Error でない、または空なら固定文
				const message            = error instanceof Error && error.message ? error.message : 'Mermaid の描画に失敗しました';
				// 失敗の説明。図の代わりに枠へ入れる
				const errorElement       = document.createElement('div');
				errorElement.className   = 'cm-md-mermaid-error';
				errorElement.textContent = message;
				wrap.appendChild(errorElement);
				view.requestMeasure();
			}
		})();

		return wrap;
	}

	/**
	 * @returns 見積もった高さ
	 */
	get estimatedHeight(): number {
		// ソースの行数。高さの見積もりに使う
		const lines = this.source.split(/\r\n|\r|\n/).length;
		return Math.max(160, Math.min(640, lines * 22 + 64));
	}

	/**
	 * @returns 同一なら true
	 */
	ignoreEvent(): boolean {
		return true;
	}
}

/**
 * Mermaid ブロックをウィジェットへ置換する
 * @param entries - エントリ
 * @param from - 開始
 * @param to - 終了
 * @param source - ソース
 */
export function pushMermaidReplace(entries: DecorationEntry[], from: number, to: number, source: string): void {
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
			// このソースを描くウィジェット
			widget: new MermaidWidget(source)
		})
	});
}
