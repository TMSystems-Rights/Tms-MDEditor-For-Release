/**
 * フォーカスを奪わないタブ要素を作る
 * ネイティブドラッグに使う DOM だけを返し、タブの並びやドロップ処理は持たない
 * @file
 */

/**
 * エディタのフォーカスを奪わず、ネイティブドラッグ可能なタブ要素を生成する
 * button 要素の mousedown を preventDefault すると dragstart も抑止されるため、フォーカスしない div をタブとして使う
 * @param documentRef - 要素を作るドキュメント。テストでは `createElement` だけを渡せる
 * @param active - そのタブが選択中か。`aria-selected` の値になる
 * @returns `role="tab"` の div。`tabIndex` は -1、`draggable` は true
 */
export function createDraggableTabElement(
	documentRef: Pick<Document, 'createElement'>,
	active: boolean,
): HTMLDivElement {
	const element     = documentRef.createElement('div');
	element.tabIndex  = -1;
	element.draggable = true;
	element.setAttribute('role', 'tab');
	element.setAttribute('aria-selected', String(active));
	return element;
}
