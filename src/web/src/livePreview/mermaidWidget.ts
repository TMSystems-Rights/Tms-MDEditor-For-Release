import { Decoration, WidgetType, type EditorView } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import type { DecorationEntry } from './inlineDecorations';

type MermaidModule = {
	initialize: (config: Record<string, unknown>) => void;
	render: (
		id: string,
		text: string,
		container?: Element,
	) => Promise<{ svg: string }>;
	run: (options?: {
		nodes?: ArrayLike<HTMLElement>;
		suppressErrors?: boolean;
	}) => Promise<void>;
};

type MermaidLabelMode = 'html' | 'plain';

type MermaidCacheEntry =
	| { ok: true; svg: string; mode: MermaidLabelMode }
	| { ok: false; error: string };

const mermaidCache = new Map<string, MermaidCacheEntry>();

const MIN_LOCKED_MERMAID_WIDTH = 120;

let mermaidLoader: Promise<MermaidModule> | null = null;
let mermaidRenderSeq                             = 0;
let lastInitKey: string | null                   = null;
let mermaidModuleOverride: MermaidModule | null  = null;

type SvgViewBoxSize = {
	width: number;
	height: number;
};

/**
 * テスト用にキャッシュをクリアする
 * @returns {void}
 */
export function clearMermaidCache(): void {
	mermaidCache.clear();
	lastInitKey = null;
}

/**
 * テスト用に Mermaid モジュールを差し替える
 * @param {MermaidModule | null} module 差し替えモジュール
 * @returns {void}
 */
export function setMermaidModuleForTest(module: MermaidModule | null): void {
	mermaidModuleOverride = module;
	mermaidLoader         = null;
	lastInitKey           = null;
}

/**
 * CodeInfo が mermaid か
 * @param {string} info CodeInfo 文字列
 * @returns {boolean}
 */
export function isMermaidCodeInfo(info: string): boolean {
	return info.trim().toLowerCase() === 'mermaid';
}

/**
 * ラベル内 HTML を SVG テキスト計測可能な形へ正規化する（フォールバック用）
 * @param {string} source 生ソース
 * @returns {string}
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
 * @param {string | null} viewBox viewBox 属性
 * @returns {boolean}
 */
function isTinyViewBox(viewBox: string | null): boolean {
	if (!viewBox) {
		return false;
	}

	const parts = viewBox.trim().split(/[\s,]+/).map(Number);
	if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
		return false;
	}

	return parts[2] <= 24 && parts[3] <= 24;
}

/**
 * viewBox から自然サイズを取得する
 * @param {string | null} viewBox viewBox 属性
 * @returns {SvgViewBoxSize | null} 自然サイズ
 */
function getViewBoxSize(viewBox: string | null): SvgViewBoxSize | null {
	if (!viewBox) {
		return null;
	}

	const parts = viewBox.trim().split(/[\s,]+/).map(Number);
	if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
		return null;
	}

	const [, , width, height] = parts;
	if (!(width > 1 && height > 1)) {
		return null;
	}

	return { width, height };
}

/**
 * CSS px 値を数値化する
 * @param {string} value CSS 値
 * @returns {number}
 */
function parseCssPx(value: string): number {
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed)
		? parsed
		: 0;
}

/**
 * 要素のコンテンツ幅を取得する
 * @param {HTMLElement} element 要素
 * @returns {number}
 */
function getElementContentWidth(element: HTMLElement): number {
	const clientWidth = element.clientWidth || element.getBoundingClientRect().width;
	if (!(clientWidth > 1)) {
		return 0;
	}

	if (typeof getComputedStyle !== 'function') {
		return clientWidth;
	}

	const style = getComputedStyle(element);
	return Math.max(
		0,
		clientWidth - parseCssPx(style.paddingLeft) - parseCssPx(style.paddingRight),
	);
}

/**
 * HTML ラベル計測失敗で潰れた SVG 文字列か判定する。
 * Mermaid 11 は正常図でも一部 foreignObject が width=0 になるため、FO 単独では判定しない。
 * @param {string} svg SVG 文字列
 * @returns {boolean}
 */
export function isCollapsedMermaidSvg(svg: string): boolean {
	if (!svg.trim()) {
		return true;
	}

	if (/\bheight="0"/.test(svg)) {
		return true;
	}

	if (/\bwidth="16"(?=[^>]*>)/.test(svg) && /\bheight="16"(?=[^>]*>)/.test(svg)) {
		return true;
	}

	const viewBox = (svg.match(/\bviewBox="([^"]+)"/) || [])[1] ?? null;
	if (isTinyViewBox(viewBox)) {
		return true;
	}

	return false;
}

