/**
 * Enter でリスト・引用・チェックボックスのマーカーを継続するコマンドを公開する
 * 継続規則は CodeMirror の実装に任せ、本ファイルは非タイト化の空行を入れない設定と、継続した行のインデントと番号の後ろの空白の補正だけを持つ
 * @file
 */
import { insertNewlineContinueMarkupCommand } from '@codemirror/lang-markdown';
import type { ChangeSpec, EditorState, Line, StateCommand, Transaction } from '@codemirror/state';
import { adjustOrderedMarkerSpacing, parseListLine } from './listIndent';

/**
 * CodeMirror 標準の継続コマンド
 * 空のマーカー行ではレベルを解除する。非タイト化のための空行は挿入しない
 */
const codeMirrorContinueListMarkup = insertNewlineContinueMarkupCommand({
	// 継続時に空行を挟まない。false のあいだは、項目のあいだを非タイトなリストにしない
	nonTightLists: false
});

/** 空行とみなす行。空白と引用符だけの行。引用の中のリストで CodeMirror が足す `>` だけの行も含める */
const BLANK_CONTINUATION_LINE = /^[\s>]*$/;

/**
 * CodeMirror が継続の前に足した空行を探す
 * CodeMirror は、リストの 1 項目目と 2 項目目のあいだに空行があると、設定に関係なく続ける項目の前にも空行を入れる
 * 見た目は別のリストでも、空行しか挟まないと前のリストの続きになるため、Enter 1 回で空行ができてしまう
 * @param state - Enter を押す前の状態
 * @param transaction - CodeMirror の継続コマンドが作ったトランザクション
 * @returns 足された空行。継続後の文書の行。足していなければ null
 */
function findInsertedBlankLine(state: EditorState, transaction: Transaction): Line | null {
	// Enter を押した行の番号。1 始まり
	const sourceNumber = state.doc.lineAt(state.selection.main.head).number;
	// 継続後のキャレットがある行の番号。空行を足したときは元の行の 2 行下
	const caretNumber  = transaction.state.doc.lineAt(transaction.state.selection.main.head).number;
	// 行が 2 行増えて、キャレットが 2 行下にあるときだけ空行を足している。どちらか一方でも違えば足していない
	if (transaction.state.doc.lines !== state.doc.lines + 2 || caretNumber !== sourceNumber + 2) {
		return null;
	}

	// 元の行とキャレット行のあいだの行
	const between = transaction.state.doc.line(sourceNumber + 1);
	return BLANK_CONTINUATION_LINE.test(between.text) ? between : null;
}

/**
 * 継続で作った次の行を、元の行と同じインデントと本文の開始位置へ直す変更を作る
 * CodeMirror はタブでインデントした項目を継続するとき、桁数にタブの文字数を足した空白を入れる
 * （8 桁の `\t\t1.` から 10 個の空白、14 桁の `\t\t\t  1.` から 19 個の空白）。この幅では同じ階層の兄弟にならない
 * また `9.` の次を `10.` にするときは、記号の後ろの空白を 1 つ減らして本文の開始位置を保つ
 * @param state - Enter を押す前の状態
 * @param transaction - CodeMirror の継続コマンドが作ったトランザクション
 * @returns 継続後の文書に対する変更。直す必要が無いときは null
 */
