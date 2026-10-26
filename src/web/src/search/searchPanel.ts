/**
 * 検索パネルの開閉、一致の移動、置換、スクロール補正をエディタ状態へつなぐ
 * @file
 */

import { EditorSelection, Facet, StateEffect, StateField, type Extension, type Transaction } from '@codemirror/state';
import { SearchQuery, closeSearchPanel, getSearchQuery, openSearchPanel, replaceAll, replaceNext, search, searchPanelOpen, setSearchQuery } from '@codemirror/search';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type Panel, type ViewUpdate } from '@codemirror/view';
import { countSearchMatches, findSearchMatchFromPosition, findSearchMatchFromRange, getRegularExpressionError, type SearchMatchDirection, type SearchMatchRange } from './searchLogic';
import { calloutFoldField, isCalloutCollapsed, setCalloutFoldEffect } from '../livePreview/calloutFold';
import { findCalloutContainingRange } from '../livePreview/lineDecorations';
import type { SearchSettings } from '../types/app';

/**
 * 検索パネルのモード
 * `find` は検索だけ、`replace` は置換欄も出す
 */
type SearchPanelMode = 'find' | 'replace';

/**
 * 検索の移動がコールアウトの開閉を戻すかどうか
 */
type SearchBehaviorSettings = {
	/** 次の一致へ移ったあと、検索で開いたコールアウトを元の折りたたみへ戻すか */
	restoreCalloutFoldStateOnMove: boolean;
};

/** パネルを検索か置換のどちらで開くかを渡す effect */
const setSearchPanelModeEffect     = StateEffect.define<SearchPanelMode>();
/** CodeMirror 標準の一致へのスクロールを置き換える印。位置合わせはこちらの補正が行う */
const noSearchScrollEffect         = StateEffect.define<void>();
/** 検索で開いたコールアウトの開始位置を更新する effect。null は自動展開が無い */
const setAutoExpandedCalloutEffect = StateEffect.define<number | null>({
	/**
	 * ドキュメント変更後も自動展開コールアウト位置を追従させる
	 * @param value - コールアウト開始位置
	 * @param changes - 変更情報
	 * @returns 変更後のコールアウト開始位置
	 */
	map: (value, changes) => (value === null ? null : changes.mapPos(value, 1))
});
/** いま強調する一致範囲を更新する effect。null は強調を消す */
const setCurrentSearchMatchEffect  = StateEffect.define<SearchMatchRange | null>({
	/**
	 * ドキュメント変更後も検索一致範囲を可能な限り追従させる
	 * @param value - 現在一致範囲
	 * @param changes - 変更情報
	 * @returns 変更後の一致範囲
	 */
	map: (value, changes) =>
		value
			? {
				// 変更後の開始。一致が無いときはこのオブジェクト自体を作らない
				from: changes.mapPos(value.from),
				// 変更後の終了
				to: changes.mapPos(value.to)
			}
			: null
});

/** スクロール補正の requestMeasure を、他の計測と区別するキー */
const searchScrollCorrectionKey    = {};
/** 一致をビューポート上端から何割の位置へ置くか */
const SEARCH_SCROLL_VIEWPORT_RATIO = 0.35;
/** 端に近すぎるときに再調整する余白（px） */
const SEARCH_SCROLL_MARGIN_PX      = 24;
/** DOM 計測で位置を合わせ直す回数 */
const SEARCH_SCROLL_FINE_ATTEMPTS  = 5;
/** 選択の反映を待ってからスクロールを始めるミリ秒 */
const SEARCH_SCROLL_DELAY_MS       = 35;

/** 設定が無いときの検索挙動。移動後にコールアウトは閉じ直さない */
const defaultSearchBehaviorSettings: SearchBehaviorSettings = {
	restoreCalloutFoldStateOnMove: false
};

/** エディタへ渡した検索設定を、パネルが読む形へ揃える */
const searchBehaviorSettingsFacet = Facet.define<SearchSettings | undefined, SearchBehaviorSettings>({
	/**
	 * 検索挙動設定を統合する
	 * @param values - 設定値
	 * @returns 正規化後設定
	 */
	combine(values: readonly (SearchSettings | undefined)[]): SearchBehaviorSettings {
		// 最後に渡された設定。未設定だけなら undefined で既定の折り戻しを使う
		const latest = [...values].reverse().find((value) => value);
		return {
			restoreCalloutFoldStateOnMove: latest?.restoreCalloutFoldStateOnMove ?? defaultSearchBehaviorSettings.restoreCalloutFoldStateOnMove
		};
	}
});

/** いまの一致に付ける装飾。標準の検索ハイライトとは別に出す */
const currentSearchMatchDecoration = Decoration.mark({
	class: 'cm-searchMatch cm-searchMatch-selected tms-mde-search-current-match'
});

/**
 * 1 回の DOM 計測で分かった、スクロールの修正量
 */
type SearchScrollCorrectionMeasure = {
	/** 一致を目標位置へ動かすスクロール量（px）。正は下方向 */
	delta: number;
	/** 高さが変わったため、もう一度測るか */
	needsRetry: boolean;
};

/**
 * ビューポート上で測った、いまの一致の上下端
 */
type SearchScrollTargetRect = {
	/** ビューポート上端からの一致の上端（px） */
	top: number;
	/** ビューポート上端からの一致の下端（px） */
	bottom: number;
};

/** スクロール補正が追う一致範囲。null は補正をやめる */
type SearchScrollTarget = SearchMatchRange | null;

