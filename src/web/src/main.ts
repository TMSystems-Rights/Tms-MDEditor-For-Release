/**
 * Web UI の起動入口
 * OS テーマを描画前に同期し、未処理のエラーをログへ渡してから、DOM 準備後にアプリ制御を生成する
 * @file
 */
import { AppController } from './app/AppController';
import { bindThemePreferenceListener, initOsThemeAttribute } from './app/theme';
import { writeLog } from './bridge';

// ----------------------------------------------
// OS テーマ
// ----------------------------------------------

initOsThemeAttribute();
bindThemePreferenceListener();

// ----------------------------------------------
// 未処理の例外
// ----------------------------------------------

// 未捕捉のエラーを C# のログへ残す。画面には出さない
window.addEventListener('error', (event) => {
	void writeLog('ERROR', `Unhandled error: ${event.message} (${event.filename}:${event.lineno})`);
});

// 未処理の Promise 拒否を C# のログへ残す。reason が Error でなければ文字列化する
window.addEventListener('unhandledrejection', (event) => {
	// ログに残す本文。Error ならメッセージとスタック。スタックが無いときはメッセージだけ。Error 以外は文字列
	const reason = event.reason instanceof Error ? `${event.reason.message}\n${event.reason.stack ?? ''}` : String(event.reason);
	void writeLog('ERROR', `Unhandled rejection: ${reason}`);
});

// ----------------------------------------------
// アプリ制御の生成
// ----------------------------------------------

// DOM が揃ってからアプリ制御を生成する。それより前にはエディタを作らない
document.addEventListener('DOMContentLoaded', () => {
	new AppController();
});
