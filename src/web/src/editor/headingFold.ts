/**
 * 見出し単位の折りたたみ範囲と、見出しガターのマーカーを持つ
 * 折りたたみ状態の保存先は呼び出し側が持ち、本ファイルは構文木から範囲を作り、渡された位置を折りたたみへ戻す
 * @file
 */
import { codeFolding, ensureSyntaxTree, foldEffect, foldedRanges, foldState, syntaxTree, unfoldEffect } from '@codemirror/language';
import { EditorSelection, RangeSet, RangeSetBuilder, type EditorState, type Extension, type StateEffect } from '@codemirror/state';
import { EditorView, GutterMarker, gutter, ViewPlugin, type ViewUpdate } from '@codemirror/view';

/** ATX または Setext の見出しノード名。キャプチャは見出しレベル 1 から 6 */
const HEADING_NODE_PATTERN  = /^(?:ATXHeading|SetextHeading)([1-6])$/;
/** 文書全体の構文木を待つ上限（ms）。超えたら、その時点の構文木で範囲を作る */
const FULL_PARSE_TIMEOUT_MS = 200;

/**
 * 見出し本文の折りたたみ範囲
 * 見出し行自身は含めず、次の同レベル以上の見出しの手前までを畳む
 */
export type HeadingFoldRange = {
	/** 見出しノード先頭の文書オフセット。折りたたみ状態のキーに使う */
	headingFrom: number;
	/** 見出しレベル。1 から 6 */
	level: number;
	/** 折りたたむ本文の先頭（含む）。見出しノードの直後 */
	from: number;
	/** 折りたたむ本文の末尾（含まない）。次の境界の改行は含めない */
	to: number;
};

/**
 * 見出し折りたたみ拡張の通知先
 * 未指定のコールバックは呼ばない
 */
type HeadingFoldExtensionOptions = {
	/** 折りたたみ状態が変わったときに呼ぶ。未指定時は通知しない */
	onFoldChange?: (view: EditorView) => void;
};

// ==============================================
// 折りたたみ範囲
// ==============================================

/**
 * Markdown 構文木から、見出しごとの本文折りたたみ範囲を作る
 * 本文が空の見出しは範囲に含めない
 * @param state - 構文木を持つ文書。折りたたみ後でも文書全体を解析してから範囲を決める
 * @returns 文書順の折りたたみ範囲。見出しが無いときは空配列
 */
export function collectHeadingFoldRanges(state: EditorState): HeadingFoldRange[] {
	const headings: Array<{ headingFrom: number; headingTo: number; level: number }> = [];
	// 折りたたみ後は表示範囲外の構文解析が省略されるため、保存・復元でも文書全体を明示的に解析する
	const tree                                                                       = ensureSyntaxTree(state, state.doc.length, FULL_PARSE_TIMEOUT_MS) ?? syntaxTree(state);
	const cursor                                                                     = tree.cursor();
	do {
		const match = HEADING_NODE_PATTERN.exec(cursor.name);
		if (!match) continue;
		headings.push({
			headingFrom: cursor.from,
			headingTo  : cursor.to,
			level      : Number(match[1]),
		});
	} while (cursor.next());

	return headings.flatMap((heading, index) => {
		let nextBoundary = state.doc.length;
		for (let nextIndex = index + 1; nextIndex < headings.length; nextIndex += 1) {
			if (headings[nextIndex].level <= heading.level) {
				nextBoundary = headings[nextIndex].headingFrom;
				break;
			}
		}

		const from = heading.headingTo;
		const to   = nextBoundary < state.doc.length
			? Math.max(from, nextBoundary - state.lineBreak.length)
			: state.doc.length;
		return from < to
			? [{ headingFrom: heading.headingFrom, level: heading.level, from, to }]
			: [];
	});
}

/**
 * 現在折りたたまれている見出しの文書位置を返す
 * @param state - 折りたたみ状態を持つ文書
 * @returns 折りたたみ中の見出し先頭オフセット。無いときは空配列
 */
export function getCollapsedHeadingFroms(state: EditorState): number[] {
	const ranges = collectHeadingFoldRanges(state);
	return ranges
		.filter((range) => isFoldedRange(state, range))
		.map((range) => range.headingFrom);
}

// ==============================================
// 展開と折りたたみ
// ==============================================

/**
 * 保存済み見出し位置を検証し、初期折りたたみ状態へ変換する
 * 選択が隠れている範囲は折りたたまない。整数でない位置と負の位置は無視する
 * @param state - 復元先の文書
 * @param headingFroms - 折りたたむ見出しの先頭オフセット。空なら状態を変えない
 * @returns 折りたたみを適用した状態。適用するものが無ければ state と同じ
 */
