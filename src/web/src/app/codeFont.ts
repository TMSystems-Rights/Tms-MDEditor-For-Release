import { CSS_SNIPPET_STYLE_ATTRIBUTE } from '../settings/cssSnippets';

/** コードブロック・インラインコードの既定フォント */
export const DEFAULT_CODE_FONT_FAMILY = 'Consolas, "Cascadia Mono", "Meiryo UI", monospace';

/** コードブロックフォントを注入する style 要素の id */
export const CODE_FONT_STYLE_ID = 'tmsMdeCodeFont';

/**
 * フォントファミリー指定から CSS 注入に使えない文字を除く。
 * @param {string | null | undefined} value 設定値
 * @returns {string} 既定値またはサニタイズ済み値
 */
export function sanitizeCssFontFamily(value: string | null | undefined): string {
	const sanitized = (value ?? '').replace(/[\n\r{}]/g, ' ').replace(/\s+/g, ' ').trim();
	return sanitized.length > 0 ? sanitized : DEFAULT_CODE_FONT_FAMILY;
}

/**
 * コードブロック用フォントを CSS 変数へ反映するルールを生成する。
 * @param {string | null | undefined} fontFamily 設定値
 * @param {string} [selector=':root'] 適用セレクタ
 * @returns {string}
 */
export function buildCodeFontCss(fontFamily: string | null | undefined, selector = ':root'): string {
	return `${selector} { --tms-mde-font-mono: ${sanitizeCssFontFamily(fontFamily)}; }`;
}

/**
 * 設定のコードブロックフォントを Web UI へ適用する。
 * `.tms-mde-editor-host` へ注入し、CSSスニペットより前へ置いてスニペットからの上書きを残す。
 * @param {string | null | undefined} fontFamily 設定値
 * @returns {void}
 */
export function applyCodeFontFamily(fontFamily: string | null | undefined): void {
	const css = buildCodeFontCss(fontFamily, '.tms-mde-editor-host');
	let style = document.getElementById(CODE_FONT_STYLE_ID) as HTMLStyleElement | null;
	if (!style) {
		style              = document.createElement('style');
		style.id           = CODE_FONT_STYLE_ID;
		const firstSnippet = document.head.querySelector(`style[${CSS_SNIPPET_STYLE_ATTRIBUTE}]`);
		if (firstSnippet) {
			document.head.insertBefore(style, firstSnippet);
		} else {
			document.head.appendChild(style);
		}
	}

	style.textContent = css;
}
