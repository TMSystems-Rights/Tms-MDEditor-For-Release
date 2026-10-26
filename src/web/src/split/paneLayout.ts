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
	// 子を持たない 1 ペイン。分割の末端
	return {
		// 葉である印。分割節の kind とは別
		kind: 'pane',
		// この葉が指すペイン。レイアウト内で一意
		paneId
	};
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
export function splitPane(node: PaneLayoutNode, targetPaneId: PaneId, newPaneId: PaneId, splitId: string, direction: SplitDirection, newPanePosition: NewPanePosition = 'second'): PaneLayoutNode {
	// 末端の葉。対象なら分割へ置き換え、違いなら同じ参照を返す
	if (node.kind === 'pane') {
		// 対象以外の葉は同じ参照で返し、対象葉だけを新しい分割ノードへ置き換える
		if (node.paneId !== targetPaneId) return node;
		// 追加する側の葉。既存の葉とは別 ID
		const newPane = createPaneLayout(newPaneId);
		// 対象葉を半分ずつの分割へ置き換えた節。追加直後の比率は中央
		return {
			// 分割節である印
			kind: 'split',
			// 後から比率を更新するときの ID
			splitId,
			// 上下か左右か。呼び出しが指定した向き
			direction,
			// 先の子が占める割合。追加直後は中央
			ratio: 0.5,
			// 前に置く子。新ペインが前なら newPane、そうでなければ元の葉
			first: newPanePosition === 'first' ? newPane : node,
			// 後に置く子。前と逆で、両方を同じ葉にはしない
			second: newPanePosition === 'first' ? node : newPane
		};
	}

	// 入れ子分割のどの深さでも対象を探せるよう、左右の部分木を不変更新する
	return {
		// この分割の ID、向き、比率はそのまま残す
		...node,
		// 先の子を再帰した結果。対象が無ければ同じ参照
		first: splitPane(node.first, targetPaneId, newPaneId, splitId, direction, newPanePosition),
		// 後の子を再帰した結果。対象が無ければ同じ参照
		second: splitPane(node.second, targetPaneId, newPaneId, splitId, direction, newPanePosition)
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
	// 葉なら、削除対象のときだけ null。それ以外は同じ参照
	if (node.kind === 'pane') return node.paneId === paneId ? null : node;

	// 子が消えた分割は残せないため、残った兄弟を親位置へ昇格して木を正規化する
	// 先の子から対象を除いた木。その部分が空なら null
	const first  = removePane(node.first, paneId);
	// 後の子から対象を除いた木。その部分が空なら null
	const second = removePane(node.second, paneId);
	// 先が消えたので後を親の位置へ上げる。後も null なら木が空
	if (!first) return second;
	// 後が消えたので先を親の位置へ上げる。先はこの時点で残っている
	if (!second) return first;
	// 両方残っている分割。子だけを差し替える
	return {
		// この分割の向きと比率は維持する
		...node,
		// 対象を除いた先の子
		first,
		// 対象を除いた後の子
		second
	};
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
	// 葉に比率は無いので、そのまま返す
	if (node.kind === 'pane') return node;
	// この節が比率を変える対象。子は変えず割合だけ収める
	if (node.splitId === splitId) {
		// calculateSplitRatioでUIと同じ20%〜80%制約へ収め、狭すぎるペインを作らない
		return {
			// 子と向きはそのまま残す
			...node,
			// 0.2〜0.8 に収めた先の子の割合
			ratio: calculateSplitRatio(ratio, 0, 1)
		};
	}
	// 対象は下の階層。この節の比率は維持して子だけ更新する
	return {
		// この分割の比率と向きは維持する
		...node,
		// 先の子を再帰した結果
		first: updateSplitRatio(node.first, splitId, ratio),
		// 後の子を再帰した結果
		second: updateSplitRatio(node.second, splitId, ratio)
	};
}

/**
 * レイアウト内のペイン ID を表示順に返す
 * 先の子を先に辿る
 * @param node - 走査する木
 * @returns 左から、または上からのペイン ID
 */
export function listPaneIds(node: PaneLayoutNode): PaneId[] {
	return node.kind === 'pane' ? [node.paneId] : [...listPaneIds(node.first), ...listPaneIds(node.second)];
}

/**
 * 指定ペインの削除後にフォーカスする隣接ペインを返す
 * 前のペインを優先し、先頭を閉じたときだけ次を選ぶ。対象が無ければ null
 * @param node - 削除前の木
 * @param paneId - 閉じるペイン
 * @returns 隣のペイン ID。隣も対象も無ければ null
 */
export function findAdjacentPaneId(node: PaneLayoutNode, paneId: PaneId): PaneId | null {
	// 表示順のペイン ID。先の子が先
	const paneIds = listPaneIds(node);
	// 閉じるペインの位置。木に無ければ -1
	const index   = paneIds.indexOf(paneId);
	// 対象が木に無い。隣を選べない
	if (index < 0) return null;
	// 閉じた位置の視線移動を抑えるため、前のペインを優先し、先頭だけ次を選ぶ
	return paneIds[index - 1] ?? paneIds[index + 1] ?? null;
}
