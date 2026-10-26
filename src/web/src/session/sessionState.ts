/**
 * 起動時に戻すセッションを、保存できるファイルタブだけに揃える
 * ディスクへの書き込みは持たず、渡された状態と外部 JSON を正規化する
 * @file
 */
import { createPaneLayout, removePane, type PaneId, type PaneLayoutNode } from '../split/paneLayout';
import type { ViewMode } from '../types/app';

/**
 * セッション JSON の版
 * これと違う `schemaVersion` は復元しない。実行中には変えない
 */
export const SESSION_SCHEMA_VERSION = 1;

/**
 * 保存する 1 タブ
 * 未保存タブはここに入らない
 */
export type SessionTabSnapshot = {
	/** ウィンドウ内でタブを指す ID。ペインの `tabIds` と同じ値 */
	tabId: string;
	/** 保存済みファイルのパス。空にはしない */
	filePath: string;
};

/**
 * 保存する 1 ペイン
 * ファイルタブを 1 つも持たないペインは含めない
 */
export type SessionPaneSnapshot = {
	/** レイアウト上のペイン ID */
	paneId: PaneId;
	/** このペインが持つタブ ID。重複は除く */
	tabIds: string[];
	/** 選択中のタブ ID。`tabIds` に含まれる */
	activeTabId: string;
	/** タブ ID から表示モード。未知の値は正規化後に入らない */
	viewModes: Record<string, ViewMode>;
};

/**
 * 保存と復元に使うセッション全体
 * タブ、ペイン、レイアウトの ID は互いに参照が閉じている
 */
export type SessionSnapshot = {
	/** このスナップショットの版。現在は `SESSION_SCHEMA_VERSION` だけ */
	schemaVersion: typeof SESSION_SCHEMA_VERSION;
	/** 復元するファイルタブ。未保存は含まない */
	tabs: SessionTabSnapshot[];
	/** ファイルタブが残ったペイン */
	panes: SessionPaneSnapshot[];
	/** 空ペインを畳んだ後の分割木 */
	paneLayout: PaneLayoutNode;
	/** 復元時にフォーカスするペイン。レイアウトに含まれる */
	activePaneId: PaneId;
};

/**
 * いま開いている状態からスナップショットを作る入力
 * 未保存タブや空ペインを含んでよい。正規化で除く
 */
export type SessionSnapshotInput = {
	/** 開いているタブ。`filePath` が null のものは保存しない */
	tabs: Array<{ tabId: string; filePath: string | null }>;
	/** 開いているペイン。空になっても入力には残してよい */
	panes: Array<{
		/** レイアウト上のペイン ID */
		paneId: PaneId;
		/** このペインのタブ ID。未保存を含んでよい */
		tabIds: string[];
		/** 選択中タブ。null や欠落は残った先頭タブへ寄せる */
		activeTabId: string | null;
		/** タブ ID から表示モード。未知の値はライブプレビューにする */
		viewModes: Record<string, ViewMode>;
	}>;
	/** 現在の分割木。空になった葉は後で畳む */
	paneLayout: PaneLayoutNode;
	/** 現在フォーカスしているペイン。残っていなければ先頭ペイン */
	activePaneId: PaneId;
};

/**
 * 保存可能なファイルタブだけを残し、空になったペインを畳んだセッションを生成する
 * ファイルタブが 1 つも残らなければ null
 * @param input - 現在のタブ、ペイン、レイアウト。未保存を含んでよい
 * @returns 相互参照を閉じたスナップショット。保存対象が無いときは null
 */
