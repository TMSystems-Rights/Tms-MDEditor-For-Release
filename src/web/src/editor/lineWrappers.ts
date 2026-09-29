import {
	RangeSet,
	RangeSetBuilder,
	StateEffect,
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

/** IME 合成中かを行ラッパー Field へ通知する Effect */
export const setLineWrapperCompositionEffect = StateEffect.define<boolean>();

type LineWrapperState = {
	wrappers: RangeSet<BlockWrapper>;
	composing: boolean;
};

/**
 * 文書の空行以外の論理行を個別のブロックラッパーで囲む。
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
		// 空行は縦方向 margin を持たない。一方で WebView2 の IME は空行を囲む
		// BlockWrapper の DOM 更新で合成を中断するため、空行には作成しない。
		if (line.length > 0) {
			builder.add(line.from, line.to, lineWrapper);
		}
	}

	return builder.finish();
}

/**
 * 行ラッパーを保持する StateField
 */
const lineWrappersField = StateField.define<LineWrapperState>({
	/**
	 * @param {EditorState} state エディタ状態
	 * @returns {LineWrapperState} 行ラッパー状態
	 */
	create(state) {
		return {
			wrappers : buildLineWrappers(state),
			composing: false,
		};
	},
	/**
	 * @param {LineWrapperState} value 現在の行ラッパー状態
	 * @param {import('@codemirror/state').Transaction} transaction トランザクション
	 * @returns {LineWrapperState} 更新後の行ラッパー状態
	 */
	update(value, transaction) {
		for (const effect of transaction.effects) {
			if (effect.is(setLineWrapperCompositionEffect)) {
				return {
					wrappers : effect.value ? value.wrappers : buildLineWrappers(transaction.state),
					composing: effect.value,
				};
			}
		}

		if (!transaction.docChanged) {
			return value;
		}

		const activeLine = transaction.startState.doc.lineAt(transaction.startState.selection.main.head);
		if (value.composing || activeLine.length === 0) {
			return {
				wrappers : value.wrappers.map(transaction.changes),
				composing: value.composing,
			};
		}

		return {
			wrappers : buildLineWrappers(transaction.state),
			composing: false,
		};
	},
	/**
	 * @param {import('@codemirror/state').StateField<import('@codemirror/state').RangeSet<import('@codemirror/view').BlockWrapper>>} field 行ラッパー Field
	 * @returns {Extension} CodeMirror 拡張
	 */
	provide: (field) => EditorView.blockWrappers.from(field, (value) => value.wrappers),
});

/**
 * 任意の CSS スニペットで行要素へ指定された縦marginをCodeMirrorの計測対象にする拡張を生成する。
 * @returns {Extension[]} 行ラッパー拡張
 */
export function createLineWrapperExtensions(): Extension[] {
	let restoreQueued = false;
	/**
	 * IME 合成開始を行ラッパー Field へ通知する。
	 * @param {CompositionEvent} event 合成開始イベント
	 * @param {EditorView} view 対象エディタ
	 * @returns {boolean} イベント未処理
	 */
	const onCompositionStart = (_event: CompositionEvent, view: EditorView): boolean => {
		view.dispatch({ effects: setLineWrapperCompositionEffect.of(true) });
		return false;
	};
	/**
	 * IME 合成確定後に行ラッパーを再構築する。
	 * @param {CompositionEvent} event 合成終了イベント
	 * @param {EditorView} view 対象エディタ
	 * @returns {boolean} イベント未処理
	 */
	const onCompositionEnd = (_event: CompositionEvent, view: EditorView): boolean => {
		if (restoreQueued) {
			return false;
		}

		restoreQueued = true;
		queueMicrotask(() => {
			restoreQueued = false;
			view.dispatch({ effects: setLineWrapperCompositionEffect.of(false) });
		});
		return false;
	};

	return [
		lineWrappersField,
		EditorView.domEventHandlers({
			compositionstart: onCompositionStart,
			compositionend  : onCompositionEnd,
		}),
	];
}
