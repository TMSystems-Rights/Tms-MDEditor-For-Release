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
	// 最初の `|` または `\|`。区切りが無ければ null
	const separator = findAliasSeparator(raw);
	// 区切りが無いときは隠す文字も表示ラベルも無い
	if (!separator) {
		// エイリアスとして使えない結果。先頭は隠さない
		return {
			// 隠す文字数。区切りが無いので 0
			hideLength: 0,
			// 表示ラベル。区切りが無いので null
			alias: null
		};
	}

	// 区切りより左のページ名。空白だけならエイリアスにしない
	const target = raw.slice(0, separator.start);
	// 区切りより右の表示ラベル。空白だけならエイリアスにしない
	const alias  = raw.slice(separator.end);
	// ページ名か表示ラベルの一方でも空白だけなら、区切りは使わず隠さない
	if (target.trim().length === 0 || alias.trim().length === 0) {
		// 片側が空のときの結果。区切りはあったがエイリアスにはしない
		return {
			// 隠す文字数。片側が空白だけなので 0
			hideLength: 0,
			// 表示ラベル。片側が空白だけなので null
			alias: null
		};
	}

	// ページ名を隠し、右側だけを表示する結果
	return {
		// ページ先頭から区切り直後まで隠す文字数。0 にはならない
		hideLength: separator.end,
		// `|` または `\|` の右側。空白だけではここに来ない
		alias
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
		// バックスラッシュと直後のパイプが両方あるときだけエスケープ区切りにする。どちらか一方では入らない
		if (raw[index] === '\\' && raw[index + 1] === '|') {
			// 表セル向けの区切り範囲。end は `\|` の直後
			return {
				// 区切りの開始。バックスラッシュの位置
				start: index,
				// 区切りの終端。2文字進めた直後
				end: index + 2
			};
		}

		// エスケープでない単独のパイプ。表セル外の区切りとして先に返す
		if (raw[index] === '|') {
			// 通常の区切り範囲。end は `|` の直後
			return {
				// 区切りの開始。パイプの位置
				start: index,
				// 区切りの終端。1文字進めた直後
				end: index + 1
			};
		}
	}

	return null;
}
