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
	// 文書順の見出し。本文が空でも一旦集め、範囲を作る段で落とす
	const headings: Array<{ headingFrom: number; headingTo: number; level: number }> = [];
	// 折りたたみ後は表示範囲外の構文解析が省略されるため、保存・復元でも文書全体を明示的に解析する
	const tree                                                                       = ensureSyntaxTree(state, state.doc.length, FULL_PARSE_TIMEOUT_MS) ?? syntaxTree(state);
	// 構文木の走査位置。見出し名のノードだけを集める
	const cursor                                                                     = tree.cursor();
	do {
		// 見出しノード名に一致したレベル。ATX でも Setext でも、名前が違えば null
		const match = HEADING_NODE_PATTERN.exec(cursor.name);
		// 見出しでないノードは範囲の材料にしない
		if (!match) continue;
		// 見出しの位置とレベル。本文の終わりは後段で決める
		headings.push({
			// 見出しノード先頭（文書オフセット）。折りたたみ状態のキー
			headingFrom: cursor.from,
			// 見出しノード末尾（文書オフセット、含まない）
			headingTo: cursor.to,
			// 見出しレベル。1 から 6。キャプチャの数字
			level: Number(match[1])
		});
	} while (cursor.next());

	return headings.flatMap((heading, index) => {
		// 本文の終わり（文字）。同レベル以上の次の見出しが無ければ文書末尾
		let nextBoundary = state.doc.length;
		for (let nextIndex = index + 1; nextIndex < headings.length; nextIndex += 1) {
			// 同レベルか、より上位の見出しが次の境界。より深い見出しは本文に含めるので境界にしない
			if (headings[nextIndex].level <= heading.level) {
				// 次の境界は、その見出しの先頭。本文はその手前まで
				nextBoundary = headings[nextIndex].headingFrom;
				break;
			}
		}

		// 折りたたむ本文の先頭（文字、含む）。見出しノードの直後で、見出し行自体は含めない
		const from = heading.headingTo;
		// 本文の末尾（文字、含まない）。文書末尾以外は、次の見出し直前の改行を含めない
		const to   = nextBoundary < state.doc.length ? Math.max(from, nextBoundary - state.lineBreak.length) : state.doc.length;
		return from < to ? [{ headingFrom: heading.headingFrom, level: heading.level, from, to }] : [];
	});
}

/**
 * 現在折りたたまれている見出しの文書位置を返す
 * @param state - 折りたたみ状態を持つ文書
 * @returns 折りたたみ中の見出し先頭オフセット。無いときは空配列
 */
export function getCollapsedHeadingFroms(state: EditorState): number[] {
	const ranges = collectHeadingFoldRanges(state);
	return ranges.filter((range) => isFoldedRange(state, range)).map((range) => range.headingFrom);
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
	// 折りたたむ見出し先頭。整数でない値と負の値は捨てる。残らなければ空集合
	const requested = new Set(headingFroms.filter((value) => Number.isInteger(value) && value >= 0));
	// 有効な位置が 1 つも無ければ、状態を変えない
	if (requested.size === 0) return state;

	// 主選択の head（文字）。この位置を隠す範囲は折りたたまない
	const selectionHead = state.selection.main.head;
	// 保存位置に一致し、選択を隠さない折りたたみ Effect。一致が無ければ空
	const effects       = collectHeadingFoldRanges(state)
		.filter((range) => requested.has(range.headingFrom))
		.filter((range) => !(range.from < selectionHead && selectionHead <= range.to))
		.map((range) =>
			foldEffect.of(
				// この見出しの本文を折りたたむ範囲。見出し行自体は含めない
				{
					// 本文の開始（文字、含む）。見出しノードの直後
					from: range.from,
					// 本文の終端（文字、含まない）。次の同レベル以上の見出しの手前
					to: range.to
				}
			)
		);
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
	// 指定見出しと、それを隠している親の展開 Effect。折りたたみ中でなければ空
	const effects = unfoldEffectsForHeading(view.state, headingFrom);
	// 展開するものが無ければ dispatch しない
	if (effects.length === 0) return false;
	// アウトラインからの展開。選択は動かさない
	view.dispatch({
		// 展開する範囲の Effect
		effects,
		// アウトライン操作。他の折りたたみ更新と区別する
		userEvent: 'unfold.heading.outline'
	});
	return true;
}

