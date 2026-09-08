export type ImageDisplaySize = {
	width: number | null;
	height: number | null;
};

/**
 * サイズ指定トークンを解釈する（`300` / `300x200`。以降の `|left` 等は無視）
 * @param {string} token `|` 以降
 * @returns {ImageDisplaySize}
 */
export function parseImageSizeToken(token: string): ImageDisplaySize {
	const first = token.split('|')[0]?.trim() ?? '';
	const match = /^(\d+)(?:x(\d+))?$/i.exec(first);
	if (!match) {
		return { width: null, height: null };
	}

	return {
		width : Number(match[1]),
		height: match[2] ? Number(match[2]) : null,
	};
}

/**
 * WikiEmbed のパスとサイズを分離する
 * @param {string} raw `![[...]]` 内
 * @returns {{ path: string; size: ImageDisplaySize }}
 */
export function splitWikiEmbedTarget(raw: string): { path: string; size: ImageDisplaySize } {
	const pipe = raw.indexOf('|');
	if (pipe < 0) {
		return { path: raw.trim(), size: { width: null, height: null } };
	}

	return {
		path: raw.slice(0, pipe).trim(),
		size: parseImageSizeToken(raw.slice(pipe + 1)),
	};
}

/**
 * 標準画像の alt とサイズを分離する
 * @param {string} alt `![alt](url)` の alt
 * @returns {{ alt: string; size: ImageDisplaySize }}
 */
export function splitImageAlt(alt: string): { alt: string; size: ImageDisplaySize } {
	const pipe = alt.indexOf('|');
	if (pipe < 0) {
		return { alt, size: { width: null, height: null } };
	}

	return {
		alt : alt.slice(0, pipe),
		size: parseImageSizeToken(alt.slice(pipe + 1)),
	};
}

/**
 * WikiEmbed 記法を組み立てる
 * @param {string} path 画像パス
 * @param {number | null} width 幅（px）
 * @returns {string}
 */
export function formatWikiEmbed(path: string, width: number | null): string {
	if (width === null || width <= 0) {
		return `![[${path}]]`;
	}

	return `![[${path}|${Math.round(width)}]]`;
}

/**
 * 標準画像記法を組み立てる
 * @param {string} alt alt（サイズなし）
 * @param {string} url URL / パス
 * @param {number | null} width 幅（px）
 * @returns {string}
 */
export function formatMarkdownImage(alt: string, url: string, width: number | null): string {
	const altPart = width !== null && width > 0 ? `${alt}|${Math.round(width)}` : alt;
	return `![${altPart}](${url})`;
}
