import { codeFolding, ensureSyntaxTree, foldEffect, foldedRanges, foldState, syntaxTree, unfoldEffect } from '@codemirror/language';
import { EditorSelection, RangeSet, RangeSetBuilder, type EditorState, type Extension, type StateEffect } from '@codemirror/state';
import { EditorView, GutterMarker, gutter, ViewPlugin, type ViewUpdate } from '@codemirror/view';

const HEADING_NODE_PATTERN  = /^(?:ATXHeading|SetextHeading)([1-6])$/;
const FULL_PARSE_TIMEOUT_MS = 200;

export type HeadingFoldRange = {
	headingFrom: number;
	level: number;
	from: number;
	to: number;
};

type HeadingFoldExtensionOptions = {
	onFoldChange?: (view: EditorView) => void;
};

/** Markdown構文木から、見出しごとの本文折りたたみ範囲を作る。 */
export function collectHeadingFoldRanges(state: EditorState): HeadingFoldRange[] {
	const headings: Array<{ headingFrom: number; headingTo: number; level: number }> = [];
	// 折りたたみ後は表示範囲外の構文解析が省略されるため、保存・復元でも文書全体を明示的に解析する。
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

/** 現在折りたたまれている見出しの文書位置を返す。 */
export function getCollapsedHeadingFroms(state: EditorState): number[] {
	const ranges = collectHeadingFoldRanges(state);
	return ranges
		.filter((range) => isFoldedRange(state, range))
		.map((range) => range.headingFrom);
}

/** 保存済み見出し位置を検証し、初期折りたたみ状態へ変換する。 */
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

/** 検索やアウトライン移動先を隠している親見出しを展開する。 */
export function revealSelectionInCollapsedHeadings(state: EditorState): EditorState {
	const effects = unfoldEffectsContainingSelection(state);
	return effects.length > 0 ? state.update({ effects }).state : state;
}

/** アウトラインで指定した見出し自身と、それを隠している親見出しを展開する。 */
export function revealHeadingInCollapsedHeadings(state: EditorState, headingFrom: number): EditorState {
	const effects = unfoldEffectsForHeading(state, headingFrom);
	return effects.length > 0 ? state.update({ effects }).state : state;
}

/** アウトラインで指定した見出し自身と、それを隠している親見出しを展開する。 */
export function expandHeadingAt(view: EditorView, headingFrom: number): boolean {
	const effects = unfoldEffectsForHeading(view.state, headingFrom);
	if (effects.length === 0) return false;
	view.dispatch({ effects, userEvent: 'unfold.heading.outline' });
	return true;
}

/** 文書内の全見出しを折りたたむ。 */
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

/** 文書内の全見出しを展開する。 */
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

/** 折りたたみ可能な見出しがあるか。 */
export function hasFoldableHeadings(state: EditorState): boolean {
	return collectHeadingFoldRanges(state).length > 0;
}

/** 折りたたみ中の見出しがあるか。 */
export function hasCollapsedHeadings(state: EditorState): boolean {
	return getCollapsedHeadingFroms(state).length > 0;
}

/** 見出し専用ガターと折りたたみ状態をEditorへ追加する。 */
export function createHeadingFoldExtensions(options: HeadingFoldExtensionOptions = {}): Extension[] {
	const markers = ViewPlugin.fromClass(class {
		public markers = RangeSet.empty as RangeSet<GutterMarker>;

		/** 初期表示用の見出しマーカーを作る。 */
		constructor(view: EditorView) {
			this.markers = buildHeadingFoldMarkers(view);
		}

		/** 文書・表示範囲・折りたたみ状態の変化をガターへ反映する。 */
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
			/** 表示範囲内の見出しマーカーを返す。 */
			markers(view) {
				return view.plugin(markers)?.markers ?? RangeSet.empty;
			},
			/** ガター幅を確保する初期マーカーを返す。 */
			initialSpacer() {
				return new HeadingFoldMarker(false);
			},
			domEventHandlers: {
				/** クリックした見出しの折りたたみ状態を切り替える。 */
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

/** 見出しガターに表示する展開状態マーカー。 */
class HeadingFoldMarker extends GutterMarker {
	/** 表示する状態を保持する。 */
	constructor(readonly collapsed: boolean) {
		super();
	}

	/** 同一表示状態ならマーカーを再利用できる。 */
	eq(other: GutterMarker): boolean {
		return other instanceof HeadingFoldMarker && other.collapsed === this.collapsed;
	}

	/** ガター用DOMを生成する。 */
	toDOM(): Node {
		const marker       = document.createElement('span');
		marker.className   = 'cm-headingFoldMarker';
		marker.textContent = this.collapsed ? '▶' : '▼';
		marker.title       = this.collapsed ? '見出しを展開' : '見出しを折りたたむ';
		marker.setAttribute('aria-hidden', 'true');
		return marker;
	}
}

/** 現在の表示範囲にある見出しマーカーを構築する。 */
function buildHeadingFoldMarkers(view: EditorView): RangeSet<GutterMarker> {
	const builder = new RangeSetBuilder<GutterMarker>();
	for (const range of collectHeadingFoldRanges(view.state)) {
		const line = view.state.doc.lineAt(range.headingFrom);
		if (line.to < view.viewport.from || line.from > view.viewport.to) continue;
		builder.add(line.from, line.from, new HeadingFoldMarker(isFoldedRange(view.state, range)));
	}
	return builder.finish();
}

/** 指定した見出し範囲が現在折りたたまれているか判定する。 */
function isFoldedRange(state: EditorState, range: HeadingFoldRange): boolean {
	let found = false;
	foldedRanges(state).between(range.from, range.from, (from, to) => {
		if (from === range.from && to === range.to) found = true;
	});
	return found;
}

/** 現在の選択範囲を隠す折りたたみ見出しの展開Effectを返す。 */
function unfoldEffectsContainingSelection(state: EditorState): StateEffect<unknown>[] {
	return collectHeadingFoldRanges(state)
		.filter((range) => isFoldedRange(state, range))
		.filter((range) => state.selection.ranges.some((selection) => (
			(range.from < selection.anchor && selection.anchor <= range.to)
			|| (range.from < selection.head && selection.head <= range.to)
		)))
		.map((range) => unfoldEffect.of({ from: range.from, to: range.to }));
}

/** 指定見出し自身と、その位置を隠している親見出しの展開Effectを返す。 */
function unfoldEffectsForHeading(state: EditorState, headingFrom: number): StateEffect<unknown>[] {
	return collectHeadingFoldRanges(state)
		.filter((range) => isFoldedRange(state, range))
		.filter((range) => range.headingFrom === headingFrom || (range.from < headingFrom && headingFrom <= range.to))
		.map((range) => unfoldEffect.of({ from: range.from, to: range.to }));
}
