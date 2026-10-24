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
	const tabs        = input.tabs.filter((tab): tab is SessionTabSnapshot => Boolean(tab.filePath?.trim()));
	const savedTabIds = new Set(tabs.map((tab) => tab.tabId));
	const panes       = input.panes.map((pane) => {
		const tabIds    = pane.tabIds.filter((tabId, index, values) => savedTabIds.has(tabId) && values.indexOf(tabId) === index);
		const viewModes = Object.fromEntries(tabIds.map((tabId) => [tabId, normalizeViewMode(pane.viewModes[tabId])]));
		return {
			paneId: pane.paneId,
			tabIds,
			activeTabId: tabIds.includes(pane.activeTabId ?? '') ? pane.activeTabId! : tabIds[0] ?? '',
			viewModes,
		};
	}).filter((pane) => pane.tabIds.length > 0);
	const paneIds    = new Set(panes.map((pane) => pane.paneId));
	const paneLayout = prunePaneLayout(input.paneLayout, paneIds);
	if (!paneLayout || panes.length === 0) return null;

	// レイアウトから脱落したペインとタブを再度除き、保存JSON内の相互参照を閉じる
	const layoutPaneIds = new Set(listLayoutPaneIds(paneLayout));
	const layoutPanes   = panes.filter((pane) => layoutPaneIds.has(pane.paneId));
	const usedTabIds    = new Set(layoutPanes.flatMap((pane) => pane.tabIds));
	const activePaneId  = layoutPaneIds.has(input.activePaneId) ? input.activePaneId : layoutPanes[0].paneId;

	return {
		schemaVersion: SESSION_SCHEMA_VERSION,
		tabs: tabs.filter((tab) => usedTabIds.has(tab.tabId)),
		panes: layoutPanes,
		paneLayout,
		activePaneId,
	};
}

/**
 * 外部 JSON を検証・正規化し、復元可能なセッションへ変換する
 * 版が違う、タブが壊れている、有効なペインが残らないときは null。壊れた項目だけは捨てて残りを復元する
 * @param value - 読み込んだ JSON。オブジェクトでなければ null
 * @returns 相互参照を閉じたスナップショット。復元できないときは null
 */
export function normalizeSessionSnapshot(value: unknown): SessionSnapshot | null {
	if (!isRecord(value) || value.schemaVersion !== SESSION_SCHEMA_VERSION || !Array.isArray(value.tabs) || !Array.isArray(value.panes)) return null;

	const tabs: SessionTabSnapshot[] = [];
	const tabIds                     = new Set<string>();
	// 壊れた項目と重複IDだけを捨て、残りのセッションは可能な限り復元する
	for (const candidate of value.tabs) {
		if (!isRecord(candidate) || !isNonEmptyString(candidate.tabId) || !isNonEmptyString(candidate.filePath) || tabIds.has(candidate.tabId)) continue;
		tabIds.add(candidate.tabId);
		tabs.push({ tabId: candidate.tabId, filePath: candidate.filePath });
	}
	if (tabs.length === 0) return null;

	const rawLayout = normalizePaneLayout(value.paneLayout, new Set(), new Set());
	if (!rawLayout) return null;
	const layoutPaneIds                = new Set(listLayoutPaneIds(rawLayout));
	const panes: SessionPaneSnapshot[] = [];
	const seenPanes                    = new Set<string>();
	// レイアウトに存在し、少なくとも1つ有効なタブを持つペインだけを採用する
	for (const candidate of value.panes) {
		if (!isRecord(candidate) || !isNonEmptyString(candidate.paneId) || seenPanes.has(candidate.paneId) || !layoutPaneIds.has(candidate.paneId) || !Array.isArray(candidate.tabIds)) continue;
		const paneTabIds = candidate.tabIds.filter((tabId, index, values): tabId is string => typeof tabId === 'string' && tabIds.has(tabId) && values.indexOf(tabId) === index);
		if (paneTabIds.length === 0) continue;
		seenPanes.add(candidate.paneId);
		const rawViewModes = isRecord(candidate.viewModes) ? candidate.viewModes : {};
		panes.push({
			paneId: candidate.paneId,
			tabIds: paneTabIds,
			activeTabId: typeof candidate.activeTabId === 'string' && paneTabIds.includes(candidate.activeTabId) ? candidate.activeTabId : paneTabIds[0],
			viewModes: Object.fromEntries(paneTabIds.map((tabId) => [tabId, normalizeViewMode(rawViewModes[tabId])])),
		});
	}
	if (panes.length === 0) return null;

	const validPaneIds = new Set(panes.map((pane) => pane.paneId));
	const paneLayout   = prunePaneLayout(rawLayout, validPaneIds);
	if (!paneLayout) return null;
	const activePaneId = typeof value.activePaneId === 'string' && validPaneIds.has(value.activePaneId) ? value.activePaneId : panes[0].paneId;
	const usedTabIds   = new Set(panes.flatMap((pane) => pane.tabIds));

	return {
		schemaVersion: SESSION_SCHEMA_VERSION,
		tabs: tabs.filter((tab) => usedTabIds.has(tab.tabId)),
		panes,
		paneLayout,
		activePaneId,
	};
}

/**
 * 保存対象のファイルタブがない正常な空セッションかを判定する
 * 版が一致し、`tabs` が空配列のときだけ true。復元失敗の null とは区別する
 * @param value - 読み込んだ JSON
 * @returns 意図して空のセッションなら true
 */
export function isEmptySessionSnapshot(value: unknown): boolean {
	return isRecord(value)
		&& value.schemaVersion === SESSION_SCHEMA_VERSION
		&& Array.isArray(value.tabs)
		&& value.tabs.length === 0;
}

/**
 * 指定集合に含まれないペインを削除し、残った兄弟を昇格する
 * すべて消えるときは null
 * @param layout - 畳む前の分割木
 * @param paneIds - 残すペイン ID
 * @returns 残った木。ペインが無ければ null
 */
export function prunePaneLayout(layout: PaneLayoutNode, paneIds: ReadonlySet<PaneId>): PaneLayoutNode | null {
	let next: PaneLayoutNode | null = layout;
	for (const paneId of listLayoutPaneIds(layout)) {
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
	if (!isRecord(value) || value.kind === 'pane' && !isNonEmptyString(value.paneId)) return null;
	if (value.kind === 'pane') {
		if (paneIds.has(value.paneId as string)) return null;
		paneIds.add(value.paneId as string);
		return createPaneLayout(value.paneId as string);
	}
	if (value.kind !== 'split' || !isNonEmptyString(value.splitId) || splitIds.has(value.splitId) || value.direction !== 'horizontal' && value.direction !== 'vertical') return null;
	splitIds.add(value.splitId);
	// 片側だけ壊れた分割は安全に畳めないため、分割ノード全体を無効とする
	const first  = normalizePaneLayout(value.first, paneIds, splitIds);
	const second = normalizePaneLayout(value.second, paneIds, splitIds);
	if (!first || !second) return null;
	const ratio = typeof value.ratio === 'number' && Number.isFinite(value.ratio) ? Math.min(0.8, Math.max(0.2, value.ratio)) : 0.5;
	return { kind: 'split', splitId: value.splitId, direction: value.direction, ratio, first, second };
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
