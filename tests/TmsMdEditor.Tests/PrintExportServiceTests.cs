// ==============================================
// 隠し WebView2 での PDF 出力
// ==============================================

// 大きなローカル画像を Data URL にせず、一時フォルダ経由で PDF に書けることを固定する
// WebView2 の実行時が必要なため、ランタイムが無い環境では失敗する

using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

/// <summary>
/// 印刷用 WebView2 で、大きな画像付き HTML を PDF にする
/// </summary>
public class PrintExportServiceTests
{
	/// <summary>
	/// ノイズ画像は Data URL にすると NavigateToString の上限を超える大きさにし、日本語の保存先へ PDF を書く
	/// </summary>
	[Fact]
	public void PrintToPdf_writes_japanese_path_with_large_local_image()
	{
		// PDF と画像を置く一時ディレクトリ。終了時に残っていれば削除する
		string root = Path.Combine(Path.GetTempPath(), "tms-mde-print-it-" + Guid.NewGuid().ToString("N"));
		Directory.CreateDirectory(root);
		try
		{
			// Data URL にしない大きな PNG の保存先
			string imagePath = Path.Combine(root, "noise.png");
			WriteNoisyPng(imagePath, 1000, 800);
			// 書いた PNG のバイト数。1_200_000 以下ならこのテストの前提を満たさない
			long imageBytes = new FileInfo(imagePath).Length;
			Assert.True(imageBytes > 1_200_000, "画像が小さい: " + imageBytes);

			// 日本語を含む PDF の保存先。親フォルダは出力時に作られる
			string pdfPath = Path.Combine(root, "設計ドキュメント", "仕様.pdf");
			// STA スレッドで起きた失敗。成功では null のまま
			Exception? error = null;
			// PDF 化の成否。Shown の完了前は null
			ExportActionResult? result = null;
			// メッセージポンプを回す STA スレッド。90秒で終わらなければ失敗する
			var thread = new Thread(() =>
			{
				try
				{
					Application.EnableVisualStyles();
					// 画面外に置く印刷用の親フォーム。タスクバーには出さない
					using var form = new Form
					{
						// テスト中にタスクバーへ出さない
						ShowInTaskbar = false,
						// ツールウィンドウにして通常の枠を出さない
						FormBorderStyle = FormBorderStyle.FixedToolWindow,
						// 位置を Location のまま使い、画面中央へ動かさない
						StartPosition = FormStartPosition.Manual,
						// 作業領域の外。ユーザーの画面に出さない
						Location = new Point(-3200, -3200),
						// 印刷用 WebView2 を載せる大きさ。単位はピクセル
						Size = new Size(800, 600),
					};
					// このフォーム上の隠し WebView2 で PDF 化する。ログ文面は見ない
					using var service = new PrintExportService(form, new Logger());
					// 表示後に PDF 化し、終わったらフォームを閉じてメッセージポンプを止める
					form.Shown += async (_, _) =>
					{
						try
						{
							// 大きな画像を media 参照のまま渡す印刷要求。Data URL にはしない
							result = await service.PrintToPdfAsync(new PrintDocumentRequest
							{
								// 画像は media/1.png を参照する HTML。本文に日本語を含む
								Html = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body><p>仕様調査</p><img src=\"media/1.png\"></body></html>",
								// 日本語フォルダを含む PDF の保存先
								FilePath = pdfPath,
								// HTML が参照するローカル画像。1件だけで Data URL にはしない
								Media =
								[
									// media へコピーするノイズ画像
									new PrintMediaFile
									{
										// HTML の src と対応するファイル名
										Name = "1.png",
										// Data URL にしないコピー元。1_200_000 バイトを超える
										SourcePath = imagePath,
									},
								],
							});
						}
						// PDF 化の失敗をテストスレッドへ残す。成功では error は null のまま
						catch (Exception ex)
						{
							error = ex;
						}
						finally
						{
							form.Close();
						}
					};
					Application.Run(form);
				}
				// フォーム起動前の失敗。WebView2 が無い環境ではここで残る
				catch (Exception ex)
				{
					error = ex;
				}
			});
			thread.SetApartmentState(ApartmentState.STA);
			thread.Start();
			Assert.True(thread.Join(TimeSpan.FromSeconds(90)), "PDF 出力が制限時間内に終わりませんでした。");
			Assert.Null(error?.ToString());
			Assert.NotNull(result);
			Assert.True(result!.Success, result.Message);

			// 書いた PDF のバイト列。100_000 バイト以下なら画像が乗っていない
			byte[] pdf = File.ReadAllBytes(pdfPath);
			Assert.True(pdf.Length > 100_000, "PDF が小さい: " + pdf.Length);
			// 画像オブジェクトの有無を見るため Latin-1 で読んだ PDF。日本語のパスは見ない
			string latin = Encoding.Latin1.GetString(pdf);
			Assert.Contains("/Image", latin);
		}
		finally
		{
			// 一時ディレクトリが残っているときだけ削除する。無いときは何もしない
			if (Directory.Exists(root))
			{
				Directory.Delete(root, recursive: true);
			}
		}
	}

	/// <summary>
	/// 圧縮が効きにくいノイズの PNG を書く
	/// </summary>
	/// <param name="path">保存先</param>
	/// <param name="width">幅</param>
	/// <param name="height">高さ</param>
	private static void WriteNoisyPng(string path, int width, int height)
	{
		// ノイズを書き込む 24bpp のビットマップ。圧縮が効きにくい
		using var bitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb);
		// ビットマップ全体をロックする範囲。単位はピクセル
		Rectangle rect = new(0, 0, width, height);
		// 書き込み用にロックしたバッファ。Stride は幅の3バイトより大きいことがある
		BitmapData data = bitmap.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format24bppRgb);
		try
		{
			// ストライドを含むバッファ長。単位はバイト。0 にはならない
			int length = data.Stride * height;
			// 乱数で埋めるピクセル列。種を 1 に固定しているので毎回同じノイズになる
			byte[] bytes = new byte[length];
			new Random(1).NextBytes(bytes);
			Marshal.Copy(bytes, 0, data.Scan0, length);
		}
		finally
		{
			bitmap.UnlockBits(data);
		}

		bitmap.Save(path, ImageFormat.Png);
	}
}
