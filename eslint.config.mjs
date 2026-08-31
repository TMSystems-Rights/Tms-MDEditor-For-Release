// @ts-check

import globals from 'globals';
import js from '@eslint/js';
import jsdoc from 'eslint-plugin-jsdoc';
import alignAssignments from 'eslint-plugin-align-assignments';
import tseslint from 'typescript-eslint';

/** @type {import('eslint').Linter.RulesRecord} */
const baseRules = {
	'no-var'                           : 'error',
	'eqeqeq'                           : ['error', 'always'],
	'dot-location'                     : ['error', 'property'],
	'comma-style'                      : 'off',
	'spaced-comment'                   : ['error', 'always'],
	'no-eval'                          : 'error',
	'no-implied-eval'                  : 'error',
	'no-labels'                        : 'error',
	'no-new-wrappers'                  : 'error',
	'no-floating-decimal'              : 'error',
	'no-func-assign'                   : 'error',
	'comma-dangle'                     : 'off',
	'no-path-concat'                   : 'error',
	'no-proto'                         : 'error',
	'jsdoc/require-jsdoc'              : ['error', {
		require: {
			FunctionDeclaration    : true,
			MethodDefinition       : true,
			ClassDeclaration       : true,
			ArrowFunctionExpression: true,
			FunctionExpression     : true,
		},
	}],
	'semi'                             : ['error', 'always'],
	'semi-spacing'                     : ['error', { after: true, before: false }],
	'semi-style'                       : ['error', 'last'],
	'no-extra-semi'                    : 'error',
	'no-unexpected-multiline'          : 'error',
	'no-unreachable'                   : 'error',
	'no-irregular-whitespace'          : ['error', {
		skipStrings  : true,
		skipComments : true,
		skipRegExps  : true,
		skipTemplates: true,
	}],
	'align-assignments/align-assignments': 'error',
	'indent'                           : ['error', 'tab', { SwitchCase: 1 }],
	'brace-style'                      : ['error', '1tbs'],
	'object-curly-spacing'             : ['error', 'always'],
	'array-bracket-spacing'            : ['error', 'never'],
	'comma-spacing'                    : 'off',
	'keyword-spacing'                  : ['error', { before: true, after: true }],
	'space-before-blocks'              : 'error',
	'space-before-function-paren'      : ['error', {
		anonymous : 'always',
		named     : 'never',
		asyncArrow: 'always',
	}],
	'no-undef'                         : 'error',
	'no-unused-vars'                   : ['warn', { argsIgnorePattern: '^_' }],
};

export default [
	{
		ignores: [
			'**/node_modules/**',
			'**/dist/**',
			'**/bin/**',
			'**/obj/**',
			'release/**',
			'**/*.min.js',
		],
	},
	...tseslint.configs.recommended.map((config) => ({
		...config,
		files: ['src/web/**/*.ts'],
	})),
	{
		files: ['src/web/**/*.ts'],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType : 'module',
			globals    : globals.browser,
		},
		plugins: {
			jsdoc              : jsdoc,
			'align-assignments': alignAssignments,
		},
		rules: {
			...js.configs.recommended.rules,
			...baseRules,
			'@typescript-eslint/no-require-imports': 'off',
			'no-undef'                             : 'off',
			'no-unused-vars'                       : 'off',
			'@typescript-eslint/no-unused-vars'    : ['warn', { argsIgnorePattern: '^_' }],
		},
	},
	{
		files: ['scripts/**/*.mjs'],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType : 'module',
			globals    : globals.node,
		},
		plugins: {
			jsdoc              : jsdoc,
			'align-assignments': alignAssignments,
		},
		rules: {
			...js.configs.recommended.rules,
			...baseRules,
		},
	},
];
