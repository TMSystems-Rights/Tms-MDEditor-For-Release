import { AppController } from './app/AppController';
import { bindThemePreferenceListener, initOsThemeAttribute } from './app/theme';
import { writeLog } from './bridge';

initOsThemeAttribute();
bindThemePreferenceListener();

window.addEventListener('error', (event) => {
	void writeLog('ERROR', `Unhandled error: ${event.message} (${event.filename}:${event.lineno})`);
});

window.addEventListener('unhandledrejection', (event) => {
	const reason = event.reason instanceof Error ? `${event.reason.message}\n${event.reason.stack ?? ''}` : String(event.reason);
	void writeLog('ERROR', `Unhandled rejection: ${reason}`);
});

document.addEventListener('DOMContentLoaded', () => {
	new AppController();
});
