/**
 * 画像ウィジェットの幅を、対応する WikiEmbed または Image 記法へ書き戻す
 * 表示用の DOM は持たず、渡された EditorView の文書だけを更新する
 * @file
 */
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { formatMarkdownImage, formatWikiEmbed, splitImageAlt, splitWikiEmbedTarget } from './imageSize';

/** 幅を書き戻す画像記法の種類。Wiki 埋め込みと標準画像を区別する */
export type ImageMarkupKind = 'WikiEmbed' | 'Image';

/** 文書上の画像記法の範囲。幅の置換はこの区間だけを変える */
export type ImageMarkupRange = {
	/** 記法の開始位置 */
	from: number;
	/** 記法の終端 */
	to: number;
	/** WikiEmbed か Image */
	kind: ImageMarkupKind;
};

/**
 * 指定位置の画像記法へ表示幅を書き戻す
 * @param view - エディタ
 * @param pos - 画像ウィジェット位置
 * @param width - 幅（px）
 * @param end - 記法の終了位置。省略可
 * @returns 更新したか
 */
export function applyImageDisplayWidth(view: EditorView, pos: number, width: number, end?: number): boolean {
	// 下限 24px へ丸めた幅。0 や負はここに来ない
	const rounded = Math.max(24, Math.round(width));
	ensureSyntaxTree(view.state, view.state.doc.length, 200);
	// 位置にある画像記法。無ければ null
	const markup = findImageMarkupAt(view.state, pos, end);
	// 記法が無い位置は書き戻さない
	if (!markup) {
		return false;
	}

	// 記法の原文。組み立て結果と同じなら dispatch しない
	const text        = view.state.sliceDoc(markup.from, markup.to);
	// 表の中なら true。セルの `|` を割らない区切りにする
	const escapePipe  = isInsideTable(view.state, markup.from);
	// 記法組み立てへ渡す区切り。表セルだけ `\|` にする
	const sizeOptions = { escapePipe };
	// 幅を入れた記法。Wiki と標準画像のどちらでも、組み立て前は空文字
	let insert        = '';
	// Wiki 埋め込みだけ両端の括弧を確認する。標準画像は別の形
	if (markup.kind === 'WikiEmbed') {
		// 先頭が `![[` でなく、または末尾が `]]` でないときは書き戻さない。どちらか一方でも false
		if (!text.startsWith('![[') || !text.endsWith(']]')) {
			return false;
		}

		// サイズを除いた埋め込みパス
		const { path } = splitWikiEmbedTarget(text.slice(3, -2));
		insert         = formatWikiEmbed(path, rounded, sizeOptions);
	} else {
		// `](` の位置。標準画像の形でなければ -1
		const closeAlt = text.indexOf('](');
		// 先頭、区切り、末尾のどれかが欠けると標準画像にしない。どれか一つが欠けても false
		if (!text.startsWith('![') || closeAlt < 0 || !text.endsWith(')')) {
			return false;
		}

		// alt 全体。サイズ指定を含むことがある
		const alt           = text.slice(2, closeAlt);
		// 画像の URL またはパス
		const url           = text.slice(closeAlt + 2, -1);
		// サイズを除いた alt。空でもよい
		const { alt: name } = splitImageAlt(alt);
		insert              = formatMarkdownImage(name, url, rounded, sizeOptions);
	}

	// 組み立て結果が原文と同じなら文書を変えない
	if (insert === text) {
		return false;
	}

	// 記法の区間だけを幅付きへ置き換える
	view.dispatch({
		// 置き換える区間と、幅を入れた記法
		changes: {
			// 記法の開始
			from: markup.from,
			// 記法の終端
			to: markup.to,
			// 幅を入れた記法
			insert
		},
		// この更新の由来。画像幅の書き戻し
		userEvent: 'input.imageResize'
	});
	return true;
}

/**
 * 行テキストだけを見て画像幅を書き戻す
 * 表の構文木が未完成でも、セルの `|` を増やさずに `\|幅` を残せる
 * @param view - エディタ
 * @param pos - 画像位置
 * @param width - 幅（px）
 * @returns 更新したか
 */