/** 新しい移動が始まったら true を返し、遅れた補正を捨てる */
type SearchScrollCancelCheck = () => boolean;

/** パネルが検索か置換かを保持する状態 */
const searchPanelModeField = StateField.define<SearchPanelMode>({
	/**
	 * 検索モードの初期値を返す
	 * @returns 初期モード
	 */
	create: () => 'find',
	/**
	 * パネルモード変更を状態へ反映する
	 * @param value - 現在のモード
	 * @param transaction - トランザクション
	 * @returns 更新後のモード
	 */
	update: (value: SearchPanelMode, transaction: Transaction) => {
		for (const effect of transaction.effects) {
			// パネルを検索か置換のどちらで開くか。この effect が無ければ今のモードを残す
			if (effect.is(setSearchPanelModeEffect)) {
				return effect.value;
			}
		}

		return value;
	}
});

/** 検索移動で開いたコールアウトの開始位置。閉じ直すときに使う */
const autoExpandedCalloutField = StateField.define<number | null>({
	/**
	 * 検索移動で自動展開したコールアウト位置の初期値を返す
	 * @returns コールアウト開始位置
	 */
	create: () => null,
	/**
	 * 自動展開コールアウト位置の更新を状態へ反映する
	 * @param value - 現在位置
	 * @param transaction - トランザクション
	 * @returns 更新後位置
	 */
	update: (value: number | null, transaction: Transaction) => {
		// 文書変更後の開始位置。未展開の null は追従させず null のまま
		let nextValue = transaction.docChanged && value !== null ? transaction.changes.mapPos(value, 1) : value;

		for (const effect of transaction.effects) {
			// 自動展開の指定。null は展開が無い。文書追従より後に来た指定が残る
			if (effect.is(setAutoExpandedCalloutEffect)) {
				nextValue = effect.value;
			}
		}

		return nextValue;
	}
});

/** いまの一致範囲。文書編集後も追従する */
const currentSearchMatchField = StateField.define<SearchMatchRange | null>({
	/**
	 * 現在の検索一致範囲の初期値を返す
	 * @returns 初期一致範囲
	 */
	create: () => null,
	/**
	 * 検索一致範囲の更新を状態へ反映する
	 * @param value - 現在一致範囲
	 * @param transaction - トランザクション
	 * @returns 更新後の一致範囲
	 */
	update: (value: SearchMatchRange | null, transaction: Transaction) => {
		// 文書変更後の範囲。一致が無い、または文書が変わっていなければ今の値
		let nextValue =
			transaction.docChanged && value
				? {
					// 変更後の開始
					from: transaction.changes.mapPos(value.from),
					// 変更後の終了
					to: transaction.changes.mapPos(value.to)
				}
				: value;

		for (const effect of transaction.effects) {
			// 検索文字列が変わった。古い一致は捨てる
			if (effect.is(setSearchQuery)) {
				nextValue = null;
			}

			// 明示の現在一致。同じトランザクションでクエリも変わったときはこちらが後に残る
			if (effect.is(setCurrentSearchMatchEffect)) {
				nextValue = effect.value;
			}
		}

		return nextValue;
	},
	/**
	 * 現在一致範囲をライブプレビューと干渉しにくい独自マーカーで描画する
	 * @param field - 状態フィールド
	 * @returns デコレーション拡張
	 */
	provide: (field) => EditorView.decorations.from(field, (match): DecorationSet => (match && match.from < match.to ? Decoration.set([currentSearchMatchDecoration.range(match.from, match.to)]) : Decoration.none))
});

/**
 * 検索パネルを検索モードで開く
 * @param view - エディタビュー
 * @returns コマンド処理結果
 */
export function openFindPanel(view: EditorView): boolean {
	// パネルを開く前に検索モードへする。開く処理がモードを読む
	view.dispatch({ effects: setSearchPanelModeEffect.of('find') });
	// パネルを開けたか。false でもモードは検索のままにする
	const handled = openSearchPanel(view);
	// 開いた後も検索モードを維持する。開く処理がモードを変えても戻す
	view.dispatch({ effects: setSearchPanelModeEffect.of('find') });
	return handled;
}

/**
 * 検索パネルを置換モードで開く
 * @param view - エディタビュー
 * @returns コマンド処理結果
 */
export function openReplacePanel(view: EditorView): boolean {
	// パネルを開く前に置換モードへする。開く処理がモードを読む
	view.dispatch({ effects: setSearchPanelModeEffect.of('replace') });
	// パネルを開けたか。false でもモードは置換のままにする
	const handled = openSearchPanel(view);
	// 開いた後も置換モードを維持する
	view.dispatch({ effects: setSearchPanelModeEffect.of('replace') });
	return handled;
}

/**
 * 検索パネルが開いている場合に閉じる
 * @param view - エディタビュー
 * @returns 閉じた場合 true
 */
export function closeOpenSearchPanel(view: EditorView): boolean {
	// パネルが閉じていれば、一致解除も閉じる処理もしない
	if (!searchPanelOpen(view.state)) {
		return false;
	}

	clearCurrentSearchMatch(view);
	return closeSearchPanel(view);
}

/**
 * 現在の検索条件で次 / 前の一致へ移動する
 * @param view - エディタビュー
 * @param direction - 検索方向
 * @returns 移動した場合 true
 */
