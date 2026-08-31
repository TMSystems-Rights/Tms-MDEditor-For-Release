let toastHost: HTMLElement | null = null;

export type ToastAction = {
	label: string;
	onClick: () => void;
};

export type ToastHandle = {
	/** Toast メッセージを更新する */
	updateMessage: (message: string) => void;
	/** Toast を閉じる */
	dismiss: () => void;
};

/**
 * 空 Toast ハンドルのメッセージ更新
 * @returns {void}
 */
function noopUpdateMessage(): void {
	// no-op
}

/**
 * 空 Toast ハンドルのクローズ
 * @returns {void}
 */
function noopDismiss(): void {
	// no-op
}

/**
 * Toast ホストを確保する
 * @returns {HTMLElement}
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
 * Toast 通知を表示する
 * @param {string} message メッセージ
 * @param {number} [durationMs] 表示時間
 * @returns {void}
 */
export function showToast(message: string, durationMs: number = 5000): ToastHandle {
	return showToastInternal(message, durationMs);
}

/**
 * 操作ボタン付きの Toast 通知を表示する
 * @param {string} message メッセージ
 * @param {ToastAction[]} actions 操作ボタン
 * @returns {void}
 */
export function showActionToast(message: string, actions: ToastAction[]): ToastHandle {
	return showToastInternal(message, 0, actions);
}

/**
 * Toast 要素を作成する
 * @param {string} message メッセージ
 * @param {number} durationMs 表示時間。0 は操作されるまで表示する
 * @param {ToastAction[]} [actions] 操作ボタン
 * @returns {void}
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
	 * Toast メッセージを更新する
	 * @param {string} nextMessage 更新後メッセージ
	 * @returns {void}
	 */
	function updateMessage(nextMessage: string): void {
		const nextText = nextMessage.trim();
		if (nextText) {
			messageElement.textContent = nextText;
		}
	}

	/**
	 * 現在の Toast を閉じる
	 * @returns {void}
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
 * Toast を閉じる
 * @param {HTMLElement} item Toast 要素
 * @param {HTMLElement} host Toast ホスト
 * @returns {void}
 */
function dismissToast(item: HTMLElement, host: HTMLElement): void {
	if (!item.isConnected) {
		return;
	}

	item.classList.add('tms-mde-toast-hide');
	window.setTimeout(() => {
		item.remove();
		if (host.childElementCount === 0) {
			host.remove();
			toastHost = null;
		}
	}, 220);
}
