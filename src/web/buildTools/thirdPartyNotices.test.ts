/**
 * ライセンス表示プラグインの、パッケージ特定、宣言の読み取り、ライセンス文の収集、テキスト整形を検証する
 * ライセンス文の収集は OS の一時ディレクトリに作った偽のパッケージを読み、テストの終わりに消す
 * @file
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectBundledPackages, describeLicense, describeSource, findPackageRoot, formatNpmNotices, isLicenseFileName, readLicenseFiles, type BundledPackage } from './thirdPartyNotices';

/** このテストで作った一時ディレクトリ。afterEach で消し、空に戻す */
const tempDirs: string[] = [];

/**
 * 偽のパッケージを置く一時ディレクトリを作る
 * 作ったパスは tempDirs に積み、afterEach で消す
 * @returns 作ったディレクトリの絶対パス
 */
function createTempDir(): string {
	// OS の一時ディレクトリ配下に作った空のディレクトリ
	const dir = mkdtempSync(join(tmpdir(), 'tms-notices-'));
	tempDirs.push(dir);
	return dir;
}

/**
 * テスト用のパッケージ表示内容を作る
 * ファイルからは読まず、渡した値をそのまま持つ固定値
 * @param name - パッケージ名
 * @param version - 版。空文字なら版なしとして扱われる
 * @param license - SPDX 式。空文字なら宣言なし
 * @returns ライセンス文 1 件を持つ表示内容。files は呼び出し側で差し替えてよい
 */