export function applyImageWidthOnDocumentLine(view: EditorView, pos: number, width: number): boolean {
	// 文書内に収めた位置
	const clamped = Math.max(0, Math.min(pos, view.state.doc.length));
	// 位置が属する行。表の未完成行でもこのテキストを見る
	const line    = view.state.doc.lineAt(clamped);
	// 行内の先頭画像へ幅を入れた行。画像が無ければ null
	const insert  = replaceImageWidthInCellText(line.text, width, /^\s*\|/.test(line.text));
	// 画像が無い、または幅が同じ行は書き戻さない。どちらか一方でも false
	if (insert === null || insert === line.text) {
		return false;
	}

	// 行全体を、幅を入れたテキストへ置き換える
	view.dispatch({
		// 行の区間と、幅を入れた行
		changes: {
			// 行の開始
			from: line.from,
			// 行の終端
			to: line.to,
			// 幅を入れた行
			insert
		},
		// この更新の由来。画像幅の書き戻し
		userEvent: 'input.imageResize'
	});
	return true;
}

/**
 * パスを比較用に正規化する
 * @param path - 画像パス
 * @returns パスを比較用に正規化する
 */
export function normalizeImagePathKey(path: string): string {
	return path.trim().replaceAll('/', '\\').toLowerCase();
}

/**
 * 文書内の画像パスを探して幅を書き戻す
 * 表セルでは列が割れないよう `\|幅` にする
 * @param view - エディタ
 * @param path - 画像パス
 * @param width - 幅（px）
 * @param hintPos - 優先する文書位置。省略可
 * @returns 更新したか
 */
export function applyImageWidthByPath(view: EditorView, path: string, width: number, hintPos?: number): boolean {
	// 前後空白を除いたパス。空なら探さない
	const pathKey = path.trim();
	// パスが空の画像は文書内を探さない
	if (!pathKey) {
		return false;
	}

	// 下限 24px へ丸めた幅
	const rounded                                   = Math.max(24, Math.round(width));
	// 比較用に揃えたパス。区切りと大文字は無視する
	const wanted                                    = normalizeImagePathKey(pathKey);
	// 文書全文。Wiki 埋め込みを順に見る
	const doc                                       = view.state.doc.toString();
	// `![[...]]` を探す正規表現。改行をまたいでよい
	const wiki                                      = /!\[\[([\s\S]*?)\]\]/g;
	// 最初の一致。無ければ null
	let match                                       = wiki.exec(doc);
	// 書き戻す区間。ヒント位置を含むものを優先し、無ければ最初の一致
	let chosen: { from: number; to: number } | null = null;
	while (match) {
		// サイズを除いた埋め込みパス
		const { path: embedPath } = splitWikiEmbedTarget(match[1] ?? '');
		// パスが違う埋め込みは次へ進む
		if (normalizeImagePathKey(embedPath) !== wanted) {
			match = wiki.exec(doc);
			continue;
		}

		// 記法の開始
		const from         = match.index;
		// 記法の終端
		const to           = from + match[0].length;
		// ヒント位置がこの記法に入るか。ヒントが無ければ false
		const containsHint = hintPos !== undefined && Number.isFinite(hintPos) && hintPos >= from && hintPos <= to;
		// ヒントを含む記法は、それだけで書き戻し先に決める
		if (containsHint) {
			// ヒントを含む記法の区間
			chosen = {
				// 記法の開始
				from,
				// 記法の終端
				to
			};
			break;
		}

		// まだ候補が無いときだけ、最初の一致を控える
		if (!chosen) {
			// 最初にパスが一致した記法
			chosen = {
				// 記法の開始
				from,
				// 記法の終端
				to
			};
		}

		match = wiki.exec(doc);
	}

	// 同じパスの埋め込みが無いときは書き戻さない
	if (!chosen) {
		return false;
	}

	// 選んだ記法の原文
	const text       = doc.slice(chosen.from, chosen.to);
	// 記法が属する行。行頭の `|` で表セルかを見る
	const line       = view.state.doc.lineAt(chosen.from);
	// 行頭が `|` なら表セル。区切りを `\|` にする
	const escapePipe = /^\s*\|/.test(line.text);
	// 先頭か末尾が Wiki 埋め込みでない原文は書き戻さない。どちらか一方でも false
	if (!text.startsWith('![[') || !text.endsWith(']]')) {
		return false;
	}

	// サイズを除いたパス
	const { path: embedPath } = splitWikiEmbedTarget(text.slice(3, -2));
	// 幅を入れた埋め込み
	const insert              = formatWikiEmbed(embedPath, rounded, { escapePipe });
	// 組み立て結果が原文と同じなら文書を変えない
	if (insert === text) {
		return false;
	}

	// 選んだ記法だけを幅付きへ置き換える
	view.dispatch({
		// 記法の区間と、幅を入れた埋め込み
		changes: {
			// 記法の開始
			from: chosen.from,
			// 記法の終端
			to: chosen.to,
			// 幅を入れた埋め込み
			insert
		},
		// この更新の由来。画像幅の書き戻し
		userEvent: 'input.imageResize'
	});
	return true;
}

