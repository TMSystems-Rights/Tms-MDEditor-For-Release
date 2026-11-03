/**
 * ライブプレビューで折り返したリスト項目の 2 行目以降を、項目本文の開始位置へ揃える
 * 本文の開始位置は描画後に測り、行の `text-indent: <幅> hanging` にして StateField が持つ
 * 呼び出し側は Extension を受け取るだけで、計測の時期はこのファイルが寸法と選択の変化に合わせて決める
 * @file
 */
import { syntaxTree } from '@codemirror/language';
import { type ChangeDesc, type EditorState, type Extension, StateEffect, StateField, type Text } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { viewModeField } from './livePreviewPlugin';

/** ぶら下げインデントを当てた行に付けるクラス。中のインラインブロックの text-indent を 0 へ戻す CSS が参照する */
export const LIST_HANGING_LINE_CLASS = 'cm-md-list-hang';

/** 計測値を丸める倍率。0.1px 単位にし、端数の揺れで装飾を出し直し続けないようにする */
const PIXEL_ROUNDING = 10;

/**
 * 折り返しを揃えるリスト項目の行と、その本文が始まる位置
 * 位置は文書先頭からの文字位置で、描画上の幅はまだ持たない
 */
export type ListHangingTarget = {
	/** 項目のマーカーがある行の先頭位置 */
	lineFrom: number;
	/** マーカー、タスク記法、直後の空白を飛ばした本文の開始位置。本文が無ければ行末 */
	textFrom: number;
};

/**
 * 1 行分のぶら下げインデントの計測結果
 * hang は描画後の px で、行の style へそのまま書く
 */
export type ListHangingMeasure = {
	/** 装飾を当てる行の先頭位置。文書変更では StateField が差分へ追従させる */
	lineFrom: number;
	/** 行頭から本文開始までの幅（px）。2 行目以降をこの幅だけ右へ寄せる。0 より大きい */
	hang: number;
};

/**
 * 計測した範囲と、その範囲で得た計測結果
 * 範囲の外にある既存の結果は、書き込み側が残す
 */
type ListHangingReadResult = {
	/** 計測した時点の文書。書き込みまでに文書が変わっていたら結果を捨てる */
	doc: Text;
	/** 計測した範囲の開始位置。ビューの viewport の開始 */
	from: number;
	/** 計測した範囲の終端位置。ビューの viewport の終端 */
	to: number;
	/** 範囲内で測れた行の結果。行頭位置の昇順。ライブプレビュー以外や折り返し無しでは空 */
	measures: ListHangingMeasure[];
	/** true のときは範囲に関係なく、すべての結果を消す。ライブプレビュー以外や折り返し無しのとき */
	clearAll: boolean;
};

// ==============================================
// 対象行と計測値の算出
// ==============================================

/**
 * 指定範囲にあるリスト項目の、マーカー行と本文開始位置を集める
 * 構文木がまだ解析していない範囲の項目は含めない
 * @param state - 対象の文書。Markdown の構文木を持つこと
 * @param from - 走査を始める位置。省略時は文書先頭
 * @param to - 走査を終える位置。省略時は文書末尾
 * @returns マーカー行ごとの対象。行頭位置の昇順。リストが無ければ空
 */
