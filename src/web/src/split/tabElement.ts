/**
 * エディタのフォーカスを奪わず、ネイティブドラッグ可能なタブ要素を生成する。
 * button 要素の mousedown を preventDefault すると dragstart も抑止されるため、
 * フォーカスしない div をタブとして使用する。
 * @param {Pick<Document, 'createElement'>} documentRef DOM ドキュメント
 * @param {boolean} active アクティブなタブか
 * @returns {HTMLDivElement} タブ要素
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
