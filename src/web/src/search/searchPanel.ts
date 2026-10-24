/**
 * 検索パネルの開閉、一致の移動、置換、スクロール補正をエディタ状態へつなぐ
 * @file
 */

import {
	EditorSelection,
	Facet,
	StateEffect,
	StateField,
	type Extension,
	type Transaction,
} from '@codemirror/state';
import {
	SearchQuery,
	closeSearchPanel,
	getSearchQuery,
	openSearchPanel,
	replaceAll,
	replaceNext,
	search,
	searchPanelOpen,
	setSearchQuery,
} from '@codemirror/search';
import {
	Decoration,
	EditorView,
	ViewPlugin,
	type DecorationSet,
	type Panel,
	type ViewUpdate,
} from '@codemirror/view';
import {
	countSearchMatches,
	findSearchMatchFromPosition,
	findSearchMatchFromRange,
	getRegularExpressionError,
	type SearchMatchDirection,
	type SearchMatchRange,
} from './searchLogic';
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
	map: (value, changes) => value === null ? null : changes.mapPos(value, 1),
});
/** いま強調する一致範囲を更新する effect。null は強調を消す */
const setCurrentSearchMatchEffect  = StateEffect.define<SearchMatchRange | null>({
	/**
	 * ドキュメント変更後も検索一致範囲を可能な限り追従させる
	 * @param value - 現在一致範囲
	 * @param changes - 変更情報
	 * @returns 変更後の一致範囲
	 */
	map: (value, changes) => value
		? {
			from: changes.mapPos(value.from),
			to  : changes.mapPos(value.to),
		}
		: null,
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
	restoreCalloutFoldStateOnMove: false,
};

/** エディタへ渡した検索設定を、パネルが読む形へ揃える */
const searchBehaviorSettingsFacet = Facet.define<SearchSettings | undefined, SearchBehaviorSettings>({
	/**
	 * 検索挙動設定を統合する
	 * @param values - 設定値
	 * @returns 正規化後設定
	 */
	combine(values: readonly (SearchSettings | undefined)[]): SearchBehaviorSettings {
		const latest = [...values].reverse().find((value) => value);
		return {
			restoreCalloutFoldStateOnMove: latest?.restoreCalloutFoldStateOnMove
				?? defaultSearchBehaviorSettings.restoreCalloutFoldStateOnMove,
		};
	},
});

/** いまの一致に付ける装飾。標準の検索ハイライトとは別に出す */
const currentSearchMatchDecoration = Decoration.mark({
	class: 'cm-searchMatch cm-searchMatch-selected tms-mde-search-current-match',
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
			if (effect.is(setSearchPanelModeEffect)) {
				return effect.value;
			}
		}

		return value;
	},
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
		let nextValue = transaction.docChanged && value !== null
			? transaction.changes.mapPos(value, 1)
			: value;

		for (const effect of transaction.effects) {
			if (effect.is(setAutoExpandedCalloutEffect)) {
				nextValue = effect.value;
			}
		}

		return nextValue;
	},
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
		let nextValue = transaction.docChanged && value
			? {
				from: transaction.changes.mapPos(value.from),
				to  : transaction.changes.mapPos(value.to),
			}
			: value;

		for (const effect of transaction.effects) {
			if (effect.is(setSearchQuery)) {
				nextValue = null;
			}

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
	provide: (field) => EditorView.decorations.from(field, (match): DecorationSet => (
		match && match.from < match.to
			? Decoration.set([currentSearchMatchDecoration.range(match.from, match.to)])
			: Decoration.none
	)),
});

/**
 * 検索パネルを検索モードで開く
 * @param view - エディタビュー
 * @returns コマンド処理結果
 */
export function openFindPanel(view: EditorView): boolean {
	view.dispatch({ effects: setSearchPanelModeEffect.of('find') });
	const handled = openSearchPanel(view);
	view.dispatch({ effects: setSearchPanelModeEffect.of('find') });
	return handled;
}

/**
 * 検索パネルを置換モードで開く
 * @param view - エディタビュー
 * @returns コマンド処理結果
 */
export function openReplacePanel(view: EditorView): boolean {
	view.dispatch({ effects: setSearchPanelModeEffect.of('replace') });
	const handled = openSearchPanel(view);
	view.dispatch({ effects: setSearchPanelModeEffect.of('replace') });
	return handled;
}

/**
 * 検索パネルが開いている場合に閉じる
 * @param view - エディタビュー
 * @returns 閉じた場合 true
 */
