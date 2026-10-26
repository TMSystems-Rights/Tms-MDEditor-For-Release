/**
 * 画像枠線の太さと色を CSS 変数へ注入する
 * スニペットより前の style 要素に書き、設定の保存は持たない
 * @file
 */
import { CSS_SNIPPET_STYLE_ATTRIBUTE } from '../settings/cssSnippets';
import type { ImageBorderSettings } from '../types/app';

/**
 * 画像枠線の既定値
 * 通常は 1px の `#888888`、ホバーは 3px で色未指定（テーマのアクセントへ任せる）
 */
// prettier-ignore
export const DEFAULT_IMAGE_BORDER: ImageBorderSettings = {
	// 通常時の太さ。単位は px。0 は枠なし
	width     : 1,
	// 通常時の 16進色。空にはしない
	color     : '#888888',
	// ホバー時の太さ。単位は px。通常より太い既定
	hoverWidth: 3,
	// ホバー時の色。空はテーマのアクセントへ任せる
	hoverColor: '',
};

/** 画像枠線用 style 要素の id。再適用時は同じ要素の中身だけを更新する */
export const IMAGE_BORDER_STYLE_ID = 'tmsMdeImageBorder';

/** `#RGB`、`#RRGGBB`、`#RRGGBBAA` だけを許す。色名や関数記法は不一致 */
const CSS_HEX_COLOR = /^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;

/**
 * `#RGB` / `#RRGGBB` / `#RRGGBBAA` か判定する
 * 前後の空白は除いてから見る。null や空は false
 * @param value - 判定する色指定。null や未設定は空文字として扱う
 * @returns 16進カラーなら true
 */
export function isCssHexColor(value: string | null | undefined): boolean {
	return CSS_HEX_COLOR.test((value ?? '').trim());
}

/**
 * CSS 注入に使う 16進カラーを返す
 * 空や不正な値は代替へ戻す。空を許す指定のときだけ、空文字をそのまま返す
 * @param value - 入力の色。null や未設定は空文字として扱う
 * @param fallback - 空または不正なときの代替。形式の再検証はしない
 * @param allowEmpty - true のとき、空文字を代替へ戻さず返す。省略時は false
 * @returns 採用する色。空を許して空だったときは空文字
 */
export function sanitizeCssHexColor(value: string | null | undefined, fallback: string, allowEmpty = false): string {
	// 前後の空白を除いた色指定。空なら 16進判定をせず、空を許すときだけ空文字を返す
	const trimmed = (value ?? '').trim();
	// 空文字のときは形式を見ない。allowEmpty が false なら代替色、true なら空のまま返す。null や未設定もここへ来る
	if (trimmed.length === 0) {
		return allowEmpty ? '' : fallback;
	}

	return isCssHexColor(trimmed) ? trimmed : fallback;
}

/**
 * color input 用の `#RRGGBB` に正規化する
 * 3桁は各桁を重ね、8桁はアルファを落とし、どれでも小文字にする。変換できないときは代替を小文字で返す
 * @param value - 入力の色。null や不正は代替になる
 * @param fallback - 変換できないときの `#RRGGBB`。小文字化だけして返す
 * @returns `#` 付き 6 桁の小文字
 */
