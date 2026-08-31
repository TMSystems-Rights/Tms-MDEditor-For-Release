import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import prettier from 'prettier';
import cssLanguageService from 'vscode-css-languageservice';

const { getCSSLanguageService, TextDocument } = cssLanguageService;

const ROOT_DIR             = path.resolve(import.meta.dirname, '..');
const TARGET_DIR           = path.join(ROOT_DIR, 'src', 'web');
const CHECK_MODE           = process.argv.includes('--check');
const CSS_SERVICE          = getCSSLanguageService();
const PRETTIER_CONFIG_PATH = path.join(ROOT_DIR, '.prettierrc.json');

/**
 * 対象ファイルを再帰的に取得する
 * @param {string} dir ディレクトリ
 * @returns {Promise<string[]>} 対象ファイル
 */
async function collectTargetFiles(dir) {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const files   = [];

	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);

		if (entry.isDirectory()) {
			if (entry.name === 'dist' || entry.name === 'node_modules') {
				continue;
			}
			files.push(...await collectTargetFiles(fullPath));
			continue;
		}

		if (entry.isFile() && ['.html', '.css'].includes(path.extname(entry.name).toLowerCase())) {
			files.push(fullPath);
		}
	}

	return files;
}

/**
 * HTML を Prettier 設定で整形する
 * @param {string} filePath ファイルパス
 * @param {string} source 元テキスト
 * @returns {Promise<string>} 整形後テキスト
 */
async function formatHtml(filePath, source) {
	const options = await prettier.resolveConfig(filePath, { config: PRETTIER_CONFIG_PATH });

	return prettier.format(source, {
		...options,
		filepath: filePath,
		parser: 'html',
	});
}

/**
 * CSS を VS Code 標準 CSS formatter 相当に整形する
 * @param {string} filePath ファイルパス
 * @param {string} source 元テキスト
 * @returns {string} 整形後テキスト
 */
function formatCss(filePath, source) {
	const document = TextDocument.create(`file:///${filePath.replace(/\\/g, '/')}`, 'css', 0, source);
	const edits    = CSS_SERVICE.format(document, undefined, {
		tabSize: 4,
		insertSpaces: false,
	});

	return TextDocument.applyEdits(document, edits);
}

/**
 * ファイルを整形する
 * @param {string} filePath ファイルパス
 * @returns {Promise<boolean>} 変更が必要なら true
 */
async function formatFile(filePath) {
	const source    = await fs.readFile(filePath, 'utf8');
	const ext       = path.extname(filePath).toLowerCase();
	const formatted = ext === '.html'
		? await formatHtml(filePath, source)
		: formatCss(filePath, source);

	if (formatted === source) {
		return false;
	}

	if (!CHECK_MODE) {
		await fs.writeFile(filePath, formatted, 'utf8');
	}

	return true;
}

const files        = await collectTargetFiles(TARGET_DIR);
const changedFiles = [];

for (const filePath of files) {
	if (await formatFile(filePath)) {
		changedFiles.push(path.relative(ROOT_DIR, filePath));
	}
}

if (changedFiles.length > 0) {
	const action = CHECK_MODE ? 'needs formatting' : 'formatted';

	for (const filePath of changedFiles) {
		console.log(`${action}: ${filePath}`);
	}

	if (CHECK_MODE) {
		process.exitCode = 1;
	}
} else {
	console.log('web HTML/CSS formatting is up to date');
}
