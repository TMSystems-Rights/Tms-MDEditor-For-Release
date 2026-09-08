import { CSS_SNIPPET_STYLE_ATTRIBUTE } from '../settings/cssSnippets';
import type { ImageBorderSettings } from '../types/app';

/** 画像枠線の既定値 */
export const DEFAULT_IMAGE_BORDER: ImageBorderSettings = {
	width     : 1,
	color     : '#888888',
	hoverWidth: 3,
	hoverColor: '',
};

/** 画像枠線を注入する style 要素の id */
export const IMAGE_BORDER_STYLE_ID = 'tmsMdeImageBorder';

const CSS_HEX_COLOR = /^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;

/**
 * `#RGB` / `#RRGGBB` / `#RRGGBBAA` か判定する
 * @param {string | null | undefined} value 入力
 * @returns {boolean}
 */
export function isCssHexColor(value: string | null | undefined): boolean {
	return CSS_HEX_COLOR.test((value ?? '').trim());
}

/**
 * CSS 注入に使う 16進カラーを返す
 * @param {string | null | undefined} value 入力
 * @param {string} fallback 不正時
 * @param {boolean} [allowEmpty] 空を許可するか
 * @returns {string}
 */
export function sanitizeCssHexColor(value: string | null | undefined, fallback: string, allowEmpty = false): string {
	const trimmed = (value ?? '').trim();
	if (trimmed.length === 0) {
		return allowEmpty ? '' : fallback;
	}

	return isCssHexColor(trimmed) ? trimmed : fallback;
}

/**
 * color input 用の `#RRGGBB` に正規化する
 * @param {string | null | undefined} value 入力
 * @param {string} fallback 代替
 * @returns {string}
 */
export function toColorInputValue(value: string | null | undefined, fallback: string): string {
	const hex = sanitizeCssHexColor(value, fallback);
	if (/^#[0-9A-Fa-f]{3}$/.test(hex)) {
		return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`.toLowerCase();
	}

	if (/^#[0-9A-Fa-f]{8}$/.test(hex)) {
		return hex.slice(0, 7).toLowerCase();
	}

	if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
		return hex.toLowerCase();
	}

	return fallback.toLowerCase();
}

/**
 * 枠線設定を既定値で補完する
 * @param {Partial<ImageBorderSettings> | null | undefined} settings 設定
 * @returns {ImageBorderSettings}
 */
export function resolveImageBorder(settings: Partial<ImageBorderSettings> | null | undefined): ImageBorderSettings {
	const width      = Number(settings?.width);
	const hoverWidth = Number(settings?.hoverWidth);
	return {
		width     : Number.isInteger(width) && width >= 0 && width <= 8 ? width : DEFAULT_IMAGE_BORDER.width,
		color     : sanitizeCssHexColor(settings?.color, DEFAULT_IMAGE_BORDER.color),
		hoverWidth: Number.isInteger(hoverWidth) && hoverWidth >= 0 && hoverWidth <= 16 ? hoverWidth : DEFAULT_IMAGE_BORDER.hoverWidth,
		hoverColor: sanitizeCssHexColor(settings?.hoverColor, '', true),
	};
}

/**
 * 画像枠線の CSS 変数ルールを生成する
 * @param {Partial<ImageBorderSettings> | null | undefined} settings 設定
 * @param {string} [selector=':root'] 適用セレクタ
 * @returns {string}
 */
export function buildImageBorderCss(settings: Partial<ImageBorderSettings> | null | undefined, selector = ':root'): string {
	const resolved   = resolveImageBorder(settings);
	const hoverColor = resolved.hoverColor.length > 0
		? resolved.hoverColor
		: 'var(--tms-mde-color-primary)';
	return `${selector} { --tms-mde-image-border-width: ${resolved.width}px; --tms-mde-image-border-color: ${resolved.color}; --tms-mde-image-border-hover-width: ${resolved.hoverWidth}px; --tms-mde-image-border-hover-color: ${hoverColor}; }`;
}

/**
 * 設定の画像枠線を Web UI へ適用する
 * @param {Partial<ImageBorderSettings> | null | undefined} settings 設定
 * @returns {void}
 */
export function applyImageBorder(settings: Partial<ImageBorderSettings> | null | undefined): void {
	const css = buildImageBorderCss(settings, '.tms-mde-editor-host');
	let style = document.getElementById(IMAGE_BORDER_STYLE_ID) as HTMLStyleElement | null;
	if (!style) {
		style              = document.createElement('style');
		style.id           = IMAGE_BORDER_STYLE_ID;
		const firstSnippet = document.head.querySelector(`style[${CSS_SNIPPET_STYLE_ATTRIBUTE}]`);
		if (firstSnippet) {
			document.head.insertBefore(style, firstSnippet);
		} else {
			document.head.appendChild(style);
		}
	}

	style.textContent = css;
}