export function restoreCollapsedHeadings(state: EditorState, headingFroms: readonly number[]): EditorState {
	const requested = new Set(headingFroms.filter((value) => Number.isInteger(value) && value >= 0));
	if (requested.size === 0) return state;

	const selectionHead = state.selection.main.head;
	const effects       = collectHeadingFoldRanges(state)
		.filter((range) => requested.has(range.headingFrom))
		.filter((range) => !(range.from < selectionHead && selectionHead <= range.to))
		.map((range) => foldEffect.of({ from: range.from, to: range.to }));
	return effects.length > 0 ? state.update({ effects }).state : state;
}

/**
 * 検索やアウトラインの移動先を隠している親見出しを展開する
 * @param state - 選択と折りたたみを持つ文書
 * @returns 選択を隠す折りたたみを展開した状態。隠していなければ state と同じ
 */
export function revealSelectionInCollapsedHeadings(state: EditorState): EditorState {
	const effects = unfoldEffectsContainingSelection(state);
	return effects.length > 0 ? state.update({ effects }).state : state;
}

/**
 * アウトラインで指定した見出し自身と、それを隠している親見出しを展開した状態を返す
 * @param state - 折りたたみを持つ文書
 * @param headingFrom - 展開する見出しの先頭オフセット。この位置を含む親も展開する
 * @returns 展開を適用した状態。対象が折りたたまれていなければ state と同じ
 */
export function revealHeadingInCollapsedHeadings(state: EditorState, headingFrom: number): EditorState {
	const effects = unfoldEffectsForHeading(state, headingFrom);
	return effects.length > 0 ? state.update({ effects }).state : state;
}

/**
 * アウトラインで指定した見出し自身と、それを隠している親見出しを展開する
 * @param view - 展開を dispatch するエディタ
 * @param headingFrom - 展開する見出しの先頭オフセット
 * @returns 1 件以上展開したとき true。対象が無ければ false
 */
export function expandHeadingAt(view: EditorView, headingFrom: number): boolean {
	const effects = unfoldEffectsForHeading(view.state, headingFrom);
	if (effects.length === 0) return false;
	view.dispatch({ effects, userEvent: 'unfold.heading.outline' });
	return true;
}

/**
 * 文書内の、まだ折りたたまれていない見出しをすべて折りたたむ
 * 選択が本文の中にある見出しへキャレットを移し、選択が隠れないようにする
 * @param view - 折りたたみを dispatch するエディタ
 * @returns 1 件以上折りたたんだとき true。対象が無ければ false
 */
export function collapseAllHeadings(view: EditorView): boolean {
	const ranges = collectHeadingFoldRanges(view.state).filter((range) => !isFoldedRange(view.state, range));
	if (ranges.length === 0) return false;

	const selectionHead = view.state.selection.main.head;
	const containing    = ranges.find((range) => range.from < selectionHead && selectionHead <= range.to);
	view.dispatch({
		effects: ranges.map((range) => foldEffect.of({ from: range.from, to: range.to })),
		selection: containing ? EditorSelection.cursor(containing.headingFrom, 1) : undefined,
		userEvent: 'fold.heading.all',
	});
	return true;
}

/**
 * 文書内の折りたたみ中の見出しをすべて展開する
 * @param view - 展開を dispatch するエディタ
 * @returns 1 件以上展開したとき true。折りたたみが無ければ false
 */
export function expandAllHeadings(view: EditorView): boolean {
	const effects: StateEffect<unknown>[] = [];
	for (const range of collectHeadingFoldRanges(view.state)) {
		if (isFoldedRange(view.state, range)) {
			effects.push(unfoldEffect.of({ from: range.from, to: range.to }));
		}
	}
	if (effects.length === 0) return false;
	view.dispatch({ effects, userEvent: 'fold.heading.all' });
	return true;
}

/**
 * 折りたたみ可能な見出しがあるかを返す
 * @param state - 範囲を数える文書
 * @returns 本文を持つ見出しが 1 つでもあるとき true
 */
export function hasFoldableHeadings(state: EditorState): boolean {
	return collectHeadingFoldRanges(state).length > 0;
}

/**
 * 折りたたみ中の見出しがあるかを返す
 * @param state - 折りたたみ状態を持つ文書
 * @returns 1 件でも折りたたまれているとき true
 */