export function createSessionSnapshot(input: SessionSnapshotInput): SessionSnapshot | null {
	// 未保存タブは復元できないため除外し、各ペインの参照も同じ集合へ揃える
	// パスがあるタブだけ。空白だけのパスは未保存扱いで除く
	const tabs        = input.tabs.filter((tab): tab is SessionTabSnapshot => Boolean(tab.filePath?.trim()));
	// 残すタブ ID。ペイン側の参照をこの集合へ揃える
	const savedTabIds = new Set(tabs.map((tab) => tab.tabId));
	// ファイルタブが残ったペイン。1 件も残らないペインは捨てる
	const panes       = input.panes
		.map((pane) => {
			// 保存対象かつ重複を除いたタブ ID。空ならこのペインは捨てる
			const tabIds    = pane.tabIds.filter((tabId, index, values) => savedTabIds.has(tabId) && values.indexOf(tabId) === index);
			// 残ったタブだけの表示モード。未知の値はライブプレビュー
			const viewModes = Object.fromEntries(tabIds.map((tabId) => [tabId, normalizeViewMode(pane.viewModes[tabId])]));
			// このペインの保存形。選択が残っていなければ先頭、タブが無ければ空文字
			return {
				// レイアウト上のペイン ID
				paneId: pane.paneId,
				// 残したタブ ID。重複は除いてある
				tabIds,
				// 残ったタブに含まれる選択。無ければ先頭。タブ 0 件は空文字
				activeTabId: tabIds.includes(pane.activeTabId ?? '') ? pane.activeTabId! : (tabIds[0] ?? ''),
				// 残ったタブだけの表示モード
				viewModes
			};
		})
		.filter((pane) => pane.tabIds.length > 0);
	// ファイルタブが残ったペイン ID
	const paneIds    = new Set(panes.map((pane) => pane.paneId));
	// 空ペインを畳んだ分割木。全部消えると null
	const paneLayout = prunePaneLayout(input.paneLayout, paneIds);
	// 木が空、またはペインが 0 件。保存対象が無い
	if (!paneLayout || panes.length === 0) return null;

	// レイアウトから脱落したペインとタブを再度除き、保存JSON内の相互参照を閉じる
	// 畳んだ後に残っているペイン ID
	const layoutPaneIds = new Set(listLayoutPaneIds(paneLayout));
	// 木に残ったペインだけ。畳みで落ちたペインは捨てる
	const layoutPanes   = panes.filter((pane) => layoutPaneIds.has(pane.paneId));
	// 残ったペインが参照するタブ ID。これ以外のタブは保存しない
	const usedTabIds    = new Set(layoutPanes.flatMap((pane) => pane.tabIds));
	// フォーカスが残っていればそれを、無ければ先頭ペイン。layoutPanes は 1 件以上
	const activePaneId  = layoutPaneIds.has(input.activePaneId) ? input.activePaneId : layoutPanes[0].paneId;

	// 相互参照を閉じたスナップショット
	return {
		// 現在のセッション版。これと違う JSON は復元しない
		schemaVersion: SESSION_SCHEMA_VERSION,
		// 残ったペインが参照するタブだけ
		tabs: tabs.filter((tab) => usedTabIds.has(tab.tabId)),
		// 木に残ったペイン
		panes: layoutPanes,
		// 空ペインを畳んだ分割木
		paneLayout,
		// 復元時にフォーカスするペイン
		activePaneId
	};
}

/**
 * 外部 JSON を検証・正規化し、復元可能なセッションへ変換する
 * 版が違う、タブが壊れている、有効なペインが残らないときは null。壊れた項目だけは捨てて残りを復元する
 * @param value - 読み込んだ JSON。オブジェクトでなければ null
 * @returns 相互参照を閉じたスナップショット。復元できないときは null
 */
