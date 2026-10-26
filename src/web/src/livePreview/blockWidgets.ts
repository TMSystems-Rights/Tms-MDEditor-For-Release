/**
 * 表、画像、Mermaid、HTML 表を、プレビュー行のウィジェット装飾へ集める
 * エディタ状態は持たず、各ウィジェットの生成は対応するモジュールへ渡す
 * @file
 */
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { collectSourceLineNumbers, isPreviewLineNumber } from './cursorLine';
import { documentContextFacet } from './documentContext';
import { classifyImageSource, pushImageReplace, type ImageSpec } from './imageWidget';
import { splitImageAlt, splitWikiEmbedTarget } from './imageSize';
import type { DecorationEntry } from './inlineDecorations';
import { extractFencedCodeText, isMermaidFencedCode, pushMermaidReplace } from './mermaidWidget';
import { extractTableData, pushTableReplace } from './tableWidget';
import { isHtmlTableBlock } from './htmlTable';
import { pushHtmlTableReplace } from './htmlTableWidget';

// ----------------------------------------------
// 範囲と画像記法の読み取り
// ----------------------------------------------

/**
 * ノード範囲のすべての行がプレビュー行かを判定する
 * 1 行でもソース表示なら、ブロック全体をウィジェットにしない
 * @param state - 行境界を読むエディタ状態
 * @param from - 範囲の開始位置。この位置の行から見る
 * @param to - 範囲の終端。終端ちょうどは手前の行までを見る
 * @param sourceLineNumbers - ソース表示の行番号。1 始まり
 * @returns 範囲内の全行がプレビューなら true
 */
function isFullyPreviewRange(state: EditorState, from: number, to: number, sourceLineNumbers: Set<number>): boolean {
	// 範囲が始まる行番号。1始まり
	const startLine = state.doc.lineAt(from).number;
	// 終端の直前が属する行番号。1始まり。終端が開始と同じときは開始行
	const endLine   = state.doc.lineAt(Math.max(from, to - 1)).number;
	for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
		// 1行でもソース表示なら、ブロック全体をウィジェットにしない
		if (!isPreviewLineNumber(lineNumber, sourceLineNumbers)) {
			return false;
		}
	}

	return true;
}

/**
 * Image ノードから alt と URL を取り出す
 * 開きと閉じの LinkMark が 2 つ無ければ alt は空。URL ノードが無ければ url は空
 * @param state - ノード範囲の文字列を読むエディタ状態
 * @param imageNode - alt と URL を含む Image ノード
 * @returns alt はサイズ指定を含み得る文面、url はトリム済みの参照
 */
export function extractImageAltAndUrl(state: EditorState, imageNode: SyntaxNode): { alt: string; url: string } {
	// トリム済みの参照。URL ノードが無ければ空文字
	let url      = '';
	// alt の開始。開き LinkMark が無ければ画像の開始位置のまま
	let altStart = imageNode.from;
	// alt の終端。閉じが無ければ開始位置のままで、切り出した alt は空になる
	let altEnd   = imageNode.from;

	// ![alt](url) → LinkMark(![) ... LinkMark(]) LinkMark(() URL LinkMark())
	// 開きと閉じの LinkMark が2つ揃ったときだけ true。揃わなければ alt は空
	let afterOpen                                    = false;
	// 子の LinkMark の範囲。2つ未満なら alt の境界に使わない
	const marks: Array<{ from: number; to: number }> = [];

	imageNode.cursor().iterate((child) => {
		// URL ノードの中身を参照として採用する。同じ子の他の役割は見ない
		if (child.name === 'URL') {
			url = state.doc.sliceString(child.from, child.to).trim();
			return;
		}

		// 括弧の位置を順に積む。2つ目までが alt の境界になる
		if (child.name === 'LinkMark') {
			// この括弧の文書上の範囲
			marks.push({
				// 括弧の開始。文書上の文字位置
				from: child.from,
				// 括弧の終端。文書上の文字位置
				to: child.to
			});
		}
	});

	// 開きと閉じが両方あるときだけ alt の範囲を切る。1つ以下では alt は空
	if (marks.length >= 2) {
		// 最初の LinkMark。通常は `![`
		const open  = marks[0]!;
		// 2つ目の LinkMark。通常は `]`
		const close = marks[1]!;
		afterOpen   = true;
		altStart    = open.to;
		altEnd      = close.from;
	}

	// サイズ指定を含み得る alt。開きと閉じが無ければ空文字
	const alt = afterOpen ? state.doc.sliceString(altStart, altEnd) : '';

	// 呼び出し側へ返す alt と参照。URL が空でも alt は返す
	return {
		// サイズ指定を含み得る文面。境界が無ければ空文字
		alt,
		// トリム済みの参照。URL ノードが無ければ空文字
		url
	};
}

