/**
 * HTML ブロックから表だけを取り出し、許可したタグと属性の文字列へ戻す
 * エディタ状態は持たず、style と class の危険な値は htmlSanitizer に任せる
 * @file
 */
import { ALLOWED_HTML_TAGS, sanitizeClassValue, sanitizeStyleValue } from './htmlSanitizer';

// ----------------------------------------------
// 表として残すタグ
// ----------------------------------------------

/**
 * 表の構造として残すタグ名。小文字で比較する
 * インラインの許可タグは htmlSanitizer 側の集合を別に見る。実行中は変えない
 */
const TABLE_TAGS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption']);

/**
 * td と th にだけ残す数値属性
 * 値は 1 より大きい整数のときだけ書き戻す。実行中は変えない
 */
const TABLE_ONLY_ATTRIBUTES = new Set(['colspan', 'rowspan']);

/**
 * コメント、タグ、それ以外のテキストへ分ける
 * タグの入れ子は見ず、断片の走査順だけを決める
 */
const TOKEN_PATTERN = /<!--[\s\S]*?-->|<\/?[a-zA-Z][\w:-]*\b[^>]*>|[^<]+/g;

/**
 * 開始タグを、タグ名と属性部分へ分ける
 * 自己閉じの末尾スラッシュは、照合前に呼び出し側が除く
 */
const OPEN_TAG_PATTERN = /^<\s*([a-zA-Z][\w:-]*)\s*([^>]*)>$/;

/**
 * 終了タグからタグ名を取り出す
 * 属性付きの終了タグには一致しない
 */
const CLOSE_TAG_PATTERN = /^<\s*\/\s*([a-zA-Z][\w:-]*)\s*>$/;

/**
 * 属性名と、引用符付きまたは裸の値を取り出す
 * グローバル正規表現のため、走査の前に lastIndex を 0 へ戻す
 */
const ATTR_PATTERN = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * 終了タグが無くても中身を持たないタグ
 * 表の中で落とす対象の入れ子深さを増やさないために使う
 */
const VOID_TAGS = new Set(['br', 'img']);

/**
 * タグだけでなく、中身もまとめて落とすタグ名
 * script や style のテキストが表へ漏れないようにする
 */
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed']);

// ----------------------------------------------
// 表ブロックの取り出し
// ----------------------------------------------

/**
 * ブロックの先頭が table 開始タグかを判定する
 * 前後の空白は無視し、タグ名の大文字は区別しない
 * @param text - 判定する HTML ブロック
 * @returns 先頭が table 開始タグなら true
 */
export function isHtmlTableBlock(text: string): boolean {
	return /^\s*<table\b/i.test(text);
}

/**
 * HTML から表だけを取り、許可したタグと属性だけを残す
 * 表が無い、またはサニタイズ後に空なら null。複数の表は改行でつなぐ
 * @param html - サニタイズ前の HTML。表の前後の文章は捨てる
 * @returns サニタイズ済みの表。取り出せなければ null
 */
export function sanitizeHtmlTable(html: string): string | null {
	// 入れ子を含めて取り出した table。無ければ空配列
	const tables = extractTableFragments(html);
	// 表が1件も無ければ null。前後の文章は返さない
	if (tables.length === 0) {
		return null;
	}

	// 空になった断片を除いた表 HTML。全部空なら空配列
	const sanitized = tables.map((fragment) => sanitizeTableFragment(fragment)).filter((fragment) => fragment.length > 0);
	return sanitized.length > 0 ? sanitized.join('\n') : null;
}

/**
 * 文字列の中から、入れ子を含めた table 要素を順に取り出す
 * 閉じタグが釣り合わない表に当たったら、そこで走査を終える
 * @param html - 検索する HTML 全文
 * @returns 表ごとの HTML。1 件も無ければ空
 */
