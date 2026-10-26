/**
 * レンダラーの Vite ビルド設定を定義する
 * 開発サーバの起動は持たず、公開パスと出力先だけを渡す
 * @file
 */
import { defineConfig } from 'vite';

// 本番ビルドへ渡す設定。開発サーバのポートは持たない
export default defineConfig({
	// アセットの基準パス。サイトルートからの相対
	base: '/',
	// 出力先と、前回成果物を残すかどうか
	build: {
		// 書き出しディレクトリ。src/web からの相対
		outDir: 'dist',
		// ビルドのたびに出力先を空にする。前回のファイルを残さない
		emptyOutDir: true
	}
});