function buildContinuedLineFix(state: EditorState, transaction: Transaction): ChangeSpec | null {
	// Enter を押した行
	const sourceLine = state.doc.lineAt(state.selection.main.head);
	// その行のリスト分解。引用の中の項目やリストでない行は null
	const sourceInfo = parseListLine(sourceLine.text);
	// 継続後のキャレットがある行。兄弟の項目を続けたときは次の行になる
	const nextLine   = transaction.state.doc.lineAt(transaction.state.selection.main.head);
	// 継続後の行のリスト分解。リストでなければ null
	const nextInfo   = parseListLine(nextLine.text);
	// 元の行と継続後の行のあいだに CodeMirror が足した空行の数。この空行は fixContinuedListIndent が取り除く
	const blankLines = findInsertedBlankLine(state, transaction) ? 1 : 0;
	// 元の行か継続後の行がリストでない、または次の行へ進んでいない。空の項目の解除などは補正しない。どれか一つでも当たれば直さない
	if (!sourceInfo || !nextInfo || nextLine.number !== sourceLine.number + 1 + blankLines) {
		return null;
	}

	// 番号付きと箇条書きが入れ替わった継続は、同じ階層の兄弟とはみなさない
	if (sourceInfo.isOrdered !== nextInfo.isOrdered) {
		return null;
	}

	// 記号の後ろの空白。番号付きは、桁数が変わっても元の行と本文の開始位置がそろうよう増減する
	const after  = sourceInfo.isOrdered ? adjustOrderedMarkerSpacing(sourceInfo.numberText, sourceInfo.after, nextInfo.numberText) : nextInfo.after;
	// 記号そのもの。番号付きは CodeMirror が付けた番号と区切り、箇条書きは記号
	const marker = nextInfo.isOrdered ? `${nextInfo.numberText}${nextInfo.separator}` : nextInfo.bullet;
	// インデントも空白も元の行どおりなら直さない。幅が同じでもタブを空白に変えた行は、元の行の書き方へそろえる
	if (sourceInfo.indent === nextInfo.indent && after === nextInfo.after) {
		return null;
	}

	// 継続後の行の、行頭から記号の後ろの空白までの置き換え
	return {
		// 継続後の行の行頭
		from: nextLine.from,
		// 記号の後ろの空白の終わり。本文は含めない
		to: nextLine.from + nextInfo.indent.length + marker.length + nextInfo.after.length,
		// 元の行のインデント、記号、そろえた空白。タブはタブのまま残す
		insert: `${sourceInfo.indent}${marker}${after}`
	};
}

/**
 * CodeMirror が振り直した後続の番号のうち、桁数が変わった行の空白を直す変更を集める
 * 後続の `9.  b` が `10.  b` になると本文の開始位置が 1 桁右へずれ、その下の子の項目が子でなくなるため `10. b` にする
 * @param state - Enter を押す前の状態
 * @param transaction - CodeMirror の継続コマンドが作ったトランザクション
 * @returns 継続後の文書に対する変更。無ければ空
 */
function buildRenumberedLineFixes(state: EditorState, transaction: Transaction): ChangeSpec[] {
	// 継続後の文書でキャレットがある行の終わり。これより後ろの変更だけを番号の振り直しとみなす
	const caretLineEnd        = transaction.state.doc.lineAt(transaction.state.selection.main.head).to;
	// 直す変更。継続後の文書の位置で持つ
	const fixes: ChangeSpec[] = [];
	transaction.changes.iterChangedRanges((fromA, _toA, fromB) => {
		// 改行と新しい記号の挿入は、キャレット行までにある。振り直しではないので見ない
		if (fromB <= caretLineEnd) {
			return;
		}

		// 振り直した行。継続後の文書
		const line    = transaction.state.doc.lineAt(fromB);
		// 振り直す前の同じ行
		const oldLine = state.doc.lineAt(fromA);
		// 振り直したあとのリスト分解。リストでなければ null
		const info    = parseListLine(line.text);
		// 振り直す前のリスト分解。リストでなければ null
		const oldInfo = parseListLine(oldLine.text);
		// どちらかが番号付きでない、または番号の桁数が同じ。どれか一つでも当たれば直さない
		if (!info?.isOrdered || !oldInfo?.isOrdered || info.numberText.length === oldInfo.numberText.length) {
			return;
		}

		// 本文の開始位置を保つ空白
		const after = adjustOrderedMarkerSpacing(oldInfo.numberText, oldInfo.after, info.numberText);
		// 既にその空白なら直さない
		if (after === info.after) {
			return;
		}

		// 記号の後ろの空白の開始
		const from = line.from + info.indent.length + info.numberText.length + info.separator.length;
		// 記号の後ろの空白の置き換え
		fixes.push({
			// 空白の開始
			from,
			// 空白の終わり。本文の直前
			to: from + info.after.length,
			// 本文の開始位置を保つ空白
			insert: after
		});
	});

	return fixes;
}