export function collectListHangingTargets(state: EditorState, from: number = 0, to: number = state.doc.length): ListHangingTarget[] {
	// 集めた対象。リスト項目が無ければ空のまま返す
	const targets: ListHangingTarget[] = [];

	syntaxTree(state).iterate({
		// 走査の開始位置
		from,
		// 走査の終端位置
		to,
		/**
		 * リスト項目ごとに、マーカー行の本文開始位置を記録する
		 * @param ref - 走査中のノード参照
		 */
		enter(ref) {
			// リスト項目以外は対象にしない。入れ子の項目は子として別に訪れる
			if (ref.name !== 'ListItem') {
				return;
			}

			// この項目直下のリスト記号。無ければ null
			const listMark = ref.node.getChild('ListMark');
			// 記号の無い項目は本文の開始を決められない
			if (!listMark) {
				return;
			}

			// マーカーがある行。項目の 1 行目
			const line     = state.doc.lineAt(listMark.from);
			// 本文の開始位置。まずリスト記号の直後とし、タスク記法と空白を後ろへ飛ばす
			let textFrom   = listMark.to;
			// 項目本文の段落。タスク項目では Task ノードになる。無ければ null
			const taskNode = ref.node.getChild('Task');
			// タスク記法。Task の直下にあるときだけ取る。無ければ null
			const marker   = taskNode?.getChild('TaskMarker') ?? null;
			// タスク記法が同じ行にあるときだけ、チェックボックスの後ろを本文の開始にする
			if (marker && marker.from <= line.to) {
				textFrom = Math.max(textFrom, marker.to);
			}

			// 記号の後ろの空白。行末までの範囲だけ見る
			const rest   = state.doc.sliceString(textFrom, line.to);
			// 先頭の空白とタブの文字数。無ければ 0
			const spaces = rest.length - rest.trimStart().length;
			textFrom    += spaces;
			// 1 行に 1 件だけ記録する。行頭位置の昇順で走査するため、末尾と比べれば重複を避けられる
			if (targets.at(-1)?.lineFrom !== line.from) {
				// マーカー行と本文の開始
				targets.push({
					// 装飾を当てる行の先頭
					lineFrom: line.from,
					// 本文の開始。本文が無い項目は行末
					textFrom
				});
			}
		}
	});

	return targets;
}

/**
 * px 値を計測値の単位へ丸める
 * @param value - 丸める px 値
 * @returns 0.1px 単位へ四捨五入した値
 */
function roundPixels(value: number): number {
	return Math.round(value * PIXEL_ROUNDING) / PIXEL_ROUNDING;
}

/**
 * 計測結果の並びが同じか判定する
 * @param left - 比べる一方。行頭位置の昇順であること
 * @param right - 比べるもう一方。行頭位置の昇順であること
 * @returns 件数と、各行の位置と幅がすべて一致すれば true
 */
export function sameListHangingMeasures(left: readonly ListHangingMeasure[], right: readonly ListHangingMeasure[]): boolean {
	// 件数が違えば、中身を比べるまでもなく別物
	if (left.length !== right.length) {
		return false;
	}

	return left.every((measure, index) => {
		// 同じ順番にある相手側の結果。件数は一致済みなので必ずある
		const other = right[index];
		return measure.lineFrom === other.lineFrom && measure.hang === other.hang;
	});
}

/**
 * 計測した範囲の結果で、既存の結果を置き換える
 * 範囲外の結果は残し、スクロールで戻ったときに一瞬だけ揃わない状態を減らす
 * @param previous - これまでの結果。行頭位置の昇順
 * @param measured - 今回測った範囲の結果。行頭位置の昇順
 * @param from - 今回測った範囲の開始位置
 * @param to - 今回測った範囲の終端位置
 * @returns 範囲外の既存結果と今回の結果を合わせたもの。行頭位置の昇順
 */
export function mergeListHangingMeasures(previous: readonly ListHangingMeasure[], measured: readonly ListHangingMeasure[], from: number, to: number): ListHangingMeasure[] {
	// 今回の範囲の外にある既存の結果。範囲内は今回の結果で置き換える
	const outside = previous.filter((measure) => measure.lineFrom < from || measure.lineFrom > to);
	return [...outside, ...measured].sort((left, right) => left.lineFrom - right.lineFrom);
}

/**
 * 文書変更に合わせて、計測結果の行頭位置をずらす
 * 行頭でなくなった位置と、同じ行へ重なった結果は捨てる。捨てた行は次の計測で測り直す
 * @param measures - 変更前の結果。行頭位置の昇順
 * @param changes - 今回の文書差分
 * @param doc - 変更後の文書
 * @returns 変更後も行頭にある結果。行頭位置の昇順
 */