function extractTableFragments(html: string): string[] {
	// 表ごとの HTML。1件も無ければ空
	const fragments: string[] = [];
	// 検索する全文。cursor はこの文字列上の位置
	const source              = html;
	// 次に探す開始位置。文字位置。末尾に達したら終了
	let cursor                = 0;
	while (cursor < source.length) {
		// cursor 以降の `<table` の相対位置。無ければ -1
		const start = source.slice(cursor).search(/<table\b/i);
		// これより後ろに表が無いので走査を終える
		if (start < 0) {
			break;
		}

		// `<table` の開始。文字位置
		const from      = cursor + start;
		// 入れ子が閉じるまでの表。閉じが壊れていれば null
		const extracted = readBalancedTable(source, from);
		// 釣り合わない表に当たったので、そこから先は取らない
		if (!extracted) {
			break;
		}

		fragments.push(extracted.html);
		cursor = extracted.end;
	}

	return fragments;
}

/**
 * 開始位置から、入れ子の深さが 0 に戻るまで table を読む
 * 閉じタグが文書末まで無いときは、残りの文字列を表として返す。開始タグ自体が見つからなければ null
 * @param source - 検索する HTML 全文
 * @param from - `<table` の開始位置
 * @returns html は取り出した表、end はその直後の位置。開始タグが閉じられない形なら null
 */
function readBalancedTable(source: string, from: number): { html: string; end: number } | null {
	// table の入れ子の深さ。0 に戻ったら外側の表が閉じた
	let depth  = 0;
	// 次にタグを探す位置。文字位置
	let cursor = from;
	while (cursor < source.length) {
		// cursor 以降の table 開始または終了の相対位置。無ければ -1
		const next = source.slice(cursor).search(/<\/?table\b/i);
		// これより後ろに table タグが無い。深さが残っていれば末尾までを表にし、最初から深さ 0 なら null
		if (next < 0) {
			// 閉じタグが残りの文書に無い表。深さが 0 のままなら開始タグとして閉じていないので null
			return depth > 0
				? {
					// 開始から文書末までの HTML。閉じタグは含まれない
					html: source.slice(from),
					// 文書末。次の探索はここより先に進まない
					end: source.length
				}
				: null;
		}

		// 見つかった table タグの開始。文字位置
		const index   = cursor + next;
		// そのタグが終了タグなら true。開始なら false
		const isClose = /^<\s*\//.test(source.slice(index));
		// タグを閉じる `>` の位置。無ければ -1
		const tagEnd  = source.indexOf('>', index);
		// `>` が文書末まで無いので、残り全部を表として返す
		if (tagEnd < 0) {
			// `>` が無いので、開始から文書末までを表として返す
			return {
				// 開始から文書末までの HTML
				html: source.slice(from),
				// 文書末。次の探索はここより先に進まない
				end: source.length
			};
		}

		// 終了タグなら深さを1段戻す。0 以下になったら外側の表が閉じた
		if (isClose) {
			depth -= 1;
			cursor = tagEnd + 1;
			// 外側の table が閉じたので、開始からこの終了タグの直後までを表にする
			if (depth <= 0) {
				// 外側の表が閉じた範囲。終了タグの直後まで
				return {
					// 開始から、この終了タグの直後まで
					html: source.slice(from, cursor),
					// 終了タグの直後。次の表はここから探す
					end: cursor
				};
			}
		} else {
			depth += 1;
			cursor = tagEnd + 1;
		}
	}

	// 文書末まで深さ 0 に戻らなかった表。残り全部を1件にする
	return {
		// 開始から文書末までの HTML
		html: source.slice(from),
		// 文書末。次の探索はここより先に進まない
		end: source.length
	};
}

// ----------------------------------------------
// 断片のサニタイズ
// ----------------------------------------------

/**
 * 1 つの表から、コメントと不許可の中身を除いた HTML を返す
 * 不許可タグは終了までスキップし、テキストはエスケープして残す
 * @param fragment - 1 つの table 要素の HTML
 * @returns 許可タグだけをつないだ文字列。空なら空文字
 */
