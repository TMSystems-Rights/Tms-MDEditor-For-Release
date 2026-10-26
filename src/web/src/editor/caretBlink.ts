/**
 * 描画キャレットの点滅を、エディタ DOM の class 切り替えで行う
 * CSS animation は CodeMirror の inline style と reduced-motion と競合するため、本ファイルがタイマーを所有する
 * 呼び出し側は Extension を受け取るだけで、点滅の開始と停止はフォーカスの変化に任せる
 * @file
 */
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

/** 点滅の半周期（ms）。この間隔で表示と非表示を切り替える */
const CARET_BLINK_HALF_CYCLE_MS = 530;
/** キャレットを隠すときにエディタ DOM へ付ける class 名。表示へ戻すときは外す */
const CARET_HIDDEN_CLASS        = 'tms-mde-caret-hidden';

/**
 * フォーカス中だけ点滅タイマーを回し、選択が動いたらキャレットを表示に戻す
 * タイマーと class の付け外しは、このインスタンスがビューの寿命に合わせて持つ
 */
class CaretBlinkController {
	/** 点滅の setInterval。停止中は null で、破棄後は再開しない */
	private timer: ReturnType<typeof setInterval> | null = null;

	/**
	 * 対象ビューを保持する。生成時点でフォーカス済みなら点滅を開始する
	 * @param view - 点滅対象のエディタ。DOM の class をこのビューへ付ける
	 */
	public constructor(private readonly view: EditorView) {
		// 生成時点でフォーカスがあるときだけ点滅を始める。未フォーカスではタイマーを持たない
		if (this.view.hasFocus) {
			this.startBlink();
		}
	}

	/**
	 * ビュー更新に合わせて点滅を同期する
	 * 選択が変わったらキャレットを表示へ戻す。フォーカスを得たら点滅を開始し、失ったら止めて表示に戻す
	 * @param update - 今回のビュー更新。フォーカス変化と選択変化の判定に使う
	 */
	public update(update: ViewUpdate): void {
		// 選択が動いたフレームはキャレットを表示へ戻す。消灯中に移動すると、次の点灯まで位置が見えない
		if (update.selectionSet) {
			this.showCaret();
		}

		// フォーカスが変わっていない更新では、点滅の開始も停止もしない
		if (!update.focusChanged) {
			return;
		}

		// フォーカスを得たとき点滅を始める。失ったときはこの分岐に入らず、タイマーを止めて表示へ戻す
		if (update.view.hasFocus) {
			this.startBlink();
			return;
		}

		this.stopBlink();
		this.showCaret();
	}

	/**
	 * 破棄時にタイマーを止め、キャレットを表示へ戻す
	 */
	public destroy(): void {
		this.stopBlink();
		this.showCaret();
	}

	/**
	 * 点滅タイマーを開始する
	 * 既存のタイマーがあれば止めてから、半周期ごとに class を切り替える
	 */
	private startBlink(): void {
		this.stopBlink();
		this.showCaret();
		// 半周期ごとに隠す class を反転する。停止は stopBlink がこのタイマーを捨てるまで続く
		this.timer = setInterval(() => {
			this.view.dom.classList.toggle(CARET_HIDDEN_CLASS);
		}, CARET_BLINK_HALF_CYCLE_MS);
	}

	/**
	 * 点滅タイマーを止める。タイマーが無いときは何もしない
	 */
	private stopBlink(): void {
		// 停止中（null）は解除しない。二重に clearInterval しない
		if (this.timer === null) {
			return;
		}

		clearInterval(this.timer);
		// 停止後は null。次の startBlink まで点滅しない
		this.timer = null;
	}

	/**
	 * キャレットを隠す class を外し、表示状態に戻す
	 */
	private showCaret(): void {
		this.view.dom.classList.remove(CARET_HIDDEN_CLASS);
	}
}

/** 点滅プラグインのインスタンス。define の結果を共有し、呼び出しごとに作り直さない */
const caretBlinkPlugin = ViewPlugin.define((view) => new CaretBlinkController(view));

/**
 * キャレット点滅用の Extension を返す
 * 返るプラグインはモジュール内で 1 つを共有する
 * @returns エディタへ渡す Extension
 */
export function createCaretBlinkExtension() {
	return caretBlinkPlugin;
}

export { CARET_HIDDEN_CLASS };