export function mapListHangingMeasures(measures: readonly ListHangingMeasure[], changes: ChangeDesc, doc: Text): ListHangingMeasure[] {
	// 変更後も行頭に残った結果
	const mapped: ListHangingMeasure[] = [];
	for (const measure of measures) {
		// 変更後の位置。行頭へ文字を挿入しても、挿入の前側に残す
		const lineFrom = changes.mapPos(measure.lineFrom, -1);
		// 文書末尾を越えた位置、または行頭でなくなった位置は捨てる。どちらか一方でも捨てる
		if (lineFrom > doc.length || doc.lineAt(lineFrom).from !== lineFrom) {
			continue;
		}

		// 直前の結果と同じ行へ重なったときは、先に残した方だけ使う
		if (mapped.at(-1)?.lineFrom === lineFrom) {
			continue;
		}

		// 位置だけを変更後へずらした結果。幅は次の計測まで変えない
		mapped.push({
			// 変更後の行頭位置
			lineFrom,
			// 変更前に測った本文開始までの幅
			hang: measure.hang
		});
	}

	return mapped;
}

/**
 * 計測結果を、行へ当てる style 属性の文字列にする
 * hanging 付きの text-indent は 1 行目を動かさず、2 行目以降だけを右へ寄せる
 * padding-left を変えないので、行の内容の起点から数えるタブ位置も動かない
 * @param measure - 1 行分の計測結果
 * @returns 行の style 属性へ入れる宣言
 */
export function formatListHangingStyle(measure: ListHangingMeasure): string {
	return `text-indent: ${measure.hang}px hanging`;
}

/**
 * 計測結果から行装飾を作る
 * @param measures - 行頭位置の昇順の計測結果
 * @returns 各行へクラスと style を付ける行装飾。結果が無ければ空
 */
function buildListHangingDecorations(measures: readonly ListHangingMeasure[]): DecorationSet {
	return Decoration.set(
		measures.map((measure) =>
			Decoration.line({
				// 中のインラインブロックへ text-indent を継がせない CSS の目印
				class: LIST_HANGING_LINE_CLASS,
				// 行ごとに幅が違うため、クラスではなく style で直接書く
				attributes: { style: formatListHangingStyle(measure) }
			}).range(measure.lineFrom)
		)
	);
}

// ==============================================
// 計測結果の保持
// ==============================================

/** 計測結果を StateField へ書く Effect。値は文書全体の結果で、既存の結果を置き換える */
const setListHangingMeasuresEffect = StateEffect.define<ListHangingMeasure[]>();

/** 計測結果を保持する StateField。初期値は空で、計測が済むまで装飾を出さない */
const listHangingMeasuresField = StateField.define<readonly ListHangingMeasure[]>({
	/**
	 * 計測前の初期値を作る
	 * @returns 空の結果
	 */
	create() {
		return [];
	},
	/**
	 * 計測結果の Effect で置き換え、文書変更では行頭位置をずらす
	 * @param value - 現在の結果
	 * @param transaction - 今回のトランザクション
	 * @returns Effect があればその値。文書だけが変わったときはずらした結果。どちらも無ければ value
	 */
	update(value, transaction) {
		for (const effect of transaction.effects) {
			// 計測結果の Effect は、文書変更より後の状態で測った値なので、そのまま採る
			if (effect.is(setListHangingMeasuresEffect)) {
				return effect.value;
			}
		}

		// 文書が変わったときだけ位置をずらす。選択だけの更新では値を変えない
		if (transaction.docChanged) {
			return mapListHangingMeasures(value, transaction.changes, transaction.state.doc);
		}

		return value;
	},
	/**
	 * 計測結果を行装飾としてエディタへ渡す
	 * @param field - 計測結果を持つ StateField
	 * @returns 結果から作った行装飾を提供する Extension
	 */
	provide: (field) => EditorView.decorations.compute([field], (state) => buildListHangingDecorations(state.field(field)))
});

// ==============================================
// 描画後の計測
// ==============================================

/**
 * 1 行分の本文開始幅を測る
 * hanging の text-indent は 1 行目を動かさないため、当てた後に測り直しても同じ幅になる
 * @param view - 対象エディタ
 * @param target - 測る行と本文の開始位置
 * @returns 計測結果。座標が取れない、幅が 0 以下、本文の開始が 2 行目へ折り返したときは null
 */
