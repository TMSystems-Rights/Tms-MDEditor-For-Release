import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

const CARET_BLINK_HALF_CYCLE_MS = 530;
const CARET_HIDDEN_CLASS        = 'tms-mde-caret-hidden';

/**
 * 描画キャレットの点滅を JS で制御する（CSS animation は CM6 inline style / reduced-motion と競合する）
 */
class CaretBlinkController {
	private timer: ReturnType<typeof setInterval> | null = null;

	/**
	 * フォーカス済みなら点滅を開始する
	 * @param {EditorView} view 対象エディタビュー
	 */
	public constructor(private readonly view: EditorView) {
		if (this.view.hasFocus) {
			this.startBlink();
		}
	}

	/**
	 * ビュー更新時に点滅状態を同期する
	 * @param {ViewUpdate} update 更新情報
	 * @returns {void}
	 */
	public update(update: ViewUpdate): void {
		if (update.selectionSet) {
			this.showCaret();
		}

		if (!update.focusChanged) {
			return;
		}

		if (update.view.hasFocus) {
			this.startBlink();
			return;
		}

		this.stopBlink();
		this.showCaret();
	}

	/**
	 * 破棄時にタイマーを解除する
	 * @returns {void}
	 */
	public destroy(): void {
		this.stopBlink();
		this.showCaret();
	}

	/**
	 * 点滅タイマーを開始する
	 * @returns {void}
	 */
	private startBlink(): void {
		this.stopBlink();
		this.showCaret();
		this.timer = setInterval(() => {
			this.view.dom.classList.toggle(CARET_HIDDEN_CLASS);
		}, CARET_BLINK_HALF_CYCLE_MS);
	}

	/**
	 * 点滅タイマーを停止する
	 * @returns {void}
	 */
	private stopBlink(): void {
		if (this.timer === null) {
			return;
		}

		clearInterval(this.timer);
		this.timer = null;
	}

	/**
	 * キャレットを表示状態に戻す
	 * @returns {void}
	 */
	private showCaret(): void {
		this.view.dom.classList.remove(CARET_HIDDEN_CLASS);
	}
}

const caretBlinkPlugin = ViewPlugin.define((view) => new CaretBlinkController(view));

/**
 * キャレット点滅用 Extension を返す
 * @returns {ReturnType<typeof ViewPlugin.define>}
 */
export function createCaretBlinkExtension() {
	return caretBlinkPlugin;
}

export { CARET_HIDDEN_CLASS };
