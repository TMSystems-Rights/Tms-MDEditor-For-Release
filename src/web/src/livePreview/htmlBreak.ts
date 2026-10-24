/**
 * HTML 改行とインライン HTML の装飾収集を、実装のある htmlInline から再公開する
 * 状態は持たず、古い import 経路を残すための境界である
 * @file
 */
/**
 * @deprecated htmlInline.ts へ移行済み。互換のため再エクスポートする
 */
export {
	collectHtmlBreakDecorationEntries,
	collectHtmlDecorationEntries,
} from './htmlInline';
