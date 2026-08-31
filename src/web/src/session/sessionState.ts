import { createPaneLayout, removePane, type PaneId, type PaneLayoutNode } from '../split/paneLayout';
import type { ViewMode } from '../types/app';

export const SESSION_SCHEMA_VERSION = 1;

export type SessionTabSnapshot = {
	tabId: string;
	filePath: string;
};

export type SessionPaneSnapshot = {
	paneId: PaneId;
	tabIds: string[];
	activeTabId: string;
	viewModes: Record<string, ViewMode>;
};

export type SessionSnapshot = {
	schemaVersion: typeof SESSION_SCHEMA_VERSION;
	tabs: SessionTabSnapshot[];
	panes: SessionPaneSnapshot[];
	paneLayout: PaneLayoutNode;
	activePaneId: PaneId;
};

export type SessionSnapshotInput = {
	tabs: Array<{ tabId: string; filePath: string | null }>;
	panes: Array<{
		paneId: PaneId;
		tabIds: string[];
		activeTabId: string | null;
		viewModes: Record<string, ViewMode>;
	}>;
	paneLayout: PaneLayoutNode;
	activePaneId: PaneId;
};

/** 保存可能なファイルタブだけを残し、空になったペインを畳んだセッションを生成する。 */
export function createSessionSnapshot(input: SessionSnapshotInput): SessionSnapshot | null {
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

/** 外部 JSON を検証・正規化し、復元可能なセッションへ変換する。 */
export function normalizeSessionSnapshot(value: unknown): SessionSnapshot | null {
	if (!isRecord(value) || value.schemaVersion !== SESSION_SCHEMA_VERSION || !Array.isArray(value.tabs) || !Array.isArray(value.panes)) return null;

	const tabs: SessionTabSnapshot[] = [];
	const tabIds                     = new Set<string>();
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

/** 保存対象のファイルタブがない正常な空セッションかを判定する。 */
export function isEmptySessionSnapshot(value: unknown): boolean {
	return isRecord(value)
		&& value.schemaVersion === SESSION_SCHEMA_VERSION
		&& Array.isArray(value.tabs)
		&& value.tabs.length === 0;
}

/** 指定集合に含まれないペインを削除し、残った兄弟を昇格する。 */
export function prunePaneLayout(layout: PaneLayoutNode, paneIds: ReadonlySet<PaneId>): PaneLayoutNode | null {
	let next: PaneLayoutNode | null = layout;
	for (const paneId of listLayoutPaneIds(layout)) {
		if (!paneIds.has(paneId) && next) next = removePane(next, paneId);
	}
	return next;
}

/**
 *
 */
function listLayoutPaneIds(layout: PaneLayoutNode): PaneId[] {
	return layout.kind === 'pane' ? [layout.paneId] : [...listLayoutPaneIds(layout.first), ...listLayoutPaneIds(layout.second)];
}

/**
 *
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
	const first  = normalizePaneLayout(value.first, paneIds, splitIds);
	const second = normalizePaneLayout(value.second, paneIds, splitIds);
	if (!first || !second) return null;
	const ratio = typeof value.ratio === 'number' && Number.isFinite(value.ratio) ? Math.min(0.8, Math.max(0.2, value.ratio)) : 0.5;
	return { kind: 'split', splitId: value.splitId, direction: value.direction, ratio, first, second };
}

/**
 *
 */
function normalizeViewMode(value: unknown): ViewMode {
	return value === 'source' ? 'source' : 'live-preview';
}

/**
 *
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 *
 */
function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}
