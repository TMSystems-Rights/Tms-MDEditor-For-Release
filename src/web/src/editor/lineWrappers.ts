/**
 * 空行以外の論理行をブロックラッパーで囲み、行の縦 margin を CodeMirror の高さ計測へ含める
 * ラッパーの寿命は StateField が持ち、呼び出し側は Extension と合成中フラグの Effect だけを受け取る
 * @file
 */
import { RangeSet, RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { BlockWrapper, EditorView } from '@codemirror/view';

/** CodeMirror の行本体を囲み、縦方向 margin を計測可能にするラッパークラス */
export const LINE_WRAPPER_CLASS = 'tms-mde-cm-line-wrapper';

/**
 * 各論理行を個別に囲むブロックラッパー
 * 空行には付けない。範囲の from と to は buildLineWrappers が行ごとに決める
 */
const lineWrapper = BlockWrapper.create({
	tagName: 'div',
	attributes: { class: LINE_WRAPPER_CLASS }
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
	// 空行以外の行ラッパーを積む。空文書は finish しても空集合
	const builder = new RangeSetBuilder<BlockWrapper>();
	for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
		// 走査中の論理行。空行かどうかは length で見る
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
		// 開いた直後のラッパー。合成はまだ始まっていない
		return {
			// 空行以外を囲む範囲
			wrappers: buildLineWrappers(state),
			// まだ合成は始まっていない
			composing: false
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
			// 合成フラグの通知。開始なら既存ラッパーを維持し、終了なら文書から作り直す
			if (effect.is(setLineWrapperCompositionEffect)) {
				// 合成の開始と終了で、ラッパーを維持するか作り直すかを切り替える
				return {
					// 合成中は既存範囲を維持する。終了（false）のときだけ空行以外を作り直す
					wrappers: effect.value ? value.wrappers : buildLineWrappers(transaction.state),
					// この Effect の値。true は合成中、false は確定後
					composing: effect.value
				};
			}
		}

		// 文書が変わっていなければ、ラッパーも合成フラグも維持する
		if (!transaction.docChanged) {
			return value;
		}

		// 変更前の主選択がある行。空行への入力ではラッパーを作り直さない
		const activeLine = transaction.startState.doc.lineAt(transaction.startState.selection.main.head);
		// 合成中、または空行への入力なら、既存範囲を差分へ追従させるだけ。どちらか一方でも DOM の作り直しはしない
		if (value.composing || activeLine.length === 0) {
			// 差分追従。空行を新たに囲まない
			return {
				// 既存ラッパーを文書差分へずらしたもの
				wrappers: value.wrappers.map(transaction.changes),
				// 合成フラグは維持する。空行入力だけでは合成中にしない
				composing: value.composing
			};
		}

		// 通常の編集後は、空行以外を文書から作り直す
		return {
			// 空行以外を作り直した範囲
			wrappers: buildLineWrappers(transaction.state),
			// 通常の編集後は合成中ではない
			composing: false
		};
	},
	/**
	 * ラッパー範囲をエディタの blockWrappers として公開する
	 * @param field - ラッパー状態を保持する StateField
	 * @returns blockWrappers へ wrappers だけを渡す Extension
	 */
	provide: (field) => EditorView.blockWrappers.from(field, (value) => value.wrappers)
});

/**
 * 任意の CSS スニペットで行要素へ指定された縦 margin を、CodeMirror の計測対象にする Extension を返す
 * @returns 行ラッパー Field と、IME の合成開始・終了ハンドラ
 */
export function createLineWrapperExtensions(): Extension[] {
	// 合成終了の再構築を予約済みか。false のあいだだけ、次の compositionend を受け付ける
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
		// 再構築が既に予約されているときは、終了イベントを重ねて予約しない
		if (restoreQueued) {
			return false;
		}

		// この終了からマイクロタスクが走るまで true。連続した compositionend は 1 回にまとめる
		restoreQueued = true;
		// 文書更新のあとにラッパーを作り直す。compositionend の時点では文書がまだ古いことがある
		queueMicrotask(() => {
			// 予約を消化した。次の合成終了は改めて再構築できる
			restoreQueued = false;
			view.dispatch({ effects: setLineWrapperCompositionEffect.of(false) });
		});
		return false;
	};

	return [
		lineWrappersField,
		// 合成の開始と終了を、行ラッパーの作り直しに結びつける。イベント自体は消費しない
		EditorView.domEventHandlers({
			// 合成開始でラッパーの再構築を止めるハンドラ
			compositionstart: onCompositionStart,
			// 合成終了の次のマイクロタスクでラッパーを作り直すハンドラ
			compositionend: onCompositionEnd
		})
	];
}
