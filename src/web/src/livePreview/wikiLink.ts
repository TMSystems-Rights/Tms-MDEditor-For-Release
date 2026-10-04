export type WikiLinkAliasSplit = {
	/** ページ先頭からエイリアス直前まで隠す文字数。エイリアスが無ければ 0 */
	hideLength: number;
	/** `|` / `\|` の右側。無ければ null */
	alias: string | null;
};

/**
 * `[[target|alias]]` と表セルの `[[target\|alias]]` を分ける。
 * 最初の `|` または `\|` を区切りにし、右側を表示ラベルにする。
 * @param {string} raw `[[ ]]` の内側
 * @returns {WikiLinkAliasSplit}
 */
export function splitWikiLinkAlias(raw: string): WikiLinkAliasSplit {
	const separator = findAliasSeparator(raw);
	if (!separator) {
		return { hideLength: 0, alias: null };
	}

	const target = raw.slice(0, separator.start);
	const alias  = raw.slice(separator.end);
	if (target.trim().length === 0 || alias.trim().length === 0) {
		return { hideLength: 0, alias: null };
	}

	return {
		hideLength: separator.end,
		alias,
	};
}

/**
 * エイリアス区切りの位置を返す。
 * @param {string} raw ページ文字列
 * @returns {{ start: number; end: number } | null}
 */
function findAliasSeparator(raw: string): { start: number; end: number } | null {
	for (let index = 0; index < raw.length; index += 1) {
		if (raw[index] === '\\' && raw[index + 1] === '|') {
			return { start: index, end: index + 2 };
		}

		if (raw[index] === '|') {
			return { start: index, end: index + 1 };
		}
	}

	return null;
}
