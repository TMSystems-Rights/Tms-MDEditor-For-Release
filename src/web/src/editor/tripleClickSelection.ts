import {
	EditorSelection,
	EditorState,
	Prec,
	type Extension,
	type SelectionRange,
} from '@codemirror/state';
import { EditorView, type MouseSelectionStyle } from '@codemirror/view';

/**
 * トリプルクリック以上で、論理行の内容だけを選択するマウス選択を登録する。
 * 行末の改行は含めない。キャレットは選択した行の末尾に置く。
 * @returns {Extension} マウス選択拡張
 */
export function createTripleClickSelectionExtension(): Extension {
	return Prec.high(EditorView.mouseSelectionStyle.of(tripleClickMouseSelectionStyle));
}

/**
 * トリプルクリックの選択スタイルを返す。単クリックとダブルクリックは既定の処理へ返す。
 * @param {EditorView} view エディタビュー
 * @param {MouseEvent} event マウスダウン
 * @returns {MouseSelectionStyle | null} 行選択スタイル。対象外なら null
 */
export function tripleClickMouseSelectionStyle(
	view: EditorView,
	event: MouseEvent,
): MouseSelectionStyle | null {
	if (event.button !== 0 || event.detail < 3) {
		return null;
	}

	let start          = view.posAndSideAtCoords({ x: event.clientX, y: event.clientY }, false);
	let startSelection = view.state.selection;
	return {
		/**
		 * ドラッグ中の文書変更に開始位置を追従させる
		 * @param {import('@codemirror/view').ViewUpdate} update ビュー更新
		 * @returns {void}
		 */
		update(update) {
			if (!update.docChanged) {
				return;
			}

			start          = {
				pos  : update.changes.mapPos(start.pos),
				assoc: start.assoc,
			};
			startSelection = startSelection.map(update.changes);
		},
		/**
		 * クリック位置の論理行、またはドラッグ先までの行範囲を返す
		 * @param {MouseEvent} currentEvent 現在のマウスイベント
		 * @param {boolean} extend 既存選択を拡張するか
		 * @param {boolean} multiple 選択範囲を追加するか
		 * @returns {EditorSelection} 新しい選択
		 */
		get(currentEvent, extend, multiple) {
			const current    = view.posAndSideAtCoords(
				{ x: currentEvent.clientX, y: currentEvent.clientY },
				false,
			);
			const currentPos = current?.pos ?? start.pos;
			const lineRange  = selectionForTripleClick(view.state, start.pos, currentPos);
			if (extend) {
				const clickedLine = selectionRangeForLine(view.state, currentPos);
				return startSelection.replaceRange(
					startSelection.main.extend(clickedLine.from, clickedLine.to),
				);
			}

			if (multiple) {
				return startSelection.addRange(lineRange);
			}

			return EditorSelection.create([lineRange]);
		},
	};
}

/**
 * 指定位置の論理行を、行末改行を含めずに選択する。
 * 空行は次行へ移らないキャレットにする。
 * @param {EditorState} state エディタ状態
 * @param {number} pos 文書位置
 * @returns {SelectionRange} 行内容の選択範囲
 */
export function selectionRangeForLine(state: EditorState, pos: number): SelectionRange {
	const line = state.doc.lineAt(clampDocumentPos(state, pos));
	if (line.length === 0) {
		return EditorSelection.cursor(line.from, 1);
	}

	return EditorSelection.range(line.from, line.to);
}

/**
 * トリプルクリックのドラッグ範囲を、両端の行末改行を含めずに作る。
 * 同一行ではキャレットを常にその行末へ置く。
 * @param {EditorState} state エディタ状態
 * @param {number} startPos ドラッグ開始位置
 * @param {number} currentPos 現在位置
 * @returns {SelectionRange} 選択範囲
 */
export function selectionForTripleClick(
	state: EditorState,
	startPos: number,
	currentPos: number,
): SelectionRange {
	const startLine   = state.doc.lineAt(clampDocumentPos(state, startPos));
	const currentLine = state.doc.lineAt(clampDocumentPos(state, currentPos));
	if (startLine.number === currentLine.number) {
		return selectionRangeForLine(state, currentLine.from);
	}

	if (currentLine.number > startLine.number) {
		const assoc = currentLine.length === 0 ? 1 : -1;
		return EditorSelection.range(startLine.from, currentLine.to, undefined, undefined, assoc);
	}

	return EditorSelection.range(startLine.to, currentLine.from);
}

/**
 * 文書範囲へ位置を収める
 * @param {EditorState} state エディタ状態
 * @param {number} pos 文書位置
 * @returns {number} 有効な文書位置
 */
function clampDocumentPos(state: EditorState, pos: number): number {
	if (!Number.isFinite(pos)) {
		return 0;
	}

	return Math.max(0, Math.min(state.doc.length, Math.trunc(pos)));
}