export function moveToSearchMatch(view: EditorView, direction: SearchMatchDirection): boolean {
	// いまの検索条件。無効なら移動先は無い
	const query = getSearchQuery(view.state);
	// 現在の一致から見た隣。一致が無ければ null
	const match = findSearchMatchFromRange(view.state, query, view.state.field(currentSearchMatchField), direction);
	// 隣が無い。ハイライトを外して移動しない
	if (!match) {
		clearCurrentSearchMatch(view);
		return false;
	}

	setCurrentSearchMatch(view, match);
	return true;
}

/**
 * 検索条件更新と現在一致への移動を同一トランザクションで反映する
 * @param view - エディタビュー
 * @param query - 検索条件
 * @param position - 検索基準位置
 * @param direction - 検索方向
 * @returns 移動先がある場合 true
 */
function setSearchQueryAndMoveFromPosition(view: EditorView, query: SearchQuery, position: number, direction: SearchMatchDirection): boolean {
	// 基準位置から見た移動先。無ければ null
	const match = findSearchMatchFromPosition(view.state, query, position, direction);
	// 移動先が無い。条件だけ更新し、一致表示は外す
	if (!match) {
		// 条件の更新と一致解除を同じトランザクションにする
		view.dispatch({
			// 新しい条件と、一致を消す印
			effects: [setSearchQuery.of(query), ...getClearSearchEffects(view)]
		});
		return false;
	}

	// 条件更新と一致への移動を同じトランザクションにする
	view.dispatch({
		// 新しい条件と、一致を出す印
		effects: [setSearchQuery.of(query), ...getSearchMatchEffects(view, match)],
		// 実選択は一致の先頭の空キャレット。範囲選択にはしない
		selection: EditorSelection.cursor(match.from),
		// 検索移動であることを示す userEvent
		userEvent: 'select.search'
	});
	return true;
}

/**
 * 現在の検索一致範囲を反映し、実選択はカーソルだけへ畳む
 * @param view - エディタビュー
 * @param match - 検索一致範囲
 */
function setCurrentSearchMatch(view: EditorView, match: SearchMatchRange): void {
	// 一致の表示と、実選択を先頭へ畳む更新
	view.dispatch({
		// コールアウト展開と現在一致の印
		effects: getSearchMatchEffects(view, match),
		// 実選択は一致の先頭。範囲はハイライト側が持つ
		selection: EditorSelection.cursor(match.from),
		// 検索移動であることを示す userEvent
		userEvent: 'select.search'
	});
}

/**
 * 検索一致を表示するために必要な Effect を生成する
 * @param view - エディタビュー
 * @param match - 検索一致範囲
 * @returns 検索一致反映 Effect
 */
function getSearchMatchEffects(view: EditorView, match: SearchMatchRange): StateEffect<unknown>[] {
	// この移動で足す印。空のまま返すことはない
	const effects: StateEffect<unknown>[] = [];
	// 検索の折りたたみ挙動。移動のたびに折りを戻すかが入る
	const settings                        = view.state.facet(searchBehaviorSettingsFacet);
	// 移動のたびに、検索で開いたコールアウトを閉じ直すか
	const shouldRestoreCalloutFoldState   = settings.restoreCalloutFoldStateOnMove;
	// 検索で開いたコールアウトの開始位置。開いていなければ null
	const autoExpandedCalloutFrom         = view.state.field(autoExpandedCalloutField, false) ?? null;
	// 一致を含むコールアウト。外なら null
	const targetCallout                   = findCalloutContainingRange(view.state, match.from, match.to);
	// 一致先コールアウトの開始位置。外なら null
	const targetCalloutFrom               = targetCallout?.calloutFrom ?? null;

	// 戻す設定があり、開いたコールアウトと一致先が同じときだけその位置を維持する。どちらか一方では null
	let nextAutoExpandedCalloutFrom: number | null = shouldRestoreCalloutFoldState && autoExpandedCalloutFrom === targetCalloutFrom ? autoExpandedCalloutFrom : null;

	// 戻す設定があり、別のコールアウトを開いたまま。三つ揃わないときは閉じ直さない
	if (shouldRestoreCalloutFoldState && autoExpandedCalloutFrom !== null && autoExpandedCalloutFrom !== targetCalloutFrom) {
		// 前に開いたコールアウトを閉じる
		effects.push(
			setCalloutFoldEffect.of({
				// 閉じるコールアウトの開始位置
				from: autoExpandedCalloutFrom,
				// 折りたたむ
				collapsed: true
			})
		);
	}

	// 一致先のコールアウトがあり、かつ折りたたまれている。どちらか一方では開かない
	if (targetCallout && isTargetCalloutCollapsed(view, targetCallout)) {
		// 一致が見えるよう、そのコールアウトを開く
		effects.push(
			setCalloutFoldEffect.of({
				// 開くコールアウトの開始位置
				from: targetCallout.calloutFrom,
				// 展開する
				collapsed: false
			})
		);
		nextAutoExpandedCalloutFrom = shouldRestoreCalloutFoldState ? targetCallout.calloutFrom : null;
	}

	// 検索で開いた位置の記録が変わるときだけ更新する
	if (nextAutoExpandedCalloutFrom !== autoExpandedCalloutFrom) {
		effects.push(setAutoExpandedCalloutEffect.of(nextAutoExpandedCalloutFrom));
	}

	effects.push(setCurrentSearchMatchEffect.of(match));
	return effects;
}

/**
 * 検索一致解除時に必要な Effect を生成する
 * @param view - エディタビュー
 * @returns 検索一致解除 Effect
 */
