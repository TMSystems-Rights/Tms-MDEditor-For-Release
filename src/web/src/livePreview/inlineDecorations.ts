/**
 * インライン記法のマークを隠し、強調やリンクの範囲へ mark を付ける
 * エディタ状態は持たず、選択が記法にかかっている範囲はソースのまま残す
 * @file
 */
import { Decoration, type DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { type EditorState, RangeSetBuilder } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { collectInlineCodeContentRanges, parseInlineCodeLanguagePrefix, resolveCodeLanguage } from '../editor/codeLanguage';
import { selectionIntersectsRange } from './cursorLine';
import { pushHiddenReplace } from './hiddenContent';
import { splitWikiLinkAlias } from './wikiLink';

// ----------------------------------------------
// 対象にする構文
// ----------------------------------------------
/** 隠す記法トークンのノード名。実行中は変えない */
const MARK_NODE_NAMES = new Set(['EmphasisMark', 'CodeMark', 'LinkMark', 'StrikethroughMark', 'HighlightMark', 'WikiLinkMark']);

/** 中身へ mark を付けるインラインノード名。実行中は変えない */
const CONTAINER_NODE_NAMES = new Set(['Emphasis', 'StrongEmphasis', 'Strikethrough', 'Highlight', 'Link', 'WikiLink', 'InlineCode']);

/** 文書範囲と、そこへ付ける Decoration。コレクタの共通の戻り */
type DecorationEntry = {
	/** 装飾の開始位置 */
	from: number;
	/** 装飾の終端。点装飾では from と同じ */
	to: number;
	/** その範囲へ付ける CodeMirror の装飾 */
	decoration: Decoration;
};

export type { DecorationEntry };

/**
 * Link ノードから URL 文字列を取得する
 * @param state - エディタ状態
 * @param linkNode - Link ノード
 * @returns Link ノードから URL 文字列
 */
export function extractLinkUrl(state: EditorState, linkNode: SyntaxNode): string {
	// URL ノードの文字列。ノードが無ければ空文字で、戻り値も空
	let url = '';
	linkNode.cursor().iterate((child) => {
		// URL ノードの中身を参照として採用する。他の子は URL にしない
		if (child.name === 'URL') {
			url = state.doc.sliceString(child.from, child.to);
		}
	});
	return url.trim();
}

/**
 * Link ノードの表示文字範囲を取得する
 * @param linkNode - Link ノード
 * @returns Link ノードの表示文字範囲
 */
export function collectLinkLabelRanges(linkNode: SyntaxNode): Array<{ from: number; to: number }> {
	// 括弧の範囲。2つ未満、または開きが閉じ以上ならラベルは空
	const linkMarks: Array<{ from: number; to: number }> = [];
	linkNode.cursor().iterate((child) => {
		// 括弧の位置を順に積む。2つ目までが表示範囲の境界
		if (child.name === 'LinkMark') {
			// この括弧の文書上の範囲
			linkMarks.push({
				// 括弧の開始。文書上の文字位置
				from: child.from,
				// 括弧の終端。文書上の文字位置
				to: child.to
			});
		}
	});

	// 括弧が2つ無い、または開きの終端が閉じの開始以上なら表示範囲は空。どちらか一方でも空を返す
	if (linkMarks.length < 2 || linkMarks[0].to >= linkMarks[1].from) {
		return [];
	}

	// 開きと閉じのあいだ。URL 側の括弧は含めない
	return [
		{
			// 表示の開始。開き括弧の直後
			from: linkMarks[0].to,
			// 表示の終端。閉じ括弧の直前
			to: linkMarks[1].from
		}
	];
}

/**
 * 記法トークン非表示 Decoration エントリを追加する
 * @param entries - エントリ配列
 * @param from - 開始位置
 * @param to - 終了位置
 */
function pushHiddenMark(entries: DecorationEntry[], from: number, to: number): void {
	pushHiddenReplace(entries, from, to);
}

/**
 * 強調系ノードの装飾エントリを追加する
 * @param node - 構文ノード
 * @param className - 内容用 CSS クラス
 * @param entries - エントリ配列
 * @param hideMarks - 非表示対象ノード名
 */
function decorateEmphasisLike(node: SyntaxNode, className: string, entries: DecorationEntry[], hideMarks: Set<string>): void {
	// このノード直下の最初の記法の終端。記法が無ければ null
	let firstMarkEnd: number | null  = null;
	// このノード直下の最後の記法の開始。記法が無ければ null
	let lastMarkStart: number | null = null;
	// 子のテキストへ mark を付けたか。false のままなら記法のあいだをまとめて塗る
	let decoratedChild               = false;

	node.cursor().iterate((child) => {
		// 隠す記法なら文字を消し、直下の記法の端を覚える
		if (hideMarks.has(child.name)) {
			pushHiddenMark(entries, child.from, child.to);
			// 直下の記法だけを、まとめて塗る範囲の端に使う。入れ子の記法は端にしない
			if (child.node.parent === node) {
				// 最初の直下記法の終端だけを記録する。2つ目以降では開始側を上書きしない
				if (firstMarkEnd === null) {
					firstMarkEnd = child.to;
				}

				lastMarkStart = child.from;
			}

			return;
		}

		// 入れ子のコンテナ、または空範囲は、この段では mark しない。どちらか一方でも飛ばす
		if (CONTAINER_NODE_NAMES.has(child.name) || child.from >= child.to) {
			return;
		}

		decoratedChild = true;
		// 子のテキスト範囲を強調する mark。記法文字は含めない
		entries.push({
			// 子の開始。文書上の文字位置
			from: child.from,
			// 子の終端。文書上の文字位置
			to: child.to,
			// 強調のクラスを付けた mark。文字は残す
			decoration: Decoration.mark({ class: className })
		});
	});

	// 子へ mark を付けておらず、直下の記法が両端ともあり、終端が開始より前のときだけ間を塗る。どれか一つが欠けても足さない
	if (!decoratedChild && firstMarkEnd !== null && lastMarkStart !== null && firstMarkEnd < lastMarkStart) {
		// 記法に挟まれたプレーンテキスト。子ノードが無いときの強調
		entries.push({
			// 最初の記法の直後。文書上の文字位置
			from: firstMarkEnd,
			// 最後の記法の直前。文書上の文字位置
			to: lastMarkStart,
			// 強調のクラスを付けた mark。文字は残す
			decoration: Decoration.mark({ class: className })
		});
	}
}

/**
 * インラインコードの装飾エントリを追加する
 * 既知言語の `{java}` 接頭辞は、キャレットが重ならないときだけ隠す（`}` 直後の空白も含む。スペース自体は不要）
 * キャレットが内部にあるときはバッククォートと接頭辞を表示し、コード背景は記法を含む範囲へ付ける
 * @param node - InlineCode ノード
 * @param state - エディタ状態
 * @param entries - エントリ配列
 * @param hideMarks - 記法を隠すなら true
 */
function decorateInlineCode(node: SyntaxNode, state: EditorState, entries: DecorationEntry[], hideMarks: boolean): void {
	// キャレットが重ならないときだけバッククォートを隠す。重なるときはソースのまま残す
	if (hideMarks) {
		node.cursor().iterate(
			/**
			 * CodeMark を隠す
			 * @param child - 子ノード
			 */
			(child) => {
				// バッククォートだけをレイアウトから外す。本文は後段の mark
				if (child.name === 'CodeMark') {
					pushHiddenMark(entries, child.from, child.to);
				}
			}
		);
	} else {
		// キャレットが重なるときは、記法を含めた範囲へコード背景を付ける
		entries.push({
			// インラインコード全体の開始。記法を含む
			from: node.from,
			// インラインコード全体の終端。記法を含む
			to: node.to,
			// コード背景。記法の文字も残す
			decoration: Decoration.mark({ class: 'cm-md-code' })
		});
	}

	for (const range of collectInlineCodeContentRanges(node)) {
		// コード本文。言語接頭辞を含み得る
		const content = state.doc.sliceString(range.from, range.to);
		// `{java}` のような接頭辞。無ければ null
		const prefix  = parseInlineCodeLanguagePrefix(content);
		// 記法を隠し、接頭辞があり、既知言語のときだけ接頭辞を隠す。どれか一つが欠けても接頭辞は残す
		if (hideMarks && prefix && resolveCodeLanguage(prefix.language)) {
			pushHiddenMark(entries, range.from, range.from + prefix.prefixLength);
		}

		// キャレットが重なっているときは、本文範囲へコード背景を重ねない
		if (!hideMarks) {
			continue;
		}

		// 記法を隠しているときの本文。接頭辞を隠したあともこの範囲は残る
		entries.push({
			// 本文の開始。接頭辞を含むことがある
			from: range.from,
			// 本文の終端
			to: range.to,
			// コード背景。バッククォートは別の隠し装飾
			decoration: Decoration.mark({ class: 'cm-md-code' })
		});
	}
}

/**
 * リンクの装飾エントリを追加する
 * @param node - Link ノード
 * @param state - エディタ状態
 * @param entries - エントリ配列
 */
function decorateLink(node: SyntaxNode, state: EditorState, entries: DecorationEntry[]): void {
	// リンク先。URL ノードが無ければ空文字で、data-href は付けない
	const url = extractLinkUrl(state, node);

	node.cursor().iterate((child) => {
		// 括弧、URL、タイトルは表示から隠す
		if (child.name === 'LinkMark' || child.name === 'URL' || child.name === 'LinkTitle') {
			pushHiddenMark(entries, child.from, child.to);
		}
	});

	for (const range of collectLinkLabelRanges(node)) {
		// 表示ラベル。URL があるときだけ data-href を載せる
		entries.push({
			// ラベルの開始。開き括弧の直後
			from: range.from,
			// ラベルの終端。閉じ括弧の直前
			to: range.to,
			// リンクの見た目。文字は残し、遷移は data-href を読む側が行う
			decoration: Decoration.mark({
				// リンク用のクラス
				class: 'cm-md-link',
				// リンク先。URL が空なら属性自体を付けない
				attributes: url ? { 'data-href': url } : undefined
			})
		});
	}
}

/**
 * WikiLink の装飾エントリを追加する（遷移なし・見た目のみ）
 * `|` または表セル用の `\|` があるときは右側のラベルだけを出す
 * @param node - WikiLink ノード
 * @param state - エディタ状態
 * @param entries - エントリ配列
 */
function decorateWikiLink(node: SyntaxNode, state: EditorState, entries: DecorationEntry[]): void {
	for (let child = node.firstChild; child; child = child.nextSibling) {
		// 括弧は表示から隠す
		if (child.name === 'WikiLinkMark') {
			pushHiddenMark(entries, child.from, child.to);
			continue;
		}

		// ページノード以外、または空範囲はラベルにしない。どちらか一方でも飛ばす
		if (child.name !== 'WikiLinkPage' || child.from >= child.to) {
			continue;
		}

		// ページノードの内側。エイリアス区切りを含み得る
		const raw         = state.doc.sliceString(child.from, child.to);
		// 隠す長さと表示ラベル。区切りが使えなければ hideLength は 0、alias は null
		const split       = splitWikiLinkAlias(raw);
		// 表示を始める位置。エイリアスが無ければページの先頭
		const visibleFrom = split.alias ? child.from + split.hideLength : child.from;
		// エイリアスがあるときだけ、ページ名側を隠す
		if (visibleFrom > child.from) {
			pushHiddenMark(entries, child.from, visibleFrom);
		}

		// 表示する文字が残っているときだけ wikilink の mark を付ける
		if (visibleFrom < child.to) {
			// 表示ラベル。ページ名側は別の隠し装飾
			entries.push({
				// 表示の開始。エイリアスが無ければページ先頭
				from: visibleFrom,
				// ページノードの終端
				to: child.to,
				// 見た目だけの mark。遷移は付けない
				decoration: Decoration.mark({ class: 'cm-md-wikilink' })
			});
		}
	}
}

// ----------------------------------------------
// インライン装飾の収集
// ----------------------------------------------
/**
 * ライブプレビュー行のインライン装飾エントリを収集する
 * @param state - エディタ状態
 * @returns 集めたライブプレビュー行のインライン装飾エントリ。該当が無ければ空
 */
export function collectInlineDecorationEntries(state: EditorState, _sourceLineNumbers?: Set<number>): DecorationEntry[] {
	// 返すインライン装飾。該当が無ければ空
	const entries: DecorationEntry[] = [];
	// 隠す記法トークン名。強調の装飾へ渡す
	const hideMarks                  = new Set(MARK_NODE_NAMES);

	syntaxTree(state).iterate({
		/**
		 * 構文木を走査して装飾エントリを収集する
		 * @param ref - ノード参照
		 * @returns 子の走査を止めるとき false。続けるときは値を返さない
		 */
		enter(ref) {
			// 選択がノードにかかっているか。かかっていれば記法をソースのまま残す
			const revealSource = selectionIntersectsRange(state, ref.from, ref.node.to);

			switch (ref.name) {
				// 斜体。選択中は装飾せず子の走査を続ける
				case 'Emphasis':
					// 選択が記法にかかっているときは、この段では強調を付けない
					if (revealSource) {
						return;
					}

					decorateEmphasisLike(ref.node, 'cm-md-em', entries, hideMarks);
					return false;
				// 太字。選択中は装飾せず子の走査を続ける
				case 'StrongEmphasis':
					// 選択が記法にかかっているときは、この段では強調を付けない
					if (revealSource) {
						return;
					}

					decorateEmphasisLike(ref.node, 'cm-md-strong', entries, hideMarks);
					return false;
				// 取り消し線。選択中は装飾せず子の走査を続ける
				case 'Strikethrough':
					// 選択が記法にかかっているときは、この段では強調を付けない
					if (revealSource) {
						return;
					}

					decorateEmphasisLike(ref.node, 'cm-md-strike', entries, hideMarks);
					return false;
				// ハイライト。選択中は装飾せず子の走査を続ける
				case 'Highlight':
					// 選択が記法にかかっているときは、この段では強調を付けない
					if (revealSource) {
						return;
					}

					decorateEmphasisLike(ref.node, 'cm-md-highlight', entries, hideMarks);
					return false;
				// インラインコード。背景は選択の有無にかかわらず残す
				case 'InlineCode':
					// 記法の表示／非表示はキャレット交差に従うが、コード背景は常に維持する
					decorateInlineCode(ref.node, state, entries, !revealSource);
					return false;
				// リンク。選択中は記法を残し、子のコードなどは走査を続ける
				case 'Link':
					// 選択がかかっていないときだけ、ラベルと隠し装飾を付ける
					if (!revealSource) {
						decorateLink(ref.node, state, entries);
					}

					// Link 表示文字列内の InlineCode なども個別に装飾するため、
					// ここでは子ノードの走査を止めない
					return;
				// Wiki リンク。選択中は装飾せず子の走査を続ける
				case 'WikiLink':
					// 選択が記法にかかっているときは、見た目の mark を付けない
					if (revealSource) {
						return;
					}

					decorateWikiLink(ref.node, state, entries);
					return false;
				default:
					return;
			}
		}
	});

	return entries;
}

/**
 * Decoration エントリから DecorationSet を構築する
 * @param entries - エントリ配列
 * @returns Decoration エントリから DecorationSet
 */
export function buildDecorationSet(entries: DecorationEntry[]): DecorationSet {
	// エントリが無ければ空の装飾集合。並び替えはしない
	if (entries.length === 0) {
		return Decoration.none;
	}

	// from、同じなら to の順。元の配列は並べ替えない
	const sorted = [...entries].sort((left, right) => {
		// 開始が違うときは、開始の早い方を前にする
		if (left.from !== right.from) {
			return left.from - right.from;
		}

		return left.to - right.to;
	});

	// from 順に積む RangeSet。空の入力では作らない
	const builder = new RangeSetBuilder<Decoration>();
	for (const entry of sorted) {
		builder.add(entry.from, entry.to, entry.decoration);
	}

	return builder.finish();
}

/**
 * インライン装飾のみの DecorationSet を構築する（テスト用）
 * @param state - エディタ状態
 * @returns インライン装飾のみの DecorationSet を構築する（テスト用）
 */
export function buildInlineDecorationsForTest(state: EditorState): DecorationSet {
	return buildDecorationSet(collectInlineDecorationEntries(state));
}
