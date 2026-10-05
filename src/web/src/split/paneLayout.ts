import { calculateSplitRatio, type SplitDirection } from './splitView';

export type PaneId = string;

export type PaneLayoutNode = PaneLeaf | PaneSplit;

export type PaneLeaf = {
	kind: 'pane';
	paneId: PaneId;
};

export type PaneSplit = {
	kind: 'split';
	splitId: string;
	direction: SplitDirection;
	ratio: number;
	first: PaneLayoutNode;
	second: PaneLayoutNode;
};

export type NewPanePosition = 'first' | 'second';

/** 単一ペインのレイアウトを生成する */
export function createPaneLayout(paneId: PaneId): PaneLeaf {
	return { kind: 'pane', paneId };
}

/** 指定ペインを分割し、新しいペインを指定方向へ追加する */
export function splitPane(
	node: PaneLayoutNode,
	targetPaneId: PaneId,
	newPaneId: PaneId,
	splitId: string,
	direction: SplitDirection,
	newPanePosition: NewPanePosition = 'second',
): PaneLayoutNode {
	if (node.kind === 'pane') {
		// 対象以外の葉は同じ参照で返し、対象葉だけを新しい分割ノードへ置き換える。
		if (node.paneId !== targetPaneId) return node;
		const newPane = createPaneLayout(newPaneId);
		return {
			kind: 'split',
			splitId,
			direction,
			ratio: 0.5,
			first: newPanePosition === 'first' ? newPane : node,
			second: newPanePosition === 'first' ? node : newPane,
		};
	}

	// 入れ子分割のどの深さでも対象を探せるよう、左右の部分木を不変更新する。
	return {
		...node,
		first: splitPane(node.first, targetPaneId, newPaneId, splitId, direction, newPanePosition),
		second: splitPane(node.second, targetPaneId, newPaneId, splitId, direction, newPanePosition),
	};
}

/** 指定ペインを削除し、兄弟ノードを親の位置へ昇格する */
export function removePane(node: PaneLayoutNode, paneId: PaneId): PaneLayoutNode | null {
	if (node.kind === 'pane') return node.paneId === paneId ? null : node;

	// 子が消えた分割は残せないため、残った兄弟を親位置へ昇格して木を正規化する。
	const first  = removePane(node.first, paneId);
	const second = removePane(node.second, paneId);
	if (!first) return second;
	if (!second) return first;
	return { ...node, first, second };
}

/** 指定分割の比率を20%〜80%の範囲で更新する */
export function updateSplitRatio(node: PaneLayoutNode, splitId: string, ratio: number): PaneLayoutNode {
	if (node.kind === 'pane') return node;
	if (node.splitId === splitId) {
		// calculateSplitRatioでUIと同じ20%〜80%制約へ収め、狭すぎるペインを作らない。
		return { ...node, ratio: calculateSplitRatio(ratio, 0, 1) };
	}
	return {
		...node,
		first: updateSplitRatio(node.first, splitId, ratio),
		second: updateSplitRatio(node.second, splitId, ratio),
	};
}

/** レイアウト内のペインIDを表示順に返す */
export function listPaneIds(node: PaneLayoutNode): PaneId[] {
	return node.kind === 'pane'
		? [node.paneId]
		: [...listPaneIds(node.first), ...listPaneIds(node.second)];
}

/** 指定ペインの削除後にフォーカスする隣接ペインを返す */
export function findAdjacentPaneId(node: PaneLayoutNode, paneId: PaneId): PaneId | null {
	const paneIds = listPaneIds(node);
	const index   = paneIds.indexOf(paneId);
	if (index < 0) return null;
	// 閉じた位置の視線移動を抑えるため、前のペインを優先し、先頭だけ次を選ぶ。
	return paneIds[index - 1] ?? paneIds[index + 1] ?? null;
}
