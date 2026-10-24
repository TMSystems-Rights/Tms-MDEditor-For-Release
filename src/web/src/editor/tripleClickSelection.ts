/**
 * トリプルクリックで論理行の内容だけを選択する
 * 行末の改行は選択に含めず、キャレットは選択した行の末尾に置く
 * 単クリックとダブルクリックは既定のマウス選択へ返し、本ファイルは detail が 3 以上のときだけスタイルを返す
 * @file
 */
import {
	EditorSelection,
	EditorState,
	Prec,
	type Extension,
	type SelectionRange,
} from '@codemirror/state';
import { EditorView, type MouseSelectionStyle } from '@codemirror/view';

// ----------------------------------------------
// 選択スタイル
// ----------------------------------------------

/**
 * トリプルクリック以上で、論理行の内容だけを選択するマウス選択を登録する
 * 行末の改行は含めない。キャレットは選択した行の末尾に置く
 * @returns 既定のマウス選択より優先する Extension
 */
export function createTripleClickSelectionExtension(): Extension {
	return Prec.high(EditorView.mouseSelectionStyle.of(tripleClickMouseSelectionStyle));
}

/**
 * トリプルクリックの選択スタイルを返す。単クリックとダブルクリックは既定の処理へ返す
 * @param view - 座標から文書位置を取るエディタ
 * @param event - マウスダウン。左ボタンかつ detail が 3 未満のときは対象外
 * @returns 行選択スタイル。左ボタンのトリプルクリック以上でないときは null
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
		 * ドラッグ中の文書変更に、開始位置と開始時の選択を追従させる
		 * @param update - ビュー更新。文書が変わったときだけ位置をマップする
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
		 * @param currentEvent - 現在のマウスイベント。座標が取れないときは開始位置を使う
		 * @param extend - true のとき開始時の選択を、クリック行の内容まで拡張する
		 * @param multiple - true のとき開始時の選択へ行範囲を追加する。extend が true のときは見ない
		 * @returns 新しい選択。同一行ではキャレットをその行末へ置く
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

// ----------------------------------------------
// 行範囲
// ----------------------------------------------

/**
 * 指定位置の論理行を、行末改行を含めずに選択する
 * 空行は次行へ移らないキャレットにする
 * @param state - 行を取る文書
 * @param pos - 文書位置。範囲外や非数は文書内へ収めてから行を決める
 * @returns 行内容の選択。空行は行頭の空キャレット
 */
export function selectionRangeForLine(state: EditorState, pos: number): SelectionRange {
	const line = state.doc.lineAt(clampDocumentPos(state, pos));
	if (line.length === 0) {
		return EditorSelection.cursor(line.from, 1);
	}

	return EditorSelection.range(line.from, line.to);
}

/**
 * トリプルクリックのドラッグ範囲を、両端の行末改行を含めずに作る
 * 同一行ではキャレットを常にその行末へ置く
 * @param state - 行範囲を取る文書
 * @param startPos - ドラッグ開始の文書位置
 * @param currentPos - 現在の文書位置。開始行より前なら選択の向きを逆にする
 * @returns 行末改行を含まない選択
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
 * @param state - 範囲の基準となる文書
 * @param pos - 収める文書位置。非数は 0、小数は切り捨てる
 * @returns 0 以上、文書長以下の整数位置
 */
function clampDocumentPos(state: EditorState, pos: number): number {
	if (!Number.isFinite(pos)) {
		return 0;
	}

	return Math.max(0, Math.min(state.doc.length, Math.trunc(pos)));
}
