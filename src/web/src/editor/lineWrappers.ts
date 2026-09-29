import {
	RangeSetBuilder,
	StateField,
	type EditorState,
	type Extension,
} from '@codemirror/state';
import { BlockWrapper, EditorView } from '@codemirror/view';

/** CodeMirror の行本体を囲み、縦方向 margin を計測可能にするラッパークラス */
export const LINE_WRAPPER_CLASS = 'tms-mde-cm-line-wrapper';

/** 各論理行を個別に囲むブロックラッパー */
const lineWrapper = BlockWrapper.create({
	tagName    : 'div',
	attributes : { class: LINE_WRAPPER_CLASS },
});

/**
 * 文書の全論理行を個別のブロックラッパーで囲む。
 *
 * `.cm-line` 自身の縦 margin は `getBoundingClientRect()` の高さに含まれない。
 * ラッパーを block formatting context として扱うことで、その margin を親要素の
 * 高さへ含め、CodeMirror の HeightMap・ガター・クリック位置計算を同期させる。
 * @param {EditorState} state エディタ状態
 * @returns {import('@codemirror/state').RangeSet<import('@codemirror/view').BlockWrapper>} 行ラッパー集合
 */
function buildLineWrappers(state: EditorState) {
	const builder = new RangeSetBuilder<BlockWrapper>();
	for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
		const line = state.doc.line(lineNumber);
		builder.add(line.from, line.to, lineWrapper);
	}

	return builder.finish();
}

/**
 * 行ラッパーを保持する StateField
 */
const lineWrappersField = StateField.define({
	/**
	 * @param {EditorState} state エディタ状態
	 * @returns {import('@codemirror/state').RangeSet<import('@codemirror/view').BlockWrapper>} 行ラッパー集合
	 */
	create(state) {
		return buildLineWrappers(state);
	},
	/**
	 * @param {import('@codemirror/state').RangeSet<import('@codemirror/view').BlockWrapper>} value 現在の行ラッパー集合
	 * @param {import('@codemirror/state').Transaction} transaction トランザクション
	 * @returns {import('@codemirror/state').RangeSet<import('@codemirror/view').BlockWrapper>} 更新後の行ラッパー集合
	 */
	update(value, transaction) {
		return transaction.docChanged ? buildLineWrappers(transaction.state) : value;
	},
	/**
	 * @param {import('@codemirror/state').StateField<import('@codemirror/state').RangeSet<import('@codemirror/view').BlockWrapper>>} field 行ラッパー Field
	 * @returns {Extension} CodeMirror 拡張
	 */
	provide: (field) => EditorView.blockWrappers.from(field),
});

/**
 * 任意の CSS スニペットで行要素へ指定された縦marginをCodeMirrorの計測対象にする拡張を生成する。
 * @returns {Extension[]} 行ラッパー拡張
 */
export function createLineWrapperExtensions(): Extension[] {
	return [lineWrappersField];
}