export function closeOpenSearchPanel(view: EditorView): boolean {
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
	const query = getSearchQuery(view.state);
	const match = findSearchMatchFromRange(
		view.state,
		query,
		view.state.field(currentSearchMatchField),
		direction,
	);
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
function setSearchQueryAndMoveFromPosition(
	view: EditorView,
	query: SearchQuery,
	position: number,
	direction: SearchMatchDirection,
): boolean {
	const match = findSearchMatchFromPosition(view.state, query, position, direction);
	if (!match) {
		view.dispatch({
			effects: [
				setSearchQuery.of(query),
				...getClearSearchEffects(view),
			],
		});
		return false;
	}

	view.dispatch({
		effects: [
			setSearchQuery.of(query),
			...getSearchMatchEffects(view, match),
		],
		selection: EditorSelection.cursor(match.from),
		userEvent: 'select.search',
	});
	return true;
}

/**
 * 現在の検索一致範囲を反映し、実選択はカーソルだけへ畳む
 * @param view - エディタビュー
 * @param match - 検索一致範囲
 */
function setCurrentSearchMatch(view: EditorView, match: SearchMatchRange): void {
	view.dispatch({
		effects  : getSearchMatchEffects(view, match),
		selection: EditorSelection.cursor(match.from),
		userEvent: 'select.search',
	});
}

/**
 * 検索一致を表示するために必要な Effect を生成する
 * @param view - エディタビュー
 * @param match - 検索一致範囲
 * @returns 検索一致反映 Effect
 */
function getSearchMatchEffects(view: EditorView, match: SearchMatchRange): StateEffect<unknown>[] {
	const effects: StateEffect<unknown>[] = [];
	const settings                        = view.state.facet(searchBehaviorSettingsFacet);
	const shouldRestoreCalloutFoldState   = settings.restoreCalloutFoldStateOnMove;
	const autoExpandedCalloutFrom         = view.state.field(autoExpandedCalloutField, false) ?? null;
	const targetCallout                   = findCalloutContainingRange(view.state, match.from, match.to);
	const targetCalloutFrom               = targetCallout?.calloutFrom ?? null;

	let nextAutoExpandedCalloutFrom: number | null = shouldRestoreCalloutFoldState
		&& autoExpandedCalloutFrom === targetCalloutFrom
		? autoExpandedCalloutFrom
		: null;

	if (
		shouldRestoreCalloutFoldState
		&& autoExpandedCalloutFrom !== null
		&& autoExpandedCalloutFrom !== targetCalloutFrom
	) {
		effects.push(setCalloutFoldEffect.of({
			from     : autoExpandedCalloutFrom,
			collapsed: true,
		}));
	}

	if (targetCallout && isTargetCalloutCollapsed(view, targetCallout)) {
		effects.push(setCalloutFoldEffect.of({
			from     : targetCallout.calloutFrom,
			collapsed: false,
		}));
		nextAutoExpandedCalloutFrom = shouldRestoreCalloutFoldState
			? targetCallout.calloutFrom
			: null;
	}

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
	const effects: StateEffect<unknown>[] = [];
	const settings                        = view.state.facet(searchBehaviorSettingsFacet);
	const autoExpandedCalloutFrom         = view.state.field(autoExpandedCalloutField, false) ?? null;

	if (settings.restoreCalloutFoldStateOnMove && autoExpandedCalloutFrom !== null) {
		effects.push(setCalloutFoldEffect.of({
			from     : autoExpandedCalloutFrom,
			collapsed: true,
		}));
	}

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
function isTargetCalloutCollapsed(
	view: EditorView,
	callout: { calloutFrom: number; foldDefault: 'none' | 'collapsed' | 'expanded' },
): boolean {
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
	const element = view.dom.querySelector('.tms-mde-search-current-match');
	if (!(element instanceof HTMLElement)) {
		return null;
	}

	const rect = element.getBoundingClientRect();
	if (rect.height <= 0 && rect.width <= 0) {
		return null;
	}

	return {
		top   : rect.top,
		bottom: rect.bottom,
	};
}

/**
 * 現在ヒットの DOM が未描画の場合にカーソル座標を取得する
 * @param view - エディタビュー
 * @returns 座標。取得不可の場合 null
 */
function getSearchCursorRect(view: EditorView): SearchScrollTargetRect | null {
	const selection = view.state.selection.main;
	const coords    = view.coordsAtPos(selection.from, 1)
		?? view.coordsAtPos(selection.to, -1)
		?? view.coordsAtPos(selection.head);

	return coords
		? {
			top   : coords.top,
			bottom: coords.bottom,
		}
		: null;
}

/**
 * 現在の独自ハイライト一致を置換して次へ移動する
 * @param view - エディタビュー
 * @returns 置換した場合 true
 */
function replaceCurrentSearchMatch(view: EditorView): boolean {
	const current = view.state.field(currentSearchMatchField);
	if (current) {
		view.dispatch({
			effects  : setCurrentSearchMatchEffect.of(null),
			selection: EditorSelection.single(current.from, current.to),
		});
	}

	const handled = replaceNext(view);
	if (!handled) {
		return false;
	}

	const selection = view.state.selection.main;
	if (!selection.empty) {
		setCurrentSearchMatch(view, {
			from: selection.from,
			to  : selection.to,
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
	const handled = replaceAll(view);
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
function scrollSearchSelectionIntoView(
	view: EditorView,
	target: SearchScrollTarget,
	isCanceled: SearchScrollCancelCheck,
): void {
	if (isCanceled() || !isActiveSearchScrollTarget(view, target)) {
		return;
	}

	const scroller = view.scrollDOM;
	if (!scroller.isConnected || scroller.clientHeight <= 0) {
		return;
	}

	const selection     = view.state.selection.main;
	const currentMatch  = view.state.field(currentSearchMatchField);
	const scrollPos     = currentMatch?.from ?? selection.from;
	const lineBlock     = view.lineBlockAt(scrollPos);
	const viewportShift = scroller.clientHeight * SEARCH_SCROLL_VIEWPORT_RATIO;
	const maxScrollTop  = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
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
function correctSearchScrollFromDom(
	view: EditorView,
	target: SearchScrollTarget,
	isCanceled: SearchScrollCancelCheck,
	attempts = SEARCH_SCROLL_FINE_ATTEMPTS,
): void {
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
			if (isCanceled() || !isActiveSearchScrollTarget(measuredView, target)) {
				return { delta: 0, needsRetry: false };
			}

			const scroller = measuredView.scrollDOM;
			if (!scroller.isConnected || scroller.clientHeight <= 0) {
				return { delta: 0, needsRetry: false };
			}

			const rect = getCurrentSearchMatchRect(measuredView) ?? getSearchCursorRect(measuredView);
			if (!rect) {
				return { delta: 0, needsRetry: attempts > 1 };
			}

			const scrollerRect = scroller.getBoundingClientRect();
			const topLimit     = scrollerRect.top + SEARCH_SCROLL_MARGIN_PX;
			const bottomLimit  = scrollerRect.bottom - SEARCH_SCROLL_MARGIN_PX;
			const desiredTop   = scrollerRect.top + scroller.clientHeight * SEARCH_SCROLL_VIEWPORT_RATIO;
			const delta        = rect.top - desiredTop;
			if (
				Math.abs(delta) <= 4
				&& rect.top >= topLimit
				&& rect.bottom <= bottomLimit
			) {
				return { delta: 0, needsRetry: false };
			}

			return {
				delta,
				needsRetry: attempts > 1,
			};
		},
		/**
		 * 追加スクロール量を反映する
		 * @param measure - 補正情報
		 * @param measuredView - エディタビュー
		 */
		write(measure, measuredView) {
			if (isCanceled() || !isActiveSearchScrollTarget(measuredView, target)) {
				return;
			}

			if (Math.abs(measure.delta) > 1) {
				measuredView.scrollDOM.scrollTop += measure.delta;
			}

			if (measure.needsRetry && attempts > 1) {
				requestAnimationFrame(() => {
					correctSearchScrollFromDom(measuredView, target, isCanceled, attempts - 1);
				});
			}
		},
	});
}

/**
 * 検索移動後のスクロール補正プラグイン
 */
const searchScrollPlugin = ViewPlugin.define((view) => {
	let scrollGeneration = 0;

	let scrollTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * 予約済みスクロールを取り消す
	 */
	const cancelPendingScroll = (): void => {
		scrollGeneration += 1;
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
			if (!update.selectionSet || !update.transactions.some((transaction) => transaction.isUserEvent('select.search'))) {
				return;
			}

			cancelPendingScroll();
			const generation = scrollGeneration;
			const target     = view.state.field(currentSearchMatchField);
			scrollTimer      = setTimeout(() => {
				scrollTimer = null;
				requestAnimationFrame(() => {
					scrollSearchSelectionIntoView(
						view,
						target,
						() => generation !== scrollGeneration,
					);
				});
			}, SEARCH_SCROLL_DELAY_MS);
		},
		/**
		 * プラグイン破棄時に予約済みスクロールを取り消す
		 */
		destroy(): void {
			cancelPendingScroll();
		},
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
			createPanel: (view) => new TmsSearchPanel(view),
		}),
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

		const findRow      = this.createFindRow();
		const optionsRow   = this.createOptionsRow();
		this.replaceRow    = this.createReplaceRow();
		this.dom           = document.createElement('div');
		this.dom.className = 'cm-search tms-mde-search-panel';
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
		const nextMode = update.state.field(searchPanelModeField);
		if (nextMode !== this.mode) {
			this.mode = nextMode;
		}

		for (const transaction of update.transactions) {
			for (const effect of transaction.effects) {
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
		const row     = document.createElement('div');
		row.className = 'tms-mde-search-row tms-mde-search-find-row';
		row.append(
			this.searchInput,
			this.createButton('前へ', '前の一致へ移動 (Shift+Enter)', () => moveToSearchMatch(this.view, 'previous')),
			this.createButton('次へ', '次の一致へ移動 (Enter)', () => moveToSearchMatch(this.view, 'next')),
			this.matchStatus,
			this.createButton('×', '検索パネルを閉じる', () => closeOpenSearchPanel(this.view), 'tms-mde-search-close'),
		);
		return row;
	}

	/**
	 * 検索オプション行を生成する
	 * @returns オプション行
	 */
	private createOptionsRow(): HTMLElement {
		const row     = document.createElement('div');
		row.className = 'tms-mde-search-row tms-mde-search-options';
		row.append(
			this.createCheckboxLabel(this.caseInput, '大文字小文字を区別'),
			this.createCheckboxLabel(this.regexpInput, '正規表現'),
			this.createCheckboxLabel(this.wordInput, '単語単位'),
		);
		return row;
	}

	/**
	 * 置換行を生成する
	 * @returns 置換行
	 */
	private createReplaceRow(): HTMLElement {
		const row     = document.createElement('div');
		row.className = 'tms-mde-search-row tms-mde-search-replace-row';
		row.append(
			this.replaceInput,
			this.createButton('置換して次へ', '現在の一致を置換して次へ移動', () => replaceCurrentSearchMatch(this.view)),
			this.createButton('すべて置換', 'すべての一致を置換', () => replaceAllSearchMatches(this.view)),
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
	private createButton(
		text: string,
		ariaLabel: string,
		action: () => boolean,
		className?: string,
	): HTMLButtonElement {
		const button       = document.createElement('button');
		button.type        = 'button';
		button.textContent = text;
		button.className   = `cm-button${className ? ` ${className}` : ''}`;
		button.setAttribute('aria-label', ariaLabel);
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
		this.searchInput.addEventListener('input', commitAndMove);
		this.replaceInput.addEventListener('input', commit);
		this.caseInput.addEventListener('change', commitAndMove);
		this.regexpInput.addEventListener('change', commitAndMove);
		this.wordInput.addEventListener('change', commitAndMove);
	}

	/**
	 * 現在のフォーム値を検索クエリへ反映する
	 * @param moveToMatch - 検索一致へ移動する場合 true
	 */
	private commitQuery(moveToMatch = false): void {
		const query = new SearchQuery({
			search       : this.searchInput.value,
			replace      : this.replaceInput.value,
			caseSensitive: this.caseInput.checked,
			regexp       : this.regexpInput.checked,
			wholeWord    : this.wordInput.checked,
		});
		if (query.eq(this.query)) {
			return;
		}

		this.query = query;
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
		if (event.key === 'Escape') {
			event.preventDefault();
			closeOpenSearchPanel(this.view);
			return;
		}

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

		const regexpError            = this.query.regexp
			? getRegularExpressionError(this.query.search)
			: null;
		this.errorStatus.textContent = regexpError ?? '';
		this.errorStatus.hidden      = regexpError === null;

		const status                 = countSearchMatches(this.view.state, this.query);
		this.matchStatus.textContent = this.query.search
			? `${status.current} / ${status.total}`
			: '0 / 0';

		const disabled = !this.query.valid;
		for (const button of this.actionButtons) {
			if (!button.classList.contains('tms-mde-search-close')) {
				button.disabled = disabled;
			}
		}
	}
}
