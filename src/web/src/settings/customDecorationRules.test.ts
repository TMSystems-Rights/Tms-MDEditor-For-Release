import { describe, expect, it } from 'vitest';
import {
	createNewCustomDecorationRule,
	normalizeCustomDecorationRules,
	validateCustomDecorationRules,
} from './customDecorationRules';

describe('customDecorationRules settings helpers', () => {
	it('日本語と記号を含む正規表現ルールを受け入れる', () => {
		const errors = validateCustomDecorationRules([{
			name           : '重要・要確認',
			enabled        : true,
			pattern        : '【([^】\\n]+)】',
			hideDelimiters : true,
			cssClass       : 'tms-important-ja',
		}]);

		expect(errors).toEqual([]);
	});

	it('空の名前、不正な正規表現、不正なCSSクラスを項目別に検出する', () => {
		const errors = validateCustomDecorationRules([{
			name     : ' ',
			pattern  : '(',
			cssClass : 'bad class;',
		}]);

		expect(errors.map((error) => error.field)).toEqual(['name', 'pattern', 'cssClass']);
	});

	it('不正な旧ルールでも無効状態なら保存を許可する', () => {
		const errors = validateCustomDecorationRules([{
			name     : '',
			enabled  : false,
			pattern  : '(',
			cssClass : 'bad class;',
		}]);

		expect(errors).toEqual([]);
	});

	it('追加ルールは既存CSSクラスと重複せず区切り記号を隠す状態で作成する', () => {
		const rule = createNewCustomDecorationRule([{
			name     : '既存',
			pattern  : '(既存)',
			cssClass : 'tms-custom-2',
		}]);

		expect(rule).toEqual({
			name           : '新しい装飾ルール 3',
			enabled        : false,
			pattern        : '_v(.+?)_v',
			hideDelimiters : true,
			cssClass       : 'tms-custom-3',
		});
	});

	it('保存前に名前とCSSクラスだけをトリムしてbooleanを補完する', () => {
		const normalized = normalizeCustomDecorationRules([{
			name     : '  TODO強調  ',
			pattern  : '(TODO: )',
			cssClass : '  tms-todo  ',
		}]);

		expect(normalized[0]).toEqual({
			name           : 'TODO強調',
			enabled        : true,
			pattern        : '(TODO: )',
			hideDelimiters : false,
			cssClass       : 'tms-todo',
		});
	});
});
