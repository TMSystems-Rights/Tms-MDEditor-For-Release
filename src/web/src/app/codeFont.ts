/**
 * コード用フォントを CSS 変数へ注入する
 * スニペットより前の style 要素に書き、スニペットからの上書きを残す。設定の保存は持たない
 * @file
 */
import { CSS_SNIPPET_STYLE_ATTRIBUTE } from '../settings/cssSnippets';

/** コードブロックとインラインコードの既定フォント。空や不正な指定のときの代替 */
export const DEFAULT_CODE_FONT_FAMILY = 'Consolas, "Cascadia Mono", "Meiryo UI", monospace';

/** コードフォント用 style 要素の id。再適用時は同じ要素の中身だけを更新する */
export const CODE_FONT_STYLE_ID = 'tmsMdeCodeFont';

/**
 * フォントファミリー指定から CSS 注入に使えない文字を除く
 * 改行と波括弧を空白にし、空になったときは既定フォントを返す
 * @param value - 設定のフォント指定。null や未設定は空文字として扱う
 * @returns サニタイズしたフォント指定。空なら `DEFAULT_CODE_FONT_FAMILY`
 */
export function sanitizeCssFontFamily(value: string | null | undefined): string {
	const sanitized = (value ?? '').replace(/[\n\r{}]/g, ' ').replace(/\s+/g, ' ').trim();
	return sanitized.length > 0 ? sanitized : DEFAULT_CODE_FONT_FAMILY;
}

/**
 * コード用フォントを CSS 変数 `--tms-mde-font-mono` へ書くルールを生成する
 * フォント文字列は `sanitizeCssFontFamily` を通してから埋め込む
 * @param fontFamily - 設定のフォント指定。null や空は既定フォントになる
 * @param selector - ルールを適用するセレクタ。省略時は `:root`
 * @returns 1 つの CSS ルール文字列
 */
export function buildCodeFontCss(fontFamily: string | null | undefined, selector = ':root'): string {
	return `${selector} { --tms-mde-font-mono: ${sanitizeCssFontFamily(fontFamily)}; }`;
}

/**
 * 設定のコードフォントをエディタホストへ適用する
 * style 要素が無ければ作り、CSS スニペットより前へ置いてスニペットからの上書きを残す。既存要素は位置を変えず中身だけ更新する
 * @param fontFamily - 設定のフォント指定。null や空は既定フォントになる
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