function fakePackage(name: string, version: string, license: string): BundledPackage {
	// 整形の検証に使う固定の表示内容
	return {
		// 呼び出し側が指定した名前
		name,
		// 呼び出し側が指定した版
		version,
		// 呼び出し側が指定したライセンス宣言
		license,
		// 取得元。固定の URL
		source: `https://example.com/${name}`,
		// ライセンス文。固定の 1 件
		files: [{ fileName: 'LICENSE', text: `${name} license text` }]
	};
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('findPackageRoot', () => {
	it('node_modules 直下のパッケージのディレクトリを返す', () => {
		expect(findPackageRoot('E:/app/src/web/node_modules/mermaid/dist/mermaid.core.mjs')).toBe('E:/app/src/web/node_modules/mermaid');
	});

	it('スコープ付きパッケージは 2 段まで含める', () => {
		expect(findPackageRoot('E:/app/node_modules/@codemirror/view/dist/index.js')).toBe('E:/app/node_modules/@codemirror/view');
	});

	it('入れ子の node_modules では最も内側のパッケージを返す', () => {
		expect(findPackageRoot('E:/app/node_modules/mermaid/node_modules/uuid/dist/index.js')).toBe('E:/app/node_modules/mermaid/node_modules/uuid');
	});

	it('Windows の区切りとクエリ文字列を扱う', () => {
		expect(findPackageRoot('E:\\app\\node_modules\\katex\\dist\\katex.css?inline')).toBe('E:/app/node_modules/katex');
	});

	it('アプリ自身のソースと仮想モジュールは null', () => {
		expect(findPackageRoot('E:/app/src/web/src/main.ts')).toBeNull();
		expect(findPackageRoot('\0vite/preload-helper.js')).toBeNull();
	});
});

describe('isLicenseFileName', () => {
	it('LICENSE、LICENCE、COPYING、NOTICE と接尾辞付きを拾う', () => {
		expect(['LICENSE', 'license', 'LICENSE.md', 'LICENCE.txt', 'LICENSE-MIT', 'COPYING', 'NOTICE.txt'].every(isLicenseFileName)).toBe(true);
	});

	it('名前の一部に license を含むだけのファイルは拾わない', () => {
		expect(['README.md', 'package.json', 'mylicense.txt', 'licenses.json'].some(isLicenseFileName)).toBe(false);
	});
});

describe('describeLicense', () => {
	it('SPDX 式の文字列はそのまま返す', () => {
		expect(describeLicense({ license: '(MPL-2.0 OR Apache-2.0)' })).toBe('(MPL-2.0 OR Apache-2.0)');
	});

	it('古い形式の license オブジェクトと licenses 配列を読む', () => {
		expect(describeLicense({ license: { type: 'MIT' } })).toBe('MIT');
		expect(describeLicense({ licenses: [{ type: 'MIT' }, { type: 'GPL-2.0' }] })).toBe('MIT OR GPL-2.0');
	});

	it('宣言が無いときは空文字', () => {
		expect(describeLicense({ name: 'khroma' })).toBe('');
	});
});

describe('describeSource', () => {
	it('git+ と .git を外し、git プロトコルを https にする', () => {
		expect(describeSource({ repository: { url: 'git+https://github.com/obsidianmd/pele.git' } })).toBe('https://github.com/obsidianmd/pele');
		expect(describeSource({ repository: 'git://github.com/d3/d3-array.git' })).toBe('https://github.com/d3/d3-array');
	});

	it('GitHub の短縮形を URL に戻す', () => {
		expect(describeSource({ repository: 'fabiospampinato/khroma' })).toBe('https://github.com/fabiospampinato/khroma');
		expect(describeSource({ repository: 'github:lezer-parser/lr' })).toBe('https://github.com/lezer-parser/lr');
	});

	it('repository が無いときは homepage、どちらも無いときは空文字', () => {
		expect(describeSource({ homepage: 'https://example.com' })).toBe('https://example.com');
		expect(describeSource({})).toBe('');
	});
});

describe('readLicenseFiles', () => {
	it('直下のライセンス系ファイルだけを名前順に読み、改行と末尾をそろえる', () => {
		// 偽のパッケージ。LICENSE と NOTICE、対象外の README、LICENSE という名前のディレクトリを置く
		const dir = createTempDir();
		writeFileSync(join(dir, 'NOTICE'), 'notice\r\n\r\n');
		writeFileSync(join(dir, 'LICENSE'), '\uFEFFMIT License\r\nCopyright\r\n');
		writeFileSync(join(dir, 'README.md'), 'readme');
		mkdirSync(join(dir, 'license-texts'));
		// NOTE: 空のライセンスファイルは、表示しても意味が無いので載らないことも見る
		writeFileSync(join(dir, 'COPYING'), '  \n');

		expect(readLicenseFiles(dir)).toEqual([
			{ fileName: 'LICENSE', text: 'MIT License\nCopyright' }, // BOM と CRLF と末尾の改行を落とした本文
			{ fileName: 'NOTICE', text: 'notice' } // 末尾の空行を落とした本文
		]);
	});
});

describe('collectBundledPackages', () => {
	it('同じディレクトリは一度だけ読み、同じ名前と版は 1 件にまとめて名前順に並べる', () => {
		// 読んだディレクトリの記録。同じディレクトリを二度読まないことを見る
		const readDirs: string[] = [];
		// 出力チャンクのモジュール ID。同じパッケージの別ファイル、入れ子の同じ版、アプリ自身を混ぜる
		const moduleIds          = [
			'E:/app/node_modules/mermaid/dist/a.mjs', // mermaid の 1 ファイル目
			'E:/app/node_modules/mermaid/dist/b.mjs', // 同じ mermaid の別ファイル。読み直さない
			'E:/app/node_modules/@codemirror/view/dist/index.js', // 名前順で先頭に来るスコープ付き
			'E:/app/node_modules/mermaid/node_modules/uuid/dist/index.js', // 入れ子の uuid
			'E:/app/node_modules/uuid/dist/index.js', // 同じ版の uuid。1 件にまとめる
			'E:/app/src/main.ts' // アプリ自身。載せない
		];

		// ディレクトリ名の末尾をパッケージ名とみなす偽の読み取り。uuid はどこでも同じ版
		const packages = collectBundledPackages(moduleIds, (packageDir) => {
			readDirs.push(packageDir);
			// ディレクトリ名から復元したパッケージ名。スコープ付きは 2 段
			const name = packageDir.split('/node_modules/').pop() ?? '';
			return fakePackage(name, '1.0.0', 'MIT');
		});

		expect(packages.map((bundled) => bundled.name)).toEqual(['@codemirror/view', 'mermaid', 'uuid']);
		expect(readDirs).toHaveLength(4);
	});

	it('name の無いパッケージは載せない', () => {
		expect(collectBundledPackages(['E:/app/node_modules/broken/index.js'], () => null)).toEqual([]);
	});
});

describe('formatNpmNotices', () => {
	it('先頭に一覧、続けてパッケージごとの見出しとライセンス文を並べる', () => {
		// 宣言ありと宣言なしの 2 件。宣言なしは khroma と同じ状態
		const text = formatNpmNotices([fakePackage('dompurify', '3.4.12', '(MPL-2.0 OR Apache-2.0)'), fakePackage('khroma', '2.1.0', '')]);

		expect(text).toContain('  - dompurify 3.4.12  [(MPL-2.0 OR Apache-2.0)]');
		expect(text).toContain('  - khroma 2.1.0  [package.json に宣言なし]');
		expect(text).toContain('License: (MPL-2.0 OR Apache-2.0)\nSource: https://example.com/dompurify');
		expect(text).toContain('khroma license text');
		expect(text.endsWith('\n')).toBe(true);
		expect(text.endsWith('\n\n')).toBe(false);
	});

	it('ライセンス文が無いパッケージは、その旨を書く', () => {
		// ライセンス文を持たないパッケージ
		const bare = { ...fakePackage('bare', '1.0.0', 'MIT'), files: [] };

		expect(formatNpmNotices([bare])).toContain('このパッケージにはライセンス文のファイルが同梱されていません');
	});
});