function sanitizeTableFragment(fragment: string): string {
	// コメント、タグ、テキストの断片。一致が無ければ空配列
	const tokens              = fragment.match(TOKEN_PATTERN) ?? [];
	// 書き戻す HTML 片。不許可の中身は入れない
	const parts: string[]     = [];
	// 中身ごと落とすタグ名。空ならテキストも残す
	const skipStack: string[] = [];

	for (const token of tokens) {
		// HTML コメントは表に残さない
		if (token.startsWith('<!--')) {
			continue;
		}

		// 終了タグの一致。終了タグでなければ null
		const close = CLOSE_TAG_PATTERN.exec(token.trim());
		// 終了タグは、落とす範囲の終わりか、許可タグの閉じとして書く
		if (close) {
			// 小文字の終了タグ名
			const name = close[1]!.toLowerCase();
			// 落とす範囲の内側では、対応する終了まで文字を書かない
			if (skipStack.length > 0) {
				// 落とす範囲の終了タグなら、その1段だけを戻す。違う名前の終了では深さを変えない
				if (skipStack[skipStack.length - 1] === name) {
					skipStack.pop();
				}

				continue;
			}

			// 表の構造か許可インラインなら閉じタグを残す。どちらでもなければ捨てる
			if (TABLE_TAGS.has(name) || ALLOWED_HTML_TAGS.has(name)) {
				parts.push(`</${name}>`);
			}

			continue;
		}

		// 開始タグの一致。自己閉じの末尾は照合前に除く。開始でなければ null
		const open = OPEN_TAG_PATTERN.exec(token.trim().replace(/\/\s*>$/, '>'));
		// 開始タグは、落とすか、許可属性だけを残して書く
		if (open) {
			// 小文字の開始タグ名
			const name = open[1]!.toLowerCase();
			// 落とす範囲の内側では書き出さず、入れ子の開始だけ深さを増やす
			if (skipStack.length > 0) {
				// void でなく、かつ自己閉じでもないときだけ深さを増やす。どちらか一方でも増やさない
				if (!VOID_TAGS.has(name) && !token.trim().endsWith('/>')) {
					skipStack.push(name);
				}

				continue;
			}

			// script や style などはタグも中身も落とす
			if (DROP_WITH_CONTENT.has(name)) {
				// void でなく、かつ自己閉じでもないときだけ、中身を落とす深さを増やす
				if (!VOID_TAGS.has(name) && !token.trim().endsWith('/>')) {
					skipStack.push(name);
				}

				continue;
			}

			// 表でも許可インラインでもない開始は中身ごと落とす。どちらか一方に該当すればこの分岐には入らない
			if (!TABLE_TAGS.has(name) && !ALLOWED_HTML_TAGS.has(name)) {
				// void でなく、かつ自己閉じでもないときだけ深さを増やす
				if (!VOID_TAGS.has(name) && !token.trim().endsWith('/>')) {
					skipStack.push(name);
				}

				continue;
			}

			// 残してよい属性だけの文字列。残らなければ空文字。先頭に空白が付く
			const attrs = sanitizeTableAttributes(name, parseAttributes(open[2] ?? ''));
			// 自己閉じの印。void でも末尾スラッシュでも、書き戻す文字は空のまま
			const slash = VOID_TAGS.has(name) || token.trim().endsWith('/>') ? '' : '';
			parts.push(`<${name}${attrs}${slash}>`);
			continue;
		}

		// 落とす範囲の外のテキストだけをエスケープして残す。範囲内のテキストは捨てる
		if (skipStack.length === 0) {
			parts.push(escapeHtmlText(token));
		}
	}

	return parts.join('').trim();
}