function getClearSearchEffects(view: EditorView): StateEffect<unknown>[] {
	// 一致を消すときに足す印
	const effects: StateEffect<unknown>[] = [];
	// 折りを戻す設定
	const settings                        = view.state.facet(searchBehaviorSettingsFacet);
	// 検索で開いたコールアウトの開始位置。無ければ null
	const autoExpandedCalloutFrom         = view.state.field(autoExpandedCalloutField, false) ?? null;

	// 戻す設定があり、開いたコールアウトがある。どちらか一方では閉じ直さない
	if (settings.restoreCalloutFoldStateOnMove && autoExpandedCalloutFrom !== null) {
		// 検索で開いたコールアウトを閉じる
		effects.push(
			setCalloutFoldEffect.of({
				// 閉じるコールアウトの開始位置
				from: autoExpandedCalloutFrom,
				// 折りたたむ
				collapsed: true
			})
		);
	}

	// 開いた記録が残っている。設定に関係なく記録自体は消す
	if (autoExpandedCalloutFrom !== null) {
		effects.push(setAutoExpandedCalloutEffect.of(null));
	}

	effects.push(setCurrentSearchMatchEffect.of(null));
	return effects;
}

/**
 * コールアウトが現在折りたたみ中かを判定する
 * @param view - エディタビュー
 * @param callout - コールアウト情報
 * @returns 折りたたみ中なら true
 */
function isTargetCalloutCollapsed(view: EditorView, callout: { calloutFrom: number; foldDefault: 'none' | 'collapsed' | 'expanded' }): boolean {
	// 折りたたみの上書き。フィールドが無ければ空で、既定の折りだけを見る
	const overrides = view.state.field(calloutFoldField, false) ?? new Map<number, boolean>();
	return isCalloutCollapsed(overrides, callout.calloutFrom, callout.foldDefault);
}

/**
 * 現在の検索一致範囲をクリアする
 * @param view - エディタビュー
 */
function clearCurrentSearchMatch(view: EditorView): void {
	view.dispatch({ effects: getClearSearchEffects(view) });
}

/**
 * 検索スクロール対象が同じかを判定する
 * @param left - 比較対象
 * @param right - 比較対象
 * @returns 同じ場合 true
 */
function isSameSearchScrollTarget(left: SearchScrollTarget, right: SearchScrollTarget): boolean {
	// どちらかが一致なし。両方 null のときだけ同じとみなす
	if (!left || !right) {
		return left === right;
	}

	return left.from === right.from && left.to === right.to;
}

/**
 * 現在状態が指定スクロール対象をまだ指しているかを判定する
 * @param view - エディタビュー
 * @param target - スクロール対象
 * @returns 有効な対象の場合 true
 */
function isActiveSearchScrollTarget(view: EditorView, target: SearchScrollTarget): boolean {
	return isSameSearchScrollTarget(view.state.field(currentSearchMatchField), target);
}

/**
 * 現在ヒットの DOM 座標を取得する
 * @param view - エディタビュー
 * @returns 座標。未描画の場合 null
 */
function getCurrentSearchMatchRect(view: EditorView): SearchScrollTargetRect | null {
	// 現在一致のハイライト要素。未描画なら null
	const element = view.dom.querySelector('.tms-mde-search-current-match');
	// 要素が無い、または HTML 要素ではない
	if (!(element instanceof HTMLElement)) {
		return null;
	}

	// 画面上の矩形。幅も高さも 0 なら未描画
	const rect = element.getBoundingClientRect();
	// 幅も高さも 0。どちらか一方でも大きさがあれば座標として使う
	if (rect.height <= 0 && rect.width <= 0) {
		return null;
	}

	// スクロール補正に使う縦範囲
	return {
		// 上端。単位は CSS ピクセル
		top: rect.top,
		// 下端。単位は CSS ピクセル
		bottom: rect.bottom
	};
}

/**
 * 現在ヒットの DOM が未描画の場合にカーソル座標を取得する
 * @param view - エディタビュー
 * @returns 座標。取得不可の場合 null
 */
function getSearchCursorRect(view: EditorView): SearchScrollTargetRect | null {
	// 主選択。ハイライトが無いときの座標の基準
	const selection = view.state.selection.main;
	// 選択開始、終了、head の順で画面座標を試す。どれも無ければ null
	const coords    = view.coordsAtPos(selection.from, 1) ?? view.coordsAtPos(selection.to, -1) ?? view.coordsAtPos(selection.head);

	return coords
		? {
			// 上端。単位は CSS ピクセル
			top: coords.top,
			// 下端。単位は CSS ピクセル
			bottom: coords.bottom
		}
		: null;
}

/**
 * 現在の独自ハイライト一致を置換して次へ移動する
 * @param view - エディタビュー
 * @returns 置換した場合 true
 */
function replaceCurrentSearchMatch(view: EditorView): boolean {
	// いまハイライトしている一致。無ければ null で置換コマンドに任せる
	const current = view.state.field(currentSearchMatchField);
	// 独自ハイライトがあるときだけ、置換前にその範囲を実選択へ戻す
	if (current) {
		view.dispatch({
			effects: setCurrentSearchMatchEffect.of(null),
			selection: EditorSelection.single(current.from, current.to)
		});
	}

	// 次の一致を置換できたか。できなければハイライトは付け直さない
	const handled = replaceNext(view);
	// 置換できなかった
	if (!handled) {
		return false;
	}

	// 置換後の主選択。空なら次のハイライトは付けない
	const selection = view.state.selection.main;
	// 置換結果が範囲選択のときだけ、それを現在一致にする
	if (!selection.empty) {
		setCurrentSearchMatch(view, {
			from: selection.from,
			to: selection.to
		});
	}

	return true;
}

