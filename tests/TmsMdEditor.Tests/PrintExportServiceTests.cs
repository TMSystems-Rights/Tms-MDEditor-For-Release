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
		string root = Path.Combine(Path.GetTempPath(), "tms-mde-print-it-" + Guid.NewGuid().ToString("N"));
		Directory.CreateDirectory(root);
		try
		{
			string imagePath = Path.Combine(root, "noise.png");
			WriteNoisyPng(imagePath, 1000, 800);
			long imageBytes = new FileInfo(imagePath).Length;
			Assert.True(imageBytes > 1_200_000, "画像が小さい: " + imageBytes);

			string pdfPath = Path.Combine(root, "設計ドキュメント", "仕様.pdf");
			Exception? error = null;
			ExportActionResult? result = null;
			var thread = new Thread(() =>
			{
				try
				{
					Application.EnableVisualStyles();
					using var form = new Form
					{
						ShowInTaskbar = false,
						FormBorderStyle = FormBorderStyle.FixedToolWindow,
						StartPosition = FormStartPosition.Manual,
						Location = new Point(-3200, -3200),
						Size = new Size(800, 600),
					};
					using var service = new PrintExportService(form, new Logger());
					form.Shown += async (_, _) =>
					{
						try
						{
							result = await service.PrintToPdfAsync(new PrintDocumentRequest
							{
								Html = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body><p>仕様調査</p><img src=\"media/1.png\"></body></html>",
								FilePath = pdfPath,
								Media =
								[
									new PrintMediaFile
									{
										Name = "1.png",
										SourcePath = imagePath,
									},
								],
							});
						}
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

			byte[] pdf = File.ReadAllBytes(pdfPath);
			Assert.True(pdf.Length > 100_000, "PDF が小さい: " + pdf.Length);
			string latin = Encoding.Latin1.GetString(pdf);
			Assert.Contains("/Image", latin);
		}
		finally
		{
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
		using var bitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb);
		Rectangle rect = new(0, 0, width, height);
		BitmapData data = bitmap.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format24bppRgb);
		try
		{
			int length = data.Stride * height;
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
