/**
 * 分割ペインの木を不変更新する
 * 画面への配置は持たず、葉と分割ノードの構造だけを返す
 * @file
 */
import { calculateSplitRatio, type SplitDirection } from './splitView';

/** ペインを指す ID。レイアウト内で一意 */
export type PaneId = string;

/**
 * 分割レイアウトの節
 * 葉か、2 つの子を持つ分割のどちらか
 */
export type PaneLayoutNode = PaneLeaf | PaneSplit;

/**
 * タブを持つ 1 ペイン
 * 分割の末端で、子は持たない
 */
export type PaneLeaf = {
	/** この節が葉であること */
	kind: 'pane';
	/** このペインの ID */
	paneId: PaneId;
};

/**
 * 2 つの子へ分けた節
 * 比率は先の子が占める割合
 */
export type PaneSplit = {
	/** この節が分割であること */
	kind: 'split';
	/** この分割を指す ID。比率更新の対象 */
	splitId: string;
	/** 上下か左右か */
	direction: SplitDirection;
	/** 先の子が占める割合。0.2〜0.8 */
	ratio: number;
	/** 分割の先に置く子。左または上 */
	first: PaneLayoutNode;
	/** 分割の後に置く子。右または下 */
	second: PaneLayoutNode;
};

/**
 * 新しいペインを既存ペインのどちら側へ置くか
 * `first` は前、`second` は後
 */
export type NewPanePosition = 'first' | 'second';

/**
 * 単一ペインのレイアウトを生成する
 * @param paneId - そのペインの ID
 * @returns 子を持たない葉
 */
export function createPaneLayout(paneId: PaneId): PaneLeaf {
	return { kind: 'pane', paneId };
}

/**
 * 指定ペインを分割し、新しいペインを指定方向へ追加する
 * 対象以外の葉は同じ参照のまま返す。対象が木に無ければ構造は実質変わらない
 * @param node - 更新するレイアウト。このオブジェクトは書き換えない
 * @param targetPaneId - 分割するペイン
 * @param newPaneId - 追加するペインの ID
 * @param splitId - 新しい分割節の ID
 * @param direction - 上下か左右か
 * @param newPanePosition - 新しいペインを前に置くか後に置くか。省略時は後
 * @returns 対象葉だけを分割へ置き換えた木
 */
export function splitPane(
	node: PaneLayoutNode,
	targetPaneId: PaneId,
	newPaneId: PaneId,
	splitId: string,
	direction: SplitDirection,
	newPanePosition: NewPanePosition = 'second',
): PaneLayoutNode {
	if (node.kind === 'pane') {
		// 対象以外の葉は同じ参照で返し、対象葉だけを新しい分割ノードへ置き換える
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

	// 入れ子分割のどの深さでも対象を探せるよう、左右の部分木を不変更新する
	return {
		...node,
		first: splitPane(node.first, targetPaneId, newPaneId, splitId, direction, newPanePosition),
		second: splitPane(node.second, targetPaneId, newPaneId, splitId, direction, newPanePosition),
	};
}

/**
 * 指定ペインを削除し、兄弟ノードを親の位置へ昇格する
 * 最後の 1 ペインを消したときは null
 * @param node - 更新するレイアウト。このオブジェクトは書き換えない
 * @param paneId - 削除するペイン
 * @returns 畳んだ木。ペインが残らなければ null
 */
export function removePane(node: PaneLayoutNode, paneId: PaneId): PaneLayoutNode | null {
	if (node.kind === 'pane') return node.paneId === paneId ? null : node;

	// 子が消えた分割は残せないため、残った兄弟を親位置へ昇格して木を正規化する
	const first  = removePane(node.first, paneId);
	const second = removePane(node.second, paneId);
	if (!first) return second;
	if (!second) return first;
	return { ...node, first, second };
}

/**
 * 指定分割の比率を 20%〜80% の範囲で更新する
 * 対象が無いときは子を再帰した木を返す。葉はそのまま
 * @param node - 更新するレイアウト。このオブジェクトは書き換えない
 * @param splitId - 比率を変える分割
 * @param ratio - 先の子へ割り当てたい割合。範囲外は 0.2〜0.8 に収める
 * @returns 対象分割の比率だけを変えた木
 */
export function updateSplitRatio(node: PaneLayoutNode, splitId: string, ratio: number): PaneLayoutNode {
	if (node.kind === 'pane') return node;
	if (node.splitId === splitId) {
		// calculateSplitRatioでUIと同じ20%〜80%制約へ収め、狭すぎるペインを作らない
		return { ...node, ratio: calculateSplitRatio(ratio, 0, 1) };
	}
	return {
		...node,
		first: updateSplitRatio(node.first, splitId, ratio),
		second: updateSplitRatio(node.second, splitId, ratio),
	};
}

/**
 * レイアウト内のペイン ID を表示順に返す
 * 先の子を先に辿る
 * @param node - 走査する木
 * @returns 左から、または上からのペイン ID
 */
export function listPaneIds(node: PaneLayoutNode): PaneId[] {
	return node.kind === 'pane'
		? [node.paneId]
		: [...listPaneIds(node.first), ...listPaneIds(node.second)];
}

/**
 * 指定ペインの削除後にフォーカスする隣接ペインを返す
 * 前のペインを優先し、先頭を閉じたときだけ次を選ぶ。対象が無ければ null
 * @param node - 削除前の木
 * @param paneId - 閉じるペイン
 * @returns 隣のペイン ID。隣も対象も無ければ null
 */
export function findAdjacentPaneId(node: PaneLayoutNode, paneId: PaneId): PaneId | null {
	const paneIds = listPaneIds(node);
	const index   = paneIds.indexOf(paneId);
	if (index < 0) return null;
	// 閉じた位置の視線移動を抑えるため、前のペインを優先し、先頭だけ次を選ぶ
	return paneIds[index - 1] ?? paneIds[index + 1] ?? null;
}