/**
 * すべて置換して現在一致範囲をクリアする
 * @param view - エディタビュー
 * @returns 置換した場合 true
 */
function replaceAllSearchMatches(view: EditorView): boolean {
	// すべて置換できたか。できなければハイライトは残す
	const handled = replaceAll(view);
	// 置換できたときだけ現在一致を消す
	if (handled) {
		clearCurrentSearchMatch(view);
	}

	return handled;
}

/**
 * 検索選択位置へ行番号ベースで直接スクロールする
 * @param view - エディタビュー
 * @param target - スクロール対象
 * @param isCanceled - キャンセル判定
 */
function scrollSearchSelectionIntoView(view: EditorView, target: SearchScrollTarget, isCanceled: SearchScrollCancelCheck): void {
	// より新しい移動で無効、または対象がもう現在一致ではない。どちらかならスクロールしない
	if (isCanceled() || !isActiveSearchScrollTarget(view, target)) {
		return;
	}

	// エディタのスクロール領域
	const scroller = view.scrollDOM;
	// DOM から外れている、または高さが 0。どちらかなら測れない
	if (!scroller.isConnected || scroller.clientHeight <= 0) {
		return;
	}

	// 主選択。現在一致が無いときの位置
	const selection     = view.state.selection.main;
	// いまの一致。無ければ選択位置へスクロールする
	const currentMatch  = view.state.field(currentSearchMatchField);
	// 行塊を取る文書位置。一致が無ければ選択の開始
	const scrollPos     = currentMatch?.from ?? selection.from;
	// その位置の行塊。上端が scrollTop の基準
	const lineBlock     = view.lineBlockAt(scrollPos);
	// 上端から下げる量。可視高さの 35%。単位は CSS ピクセル
	const viewportShift = scroller.clientHeight * SEARCH_SCROLL_VIEWPORT_RATIO;
	// これ以上動かせない scrollTop。内容が高さ以下なら 0
	const maxScrollTop  = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
	// 余白を引いて 0 から下端までに収めた scrollTop
	const targetTop     = Math.min(Math.max(0, lineBlock.top - viewportShift), maxScrollTop);

	scroller.scrollTop = targetTop;
	view.requestMeasure();
	requestAnimationFrame(() => {
		requestAnimationFrame(() => {
			correctSearchScrollFromDom(view, target, isCanceled);
		});
	});
}

/**
 * 実 DOM 座標を使って検索選択位置のスクロールを微調整する
 * @param view - エディタビュー
 * @param target - スクロール対象
 * @param isCanceled - キャンセル判定
 * @param attempts - 残り試行回数
 */
function correctSearchScrollFromDom(view: EditorView, target: SearchScrollTarget, isCanceled: SearchScrollCancelCheck, attempts = SEARCH_SCROLL_FINE_ATTEMPTS): void {
	// より新しい移動で無効、または対象がもう現在一致ではない。どちらかなら測らない
	if (isCanceled() || !isActiveSearchScrollTarget(view, target)) {
		return;
	}

	view.requestMeasure<SearchScrollCorrectionMeasure>({
		key: searchScrollCorrectionKey,
		/**
		 * 選択位置の実 DOM 座標から追加スクロール量を計算する
		 * @param measuredView - エディタビュー
		 * @returns 補正情報
		 */
		read(measuredView) {
			// 計測の時点で無効、または対象が変わった。どちらかなら動かさない
			if (isCanceled() || !isActiveSearchScrollTarget(measuredView, target)) {
				// 追加スクロールはせず、再計測もしない
				return {
					// 足す scrollTop。単位は CSS ピクセル。0 は動かさない
					delta: 0,
					// 高さがまだ安定していないときの再計測。ここでは打ち切る
					needsRetry: false
				};
			}

			// エディタのスクロール領域
			const scroller = measuredView.scrollDOM;
			// DOM から外れている、または高さが 0。どちらかなら座標が無い
			if (!scroller.isConnected || scroller.clientHeight <= 0) {
				return {
					delta: 0,
					needsRetry: false
				};
			}

			// ハイライトの矩形。未描画ならカーソル座標。どちらも無ければ null
			const rect = getCurrentSearchMatchRect(measuredView) ?? getSearchCursorRect(measuredView);
			// まだ描画されていない。残り試行があるときだけもう一度測る
			if (!rect) {
				return {
					delta: 0,
					// 初回以外が残っているときだけ再計測する
					needsRetry: attempts > 1
				};
			}

			// スクロール領域の画面上の矩形
			const scrollerRect = scroller.getBoundingClientRect();
			// これより上には置かない上端。余白は 24px
			const topLimit     = scrollerRect.top + SEARCH_SCROLL_MARGIN_PX;
			// これより下にはみ出さない下端。余白は 24px
			const bottomLimit  = scrollerRect.bottom - SEARCH_SCROLL_MARGIN_PX;
			// 一致の上端を置きたい画面位置。可視高さの 35%
			const desiredTop   = scrollerRect.top + scroller.clientHeight * SEARCH_SCROLL_VIEWPORT_RATIO;
			// 目標との差。正なら下へ動かす。単位は CSS ピクセル
			const delta        = rect.top - desiredTop;
			// 差が 4px 以内で、かつ上下の余白にも収まっている。片方でも欠ければ動かす
			if (Math.abs(delta) <= 4 && rect.top >= topLimit && rect.bottom <= bottomLimit) {
				return {
					delta: 0,
					needsRetry: false
				};
			}

			// まだ目標から外れているときの修正量
			return {
				// 足す scrollTop。単位は CSS ピクセル
				delta,
				// 反映後にもう一度測るか。残り試行が 1 ならここで終える
				needsRetry: attempts > 1
			};
		},
		/**
		 * 追加スクロール量を反映する
		 * @param measure - 補正情報
		 * @param measuredView - エディタビュー
		 */
		write(measure, measuredView) {
			// 反映前に無効、または対象が変わった。どちらかなら scrollTop を変えない
			if (isCanceled() || !isActiveSearchScrollTarget(measuredView, target)) {
				return;
			}

			// 1px を超える差だけ動かす。それ以下は誤差として残す
			if (Math.abs(measure.delta) > 1) {
				measuredView.scrollDOM.scrollTop += measure.delta;
			}

			// 再計測が必要で、かつ残り試行がある。片方だけでは繰り返さない
			if (measure.needsRetry && attempts > 1) {
				requestAnimationFrame(() => {
					correctSearchScrollFromDom(measuredView, target, isCanceled, attempts - 1);
				});
			}
		}
	});
}