export function hasCollapsedHeadings(state: EditorState): boolean {
	return getCollapsedHeadingFroms(state).length > 0;
}

// ==============================================
// 見出しガター
// ==============================================

/**
 * 見出し専用ガターと折りたたみ状態をエディタへ追加する Extension を返す
 * @param options - 折りたたみ変化の通知先。未指定時は空オブジェクトで、通知しない
 * @param options.onFoldChange - 折りたたみ状態が変わったときに呼ぶ。未指定時は呼ばない
 * @returns 折りたたみ、マーカー、ガター、変化通知、ガター用テーマ
 */
export function createHeadingFoldExtensions(options: HeadingFoldExtensionOptions = {}): Extension[] {
	const markers = ViewPlugin.fromClass(/** 表示範囲の見出しマーカーを保持する。文書、表示範囲、構文木、折りたたみ状態が変わったときだけ作り直す */ class {
		/** 表示範囲の見出しマーカー。該当が無いときは空集合 */
		public markers = RangeSet.empty as RangeSet<GutterMarker>;

		/**
		 * 開いた直後の表示範囲から見出しマーカーを作る
		 * @param view - 初期マーカーを作るエディタ
		 */
		constructor(view: EditorView) {
			this.markers = buildHeadingFoldMarkers(view);
		}

		/**
		 * 文書、表示範囲、構文木、折りたたみ状態の変化をガターへ反映する
		 * それらが変わっていなければマーカーは維持する
		 * @param update - 今回のビュー更新
		 */
		update(update: ViewUpdate): void {
			if (update.docChanged
				|| update.viewportChanged
				|| syntaxTree(update.startState) !== syntaxTree(update.state)
				|| update.startState.field(foldState, false) !== update.state.field(foldState, false)) {
				this.markers = buildHeadingFoldMarkers(update.view);
			}
		}
	});

	return [
		codeFolding({ placeholderText: '…' }),
		markers,
		gutter({
			class: 'cm-headingFoldGutter',
			/**
			 * 表示範囲内の見出しマーカーを返す
			 * @param view - マーカーを持つエディタ。プラグインが無いときは空集合
			 * @returns 現在の見出しマーカー
			 */
			markers(view) {
				return view.plugin(markers)?.markers ?? RangeSet.empty;
			},
			/**
			 * ガター幅を確保する初期マーカーを返す
			 * 折りたたみ前の幅計算用なので、展開状態のマーカーにする
			 * @returns 展開表示のマーカー
			 */
			initialSpacer() {
				return new HeadingFoldMarker(false);
			},
			domEventHandlers: {
				/**
				 * クリックした見出しの折りたたみ状態を切り替える
				 * 折りたたみで選択が隠れるときは、見出しの先頭へキャレットを移す
				 * @param view - 切り替えるエディタ
				 * @param line - クリックされたガター行。見出し行と一致するときだけ処理する
				 * @param event - クリック。見出し行なら既定の動作を止める
				 * @returns 見出しを切り替えたとき true。見出し行でなければ false
				 */
				click(view, line, event) {
					const range = collectHeadingFoldRanges(view.state).find((entry) => (
						view.state.doc.lineAt(entry.headingFrom).from === line.from
					));
					if (!range) return false;
					event.preventDefault();
					if (isFoldedRange(view.state, range)) {
						view.dispatch({ effects: unfoldEffect.of({ from: range.from, to: range.to }), userEvent: 'fold.heading' });
						return true;
					}

					const selectionHead = view.state.selection.main.head;
					view.dispatch({
						effects: foldEffect.of({ from: range.from, to: range.to }),
						selection: range.from < selectionHead && selectionHead <= range.to
							? EditorSelection.cursor(range.headingFrom, 1)
							: undefined,
						userEvent: 'fold.heading',
					});
					return true;
				},
			},
		}),
		EditorView.updateListener.of((update) => {
			if (update.selectionSet) {
				const effects = unfoldEffectsContainingSelection(update.state);
				if (effects.length > 0) {
					update.view.dispatch({ effects, userEvent: 'unfold.heading.reveal' });
					return;
				}
			}
			if (update.startState.field(foldState, false) !== update.state.field(foldState, false)) {
				options.onFoldChange?.(update.view);
			}
		}),
		EditorView.baseTheme({
			'.cm-headingFoldGutter': {
				width: '16px',
			},
			'.cm-headingFoldGutter .cm-gutterElement': {
				padding: '0',
				cursor : 'pointer',
			},
			'.cm-headingFoldMarker': {
				display   : 'inline-flex',
				width     : '16px',
				height    : '100%',
				alignItems : 'center',
				justifyContent: 'center',
				color     : 'var(--tms-mde-color-text-muted)',
				fontSize  : '11px',
				userSelect: 'none',
			},
			'.cm-foldPlaceholder': {
				border         : '0',
				backgroundColor: 'transparent',
				color          : 'var(--tms-mde-color-text-muted)',
			},
		}),
	];
}

