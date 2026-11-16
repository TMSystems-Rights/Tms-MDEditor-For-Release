/**
 * レンダラーの Vite ビルド設定を定義する
 * 開発サーバの起動は持たず、公開パスと出力先、本番ビルドで加えるライセンス表示だけを渡す
 * @file
 */
import { defineConfig } from 'vite';
import { thirdPartyNoticesPlugin } from './buildTools/thirdPartyNotices';

// 本番ビルドへ渡す設定。開発サーバのポートは持たない
export default defineConfig({
	// アセットの基準パス。サイトルートからの相対
	base: '/',
	// 本番ビルドで、同梱した npm パッケージのライセンス表示を出力へ加える
	plugins: [thirdPartyNoticesPlugin()],
	// 出力先と、前回成果物を残すかどうか
	build: {
		// 書き出しディレクトリ。src/web からの相対
		outDir: 'dist',
		// ビルドのたびに出力先を空にする。前回のファイルを残さない
		emptyOutDir: true
	}
});