/**
 * 検索移動後のスクロール補正プラグイン
 */
const searchScrollPlugin = ViewPlugin.define((view) => {
	// 何回目の移動か。遅れた補正が古い移動なら捨てる
	let scrollGeneration = 0;

	// 選択反映を待つタイマー。予約が無ければ null
	let scrollTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * 予約済みスクロールを取り消す
	 */
	const cancelPendingScroll = (): void => {
		scrollGeneration += 1;
		// まだ発火していないタイマーがある
		if (scrollTimer !== null) {
			clearTimeout(scrollTimer);
			scrollTimer = null;
		}
	};

	return {
		/**
		 * エディタ更新を監視する
		 * @param update - 更新情報
		 */
		update(update: ViewUpdate): void {
			// 選択が変わっていない、または検索の移動ではない。どちらかならスクロールを予約しない
			if (!update.selectionSet || !update.transactions.some((transaction) => transaction.isUserEvent('select.search'))) {
				return;
			}

			cancelPendingScroll();
			// この予約の世代。次の移動でずれたら補正しない
			const generation = scrollGeneration;
			// 予約時点の一致。無ければ null で補正をやめる
			const target     = view.state.field(currentSearchMatchField);
			scrollTimer      = setTimeout(() => {
				scrollTimer = null;
				requestAnimationFrame(() => {
					scrollSearchSelectionIntoView(view, target, () => generation !== scrollGeneration);
				});
			}, SEARCH_SCROLL_DELAY_MS);
		},
		/**
		 * プラグイン破棄時に予約済みスクロールを取り消す
		 */
		destroy(): void {
			cancelPendingScroll();
		}
	};
});

/**
 * TMS-MDEditor の検索拡張を生成する
 * @param settings - 検索設定
 * @returns 検索拡張
 */
export function createSearchExtensions(settings?: SearchSettings): Extension[] {
	return [
		searchBehaviorSettingsFacet.of(settings),
		searchPanelModeField,
		autoExpandedCalloutField,
		currentSearchMatchField,
		searchScrollPlugin,
		search({
			top: true,
			/**
			 * 検索一致のスクロールは searchScrollPlugin 側で行う
			 * @param range - 一致範囲
			 * @returns スクロール効果
			 */
			scrollToMatch: () => noSearchScrollEffect.of(),
			/**
			 * 日本語検索パネルを生成する
			 * @param view - エディタビュー
			 * @returns 検索パネル
			 */
			createPanel: (view) => new TmsSearchPanel(view)
		})
	];
}

/**
 * 日本語 UI の検索・置換パネル
 */
class TmsSearchPanel implements Panel {
	/** パネルのルート。CodeMirror がこの要素をエディタの上へ置く */
	public readonly dom: HTMLElement;

	/** エディタ上部へ出す。false なら下部 */
	public readonly top = true;

	/** パネルの並び順。大きいほど後ろ */
	public readonly pos = 80;

	/** いまパネルが編集している検索条件 */
	private query: SearchQuery;

	/** 検索か置換か */
	private mode: SearchPanelMode;

	/** 検索文字列の入力 */
	private readonly searchInput: HTMLInputElement;

	/** 置換後文字列の入力 */
	private readonly replaceInput: HTMLInputElement;

	/** 大文字小文字を区別するチェック */
	private readonly caseInput: HTMLInputElement;

	/** 正規表現として扱うチェック */
	private readonly regexpInput: HTMLInputElement;

	/** 単語単位で探すチェック */
	private readonly wordInput: HTMLInputElement;

	/** 置換モードのときだけ出す行 */
	private readonly replaceRow: HTMLElement;

	/** 一致件数の表示 */
	private readonly matchStatus: HTMLElement;

	/** 正規表現のエラー表示 */
	private readonly errorStatus: HTMLElement;

	/** 検索中に無効にするボタン */
	private readonly actionButtons: HTMLButtonElement[] = [];

	/** パネルを開いたときのキャレット位置。次の一致の起点 */
	private readonly searchAnchor: number;

