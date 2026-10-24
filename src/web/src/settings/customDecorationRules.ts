/**
 * 設定画面で編集するカスタム装飾ルールを作り、検証し、保存前に正規化する
 * エディタへの適用は持たない
 * @file
 */
import type { CustomDecorationRule } from '../types/app';
import { isSafeCssClassName } from '../livePreview/customDecorations';

/**
 * 検証エラーが指す入力欄
 * 名前、正規表現、CSS クラスのいずれか
 */
export type CustomDecorationRuleField = 'name' | 'pattern' | 'cssClass';

/**
 * 1 件のルール検証エラー
 * 無効なルールは検証しないため、ここには載らない
 */
export type CustomDecorationValidationError = {
	/** ルール配列の位置。0 始まり */
	index: number;
	/** エラーを表示する入力欄 */
	field: CustomDecorationRuleField;
	/** その欄の下に出す説明 */
	message: string;
};

/**
 * 設定画面から追加する新規ルールを生成する
 * CSS クラスは既存と重ならない `tms-custom-N` にし、追加直後は無効
 * @param current - すでに並んでいるルール。クラス名の重複回避に使う
 * @returns 未保存の新規ルール。区切り記号は隠す初期値
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
 * GUI で編集したカスタム装飾ルールを検証する
 * 無効なルールは不正でも保存できるよう、検証をスキップする
 * @param rules - 画面上のルール一覧。無効なものはエラーにしない
 * @returns 有効なルールの入力エラー。問題が無ければ空配列
 */
export function validateCustomDecorationRules(
	rules: CustomDecorationRule[],
): CustomDecorationValidationError[] {
	const errors: CustomDecorationValidationError[] = [];

	rules.forEach((rule, index) => {
		// 不正な旧ルールでも、まず無効化して保存できるようにする
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
 * 保存用に文字列項目を正規化する
 * 名前と CSS クラスの前後空白を除き、有効フラグと区切り隠しを boolean に揃える。パターンは変えない
 * @param rules - 画面上のルール一覧
 * @returns 保存へ渡すルール。入力配列は変えない
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
