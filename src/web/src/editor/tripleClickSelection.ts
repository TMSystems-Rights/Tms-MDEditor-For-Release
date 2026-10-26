/**
 * トリプルクリックで論理行の内容だけを選択する
 * 行末の改行は選択に含めず、キャレットは選択した行の末尾に置く
 * 単クリックとダブルクリックは既定のマウス選択へ返し、本ファイルは detail が 3 以上のときだけスタイルを返す
 * @file
 */
import { EditorSelection, EditorState, Prec, type Extension, type SelectionRange } from '@codemirror/state';
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
	// 既定のマウス選択より前に、トリプルクリックの行選択を置く
	return Prec.high(EditorView.mouseSelectionStyle.of(tripleClickMouseSelectionStyle));
}

/**
 * トリプルクリックの選択スタイルを返す。単クリックとダブルクリックは既定の処理へ返す
 * @param view - 座標から文書位置を取るエディタ
 * @param event - マウスダウン。左ボタンかつ detail が 3 未満のときは対象外
 * @returns 行選択スタイル。左ボタンのトリプルクリック以上でないときは null
 */
export function tripleClickMouseSelectionStyle(view: EditorView, event: MouseEvent): MouseSelectionStyle | null {
	// 左ボタンでない、または detail が 3 未満なら既定の選択へ返す。いずれか一方でも行選択にはしない
	if (event.button !== 0 || event.detail < 3) {
		return null;
	}

	// 押した位置と、その側。座標から文書位置が取れないときは、後の get がこの値の欠落を開始位置で補う
	let start          = view.posAndSideAtCoords({ x: event.clientX, y: event.clientY }, false);
	// 押し始めたときの選択。拡張と追加では、この選択へ行範囲を足す
	let startSelection = view.state.selection;
	// ドラッグ中の追従と、離したときの行範囲。単クリック用のスタイルは返さない
	return {
		// 文書が変わったドラッグ中に、開始位置と開始時の選択を差分へ載せる
		/**
		 * ドラッグ中の文書変更に、開始位置と開始時の選択を追従させる
		 * @param update - ビュー更新。文書が変わったときだけ位置をマップする
		 */
		update(update) {
			// 文書が変わっていない更新では、開始位置も開始時の選択も動かさない
			if (!update.docChanged) {
				return;
			}

			// 文書差分を通した開始位置。側は押し始めのまま
			start          = {
				// マップ後の文書オフセット（文字）
				pos: update.changes.mapPos(start.pos),
				// 押し始めに付いていた側。差分では変えない
				assoc: start.assoc
			};
			// 開始時の選択を、同じ文書差分でずらす。範囲の中身は押し始めの選択のまま
			startSelection = startSelection.map(update.changes);
		},
		// クリック行、またはドラッグが跨いだ行範囲を、改行を含めずに返す
		/**
		 * クリック位置の論理行、またはドラッグ先までの行範囲を返す
		 * @param currentEvent - 現在のマウスイベント。座標が取れないときは開始位置を使う
		 * @param extend - true のとき開始時の選択を、クリック行の内容まで拡張する
		 * @param multiple - true のとき開始時の選択へ行範囲を追加する。extend が true のときは見ない
		 * @returns 新しい選択。同一行ではキャレットをその行末へ置く
		 */
		get(currentEvent, extend, multiple) {
			// いまの座標の文書位置と側。座標が取れないときは null で、開始位置を使う
			const current    = view.posAndSideAtCoords({ x: currentEvent.clientX, y: currentEvent.clientY }, false);
			// 選択の終点に使う文書オフセット（文字）。座標が取れなければ押し始めの位置
			const currentPos = current?.pos ?? start.pos;
			// 開始行から現在行まで、行末改行を含めない範囲。同一行ではその行の内容だけ
			const lineRange  = selectionForTripleClick(view.state, start.pos, currentPos);
			// 拡張のときは、開始時の選択を現在行の内容まで広げる。追加選択は見ない
			if (extend) {
				// 現在位置の行内容。空行は行頭の空キャレット
				const clickedLine = selectionRangeForLine(view.state, currentPos);
				return startSelection.replaceRange(startSelection.main.extend(clickedLine.from, clickedLine.to));
			}

			// 追加選択のときは、開始時の選択へ行範囲を足す。拡張のあとには到達しない
			if (multiple) {
				return startSelection.addRange(lineRange);
			}

			return EditorSelection.create([lineRange]);
		}
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
	// 収めた位置がある論理行。選択はこの行の文字だけで、改行は含めない
	const line = state.doc.lineAt(clampDocumentPos(state, pos));
	// 空行は次の行へ移らない空キャレットにする。行末側へ付ける
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
export function selectionForTripleClick(state: EditorState, startPos: number, currentPos: number): SelectionRange {
	// 押し始めた行。from は選択の上流側に使う
	const startLine   = state.doc.lineAt(clampDocumentPos(state, startPos));
	// いま指がある行。開始行より前なら選択の向きを逆にする
	const currentLine = state.doc.lineAt(clampDocumentPos(state, currentPos));
	// 同じ論理行では、その行の内容だけを選ぶ。キャレットは行末
	if (startLine.number === currentLine.number) {
		return selectionRangeForLine(state, currentLine.from);
	}

	// 現在行が開始行より後ろのとき、開始行の先頭から現在行の末尾まで。行末改行は to に含まれない
	if (currentLine.number > startLine.number) {
		// 現在行が空なら次行へ移らない側、文字がある行は行末の手前側。描画上の改行を選択に含めない
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
	// 非数は文書先頭として扱う。行の解決に NaN を渡さない
	if (!Number.isFinite(pos)) {
		return 0;
	}

	return Math.max(0, Math.min(state.doc.length, Math.trunc(pos)));
}
