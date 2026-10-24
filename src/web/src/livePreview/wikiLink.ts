/**
 * Wiki リンク `[[target|alias]]` の内側を、表示ラベルと隠す長さに分ける
 * 状態は持たず、文字列の解釈だけを呼び出し側へ返す
 * @file
 */
/**
 * Wiki リンク内側の、隠す長さと表示ラベル
 * 区切りが無い、または片側が空白だけのときは alias が null で hideLength は 0
 */
export type WikiLinkAliasSplit = {
	/** ページ先頭からエイリアス直前まで隠す文字数。エイリアスが無ければ 0 */
	hideLength: number;
	/** `|` / `\|` の右側。無ければ null */
	alias: string | null;
};

/**
 * `[[target|alias]]` と表セルの `[[target\|alias]]` を分ける
 * 最初の `|` または `\|` を区切りにし、右側を表示ラベルにする
 * @param raw - `[[ ]]` の内側。括弧自体は含めない
 * @returns 隠す文字数と表示ラベル。区切りとして使えなければ hideLength は 0、alias は null
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
 * 最初のエイリアス区切りの位置を返す
 * `\|` を `|` より優先し、表セル内のエスケープを区切りとして扱う
 * @param raw - ページ文字列。`[[ ]]` の内側
 * @returns 区切りの開始と終端（終端は区切り文字の直後）。無ければ null
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