export function normalizeSessionSnapshot(value: unknown): SessionSnapshot | null {
	// オブジェクトでない、版が違う、タブかペインが配列でない。どれか一つでも復元しない
	if (!isRecord(value) || value.schemaVersion !== SESSION_SCHEMA_VERSION || !Array.isArray(value.tabs) || !Array.isArray(value.panes)) return null;

	// 復元できるタブ。壊れた項目は捨てる
	const tabs: SessionTabSnapshot[] = [];
	// すでに採用したタブ ID。重複は捨てる
	const tabIds                     = new Set<string>();
	// 壊れた項目と重複IDだけを捨て、残りのセッションは可能な限り復元する
	for (const candidate of value.tabs) {
		// オブジェクトでない、ID かパスが空白だけ、または ID が重複。どれか一つでもそのタブは捨てる
		if (!isRecord(candidate) || !isNonEmptyString(candidate.tabId) || !isNonEmptyString(candidate.filePath) || tabIds.has(candidate.tabId)) continue;
		tabIds.add(candidate.tabId);
		// 採用した 1 タブ。パスは空にしない
		tabs.push({
			// ウィンドウ内のタブ ID
			tabId: candidate.tabId,
			// 保存済みファイルのパス
			filePath: candidate.filePath
		});
	}
	// 有効なタブが 1 件も無い。セッションは復元しない
	if (tabs.length === 0) return null;

	// 重複 ID を除いた分割木。構造が壊れていれば null
	const rawLayout = normalizePaneLayout(value.paneLayout, new Set(), new Set());
	// レイアウトが復元できない。タブがあってもセッションにはしない
	if (!rawLayout) return null;
	// 正規化後の木にあるペイン ID
	const layoutPaneIds                = new Set(listLayoutPaneIds(rawLayout));
	// 採用したペイン。タブが残らないものは入れない
	const panes: SessionPaneSnapshot[] = [];
	// すでに採用したペイン ID。重複は捨てる
	const seenPanes                    = new Set<string>();
	// レイアウトに存在し、少なくとも1つ有効なタブを持つペインだけを採用する
	for (const candidate of value.panes) {
		// 形が違う、ID が空か重複、木に無い、タブ配列が無い。どれか一つでもそのペインは捨てる
		if (!isRecord(candidate) || !isNonEmptyString(candidate.paneId) || seenPanes.has(candidate.paneId) || !layoutPaneIds.has(candidate.paneId) || !Array.isArray(candidate.tabIds)) continue;
		// 採用済みタブだけを残し、重複を除いた ID。空ならこのペインは捨てる
		const paneTabIds = candidate.tabIds.filter((tabId, index, values): tabId is string => typeof tabId === 'string' && tabIds.has(tabId) && values.indexOf(tabId) === index);
		// 有効なタブが無いペインはレイアウトから後で落とす
		if (paneTabIds.length === 0) continue;
		seenPanes.add(candidate.paneId);
		// 表示モードの元オブジェクト。オブジェクトでなければ空として未知値を既定にする
		const rawViewModes = isRecord(candidate.viewModes) ? candidate.viewModes : {};
		// 採用した 1 ペイン
		panes.push({
			// レイアウト上のペイン ID
			paneId: candidate.paneId,
			// 有効なタブ ID。重複は除いてある
			tabIds: paneTabIds,
			// 残ったタブに含まれる選択。無ければ先頭
			activeTabId: typeof candidate.activeTabId === 'string' && paneTabIds.includes(candidate.activeTabId) ? candidate.activeTabId : paneTabIds[0],
			// 残ったタブだけの表示モード。未知はライブプレビュー
			viewModes: Object.fromEntries(paneTabIds.map((tabId) => [tabId, normalizeViewMode(rawViewModes[tabId])]))
		});
	}
	// 有効なペインが 1 件も無い。セッションは復元しない
	if (panes.length === 0) return null;

	// 採用したペイン ID。これ以外の葉は畳む
	const validPaneIds = new Set(panes.map((pane) => pane.paneId));
	// 空ペインを畳んだ木。全部消えると null
	const paneLayout   = prunePaneLayout(rawLayout, validPaneIds);
	// 畳んだ結果が空。ペイン配列と木が食い違うので復元しない
	if (!paneLayout) return null;
	// 指定フォーカスが残っていればそれ、無ければ先頭ペイン
	const activePaneId = typeof value.activePaneId === 'string' && validPaneIds.has(value.activePaneId) ? value.activePaneId : panes[0].paneId;
	// 残ったペインが参照するタブ ID
	const usedTabIds   = new Set(panes.flatMap((pane) => pane.tabIds));

	// 相互参照を閉じた復元結果
	return {
		// 現在のセッション版
		schemaVersion: SESSION_SCHEMA_VERSION,
		// 残ったペインが参照するタブだけ
		tabs: tabs.filter((tab) => usedTabIds.has(tab.tabId)),
		// タブが残ったペイン
		panes,
		// 空ペインを畳んだ分割木
		paneLayout,
		// 復元時にフォーカスするペイン
		activePaneId
	};
}

/**
 * 保存対象のファイルタブがない正常な空セッションかを判定する
 * 版が一致し、`tabs` が空配列のときだけ true。復元失敗の null とは区別する
 * @param value - 読み込んだ JSON
 * @returns 意図して空のセッションなら true
 */
export function isEmptySessionSnapshot(value: unknown): boolean {
	return isRecord(value) && value.schemaVersion === SESSION_SCHEMA_VERSION && Array.isArray(value.tabs) && value.tabs.length === 0;
}

/**
 * 指定集合に含まれないペインを削除し、残った兄弟を昇格する
 * すべて消えるときは null
 * @param layout - 畳む前の分割木
 * @param paneIds - 残すペイン ID
 * @returns 残った木。ペインが無ければ null
 */