function measureListHangingLine(view: EditorView, target: ListHangingTarget): ListHangingMeasure | null {
	// 本文開始が行末か。行末では次の文字が無いため、前の文字側の座標を取る
	const atLineEnd = target.textFrom >= view.state.doc.lineAt(target.lineFrom).to;
	// 1 行目の先頭の座標。行の内容の起点で、ぶら下げを当てても動かない
	const startRect = view.coordsAtPos(target.lineFrom, 1);
	// 本文開始の座標。行末では直前の文字の右端
	const textRect  = view.coordsAtPos(target.textFrom, atLineEnd ? -1 : 1);
	// どちらかの座標が取れなければ測れない。描画範囲外の行も含め、どちらか一方でも null なら返す
	if (!startRect || !textRect) {
		return null;
	}

	// 本文の開始が 1 行目に無いときは幅を決められない。表示行が重ならなければ返す
	if (textRect.top >= startRect.bottom || startRect.top >= textRect.bottom) {
		return null;
	}

	// 横方向の拡大率。変形が無ければ 1。0 は未レイアウトとして 1 で割る
	const scale = view.scaleX || 1;
	// 行頭から本文開始までの幅（px）。拡大率を戻した CSS 上の幅
	const hang  = roundPixels((textRect.left - startRect.left) / scale);
	// 幅が 0 以下、または数値でなければ当てない。折りたたみで隠れた行も含む
	if (!(hang > 0)) {
		return null;
	}

	// この行の計測結果
	return {
		// 装飾を当てる行の先頭
		lineFrom: target.lineFrom,
		// 本文開始までの幅
		hang
	};
}

/**
 * ビューの描画範囲で、折り返しを揃える行を測る
 * ライブプレビュー以外と、折り返しを切っているときは、すべての結果を消す指示を返す
 * @param view - 対象エディタ
 * @returns 計測した範囲と結果
 */
function readListHangingMeasures(view: EditorView): ListHangingReadResult {
	// 描画中の範囲。この外の行は DOM が無く測れない
	const { from, to } = view.viewport;
	// 表示モード。フィールドが無ければソース表示
	const viewMode     = view.state.field(viewModeField, false) ?? 'source';
	// ライブプレビューで折り返しが有効なときだけ測る。どちらか一方でも欠ければ結果を消す
	if (viewMode !== 'live-preview' || !view.lineWrapping) {
		// すべて消す指示
		return {
			// 計測時点の文書
			doc: view.state.doc,
			// 消す指示では使わない範囲の開始
			from,
			// 消す指示では使わない範囲の終端
			to,
			// 消す指示なので結果は空
			measures: [],
			// 範囲に関係なく消す
			clearAll: true
		};
	}

	// 描画範囲で測れた行の結果
	const measures: ListHangingMeasure[] = [];
	for (const target of collectListHangingTargets(view.state, from, to)) {
		// この行の結果。測れなければ null
		const measure = measureListHangingLine(view, target);
		// 測れた行だけ結果に入れる
		if (measure) {
			measures.push(measure);
		}
	}

	// 描画範囲の結果
	return {
		// 計測時点の文書
		doc: view.state.doc,
		// 測った範囲の開始
		from,
		// 測った範囲の終端
		to,
		// 範囲内の結果
		measures,
		// 範囲外の結果は残す
		clearAll: false
	};
}

/**
 * 描画後に本文開始位置を測り、変わったときだけ StateField へ書く
 * 計測の予約とマイクロタスクでの書き込みは、このインスタンスがビューの寿命に合わせて持つ
 */
class ListHangingIndentMeasurer {
	/** 破棄後は書き込まない。予約したマイクロタスクが遅れて走っても、このフラグで止める */
	private destroyed     = false;
	/** 書き込みをマイクロタスクへ予約済みなら true。同じ周期の書き込みを 1 回にまとめる */
	private writeQueued   = false;
	/** 予約中の書き込みで使う結果。書き込むまでは最後に測った値で上書きする */
	private pendingResult: ListHangingReadResult | null = null;

	/**
	 * 初回の計測を予約する
	 * @param view - 計測と書き込みの対象エディタ
	 */
	constructor(private readonly view: EditorView) {
		this.schedule();
	}

