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
// prettier-ignore
function ensureToastHost(): HTMLElement {
	// 作ったホストが残っていて、かつ body に付いているときだけそれを返す。どちらか一方が欠けても作り直す
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
// prettier-ignore
function showToastInternal(message: string, durationMs: number, actions: ToastAction[] = []): ToastHandle {
	// ----- 空文言 -----

	// 前後の空白を除いた表示文言。空なら要素を作らず、空操作のハンドルを返す
	const text = message.trim();
	// 表示する文字が残っていないときは DOM を作らない。空白だけの指定もここへ入る
	if (!text) {
		// 表示しなかったときの空操作。呼び出し側は表示したときと同じ形で扱う
		return {
			// 文言更新を受けても捨てる。表示中の要素が無い
			updateMessage: noopUpdateMessage,
			// 閉じるを受けてもホストは残さない。表示していない
			dismiss      : noopDismiss
		};
	}

	// ----- 通知要素 -----

	// 通知を積む親。無ければ作って body の末尾へ足す
	const host                 = ensureToastHost();
	// この 1 件の通知。非表示クラスを付けてから外す
	const item                 = document.createElement('div');
	item.className             = 'tms-mde-toast';
	// 文言を出す子要素。後からの文言更新はここの textContent だけを差し替える
	const messageElement       = document.createElement('div');
	messageElement.className   = 'tms-mde-toast-message';
	messageElement.textContent = text;
	item.appendChild(messageElement);

	// ----- 操作ボタン -----

	// ボタンが 1 件以上あるときだけ操作欄を足す。0 件なら文言だけで、自動で閉じるかは durationMs に従う
	if (actions.length > 0) {
		// ボタンを横に並べる領域。0 件のときは作らない
		const actionHost     = document.createElement('div');
		actionHost.className = 'tms-mde-toast-actions';
		for (const action of actions) {
			// この操作のボタン。表示文言は action.label
			const button       = document.createElement('button');
			button.type        = 'button';
			button.className   = 'tms-mde-toast-action';
			button.textContent = action.label;
			// 通知を閉じてから、このボタンの onClick を呼ぶ
			button.addEventListener('click', () => {
				dismissToast(item, host);
				action.onClick();
			});
			actionHost.appendChild(button);
		}
		item.appendChild(actionHost);
	}
	host.appendChild(item);

	// ----- 閉じる操作 -----

	// 自動で閉じるタイマー ID。0 以下の表示時間では null のままで、解除する対象が無い
	let hideTimer: number | null = null;

	/**
	 * この通知の文言を差し替える
	 * 空白だけは無視し、表示中の文字を残す
	 * @param nextMessage - 新しい文言。前後の空白は除く
	 */
	function updateMessage(nextMessage: string): void {
		// 前後の空白を除いた新しい文言。空なら表示中の文字を残す
		const nextText = nextMessage.trim();
		// 空白以外が残っているときだけ表示を差し替える。空なら今の文言を維持する
		if (nextText) {
			messageElement.textContent = nextText;
		}
	}

	/**
	 * この通知を閉じる
	 * 自動クローズのタイマーが残っていれば先に解除する
	 */
	function dismiss(): void {
		// 自動クローズがまだ発火していないときだけタイマーを解除する。null なら要素を閉じるだけ
		if (hideTimer !== null) {
			window.clearTimeout(hideTimer);
			// 解除済み。同じ通知を再度閉じても clearTimeout しない
			hideTimer = null;
		}
		dismissToast(item, host);
	}

	// 呼び出し側へ返す更新と閉じる。自動クローズのタイマーは、表示時間が正のときだけこの後で付ける
	const handle: ToastHandle = {
		// 空白以外のときだけ表示中の文字を差し替える
		updateMessage,
		// タイマーがあれば先に解除してから要素を外す
		dismiss
	};

	// 0 以下は操作されるまで残す。ボタンの有無では判断しない
	if (durationMs <= 0) {
		return handle;
	}

	// 表示時間後に閉じるタイマー ID。単位はミリ秒。手動で閉じたときは dismiss が解除する
	hideTimer = window.setTimeout(() => {
		handle.dismiss();
		// 発火済み。dismiss が同じ ID を再度 clearTimeout しない
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
	// すでに DOM から外れている通知は、非表示アニメーションを重ねない
	if (!item.isConnected) {
		return;
	}

	item.classList.add('tms-mde-toast-hide');
	// 非表示の transition は 0.2s のため、終わるのを待ってから要素を外す
	window.setTimeout(() => {
		item.remove();
		// 最後の通知を外したときだけホストも外し、次の表示で作り直す。他の通知が残っていればホストは残す
		if (host.childElementCount === 0) {
			host.remove();
			toastHost = null;
		}
	}, 220);
}