/**
 * 文書位置にある画像記法の範囲を返す
 * @param state - 状態
 * @param pos - 開始位置
 * @param end - 終了位置。省略可
 * @returns 文書位置にある画像記法の範囲
 */
export function findImageMarkupAt(state: EditorState, pos: number, end?: number): ImageMarkupRange | null {
	// 文書内に収めた開始位置
	const from = Math.max(0, Math.min(pos, state.doc.length));
	// 終了位置が開始より後ろの有限値のときだけ、その区間を先に見る。どれか一つが欠けても木を見る
	if (end !== undefined && Number.isFinite(end) && end > from) {
		// 区間の記法種別。画像でなければ null
		const exact = classifyImageMarkup(state.sliceDoc(from, Math.min(end, state.doc.length)));
		// 区間そのものが画像記法なら、その範囲を返す
		if (exact) {
			// 渡された区間の画像記法
			return {
				// 収めた開始位置
				from,
				// 文書内に収めた終了位置
				to: Math.min(end, state.doc.length),
				// WikiEmbed か Image
				kind: exact
			};
		}
	}

	// 構文木で見つかった画像。無ければ null
	const fromTree = findImageMarkupInTree(state, from);
	// 木で見つかったときは行スキャンをしない
	if (fromTree) {
		return fromTree;
	}

	return scanImageMarkupOnLine(state, from);
}

/**
 * 記法文字列の種別を返す
 * @param text - 記法
 * @returns 記法文字列の種別
 */
function classifyImageMarkup(text: string): ImageMarkupKind | null {
	// 両端が Wiki 括弧で、中身があるときだけ埋め込みにする。どれか一つが欠けても次へ進む
	if (text.startsWith('![[') && text.endsWith(']]') && text.length > 5) {
		return 'WikiEmbed';
	}

	// `](` の位置。標準画像の形でなければ -1
	const closeAlt = text.indexOf('](');
	// 先頭、区切り、末尾が揃ったときだけ標準画像にする。どれか一つが欠けても null
	if (text.startsWith('![') && closeAlt >= 0 && text.endsWith(')')) {
		return 'Image';
	}

	return null;
}

/**
 * 構文木から画像記法を探す
 * @param state - 状態
 * @param pos - 位置
 * @returns 構文木から画像記法。無ければ null
 */
function findImageMarkupInTree(state: EditorState, pos: number): ImageMarkupRange | null {
	// 位置の内側のノード。画像まで親を辿る
	let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
	while (node && node.name !== 'WikiEmbed' && node.name !== 'Image') {
		node = node.parent;
	}

	// 辿り切っても画像ノードでなければ範囲にしない。どちらか一方でも null
	if (!node || (node.name !== 'WikiEmbed' && node.name !== 'Image')) {
		return null;
	}

	// 構文木上の画像記法
	return {
		// 記法の開始
		from: node.from,
		// 記法の終端
		to: node.to,
		// WikiEmbed か Image。ノード名と同じ
		kind: node.name
	};
}

/**
 * 行内の `![[ ]]` / `![]()` を探す
 * @param state - 状態
 * @param pos - 位置
 * @returns 行内の `![[ ]]` / `![]()` 。無ければ null
 */