export function toColorInputValue(value: string | null | undefined, fallback: string): string {
	// 注入に使える 16進カラー。空や不正な入力は代替に置き換わっている。3、6、8 桁以外の代替は末尾で小文字にする
	const hex = sanitizeCssHexColor(value, fallback);
	// 3 桁のときだけ各桁を重ねて 6 桁の小文字にする。6 桁や 8 桁はこの分岐に入らない
	if (/^#[0-9A-Fa-f]{3}$/.test(hex)) {
		return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`.toLowerCase();
	}

	// 8 桁のときだけ先頭 6 桁を残して小文字にする。アルファは color input が受け取れない
	if (/^#[0-9A-Fa-f]{8}$/.test(hex)) {
		return hex.slice(0, 7).toLowerCase();
	}

	// 6 桁のときだけ小文字にする。3 桁と 8 桁はここまで来ない
	if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
		return hex.toLowerCase();
	}

	return fallback.toLowerCase();
}

/**
 * 枠線設定を既定値で補完する
 * 太さは整数だけを採用し、通常は 0〜8、ホバーは 0〜16 に収める。範囲外は既定値に戻す
 * @param settings - 部分的な設定。null や未設定の項目は既定値
 * @returns 注入に使える完全な枠線設定。ホバー色の空文字は「アクセント色を使う」
 */
// prettier-ignore
export function resolveImageBorder(settings: Partial<ImageBorderSettings> | null | undefined): ImageBorderSettings {
	// 数値化した通常の太さ。単位は px。未設定や数値でないときは NaN になり、戻り値では既定の 1 に戻す
	const width      = Number(settings?.width);
	// 数値化したホバーの太さ。単位は px。未設定や数値でないときは NaN になり、戻り値では既定の 3 に戻す
	const hoverWidth = Number(settings?.hoverWidth);
	// 注入に使える枠線。範囲外の太さと不正な色は既定へ戻し、ホバー色の空はアクセント色の印として残す
	return {
		// 0〜8 の整数だけ採用する。範囲外、小数、NaN は既定の 1。単位は px。どれか一つ欠けても既定へ戻す
		width     : Number.isInteger(width) && width >= 0 && width <= 8 ? width : DEFAULT_IMAGE_BORDER.width,
		// 16進以外は既定の #888888。空も代替へ戻す
		color     : sanitizeCssHexColor(settings?.color, DEFAULT_IMAGE_BORDER.color),
		// 0〜16 の整数だけ採用する。範囲外、小数、NaN は既定の 3。単位は px。どれか一つ欠けても既定へ戻す
		hoverWidth: Number.isInteger(hoverWidth) && hoverWidth >= 0 && hoverWidth <= 16 ? hoverWidth : DEFAULT_IMAGE_BORDER.hoverWidth,
		// 空はアクセント色を使う印として残す。不正な色は空へ戻す
		hoverColor: sanitizeCssHexColor(settings?.hoverColor, '', true),
	};
}

// prettier-ignore
/**
 * 画像枠線の CSS 変数ルールを生成する
 * ホバー色が空のときは `--tms-mde-color-primary` を参照する
 * @param settings - 部分的な設定。null や未設定は既定値で補う
 * @param selector - ルールを適用するセレクタ。省略時は `:root`
 * @returns 1 つの CSS ルール文字列。太さの単位は px
 */
// prettier-ignore
export function buildImageBorderCss(settings: Partial<ImageBorderSettings> | null | undefined, selector = ':root'): string {
	// 既定値で補完した枠線。太さは px の整数、ホバー色の空はアクセント色の印
	const resolved   = resolveImageBorder(settings);
	// CSS に書くホバー色。設定が空のときはテーマのアクセント変数。空のまま変数へは書かない
	const hoverColor = resolved.hoverColor.length > 0
		? resolved.hoverColor
		: 'var(--tms-mde-color-primary)';
	return `${selector} { --tms-mde-image-border-width: ${resolved.width}px; --tms-mde-image-border-color: ${resolved.color}; --tms-mde-image-border-hover-width: ${resolved.hoverWidth}px; --tms-mde-image-border-hover-color: ${hoverColor}; }`;
}

/**
 * 設定の画像枠線をエディタホストへ適用する
 * style 要素が無ければ作り、CSS スニペットより前へ置く。既存要素は位置を変えず中身だけ更新する
 * @param settings - 部分的な設定。null や未設定は既定値で補う
 */
// prettier-ignore
export function applyImageBorder(settings: Partial<ImageBorderSettings> | null | undefined): void {
	// エディタホストへ書く枠線変数の 1 ルール。太さの単位は px。ホバー色が空ならアクセント変数
	const css = buildImageBorderCss(settings, '.tms-mde-editor-host');
	// 既存の画像枠線用 style。同じ id が無いときは null で、このあと作る
	let style = document.getElementById(IMAGE_BORDER_STYLE_ID) as HTMLStyleElement | null;
	// 同じ id の style が無いときだけ要素を作る。あるときは位置を変えず、中身だけ後で更新する
	if (!style) {
		// 新しく作る style。この時点ではまだ head に無い
		style              = document.createElement('style');
		style.id           = IMAGE_BORDER_STYLE_ID;
		// 先頭の CSS スニペット style。無いときは null で、枠線用 style は head の末尾へ足す
		const firstSnippet = document.head.querySelector(`style[${CSS_SNIPPET_STYLE_ATTRIBUTE}]`);
		// スニペットがあるときだけその直前へ挿入し、スニペットからの上書きを残す。スニペットが無いときはこの分岐に入らない
		if (firstSnippet) {
			document.head.insertBefore(style, firstSnippet);
		} else {
			document.head.appendChild(style);
		}
	}

	style.textContent = css;
}
