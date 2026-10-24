/**
 * 空行以外の論理行をブロックラッパーで囲み、行の縦 margin を CodeMirror の高さ計測へ含める
 * ラッパーの寿命は StateField が持ち、呼び出し側は Extension と合成中フラグの Effect だけを受け取る
 * @file
 */
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

/**
 * 各論理行を個別に囲むブロックラッパー
 * 空行には付けない。範囲の from と to は buildLineWrappers が行ごとに決める
 */
const lineWrapper = BlockWrapper.create({
	tagName    : 'div',
	attributes : { class: LINE_WRAPPER_CLASS },
});

/** IME 合成中かを行ラッパー Field へ通知する Effect。true で開始、false で確定後の再構築 */
export const setLineWrapperCompositionEffect = StateEffect.define<boolean>();

/**
 * 行ラッパー Field が持つ、ラッパー範囲と IME 合成中かどうか
 * 合成中はラッパーを作り直さず、既存範囲を文書差分へ追従させる
 */
type LineWrapperState = {
	/** 空行以外を囲む BlockWrapper の範囲。合成中は作り直さない */
	wrappers: RangeSet<BlockWrapper>;
	/** IME 合成中は true。確定後の再構築まで維持する */
	composing: boolean;
};

/**
 * 文書の空行以外の論理行を個別のブロックラッパーで囲む
 *
 * `.cm-line` 自身の縦 margin は `getBoundingClientRect()` の高さに含まれない
 * ラッパーを block formatting context として扱うことで、その margin を親要素の
 * 高さへ含め、CodeMirror の HeightMap・ガター・クリック位置計算を同期させる
 * @param state - ラッパーを作る文書
 * @returns 空行を除いた行ラッパー。空文書は空集合
 */
function buildLineWrappers(state: EditorState) {
	const builder = new RangeSetBuilder<BlockWrapper>();
	for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
		const line = state.doc.line(lineNumber);
		// 空行は縦方向 margin を持たない。一方で WebView2 の IME は空行を囲む
		// BlockWrapper の DOM 更新で合成を中断するため、空行には作成しない
		if (line.length > 0) {
			builder.add(line.from, line.to, lineWrapper);
		}
	}

	return builder.finish();
}

/**
 * 行ラッパーを保持する StateField
 * 合成中と空行への入力では作り直さず、既存範囲を文書差分へ追従させる
 */
const lineWrappersField = StateField.define<LineWrapperState>({
	/**
	 * 開いた直後のラッパーを、空行を除いて作る。合成はまだ始まっていない
	 * @param state - 初期文書
	 * @returns 空行以外のラッパーと、composing false
	 */
	create(state) {
		return {
			wrappers : buildLineWrappers(state),
			composing: false,
		};
	},
	/**
	 * 合成の開始と終了、または文書変更に合わせてラッパーを更新する
	 * 合成中と空行への入力では作り直さない。空行を囲む DOM 更新は WebView2 の IME を中断する
	 * @param value - 更新前のラッパーと合成フラグ
	 * @param transaction - 今回のトランザクション。合成 Effect と文書差分を見る
	 * @returns 合成 Effect があればそのフラグに合わせた状態。文書が変わらなければ value
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
	 * ラッパー範囲をエディタの blockWrappers として公開する
	 * @param field - ラッパー状態を保持する StateField
	 * @returns blockWrappers へ wrappers だけを渡す Extension
	 */
	provide: (field) => EditorView.blockWrappers.from(field, (value) => value.wrappers),
});

/**
 * 任意の CSS スニペットで行要素へ指定された縦 margin を、CodeMirror の計測対象にする Extension を返す
 * @returns 行ラッパー Field と、IME の合成開始・終了ハンドラ
 */
export function createLineWrapperExtensions(): Extension[] {
	let restoreQueued        = false;
	/**
	 * IME 合成開始を行ラッパー Field へ通知する
	 * イベント自体は消費しない
	 * @param _event - 合成開始イベント。内容は読まない
	 * @param view - 合成中フラグを Effect で更新するエディタ
	 * @returns 他のハンドラへ渡す false
	 */
	const onCompositionStart = (_event: CompositionEvent, view: EditorView): boolean => {
		view.dispatch({ effects: setLineWrapperCompositionEffect.of(true) });
		return false;
	};
	/**
	 * IME 合成確定後に行ラッパーを再構築する
	 * compositionend の時点では文書更新が終わっていないことがあるため、次のマイクロタスクまで再構築を遅らせる
	 * 連続した終了イベントは 1 回にまとめる
	 * @param _event - 合成終了イベント。内容は読まない
	 * @param view - 合成終了を Effect で通知するエディタ
	 * @returns 他のハンドラへ渡す false。再構築の予約が済んでいるときも false
	 */
	const onCompositionEnd   = (_event: CompositionEvent, view: EditorView): boolean => {
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
