import type { CustomDecorationRule } from '../types/app';
import { isSafeCssClassName } from '../livePreview/customDecorations';

export type CustomDecorationRuleField = 'name' | 'pattern' | 'cssClass';

export type CustomDecorationValidationError = {
	index: number;
	field: CustomDecorationRuleField;
	message: string;
};

/**
 * 設定画面から追加する新規ルールを生成する。
 * @param {CustomDecorationRule[]} current 現在のルール
 * @returns {CustomDecorationRule} 新規ルール
 */
export function createNewCustomDecorationRule(current: CustomDecorationRule[]): CustomDecorationRule {
	let suffix = current.length + 1;
	while (current.some((rule) => rule.cssClass === `tms-custom-${suffix}`)) {
		suffix += 1;
	}

	return {
		name           : `新しい装飾ルール ${suffix}`,
		enabled        : false,
		pattern        : '_v(.+?)_v',
		hideDelimiters : true,
		cssClass       : `tms-custom-${suffix}`,
	};
}

/**
 * GUIで編集したカスタム装飾ルールを検証する。
 * @param {CustomDecorationRule[]} rules ルール一覧
 * @returns {CustomDecorationValidationError[]} 検証エラー
 */
export function validateCustomDecorationRules(
	rules: CustomDecorationRule[],
): CustomDecorationValidationError[] {
	const errors: CustomDecorationValidationError[] = [];

	rules.forEach((rule, index) => {
		// 不正な旧ルールでも、まず無効化して保存できるようにする。
		if (rule.enabled === false) {
			return;
		}

		if (!rule.name.trim()) {
			errors.push({ index, field: 'name', message: 'ルール名を入力してください。' });
		}

		if (!rule.pattern) {
			errors.push({ index, field: 'pattern', message: '正規表現を入力してください。' });
		} else {
			try {
				new RegExp(rule.pattern, 'gd');
			} catch {
				errors.push({ index, field: 'pattern', message: '正規表現の構文が正しくありません。' });
			}
		}

		const cssClass = rule.cssClass.trim();
		if (!cssClass) {
			errors.push({ index, field: 'cssClass', message: 'CSSクラスを入力してください。' });
		} else if (!isSafeCssClassName(cssClass)) {
			errors.push({
				index,
				field   : 'cssClass',
				message : 'CSSクラスは英字または _ で始まり、英数字・_・- のみ使用できます。',
			});
		}
	});

	return errors;
}

/**
 * 保存用に文字列項目を正規化する。
 * @param {CustomDecorationRule[]} rules ルール一覧
 * @returns {CustomDecorationRule[]} 正規化済みルール
 */
export function normalizeCustomDecorationRules(rules: CustomDecorationRule[]): CustomDecorationRule[] {
	return rules.map((rule) => ({
		name           : rule.name.trim(),
		enabled        : rule.enabled !== false,
		pattern        : rule.pattern,
		hideDelimiters : Boolean(rule.hideDelimiters),
		cssClass       : rule.cssClass.trim(),
	}));
}