	/**
	 * 文書、選択、寸法、表示範囲、表示モード、設定が変わったときに測り直す
	 * 自分の書き込みで寸法が変わったときも測り直すが、値が同じなら書き込まないので繰り返さない
	 * @param update - 今回のビュー更新
	 */
	update(update: ViewUpdate): void {
		// 表示モードが変わったか。ライブプレビューの出入りで結果を作り直す
		const viewModeChanged = update.startState.field(viewModeField, false) !== update.state.field(viewModeField, false);
		// 再計測が要る更新か。どれか一つでも当てはまれば測る
		const needsMeasure    = update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged || viewModeChanged || update.transactions.some((transaction) => transaction.reconfigured);
		// 測り直す変化があるときだけ予約する
		if (needsMeasure) {
			this.schedule();
		}
	}

	/**
	 * 以後の書き込みを止める
	 */
	destroy(): void {
		this.destroyed = true;
	}

	/**
	 * 読み取りと書き込みを requestMeasure の別フェーズに分けて予約する
	 * 同じキーで予約するため、1 フレームに何度呼んでも計測は 1 回にまとまる
	 */
	private schedule(): void {
		this.view.requestMeasure({
			// このインスタンスを同一キーにし、重複した予約をまとめる
			key: this,
			/**
			 * 読み取りフェーズ。DOM の座標だけを読み、書き込みはしない
			 * @param view - 計測するエディタ
			 * @returns 描画範囲の計測結果
			 */
			read: (view) => readListHangingMeasures(view),
			/**
			 * 書き込みフェーズ。計測中の dispatch は禁止のため、マイクロタスクへ回す
			 * @param result - 読み取りフェーズの計測結果
			 */
			write: (result) => this.queueWrite(result)
		});
	}

	/**
	 * 計測結果の書き込みをマイクロタスクへ予約する
	 * CodeMirror は計測中の dispatch を許さないため、計測の周期が終わってから書く
	 * マイクロタスクは描画の前に走るので、揃っていない行が画面に出る時間はほぼ無い
	 * @param result - 今回の計測結果
	 */
	private queueWrite(result: ListHangingReadResult): void {
		this.pendingResult = result;
		// 予約済みなら、結果だけ差し替えて重ねて予約しない
		if (this.writeQueued) {
			return;
		}

		this.writeQueued = true;
		queueMicrotask(() => {
			// 予約を消化した。次の計測結果は改めて予約する
			this.writeQueued   = false;
			// 書き込む結果。予約後に差し替わっていれば最後のもの
			const pending      = this.pendingResult;
			this.pendingResult = null;
			// 破棄後か、結果が無いときは書かない。どちらか一方でも書かない
			if (this.destroyed || !pending) {
				return;
			}

			this.apply(pending);
		});
	}

	/**
	 * 計測結果を既存の結果と合わせ、変わったときだけ StateField へ書く
	 * 測ったあとに文書が変わっていたら書かずに測り直す
	 * @param result - 今回の計測結果
	 */
	private apply(result: ListHangingReadResult): void {
		// 測った文書がもう古ければ、位置がずれるので書かずに測り直す
		if (result.doc !== this.view.state.doc) {
			this.schedule();
			return;
		}

		// IME 合成中は行の属性を変えない。WebView2 では行 DOM の更新で合成が途切れる
		if (this.view.composing) {
			return;
		}

		// いまの結果。フィールドが無ければ空
		const current = this.view.state.field(listHangingMeasuresField, false) ?? [];
		// 書く結果。消す指示なら空、そうでなければ範囲外の既存結果と今回の結果を合わせたもの
		const next    = result.clearAll ? [] : mergeListHangingMeasures(current, result.measures, result.from, result.to);
		// 値が変わらなければ書かない。自分の書き込みで寸法が変わったときの再計測はここで止まる
		if (sameListHangingMeasures(current, next)) {
			return;
		}

		this.view.dispatch({ effects: setListHangingMeasuresEffect.of(next) });
	}
}

/**
 * ライブプレビューで折り返したリスト項目を、本文の開始位置へ揃える Extension を返す
 * @returns 計測結果の StateField と、描画後に測る ViewPlugin
 */
export function createListHangingIndentExtensions(): Extension[] {
	return [listHangingMeasuresField, ViewPlugin.fromClass(ListHangingIndentMeasurer)];
}
