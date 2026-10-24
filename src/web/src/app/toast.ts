/**
 * 画面下に短時間の通知を出す
 * 設定やログは持たず、表示中の要素だけを body へ足して外す
 * @file
 */

/** 通知を積むホスト。表示中の通知が無くなったら null に戻す */
let toastHost: HTMLElement | null = null;

/**
 * 通知に付ける操作ボタン
 * 押すと通知を閉じてから `onClick` を呼ぶ
 */
export type ToastAction = {
	/** ボタンに出す文言 */
	label: string;
	/** ボタンを押したときに行う処理。閉じた後に呼ぶ */
	onClick: () => void;
};

/**
 * 表示中の 1 件の通知を操作するハンドル
 * 空メッセージで表示しなかったときも、同じ形の空操作を返す
 */
export type ToastHandle = {
	/**
	 * 表示中の文言を差し替える
	 * 空白だけの指定は無視する
	 * @param message - 新しい文言。前後の空白は除く
	 */
	updateMessage: (message: string) => void;
	/** 通知を閉じる。すでに閉じていれば何もしない */
	dismiss: () => void;
};

/**
 * 空の通知ハンドルで文言更新を受けても何もしない
 * 空メッセージでは DOM を作らないため、呼び出し側が分岐しなくてよい
 */
function noopUpdateMessage(): void {
	// no-op
}

/**
 * 空の通知ハンドルで閉じるを受けても何もしない
 * 表示していない通知を閉じてもホストは残さない
 */
function noopDismiss(): void {
	// no-op
}

/**
 * 通知を積むホストを確保する
 * 既にあって body に付いていればそれを返し、無ければ作って body の末尾へ足す
 * @returns 通知の親要素。`aria-live` は polite
 */
function ensureToastHost(): HTMLElement {
	if (toastHost && document.body.contains(toastHost)) {
		return toastHost;
	}

	toastHost           = document.createElement('div');
	toastHost.className = 'tms-mde-toast-host';
	toastHost.setAttribute('aria-live', 'polite');
	document.body.appendChild(toastHost);
	return toastHost;
}

/**
 * 操作ボタンの無い通知を表示する
 * 空白だけの文言は表示せず、空操作のハンドルを返す
 * @param message - 表示する文言。前後の空白は除く
 * @param durationMs - 自動で閉じるまでの時間。単位はミリ秒。省略時は 5000。0 以下は閉じない
 * @returns 文言更新と閉じる操作。表示しなかったときも同じ形
 */
export function showToast(message: string, durationMs: number = 5000): ToastHandle {
	return showToastInternal(message, durationMs);
}

/**
 * 操作ボタン付きの通知を表示する
 * ボタンを押すまで自動では閉じない
 * @param message - 表示する文言。空白だけなら表示しない
 * @param actions - 通知に並べるボタン。空配列でも自動では閉じない
 * @returns 文言更新と閉じる操作
 */
export function showActionToast(message: string, actions: ToastAction[]): ToastHandle {
	return showToastInternal(message, 0, actions);
}

/**
 * 通知要素を作り、ホストへ足す
 * 空白だけの文言は要素を作らない。表示時間後に閉じ、0 以下なら操作されるまで残す
 * @param message - 表示する文言
 * @param durationMs - 自動で閉じるまでの時間。単位はミリ秒。0 以下は自動で閉じない
 * @param actions - 並べるボタン。省略時はボタンなし
 * @returns その通知のハンドル
 */
function showToastInternal(message: string, durationMs: number, actions: ToastAction[] = []): ToastHandle {
	const text = message.trim();
	if (!text) {
		return {
			updateMessage: noopUpdateMessage,
			dismiss      : noopDismiss
		};
	}

	const host                 = ensureToastHost();
	const item                 = document.createElement('div');
	item.className             = 'tms-mde-toast';
	const messageElement       = document.createElement('div');
	messageElement.className   = 'tms-mde-toast-message';
	messageElement.textContent = text;
	item.appendChild(messageElement);

	if (actions.length > 0) {
		const actionHost     = document.createElement('div');
		actionHost.className = 'tms-mde-toast-actions';
		for (const action of actions) {
			const button       = document.createElement('button');
			button.type        = 'button';
			button.className   = 'tms-mde-toast-action';
			button.textContent = action.label;
			button.addEventListener('click', () => {
				dismissToast(item, host);
				action.onClick();
			});
			actionHost.appendChild(button);
		}
		item.appendChild(actionHost);
	}
	host.appendChild(item);

	let hideTimer: number | null = null;

	/**
	 * この通知の文言を差し替える
	 * 空白だけは無視し、表示中の文字を残す
	 * @param nextMessage - 新しい文言。前後の空白は除く
	 */
	function updateMessage(nextMessage: string): void {
		const nextText = nextMessage.trim();
		if (nextText) {
			messageElement.textContent = nextText;
		}
	}

	/**
	 * この通知を閉じる
	 * 自動クローズのタイマーが残っていれば先に解除する
	 */
	function dismiss(): void {
		if (hideTimer !== null) {
			window.clearTimeout(hideTimer);
			hideTimer = null;
		}
		dismissToast(item, host);
	}

	const handle: ToastHandle = { updateMessage, dismiss };

	if (durationMs <= 0) {
		return handle;
	}

	hideTimer = window.setTimeout(() => {
		handle.dismiss();
		hideTimer = null;
	}, durationMs);

	return handle;
}

/**
 * 通知を閉じる
 * すでに DOM から外れていれば何もしない。非表示クラスの後に要素を外し、最後の 1 件ならホストも外す
 * @param item - 閉じる通知要素
 * @param host - その通知の親。子が無くなったら外す
 */
function dismissToast(item: HTMLElement, host: HTMLElement): void {
	if (!item.isConnected) {
		return;
	}

	item.classList.add('tms-mde-toast-hide');
	// 非表示の transition は 0.2s のため、終わるのを待ってから要素を外す
	window.setTimeout(() => {
		item.remove();
		if (host.childElementCount === 0) {
			host.remove();
			toastHost = null;
		}
	}, 220);
}