export function prunePaneLayout(layout: PaneLayoutNode, paneIds: ReadonlySet<PaneId>): PaneLayoutNode | null {
	// 畳み途中の木。すべて消えると null
	let next: PaneLayoutNode | null = layout;
	for (const paneId of listLayoutPaneIds(layout)) {
		// 残す集合に無く、まだ木があるときだけその葉を外す。どちらか一方では外さない
		if (!paneIds.has(paneId) && next) next = removePane(next, paneId);
	}
	return next;
}

/**
 * 再帰レイアウトを画面上の順序で走査し、参照整合性の検証に使う
 * @param layout - 走査する分割木
 * @returns 表示順のペイン ID
 */
function listLayoutPaneIds(layout: PaneLayoutNode): PaneId[] {
	return layout.kind === 'pane' ? [layout.paneId] : [...listLayoutPaneIds(layout.first), ...listLayoutPaneIds(layout.second)];
}

/**
 * 外部 JSON の再帰構造を検証し、重複 ID のないペインレイアウトへ正規化する
 * 片側が壊れた分割は全体を無効にする。比率は 0.2〜0.8、欠落は 0.5
 * @param value - 検証するレイアウト JSON
 * @param paneIds - すでに見たペイン ID。重複は無効
 * @param splitIds - すでに見た分割 ID。重複は無効
 * @returns 正規化した木。構造が壊れていれば null
 */
function normalizePaneLayout(value: unknown, paneIds: Set<string>, splitIds: Set<string>): PaneLayoutNode | null {
	// オブジェクトでない、または葉なのにペイン ID が空。葉の ID 欠落は kind が pane のときだけ見る
	if (!isRecord(value) || (value.kind === 'pane' && !isNonEmptyString(value.paneId))) return null;
	// 葉。重複 ID は無効、そうでなければ葉を作る
	if (value.kind === 'pane') {
		// 同じペイン ID がすでに木にある。レイアウト全体を無効にする
		if (paneIds.has(value.paneId as string)) return null;
		paneIds.add(value.paneId as string);
		return createPaneLayout(value.paneId as string);
	}
	// 分割でない、ID が空か重複、向きが horizontal でも vertical でもない。どれか一つでも無効
	if (value.kind !== 'split' || !isNonEmptyString(value.splitId) || splitIds.has(value.splitId) || (value.direction !== 'horizontal' && value.direction !== 'vertical')) return null;
	splitIds.add(value.splitId);
	// 片側だけ壊れた分割は安全に畳めないため、分割ノード全体を無効とする
	// 先の子。壊れていれば null
	const first  = normalizePaneLayout(value.first, paneIds, splitIds);
	// 後の子。壊れていれば null
	const second = normalizePaneLayout(value.second, paneIds, splitIds);
	// どちらかの子が壊れている。片方だけでは分割を残さない
	if (!first || !second) return null;
	// 0.2〜0.8 に収めた先の子の割合。数値でなければ中央の 0.5
	const ratio = typeof value.ratio === 'number' && Number.isFinite(value.ratio) ? Math.min(0.8, Math.max(0.2, value.ratio)) : 0.5;
	// 両方の子が有効な分割
	return {
		// 分割節である印
		kind: 'split',
		// この分割の ID。重複は上で捨てている
		splitId: value.splitId,
		// 上下か左右か。horizontal か vertical
		direction: value.direction,
		// 先の子が占める割合。0.2〜0.8
		ratio,
		// 先の子。左または上
		first,
		// 後の子。右または下
		second
	};
}

/**
 * 未知の値は、互換性を保てる既定のライブプレビューへフォールバックする
 * `source` だけをソース表示とし、それ以外はライブプレビュー
 * @param value - 保存されていた表示モード。型は未知
 * @returns 復元に使う表示モード
 */
function normalizeViewMode(value: unknown): ViewMode {
	return value === 'source' ? 'source' : 'live-preview';
}

/**
 * 配列や null を除外し、JSON オブジェクトとして安全にプロパティを参照可能にする
 * @param value - 判定する値
 * @returns プレーンオブジェクトなら true。配列と null は false
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * ID やパスに使える、空白だけではない文字列かを判定する
 * @param value - 判定する値
 * @returns 空白以外を含む文字列なら true
 */
function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}
