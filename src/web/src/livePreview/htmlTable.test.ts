/**
 * HTML 表ブロックの判定と、表示前のサニタイズ結果を検証する
 * 本番の isHtmlTableBlock と sanitizeHtmlTable だけを呼び、DOM は作らない
 * @file
 */
import { describe, expect, it } from 'vitest';
import { isHtmlTableBlock, sanitizeHtmlTable } from './htmlTable';

describe('htmlTable', () => {
	it('table で始まるブロックだけを表と判定する', () => {
		expect(isHtmlTableBlock('<table><tr><td>A</td></tr></table>')).toBe(true);
		expect(isHtmlTableBlock('  <TABLE><tr><td>A</td></tr></TABLE>')).toBe(true);
		expect(isHtmlTableBlock('<p>table</p>')).toBe(false);
	});

	it('許可タグと colspan を残し script を落とす', () => {
		// 許可タグと colspan を残し、script と onclick を落とした表
		const html = sanitizeHtmlTable('<table><tr><th colspan="2" onclick="alert(1)">見出し</th></tr><tr><td>A<script>x()</script></td><td>B</td></tr></table>');
		expect(html).toContain('<table>');
		expect(html).toContain('colspan="2"');
		expect(html).not.toContain('onclick');
		expect(html).not.toContain('script');
		expect(html).toContain('見出し');
		expect(html).toContain('A');
		expect(html).toContain('B');
	});
});