/**
 * 開始タグの属性文字列を、名前から値への対応へ分ける
 * 共有の ATTR_PATTERN は lastIndex を持つため、走査前に 0 へ戻す
 * @param attributeText - タグ名より後ろの属性部分。末尾のスラッシュは無視する
 * @returns 属性名から値への対応。属性が無ければ空
 */
function parseAttributes(attributeText: string): Record<string, string> {
	// 属性名から値。無ければ空
	const attributes: Record<string, string> = {};
	// 末尾の自己閉じスラッシュを除いた属性部分。空白だけなら空文字
	const text                               = attributeText.trim().replace(/\/\s*$/, '');
	ATTR_PATTERN.lastIndex                   = 0;
	// 次の属性の一致。無ければ null で走査を終える
	let match: RegExpExecArray | null        = ATTR_PATTERN.exec(text);
	while (match) {
		// 一致した属性名。空や単独の `/` は属性にしない
		const name = match[1];
		// 名前があり、かつ自己閉じのスラッシュでないときだけ値を入れる。どちらか一方が欠けても入れない
		if (name && name !== '/') {
			attributes[name] = match[2] ?? match[3] ?? match[4] ?? '';
		}

		match = ATTR_PATTERN.exec(text);
	}

	return attributes;
}

/**
 * 表タグに残してよい属性だけを、HTML 属性文字列へ戻す
 * colspan と rowspan は td と th の 1 より大きい整数だけを残す
 * @param tagName - 小文字のタグ名。結合属性を残すかの判定に使う
 * @param attributes - パース直後の属性。危険な style と class はここで落とす
 * @returns 先頭に空白を付けた属性列。残る属性が無ければ空文字
 */
function sanitizeTableAttributes(tagName: string, attributes: Record<string, string>): string {
	// 書き戻す属性片。先頭に空白付き。残らなければ空配列で、結合は空文字
	const parts: string[] = [];
	for (const [rawName, rawValue] of Object.entries(attributes)) {
		// 小文字の属性名
		const name = rawName.toLowerCase();
		// style は危険な宣言を除いてから属性に戻す
		if (name === 'style') {
			// 残った style。すべて危険なら空文字
			const style = sanitizeStyleValue(rawValue);
			// 残った宣言があるときだけ style 属性を書く
			if (style) {
				parts.push(` style="${escapeAttribute(style)}"`);
			}

			continue;
		}

		// class は安全なトークンだけを属性に戻す
		if (name === 'class') {
			// 残ったクラス。無ければ空文字
			const className = sanitizeClassValue(rawValue);
			// 残ったクラスがあるときだけ class 属性を書く
			if (className) {
				parts.push(` class="${escapeAttribute(className)}"`);
			}

			continue;
		}

		// colspan と rowspan は、td か th のときだけ見る。属性名が対象外、またはセル以外では入らない
		if (TABLE_ONLY_ATTRIBUTES.has(name) && (tagName === 'td' || tagName === 'th')) {
			// 10進の結合数。数値でなければ NaN
			const value = Number.parseInt(rawValue, 10);
			// 有限で、かつ 1 より大きいときだけ結合数を書く。どちらか一方が欠けても落とす
			if (Number.isFinite(value) && value > 1) {
				parts.push(` ${name}="${value}"`);
			}
		}
	}

	return parts.join('');
}

// ----------------------------------------------
// テキストのエスケープ
// ----------------------------------------------

/**
 * 表のテキストノードに残す文字列をエスケープする
 * 引用符はテキストでは変換しない
 * @param value - タグ以外のテキスト
 * @returns `&`、`<`、`>` を実体参照へ置き換えた文字列
 */
function escapeHtmlText(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * 属性値に残す文字列をエスケープする
 * テキスト用の変換に加え、二重引用符も実体参照にする
 * @param value - 引用符で囲む前の属性値
 * @returns 属性値として安全な文字列
 */
function escapeAttribute(value: string): string {
	return escapeHtmlText(value).replaceAll('"', '&quot;');
}