/**
 * 見出しガターに表示する展開状態マーカー
 * 同じ collapsed のインスタンスは eq で再利用できる
 */
class HeadingFoldMarker extends GutterMarker {
	/**
	 * 展開か折りたたみかを保持する
	 * @param collapsed - true のとき折りたたみ表示。false のとき展開表示
	 */
	constructor(readonly collapsed: boolean) {
		super();
	}

	/**
	 * 同一表示状態ならマーカーを再利用できるかを返す
	 * @param other - 比較するガターマーカー。HeadingFoldMarker 以外は再利用しない
	 * @returns collapsed が同じ HeadingFoldMarker のとき true
	 */
	eq(other: GutterMarker): boolean {
		return other instanceof HeadingFoldMarker && other.collapsed === this.collapsed;
	}

	/**
	 * ガター用の DOM を生成する
	 * 折りたたみ中は ▶、展開中は ▼。読み上げ対象にはしない
	 * @returns 見出しマーカーの span
	 */
	toDOM(): Node {
		const marker       = document.createElement('span');
		marker.className   = 'cm-headingFoldMarker';
		marker.textContent = this.collapsed ? '▶' : '▼';
		marker.title       = this.collapsed ? '見出しを展開' : '見出しを折りたたむ';
		marker.setAttribute('aria-hidden', 'true');
		return marker;
	}
}

/**
 * 現在の表示範囲にある見出しマーカーを構築する
 * @param view - 表示範囲と折りたたみ状態を持つエディタ
 * @returns 表示範囲内の見出し行だけのマーカー。範囲外は含めない
 */
function buildHeadingFoldMarkers(view: EditorView): RangeSet<GutterMarker> {
	const builder = new RangeSetBuilder<GutterMarker>();
	for (const range of collectHeadingFoldRanges(view.state)) {
		const line = view.state.doc.lineAt(range.headingFrom);
		if (line.to < view.viewport.from || line.from > view.viewport.to) continue;
		builder.add(line.from, line.from, new HeadingFoldMarker(isFoldedRange(view.state, range)));
	}
	return builder.finish();
}

/**
 * 指定した見出し範囲が現在折りたたまれているかを判定する
 * from と to が両方一致する折りたたみだけを、その見出しとみなす
 * @param state - 折りたたみ範囲を持つ文書
 * @param range - 判定する見出し範囲
 * @returns 同じ from と to の折りたたみがあるとき true
 */
function isFoldedRange(state: EditorState, range: HeadingFoldRange): boolean {
	let found = false;
	foldedRanges(state).between(range.from, range.from, (from, to) => {
		if (from === range.from && to === range.to) found = true;
	});
	return found;
}

/**
 * 現在の選択を隠している折りたたみ見出しの展開 Effect を返す
 * @param state - 選択と折りたたみを持つ文書
 * @returns 選択の anchor または head を隠している範囲の展開 Effect。無ければ空配列
 */
function unfoldEffectsContainingSelection(state: EditorState): StateEffect<unknown>[] {
	return collectHeadingFoldRanges(state)
		.filter((range) => isFoldedRange(state, range))
		.filter((range) => state.selection.ranges.some((selection) => (
			(range.from < selection.anchor && selection.anchor <= range.to)
			|| (range.from < selection.head && selection.head <= range.to)
		)))
		.map((range) => unfoldEffect.of({ from: range.from, to: range.to }));
}

/**
 * 指定見出し自身と、その位置を隠している親見出しの展開 Effect を返す
 * @param state - 折りたたみを持つ文書
 * @param headingFrom - 展開する見出しの先頭オフセット。この位置を本文に含む親も含める
 * @returns 折りたたみ中のものだけの展開 Effect。無ければ空配列
 */
function unfoldEffectsForHeading(state: EditorState, headingFrom: number): StateEffect<unknown>[] {
	return collectHeadingFoldRanges(state)
		.filter((range) => isFoldedRange(state, range))
		.filter((range) => range.headingFrom === headingFrom || (range.from < headingFrom && headingFrom <= range.to))
		.map((range) => unfoldEffect.of({ from: range.from, to: range.to }));
}