/**
 * WikiEmbed から、サイズ指定を含み得るパスを取り出す
 * WikiEmbedPath が無ければ空文字を返す
 * @param state - ノード範囲の文字列を読むエディタ状態
 * @param node - パスを含む WikiEmbed ノード
 * @returns トリム済みのパス。見つからなければ空文字
 */
export function extractWikiEmbedPath(state: EditorState, node: SyntaxNode): string {
	// トリム済みの埋め込みパス。WikiEmbedPath が無ければ空文字
	let path = '';
	node.cursor().iterate((child) => {
		// パスノードの中身だけを採用する。他の子はパスにしない
		if (child.name === 'WikiEmbedPath') {
			path = state.doc.sliceString(child.from, child.to).trim();
		}
	});
	return path;
}

// ----------------------------------------------
// ブロック装飾の収集
// ----------------------------------------------

/**
 * 表、画像、Mermaid、HTML 表のウィジェット装飾を集める
 * 画像のパス解決に必要な文脈は documentContextFacet から読む。状態は変えない
 * @param state - 構文木と文書文脈を読むエディタ状態
 * @param sourceLineNumbers - ソース表示の行番号。省略時は選択から作る
 * @returns ブロックウィジェットの装飾。空の表やソース行の画像は含めない
 */
export function collectBlockDecorationEntries(state: EditorState, sourceLineNumbers: Set<number> = collectSourceLineNumbers(state)): DecorationEntry[] {
	// ブロックウィジェットの装飾。空の表やソース行の画像は含めない
	const entries: DecorationEntry[] = [];
	// 画像のパス解決に使う文書文脈。未保存なら filePath は null
	const context                    = state.facet(documentContextFacet);

	syntaxTree(state).iterate({
		/**
		 * 表、画像、Mermaid、HTML 表を装飾へ置き、対象にしたノードの子は走査しない
		 * @param ref - 構文木のノード。name で種別、from と to で文書上の範囲を見る
		 * @returns 子を走査しないとき false。対象外は undefined
		 */
		enter(ref) {
			// フェンスコードは Mermaid のときだけウィジェットにし、中の子は走査しない
			if (ref.name === 'FencedCode') {
				// Mermaid でないフェンスは置き換えず、中も走査しない
				if (!isMermaidFencedCode(state, ref.node)) {
					return false;
				}

				// 1行でもソース表示なら、Mermaid ウィジェットにしない
				if (!isFullyPreviewRange(state, ref.from, ref.to, sourceLineNumbers)) {
					return false;
				}

				// 描画する Mermaid ソース。情報文字列の行は含めない
				const source = extractFencedCodeText(state, ref.node);
				pushMermaidReplace(entries, ref.from, ref.to, source);
				return false;
			}

			// HTML ブロックは表のときだけウィジェットにする
			if (ref.name === 'HTMLBlock') {
				// ブロック全体の HTML。表でなければウィジェットにしない
				const raw = state.doc.sliceString(ref.from, ref.to);
				// 表でない、またはソース行が混ざるときは置き換えない。どちらか一方でも子の走査は止める
				if (!isHtmlTableBlock(raw) || !isFullyPreviewRange(state, ref.from, ref.to, sourceLineNumbers)) {
					return false;
				}

				pushHtmlTableReplace(entries, ref.from, ref.to, raw);
				return false;
			}

			// Markdown 表は中身を取り出してウィジェットにする
			if (ref.name === 'Table') {
				// 表のヘッダと行。両方空なら表として描かない
				const data = extractTableData(state, ref.node);
				// ヘッダと行が両方空のときだけ表にしない。どちらか一方にセルがあれば描く
				if (data.headers.length === 0 && data.rows.length === 0) {
					return false;
				}

				pushTableReplace(entries, ref.from, ref.to, data);
				return false;
			}

			// 標準画像は、プレビュー行で参照があるときだけウィジェットにする
			if (ref.name === 'Image') {
				// 画像の開始行。1始まり
				const lineNumber = state.doc.lineAt(ref.from).number;
				// ソース表示の行は記法のまま残す
				if (!isPreviewLineNumber(lineNumber, sourceLineNumbers)) {
					return false;
				}

				// サイズ指定を含み得る alt と、トリム済みの参照。参照が無ければ url は空
				const { alt, url } = extractImageAltAndUrl(state, ref.node);
				// 参照が空の画像はウィジェットにしない
				if (!url) {
					return false;
				}

				// サイズを除いた alt と、解釈した幅と高さ。サイズが無ければ幅も高さも null
				const { alt: altText, size } = splitImageAlt(alt);
				// 参照の種別。リモート URL、絶対パス、相対パスのいずれか
				const kind                   = classifyImageSource(url);
				// ウィジェットへ渡す画像。パスの実体解決は imageWidget 側
				const spec: ImageSpec        = {
					// サイズを除いた alt。空文字でもそのまま渡す
					alt: altText,
					// 記法上の参照。トリム済み。空ではここに来ない
					raw: url,
					// 参照の種別。リモートかどうかの判定に使う
					kind,
					// 開いているノートの絶対パス。未保存なら null で相対パスは解決しない
					documentPath: context.filePath,
					// リモート画像を読むか。false のときはリモート URL を解決しない
					loadRemoteImages: context.loadRemoteImages,
					// 表示幅（px）。指定が無ければ null
					width: size.width,
					// 表示高さ（px）。幅だけなら null
					height: size.height
				};
				pushImageReplace(entries, ref.from, ref.to, spec);
				return false;
			}

			// 埋め込み画像は、プレビュー行でパスがあるときだけウィジェットにする
			if (ref.name === 'WikiEmbed') {
				// 埋め込みの開始行。1始まり
				const lineNumber = state.doc.lineAt(ref.from).number;
				// ソース表示の行は記法のまま残す
				if (!isPreviewLineNumber(lineNumber, sourceLineNumbers)) {
					return false;
				}

				// サイズ指定を含み得るパス。パスノードが無ければ空文字
				const rawPath = extractWikiEmbedPath(state, ref.node);
				// パスが空の埋め込みはウィジェットにしない
				if (!rawPath) {
					return false;
				}

				// サイズを除いたパスと、解釈した幅と高さ。サイズが無ければ幅も高さも null
				const { path, size }  = splitWikiEmbedTarget(rawPath);
				// 埋め込みとして渡す画像。種別は常に embed
				const spec: ImageSpec = {
					// 表示に使うパス。サイズ指定は含めない
					alt: path,
					// 解決するパス。サイズ指定は含めない
					raw: path,
					// 埋め込み記法。URL 分類はせず embed 固定
					kind: 'embed',
					// 開いているノートの絶対パス。未保存なら null
					documentPath: context.filePath,
					// リモート画像を読むか。埋め込みパス自体はローカル解決
					loadRemoteImages: context.loadRemoteImages,
					// 表示幅（px）。指定が無ければ null
					width: size.width,
					// 表示高さ（px）。幅だけなら null
					height: size.height
				};
				pushImageReplace(entries, ref.from, ref.to, spec);
				return false;
			}
		}
	});

	return entries;
}