function scanImageMarkupOnLine(state: EditorState, pos: number): ImageMarkupRange | null {
	// 位置が属する行
	const line = state.doc.lineAt(pos);
	// 行内の Wiki 埋め込み。改行をまたいでよい
	const wiki = /!\[\[[\s\S]*?\]\]/g;
	// 最初の埋め込み。無ければ null
	let match  = wiki.exec(line.text);
	while (match) {
		// 埋め込みの文書上の開始
		const from = line.from + match.index;
		// 埋め込みの文書上の終端
		const to   = from + match[0].length;
		// 位置がこの埋め込みに入るときだけ、その範囲を返す
		if (pos >= from && pos <= to) {
			// 行スキャンで見つかった Wiki 埋め込み
			return {
				// 記法の開始
				from,
				// 記法の終端
				to,
				// Wiki 埋め込み
				kind: 'WikiEmbed'
			};
		}

		match = wiki.exec(line.text);
	}

	// 行内の標準画像
	const markdown = /!\[[^\]]*\]\([^)]+\)/g;
	match          = markdown.exec(line.text);
	while (match) {
		// 標準画像の文書上の開始
		const from = line.from + match.index;
		// 標準画像の文書上の終端
		const to   = from + match[0].length;
		// 位置がこの画像に入るときだけ、その範囲を返す
		if (pos >= from && pos <= to) {
			// 行スキャンで見つかった標準画像
			return {
				// 記法の開始
				from,
				// 記法の終端
				to,
				// 標準画像
				kind: 'Image'
			};
		}

		match = markdown.exec(line.text);
	}

	return null;
}

/**
 * 指定位置が GFM 表の中か判定する
 * @param state - 状態
 * @param pos - 位置
 * @returns 指定位置が GFM 表の中なら true
 */
function isInsideTable(state: EditorState, pos: number): boolean {
	// 位置の内側のノード。表まで親を辿る
	let current: SyntaxNode | null = syntaxTree(state).resolveInner(Math.min(pos, state.doc.length), 1);
	while (current) {
		// 表ノードに当たった位置はセル内として扱う
		if (current.name === 'Table') {
			return true;
		}

		current = current.parent;
	}

	return /^\s*\|/.test(state.doc.lineAt(pos).text);
}

/**
 * セル文字列内の先頭画像へ表示幅を書き戻した文字列を返す
 * @param text - セルソース
 * @param width - 幅（px）
 * @param escapePipe - 表セルなら `\|`。省略可
 * @returns 変更後。画像が無ければ null
 */
export function replaceImageWidthInCellText(text: string, width: number, escapePipe: boolean = true): string | null {
	// 下限 24px へ丸めた幅
	const rounded     = Math.max(24, Math.round(width));
	// 組み立てへ渡す区切り。表セルなら `\|`
	const sizeOptions = { escapePipe };
	// セル内の最初の Wiki 埋め込み
	const wiki        = /!\[\[[\s\S]*?\]\]/;
	// 最初の一致。無ければ null
	const wikiMatch   = wiki.exec(text);
	// Wiki 埋め込みがあるセルは、その区間だけ幅を入れ替える
	if (wikiMatch) {
		// サイズを除いたパス
		const { path } = splitWikiEmbedTarget(wikiMatch[0].slice(3, -2));
		// 幅を入れた埋め込み
		const insert   = formatWikiEmbed(path, rounded, sizeOptions);
		return `${text.slice(0, wikiMatch.index)}${insert}${text.slice(wikiMatch.index + wikiMatch[0].length)}`;
	}

	// セル内の最初の標準画像
	const markdown      = /!\[[^\]]*\]\([^)]+\)/;
	// 最初の一致。無ければ null
	const markdownMatch = markdown.exec(text);
	// 標準画像も無いセルは幅を書き戻さない
	if (!markdownMatch) {
		return null;
	}

	// 一致した記法の原文
	const raw      = markdownMatch[0];
	// `](` の位置。形が崩れていれば -1
	const closeAlt = raw.indexOf('](');
	// 区切りが無い記法は標準画像にしない
	if (closeAlt < 0) {
		return null;
	}

	// サイズを除いた alt
	const { alt: name } = splitImageAlt(raw.slice(2, closeAlt));
	// 幅を入れた標準画像
	const insert        = formatMarkdownImage(name, raw.slice(closeAlt + 2, -1), rounded, sizeOptions);
	return `${text.slice(0, markdownMatch.index)}${insert}${text.slice(markdownMatch.index + raw.length)}`;
}