/**
 * 継続で作った行と、振り直した後続の行を直し、CodeMirror が足した空行を取り除いたトランザクションを作る
 * 直す変更は CodeMirror の継続と 1 つのトランザクションにまとめ、元に戻す操作を 1 回で済ませる
 * @param state - Enter を押す前の状態
 * @param transaction - CodeMirror の継続コマンドが作ったトランザクション
 * @returns 直したトランザクション。直す必要が無いときは null
 */
export function fixContinuedListIndent(state: EditorState, transaction: Transaction): Transaction | null {
	// 複数カーソルは補正しない。各行の対応を取らず、CodeMirror の結果をそのまま使う
	if (state.selection.ranges.length !== 1 || transaction.state.selection.ranges.length !== 1) {
		return null;
	}

	// CodeMirror が足した空行。足していなければ null
	const blankLine = findInsertedBlankLine(state, transaction);
	// 空行を、その改行ごと取り除く変更。足していなければ無し
	const blankFix  = blankLine ? [{ from: blankLine.from, to: blankLine.to + 1 }] : [];
	// 継続した行の修正。直さないときは null
	const lineFix   = buildContinuedLineFix(state, transaction);
	// 継続後の文書に対する変更の並び。どれも同じ文書の位置で、範囲は重ならない
	const fixes     = [...blankFix, ...(lineFix ? [lineFix] : []), ...buildRenumberedLineFixes(state, transaction)];
	// 直すところが無ければ CodeMirror の結果のまま
	if (fixes.length === 0) {
		return null;
	}

	return state.update(
		{
			// CodeMirror の継続そのもの。番号の振り直しも含む
			changes: transaction.changes,
			// 継続後のキャレット。後ろの置換で位置がずれる分は自動で写す
			selection: transaction.selection,
			// 継続した行を表示域へ入れる
			scrollIntoView: true,
			// 文字入力として履歴に残す。CodeMirror の継続と同じ種別
			userEvent: 'input'
		},
		{
			// 継続した行と、振り直した行の修正
			changes: fixes,
			// 位置は 1 つ目の変更を当てたあとの文書で数える
			sequential: true
		}
	);
}

/**
 * リスト・引用・チェックボックス行で Enter したときにマーカーを継続するコマンド
 * 空のマーカー行ではレベルを解除する。非タイト化のための空行は挿入しない
 * タブでインデントした項目では、次の行のインデントを元の行と同じ文字列にする
 * 番号の桁数が変わる行は、記号の後ろの空白を増減して本文の開始位置を保つ
 * 前の項目とのあいだに空行があるリストでも、続ける項目の前に空行を足さない
 * @param target - コマンド対象
 * @param target.state - Enter を押す前の状態
 * @param target.dispatch - 継続のトランザクションを適用する先
 * @returns リストや引用として継続したとき true。それ以外は false で、後続の改行に任せる
 */
export const continueListMarkup: StateCommand = ({ state, dispatch }) => {
	// CodeMirror が作った継続。呼ばれなければ null
	let continued: Transaction | null = null;
	// 継続できたか。false のときは何も適用しない
	const handled                     = codeMirrorContinueListMarkup({
		// Enter を押す前の状態
		state,
		/**
		 * 継続のトランザクションを、補正の前に受け取る
		 * @param transaction - CodeMirror が作った継続
		 */
		dispatch: (transaction) => {
			continued = transaction;
		}
	});
	// 継続しなかった、またはトランザクションを受け取れなかった。どちらか一方でも補正しない
	if (!handled || !continued) {
		return handled;
	}

	dispatch(fixContinuedListIndent(state, continued) ?? continued);
	return true;
};
