/**
 * Vitest の実行条件を定義する
 * テスト本体は持たず、実行環境と対象ファイルだけを渡す
 * @file
 */
import { defineConfig } from 'vitest/config';

// 単体テストの実行条件。ブラウザは使わない
export default defineConfig({
	// ランナー側の設定。ビルド出力とは別
	test: {
		// Node 上で実行する。DOM が要るテストは各ファイルが用意する
		environment: 'node',
		// 実行するファイル。src 以下の *.test.ts だけ
		include: ['src/**/*.test.ts']
	}
});