	/**
	 * 検索パネルを初期化する
	 * @param view - エディタビュー
	 */
	public constructor(private readonly view: EditorView) {
		this.query        = getSearchQuery(view.state);
		this.mode         = view.state.field(searchPanelModeField);
		this.searchAnchor = view.state.selection.main.from;

		this.searchInput = this.createTextInput('検索', 'search');
		this.searchInput.setAttribute('main-field', 'true');
		this.searchInput.value = this.query.search;

		this.replaceInput       = this.createTextInput('置換後の文字列', 'replace');
		this.replaceInput.value = this.query.replace;

		this.caseInput   = this.createCheckbox('case', this.query.caseSensitive);
		this.regexpInput = this.createCheckbox('regexp', this.query.regexp);
		this.wordInput   = this.createCheckbox('word', this.query.wholeWord);

		this.matchStatus           = document.createElement('span');
		this.matchStatus.className = 'tms-mde-search-count';
		this.matchStatus.setAttribute('aria-live', 'polite');

		this.errorStatus           = document.createElement('div');
		this.errorStatus.className = 'tms-mde-search-error';
		this.errorStatus.setAttribute('role', 'alert');

		// 検索語と移動ボタンの行
		const findRow      = this.createFindRow();
		// 大文字、正規表現、単語単位の行
		const optionsRow   = this.createOptionsRow();
		this.replaceRow    = this.createReplaceRow();
		// パネル全体。CodeMirror の検索パネルクラスに載せる
		this.dom           = document.createElement('div');
		this.dom.className = 'cm-search tms-mde-search-panel';
		// Escape と Enter をパネル操作へ渡す。ボタン上の Enter はボタン側に残す
		this.dom.addEventListener('keydown', (event) => {
			this.handleKeydown(event);
		});
		this.dom.append(findRow, optionsRow, this.replaceRow, this.errorStatus);

		this.bindInputs();
		this.render();
	}

	/**
	 * パネルをマウントした直後に検索欄を選択する
	 */
	public mount(): void {
		this.searchInput.select();
	}

	/**
	 * エディタ更新をパネルへ反映する
	 * @param update - 更新情報
	 */
	public update(update: ViewUpdate): void {
		// 状態側の検索か置換。パネル表示と違えば合わせる
		const nextMode = update.state.field(searchPanelModeField);
		// モードが変わったときだけパネル側を更新する
		if (nextMode !== this.mode) {
			this.mode = nextMode;
		}

		for (const transaction of update.transactions) {
			for (const effect of transaction.effects) {
				// 外部の条件変更で、パネルの入力と違うときだけ取り込む。同じ条件では入らない
				if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) {
					this.setQuery(effect.value);
				}
			}
		}