/**
 * DOM 上の SVG が潰れているか判定する
 * @param {SVGSVGElement | null} svg SVG
 * @returns {boolean}
 */
export function isCollapsedMermaidSvgElement(svg: SVGSVGElement | null): boolean {
	if (!svg) {
		return true;
	}

	if (svg.getAttribute('height') === '0') {
		return true;
	}

	if (svg.getAttribute('width') === '16' && svg.getAttribute('height') === '16') {
		return true;
	}

	try {
		const bbox = svg.getBBox();
		if (bbox.width > 24 && bbox.height > 24) {
			return false;
		}
	} catch {
		// getBBox 不可時は viewBox 判定へ
	}

	const viewBox = svg.getAttribute('viewBox');
	if (viewBox) {
		return isTinyViewBox(viewBox);
	}

	return false;
}

/**
 * 描画後の潰れた viewBox / height=0 を内容の bbox で補正する
 * @param {SVGSVGElement | null} svg SVG 要素
 * @returns {boolean} 補正できたか
 */
export function fixMermaidSvgViewport(svg: SVGSVGElement | null): boolean {
	if (!svg) {
		return false;
	}

	try {
		const bbox = svg.getBBox();
		if (!(bbox.width > 1 && bbox.height > 1)) {
			return false;
		}

		const pad = 8;
		svg.setAttribute(
			'viewBox',
			`${bbox.x - pad} ${bbox.y - pad} ${bbox.width + pad * 2} ${bbox.height + pad * 2}`,
		);
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
 * Mermaid SVG の表示サイズを現在のエディタ幅で固定する。
 * Obsidian 風に、初回表示幅へ収めた後はウィンドウ拡縮で図を伸縮させず横スクロールへ逃がす。
 * @param {SVGSVGElement | null} svg SVG 要素
 * @param {HTMLElement | null} container スクロールコンテナ
 * @returns {boolean} 固定できたか
 */
export function lockMermaidSvgDisplaySize(
	svg: SVGSVGElement | null,
	container: HTMLElement | null,
): boolean {
	if (!svg || !container) {
		return false;
	}

	const viewBoxSize = getViewBoxSize(svg.getAttribute('viewBox'));
	if (!viewBoxSize) {
		return false;
	}

	const contentWidth = getElementContentWidth(container);
	if (!(contentWidth > 1)) {
		return false;
	}

	const displayWidth  = Math.max(
		MIN_LOCKED_MERMAID_WIDTH,
		Math.min(Math.ceil(viewBoxSize.width), Math.floor(contentWidth)),
	);
	const displayHeight = Math.ceil((displayWidth / viewBoxSize.width) * viewBoxSize.height);

	svg.setAttribute('width', String(displayWidth));
	svg.setAttribute('height', String(displayHeight));
	svg.style.width    = `${displayWidth}px`;
	svg.style.height   = 'auto';
	svg.style.maxWidth = 'none';
	return true;
}

/**
 * Mermaid 図は classDef 色を優先するため既定テーマを使う。
 * ダーク外観は CSS（Obsidian 同様の invert）で合わせる。
 * @returns {'default'}
 */
export function resolveMermaidTheme(): 'default' {
	return 'default';
}

/**
 * キャッシュキー
 * @param {string} source ソース
 * @param {string} theme テーマ
 * @returns {string}
 */
function cacheKeyFor(source: string, theme: string): string {
	return `v7-mmd1141-pad\n${theme}\n${source}`;
}

/**
 * Mermaid を遅延ロードする
 * @returns {Promise<MermaidModule>}
 */
async function loadMermaid(): Promise<MermaidModule> {
	if (mermaidModuleOverride) {
		return mermaidModuleOverride;
	}

	if (!mermaidLoader) {
		mermaidLoader = import('mermaid').then((mod) => mod.default as MermaidModule);
	}

	return mermaidLoader;
}

/**
 * 次フレームまで待つ
 * @returns {Promise<void>}
 */
function nextFrame(): Promise<void> {
	return new Promise((resolve) => {
		requestAnimationFrame(() => resolve());
	});
}

/**
 * ラベルモードに合わせて initialize する
 * @param {MermaidModule} mermaid モジュール
 * @param {'default' | 'dark'} theme テーマ
 * @param {MermaidLabelMode} mode ラベルモード
 * @returns {void}
 */
function ensureMermaidInitialized(
	mermaid: MermaidModule,
	theme: 'default' | 'dark',
	mode: MermaidLabelMode,
): void {
	// Obsidian 1.12.x 同梱の Mermaid 11.4.1 相当設定
	const initKey = `${theme}:loose:${mode}:mmd1141:pad15`;
	if (lastInitKey === initKey) {
		return;
	}

	if (lastInitKey !== null) {
		mermaidCache.clear();
	}

	const htmlLabels = mode === 'html';
	mermaid.initialize({
		startOnLoad     : false,
		securityLevel   : 'loose',
		htmlLabels,
		theme,
		// エディタ字体と切り離し、HTML ラベル計測の見切れを防ぐ
		themeVariables  : {
			fontFamily : '"trebuchet ms", verdana, arial, "Segoe UI", Meiryo, sans-serif',
			fontSize   : '16px',
		},
		flowchart       : {
			htmlLabels,
			// Obsidian 同様。幅は CSS 側で 100% にする
			useMaxWidth : false,
			padding     : 15,
		},
	});
	lastInitKey = initKey;
}

/**
 * 指定モードで文字列描画する（テスト / フォールバック用）
 * @param {MermaidModule} mermaid モジュール
 * @param {string} text ソース
 * @param {'default' | 'dark'} theme テーマ
 * @param {MermaidLabelMode} mode モード
 * @returns {Promise<string>}
 */
async function renderWithMode(
	mermaid: MermaidModule,
	text: string,
	theme: 'default' | 'dark',
	mode: MermaidLabelMode,
): Promise<string> {
	ensureMermaidInitialized(mermaid, theme, mode);
	mermaidRenderSeq += 1;
	const id          = `tms-mde-mermaid-${mermaidRenderSeq}`;
	const { svg }     = await mermaid.render(id, text);
	return svg;
}

/**
 * 表示中のホストへ in-place 描画する（FO 計測が効く）
 * @param {MermaidModule} mermaid モジュール
 * @param {HTMLElement} host ホスト
 * @param {string} text ソース
 * @param {'default' | 'dark'} theme テーマ
 * @param {MermaidLabelMode} mode モード
 * @returns {Promise<SVGSVGElement | null>}
 */
async function runIntoHost(
	mermaid: MermaidModule,
	host: HTMLElement,
	text: string,
	theme: 'default' | 'dark',
	mode: MermaidLabelMode,
): Promise<SVGSVGElement | null> {
	ensureMermaidInitialized(mermaid, theme, mode);
	host.className   = 'mermaid';
	host.textContent = text;
	host.removeAttribute('data-processed');

	// CJK フォント読込前の計測ずれ（下端見切れ）を避ける
	if (typeof document !== 'undefined' && document.fonts?.ready) {
		try {
			await document.fonts.ready;
		} catch {
			// fonts API 失敗時はそのまま描画
		}
	}

	await nextFrame();
	await mermaid.run({
		nodes          : [host],
		suppressErrors : false,
	});
	return host.querySelector('svg');
}

/**
 * FencedCode から CodeInfo を取得する
 * @param {EditorState} state 状態
 * @param {SyntaxNode} node FencedCode
 * @returns {string}
 */
export function extractFencedCodeInfo(state: EditorState, node: SyntaxNode): string {
	for (let child = node.firstChild; child; child = child.nextSibling) {
		if (child.name === 'CodeInfo') {
			return state.doc.sliceString(child.from, child.to).trim();
		}
	}

	return '';
}

/**
 * FencedCode から本文（CodeText）を取得する
 * @param {EditorState} state 状態
 * @param {SyntaxNode} node FencedCode
 * @returns {string}
 */
export function extractFencedCodeText(state: EditorState, node: SyntaxNode): string {
	for (let child = node.firstChild; child; child = child.nextSibling) {
		if (child.name === 'CodeText') {
			return state.doc.sliceString(child.from, child.to);
		}
	}

	return '';
}

/**
 * FencedCode が Mermaid ブロックか
 * @param {EditorState} state 状態
 * @param {SyntaxNode} node FencedCode
 * @returns {boolean}
 */
export function isMermaidFencedCode(state: EditorState, node: SyntaxNode): boolean {
	return isMermaidCodeInfo(extractFencedCodeInfo(state, node));
}

/**
 * Mermaid ソースを描画する（キャッシュ付き・主にテスト用）
 * @param {string} source ソース
 * @param {'default' | 'dark'} [theme] テーマ
 * @returns {Promise<MermaidCacheEntry>}
 */
export async function renderMermaidSource(
	source: string,
	theme: 'default' | 'dark' = resolveMermaidTheme(),
): Promise<MermaidCacheEntry> {
	const trimmed = source.trim();
	if (!trimmed) {
		return { ok: false, error: '空の Mermaid ブロックです' };
	}

	const key    = cacheKeyFor(trimmed, theme);
	const cached = mermaidCache.get(key);
	if (cached) {
		return cached;
	}

	try {
		const mermaid = await loadMermaid();

		let mode: MermaidLabelMode = 'html';
		let svg                    = await renderWithMode(mermaid, trimmed, theme, mode);
		if (isCollapsedMermaidSvg(svg)) {
			svg  = await renderWithMode(mermaid, preprocessMermaidSource(trimmed).trim(), theme, 'plain');
			mode = 'plain';
		}

		if (!svg.trim()) {
			const entry: MermaidCacheEntry = {
				ok    : false,
				error : 'Mermaid の描画結果が空でした（構文を確認してください）',
			};
			mermaidCache.set(key, entry);
			return entry;
		}

		const entry: MermaidCacheEntry = { ok: true, svg, mode };
		mermaidCache.set(key, entry);
		return entry;
	} catch (error) {
		const message                  = error instanceof Error && error.message
			? error.message
			: 'Mermaid の描画に失敗しました';
		const entry: MermaidCacheEntry = { ok: false, error: message };
		mermaidCache.set(key, entry);
		return entry;
	}
}

/**
 * Mermaid 図ウィジェット
 */
export class MermaidWidget extends WidgetType {
	readonly source: string;

	/**
	 * @param {string} source Mermaid ソース
	 */
	constructor(source: string) {
		super();
		this.source = source;
	}

	/**
	 * @param {WidgetType} other 比較対象
	 * @returns {boolean}
	 */
	eq(other: WidgetType): boolean {
		return other instanceof MermaidWidget && other.source === this.source;
	}

	/**
	 * @param {EditorView} view ビュー
	 * @returns {HTMLElement}
	 */
	toDOM(view: EditorView): HTMLElement {
		const wrap     = document.createElement('div');
		wrap.className = 'cm-md-mermaid-wrap';
		wrap.setAttribute('contenteditable', 'false');

		const status       = document.createElement('div');
		status.className   = 'cm-md-mermaid-status';
		status.textContent = 'Mermaid を読み込み中…';
		wrap.appendChild(status);

		const theme  = resolveMermaidTheme();
		const source = this.source.trim();

		void (async () => {
			try {
				for (let attempt = 0; attempt < 12 && !wrap.isConnected; attempt += 1) {
					await nextFrame();
				}

				if (!wrap.isConnected) {
					return;
				}

				const mermaid = await loadMermaid();
				const host    = document.createElement('div');
				wrap.replaceChildren(host);

				let svg = await runIntoHost(mermaid, host, source, theme, 'html');
				if (isCollapsedMermaidSvgElement(svg)) {
					svg = await runIntoHost(mermaid, host, preprocessMermaidSource(source).trim(), theme, 'plain');
				}

				if (isCollapsedMermaidSvgElement(svg)) {
					wrap.replaceChildren();
					const error       = document.createElement('div');
					error.className   = 'cm-md-mermaid-error';
					error.textContent = 'Mermaid の描画に失敗しました（寸法が不正です）';
					wrap.appendChild(error);
					view.requestMeasure();
					return;
				}

				/**
				 * viewBox 補正
				 * @returns {void}
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
				if (!wrap.isConnected) {
					return;
				}

				wrap.replaceChildren();
				const message            = error instanceof Error && error.message
					? error.message
					: 'Mermaid の描画に失敗しました';
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
	 * @returns {number}
	 */
	get estimatedHeight(): number {
		const lines = this.source.split(/\r\n|\r|\n/).length;
		return Math.max(160, Math.min(640, lines * 22 + 64));
	}

	/**
	 * @returns {boolean}
	 */
	ignoreEvent(): boolean {
		return true;
	}
}

/**
 * Mermaid ブロックをウィジェットへ置換する
 * @param {DecorationEntry[]} entries エントリ
 * @param {number} from 開始
 * @param {number} to 終了
 * @param {string} source ソース
 * @returns {void}
 */
export function pushMermaidReplace(
	entries: DecorationEntry[],
	from: number,
	to: number,
	source: string,
): void {
	if (from >= to) {
		return;
	}

	entries.push({
		from,
		to,
		decoration: Decoration.replace({
			widget: new MermaidWidget(source),
		}),
	});
}
