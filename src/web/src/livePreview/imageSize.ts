/**
 * 画像記法の幅・高さトークンを解釈し、リサイズ後の記法へ組み立て直す
 * 状態は持たず、パス解決や DOM のサイズ計測は呼び出し側が行う
 * @file
 */
/**
 * 画像記法から取り出した表示サイズ
 * 幅も高さも px の整数。指定が無ければ null で、比率は呼び出し側が決める
 */
export type ImageDisplaySize = {
	/** 表示幅（px）。トークンが無ければ null */
	width: number | null;
	/** 表示高さ（px）。幅だけの指定では null */
	height: number | null;
};

/**
 * サイズ指定トークンを解釈する
 * `300` と `300x200` を受け、それ以降の `|left` などは無視する。解釈できないときは両方 null
 * @param token - `|` より後ろのサイズ指定。空文字はサイズ無し
 * @returns 幅と高さ（px）。数値でなければ両方 null
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
 * 最初の `\|` を優先し、無ければ最初の `|` を区切りにする
 * @param raw - `![[...]]` の内側。括弧は含めない
 * @returns path はサイズを除いたパス、size は解釈した幅と高さ
 */
export function splitWikiEmbedTarget(raw: string): { path: string; size: ImageDisplaySize } {
	const escaped = raw.indexOf('\\|');
	if (escaped >= 0) {
		return {
			path: raw.slice(0, escaped).trim(),
			size: parseImageSizeToken(raw.slice(escaped + 2)),
		};
	}

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
 * 区切りの規則は splitWikiEmbedTarget と同じで、左側はパスではなく alt 文面
 * @param alt - `![alt](url)` の alt。サイズを含んでよい
 * @returns alt はサイズを除いた文面、size は解釈した幅と高さ
 */
export function splitImageAlt(alt: string): { alt: string; size: ImageDisplaySize } {
	const escaped = alt.indexOf('\\|');
	if (escaped >= 0) {
		return {
			alt : alt.slice(0, escaped),
			size: parseImageSizeToken(alt.slice(escaped + 2)),
		};
	}

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
 * 幅が null または 0 以下のときはサイズ無しの `![[path]]` を返す
 * @param path - 画像パス。区切り文字のエスケープはしない
 * @param width - 幅（px）。null または 0 以下ならサイズを書かない
 * @param options - 表セル向けの区切り。escapePipe が true のとき `|` ではなく `\|` を使う。省略時は `|`
 * @returns `![[...]]` 形式の記法
 */
export function formatWikiEmbed(path: string, width: number | null, options?: { escapePipe?: boolean }): string {
	if (width === null || width <= 0) {
		return `![[${path}]]`;
	}

	const delimiter = options?.escapePipe ? '\\|' : '|';
	return `![[${path}${delimiter}${Math.round(width)}]]`;
}

/**
 * 標準画像記法を組み立てる
 * 幅が有効なときだけ alt の後ろへサイズを付ける。高さは書かない
 * @param alt - サイズを含まない alt。空文字でもそのまま連結する
 * @param url - 画像の URL またはパス。括弧のエスケープはしない
 * @param width - 幅（px）。null または 0 以下なら alt だけを書く
 * @param options - 表セル向けの区切り。escapePipe が true のとき `|` ではなく `\|` を使う。省略時は `|`
 * @returns `![alt](url)` 形式の記法
 */
export function formatMarkdownImage(
	alt: string,
	url: string,
	width: number | null,
	options?: { escapePipe?: boolean },
): string {
	const delimiter = options?.escapePipe ? '\\|' : '|';
	const altPart   = width !== null && width > 0 ? `${alt}${delimiter}${Math.round(width)}` : alt;
	return `![${altPart}](${url})`;
}