		this.render();
	}

	/**
	 * 検索行を生成する
	 * @returns 検索行
	 */
	private createFindRow(): HTMLElement {
		// 検索入力と移動ボタンを横に並べる行
		const row     = document.createElement('div');
		row.className = 'tms-mde-search-row tms-mde-search-find-row';
		row.append(
			this.searchInput,
			this.createButton('前へ', '前の一致へ移動 (Shift+Enter)', () => moveToSearchMatch(this.view, 'previous')),
			this.createButton('次へ', '次の一致へ移動 (Enter)', () => moveToSearchMatch(this.view, 'next')),
			this.matchStatus,
			this.createButton('×', '検索パネルを閉じる', () => closeOpenSearchPanel(this.view), 'tms-mde-search-close')
		);
		return row;
	}

	/**
	 * 検索オプション行を生成する
	 * @returns オプション行
	 */
	private createOptionsRow(): HTMLElement {
		// 検索オプションを横に並べる行
		const row     = document.createElement('div');
		row.className = 'tms-mde-search-row tms-mde-search-options';
		row.append(this.createCheckboxLabel(this.caseInput, '大文字小文字を区別'), this.createCheckboxLabel(this.regexpInput, '正規表現'), this.createCheckboxLabel(this.wordInput, '単語単位'));
		return row;
	}

	/**
	 * 置換行を生成する
	 * @returns 置換行
	 */
	private createReplaceRow(): HTMLElement {
		// 置換語と置換ボタンを横に並べる行。検索モードでは隠す
		const row     = document.createElement('div');
		row.className = 'tms-mde-search-row tms-mde-search-replace-row';
		row.append(
			this.replaceInput,
			this.createButton('置換して次へ', '現在の一致を置換して次へ移動', () => replaceCurrentSearchMatch(this.view)),
			this.createButton('すべて置換', 'すべての一致を置換', () => replaceAllSearchMatches(this.view))
		);
		return row;
	}

	/**
	 * テキスト入力を生成する
	 * @param placeholder - プレースホルダー
	 * @param name - フィールド名
	 * @returns 入力要素
	 */
	private createTextInput(placeholder: string, name: string): HTMLInputElement {
		// 検索語か置換語の入力。名前でどちら側かを分ける
		const input       = document.createElement('input');
		input.type        = 'text';
		input.name        = name;
		input.placeholder = placeholder;
		input.setAttribute('aria-label', placeholder);
		input.className = 'cm-textfield tms-mde-search-input';
		return input;
	}

	/**
	 * チェックボックスを生成する
	 * @param name - フィールド名
	 * @param checked - 初期状態
	 * @returns チェックボックス
	 */
	private createCheckbox(name: string, checked: boolean): HTMLInputElement {
		// 検索オプションのチェック。初期状態はいまのクエリ
		const input   = document.createElement('input');
		input.type    = 'checkbox';
		input.name    = name;
		input.checked = checked;
		return input;
	}

	/**
	 * チェックボックスラベルを生成する
	 * @param input - チェックボックス
	 * @param text - ラベル
	 * @returns ラベル要素
	 */
	private createCheckboxLabel(input: HTMLInputElement, text: string): HTMLLabelElement {
		// チェックとその説明を一つのラベルにする
		const label = document.createElement('label');
		label.append(input, document.createTextNode(text));
		return label;
	}

	/**
	 * ボタンを生成する
	 * @param text - 表示文言
	 * @param ariaLabel - アクセシブル名
	 * @param action - 実行処理
	 * @param className - 追加クラス
	 * @returns ボタン
	 */
	private createButton(text: string, ariaLabel: string, action: () => boolean, className?: string): HTMLButtonElement {
		// クリックで action を実行するボタン。追加クラスが無ければ検索ボタンの見た目だけ
		const button       = document.createElement('button');
		button.type        = 'button';
		button.textContent = text;
		button.className   = `cm-button${className ? ` ${className}` : ''}`;
		button.setAttribute('aria-label', ariaLabel);
		// クリックで渡された処理を実行する。戻り値はボタン側では見ない
		button.addEventListener('click', () => {
			action();
		});
		this.actionButtons.push(button);
		return button;
	}

	/**
	 * 入力変更を検索状態へ反映する
	 */
	private bindInputs(): void {
		/**
		 * 現在の入力値を検索状態へ反映する
		 */
		const commit        = (): void => {
			this.commitQuery();
		};
		/**
		 * 検索条件を反映して現在の一致へ移動する
		 */
		const commitAndMove = (): void => {
			this.commitQuery(true);
		};
		// 検索語の変更は条件を反映して現在の一致へ移す
		this.searchInput.addEventListener('input', commitAndMove);
		// 置換語の変更は条件だけ反映し、キャレットは動かさない
		this.replaceInput.addEventListener('input', commit);
		// 大文字小文字の切替は条件を反映して一致へ移す
		this.caseInput.addEventListener('change', commitAndMove);
		// 正規表現の切替は条件を反映して一致へ移す
		this.regexpInput.addEventListener('change', commitAndMove);
		// 単語単位の切替は条件を反映して一致へ移す
		this.wordInput.addEventListener('change', commitAndMove);
	}

	/**
	 * 現在のフォーム値を検索クエリへ反映する
	 * @param moveToMatch - 検索一致へ移動する場合 true
	 */
	private commitQuery(moveToMatch = false): void {
		// フォームから作った検索条件。空の検索語もありうる
		const query = new SearchQuery({
			// 検索語。空なら件数は出さない
			search: this.searchInput.value,
			// 置換語。検索モードでも値は持つ
			replace: this.replaceInput.value,
			// 大文字小文字を区別するか
			caseSensitive: this.caseInput.checked,
			// 正規表現として解釈するか
			regexp: this.regexpInput.checked,
			// 単語単位で一致させるか
			wholeWord: this.wordInput.checked
		});
		// 直前と同じ条件。状態も移動もしない
		if (query.eq(this.query)) {
			return;
		}

		this.query = query;
		// 一致へ移動する指定のときだけ、条件更新と移動を同じトランザクションにする
		if (moveToMatch) {
			setSearchQueryAndMoveFromPosition(this.view, query, this.searchAnchor, 'next');
			return;
		}

		this.view.dispatch({ effects: setSearchQuery.of(query) });
	}

	/**
	 * 外部から更新された検索クエリをフォームへ反映する
	 * @param query - 検索クエリ
	 */
	private setQuery(query: SearchQuery): void {
		this.query               = query;
		this.searchInput.value   = query.search;
		this.replaceInput.value  = query.replace;
		this.caseInput.checked   = query.caseSensitive;
		this.regexpInput.checked = query.regexp;
		this.wordInput.checked   = query.wholeWord;
	}

	/**
	 * パネル内キーボード操作を処理する
	 * @param event - キーボードイベント
	 */
	private handleKeydown(event: KeyboardEvent): void {
		// Escape はパネルを閉じる。入力の確定には使わない
		if (event.key === 'Escape') {
			event.preventDefault();
			closeOpenSearchPanel(this.view);
			return;
		}

		// Enter でない、またはボタン上の Enter。どちらかなら既定の動作に任せる
		if (event.key !== 'Enter' || event.target instanceof HTMLButtonElement) {
			return;
		}

		event.preventDefault();
		moveToSearchMatch(this.view, event.shiftKey ? 'previous' : 'next');
	}

	/**
	 * モード、件数、エラー表示を更新する
	 */
	private render(): void {
		this.replaceRow.hidden = this.mode !== 'replace' || this.view.state.readOnly;

		// 正規表現のときだけ構文エラー。正規表現でなければ null
		const regexpError            = this.query.regexp ? getRegularExpressionError(this.query.search) : null;
		this.errorStatus.textContent = regexpError ?? '';
		this.errorStatus.hidden      = regexpError === null;

		// 現在位置と総数。ヒットが無いときは両方 0
		const status                 = countSearchMatches(this.view.state, this.query);
		this.matchStatus.textContent = this.query.search ? `${status.current} / ${status.total}` : '0 / 0';

		// クエリが無効なら閉じる以外のボタンを止める
		const disabled = !this.query.valid;
		for (const button of this.actionButtons) {
			// 閉じるボタン以外を無効化する。閉じるは無効クエリでも押せる
			if (!button.classList.contains('tms-mde-search-close')) {
				button.disabled = disabled;
			}
		}
	}
}