/**
 * 文書内の、まだ折りたたまれていない見出しをすべて折りたたむ
 * 選択が本文の中にある見出しへキャレットを移し、選択が隠れないようにする
 * @param view - 折りたたみを dispatch するエディタ
 * @returns 1 件以上折りたたんだとき true。対象が無ければ false
 */
export function collapseAllHeadings(view: EditorView): boolean {
	// まだ折りたたまれていない見出し。本文が空の見出しは collect に含まれない
	const ranges = collectHeadingFoldRanges(view.state).filter((range) => !isFoldedRange(view.state, range));
	// 折りたたむものが無ければ dispatch しない
	if (ranges.length === 0) return false;

	// 主選択の head（文字）。本文の中にある見出しへキャレットを移す判定に使う
	const selectionHead = view.state.selection.main.head;
	// 選択を本文に含む見出し。無ければ undefined で、選択は動かさない
	const containing    = ranges.find((range) => range.from < selectionHead && selectionHead <= range.to);
	// 未折りの見出しをすべて畳む。選択が本文の中なら、その見出しの先頭へキャレットを移す
	view.dispatch({
		// 折りたたむ範囲の Effect。本文が空の見出しは ranges に含まれない
		effects: ranges.map((range) =>
			foldEffect.of(
				// この見出しの本文を折りたたむ範囲。見出し行自体は含めない
				{
					// 本文の開始（文字、含む）。見出しノードの直後
					from: range.from,
					// 本文の終端（文字、含まない）。次の同レベル以上の見出しの手前
					to: range.to
				}
			)
		),
		// 選択が本文の中にあるときだけ、その見出しの先頭へ移す。無ければ undefined で選択は動かさない
		selection: containing ? EditorSelection.cursor(containing.headingFrom, 1) : undefined,
		// 全文折りたたみ。個別のガター操作と区別する
		userEvent: 'fold.heading.all'
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
		// 折りたたみ中の見出しだけ展開する。展開済みは Effect に入れない
		if (isFoldedRange(view.state, range)) {
			effects.push(
				unfoldEffect.of(
					// 展開する本文の範囲。見出し行自体は折りたたみに含まれていない
					{
						// 本文の開始（文字、含む）
						from: range.from,
						// 本文の終端（文字、含まない）
						to: range.to
					}
				)
			);
		}
	}
	// 展開するものが無ければ dispatch しない
	if (effects.length === 0) return false;
	// 折りたたみ中の見出しをすべて開く。選択は動かさない
	view.dispatch({
		// 展開する範囲の Effect
		effects,
		// 全文展開。個別のガター操作と区別する
		userEvent: 'fold.heading.all'
	});
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
	const markers = ViewPlugin.fromClass(
		/** 表示範囲の見出しマーカーを保持する。文書、表示範囲、構文木、折りたたみ状態が変わったときだけ作り直す */ class {
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
				// 文書、表示範囲、構文木、折りたたみ状態のどれかが変わったときだけマーカーを作り直す。四つとも同じ更新では維持する
				if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state) || update.startState.field(foldState, false) !== update.state.field(foldState, false)) {
					this.markers = buildHeadingFoldMarkers(update.view);
				}
			}
		}
	);

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
					const range = collectHeadingFoldRanges(view.state).find((entry) => view.state.doc.lineAt(entry.headingFrom).from === line.from);
					// クリック行が見出しでなければ、ガターの既定動作に任せる
					if (!range) return false;
					event.preventDefault();
					// 折りたたみ中なら展開する。展開中はこの分岐に入らず、折りたたみへ進む
					if (isFoldedRange(view.state, range)) {
						// 折りたたみ中の見出しを開く。選択は動かさない
						view.dispatch({
							// この見出しの本文を展開する
							effects: unfoldEffect.of(
								// 展開する本文の範囲。見出し行自体は折りたたみに含まれていない
								{
									// 本文の開始（文字、含む）
									from: range.from,
									// 本文の終端（文字、含まない）
									to: range.to
								}
							),
							// ガターのクリック。全文折りたたみと区別する
							userEvent: 'fold.heading'
						});
						return true;
					}

					// 主選択の head（文字）。本文の中なら、折りたたむ前に見出し先頭へ移す
					const selectionHead = view.state.selection.main.head;
					// 展開中の見出しを畳む。選択が本文の中なら見出し先頭へ移す
					view.dispatch({
						// この見出しの本文を折りたたむ
						effects: foldEffect.of(
							// 折りたたむ本文の範囲。見出し行自体は含めない
							{
								// 本文の開始（文字、含む）
								from: range.from,
								// 本文の終端（文字、含まない）
								to: range.to
							}
						),
						// 選択が本文の中にあるときだけ見出し先頭へ移す。外れていれば undefined で選択は動かさない
						selection: range.from < selectionHead && selectionHead <= range.to ? EditorSelection.cursor(range.headingFrom, 1) : undefined,
						// ガターのクリック。全文折りたたみと区別する
						userEvent: 'fold.heading'
					});
					return true;
				}
			}
		}),
		EditorView.updateListener.of((update) => {
			// 選択が変わったとき、選択を隠している見出しを展開する。選択が動いていない更新では見ない
			if (update.selectionSet) {
				// 選択の anchor または head を隠している展開 Effect。隠していなければ空
				const effects = unfoldEffectsContainingSelection(update.state);
				// 隠している範囲があるときだけ展開を送る。無ければ折りたたみ通知の判定へ進む
				if (effects.length > 0) {
					// 選択を隠している見出しを開く。選択位置は維持する
					update.view.dispatch({
						// 選択の anchor または head を隠している範囲の展開 Effect
						effects,
						// 選択移動に伴う展開。ガター操作と区別する
						userEvent: 'unfold.heading.reveal'
					});
					return;
				}
			}
			// 折りたたみ状態が変わったときだけ通知する。選択だけの更新では呼ばない
			if (update.startState.field(foldState, false) !== update.state.field(foldState, false)) {
				options.onFoldChange?.(update.view);
			}
		}),
		EditorView.baseTheme({
			'.cm-headingFoldGutter': {
				width: '16px'
			},
			'.cm-headingFoldGutter .cm-gutterElement': {
				padding: '0',
				cursor: 'pointer'
			},
			'.cm-headingFoldMarker': {
				display: 'inline-flex',
				width: '16px',
				height: '100%',
				alignItems: 'center',
				justifyContent: 'center',
				color: 'var(--tms-mde-color-text-muted)',
				fontSize: '11px',
				userSelect: 'none'
			},
			'.cm-foldPlaceholder': {
				border: '0',
				backgroundColor: 'transparent',
				color: 'var(--tms-mde-color-text-muted)'
			}
		})
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
		// ガターへ出す span。折りたたみ中かで中身を変える
		const marker       = document.createElement('span');
		// テーマが幅と色を当てるクラス。折りたたみ状態では変えない
		marker.className   = 'cm-headingFoldMarker';
		// 折りたたみ中は ▶、展開中は ▼
		marker.textContent = this.collapsed ? '▶' : '▼';
		// ホバーで示す操作。折りたたみ中は展開、展開中は折りたたみ
		marker.title       = this.collapsed ? '見出しを展開' : '見出しを折りたたむ';
		// 読み上げ対象にしない。操作の説明は title が持つ
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
		// 行が表示範囲より上で終わる、または表示範囲より下で始まるときはマーカーを作らない。どちらか一方でも範囲外
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
	// 同じ from と to の折りたたみが見つかったか。無ければ false のまま
	let found = false;
	foldedRanges(state).between(range.from, range.from, (from, to) => {
		// 開始と終了が両方一致する折りたたみだけ、その見出しとみなす。どちらか一方が違う範囲は別の折りたたみ
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
		.filter((range) => state.selection.ranges.some((selection) => (range.from < selection.anchor && selection.anchor <= range.to) || (range.from < selection.head && selection.head <= range.to)))
		.map((range) =>
			unfoldEffect.of(
				// 選択を隠している本文を展開する範囲
				{
					// 本文の開始（文字、含む）
					from: range.from,
					// 本文の終端（文字、含まない）
					to: range.to
				}
			)
		);
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
		.map((range) =>
			unfoldEffect.of(
				// 指定見出し、またはそれを隠している親の本文を展開する範囲
				{
					// 本文の開始（文字、含む）
					from: range.from,
					// 本文の終端（文字、含まない）
					to: range.to
				}
			)
		);
}
