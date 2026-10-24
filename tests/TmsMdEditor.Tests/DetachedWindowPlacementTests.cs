// ==============================================
// 切り離したウィンドウの左上を作業領域内に収める
// ==============================================

// タブを離したときのウィンドウ左上を、ドロップ位置の近くかつ作業領域の内側に固定する

using System.Drawing;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

/// <summary>
/// 画面矩形とウィンドウサイズを引数で渡し、実際のディスプレイは使わない
/// </summary>
public sealed class DetachedWindowPlacementTests
{
	/// <summary>
	/// 画面内のドロップ位置では、800×600 のウィンドウ左上を (780, 460) に置く
	/// </summary>
	[Fact]
	public void CalculateLocation_places_tab_near_drop_point()
	{
		Point location = DetachedWindowPlacement.CalculateLocation(
			new Point(900, 500),
			new Size(800, 600),
			new Rectangle(0, 0, 1920, 1080));

		Assert.Equal(new Point(780, 460), location);
	}

	/// <summary>
	/// 画面外へドロップしても、800×600 のウィンドウ全体が作業領域に収まる左上へ動かす
	/// </summary>
	/// <param name="dropX">ドロップ位置の X。画面左上が 0 で、単位はピクセル。画面外も渡す</param>
	/// <param name="dropY">ドロップ位置の Y。画面左上が 0 で、単位はピクセル。画面外も渡す</param>
	/// <param name="expectedX">作業領域内へ収めた左端。単位はピクセル</param>
	/// <param name="expectedY">作業領域内へ収めた上端。単位はピクセル</param>
	[Theory]
	[InlineData(-100, -100, 0, 0)]
	[InlineData(2500, 1400, 1120, 480)]
	public void CalculateLocation_clamps_window_to_working_area(int dropX, int dropY, int expectedX, int expectedY)
	{
		Point location = DetachedWindowPlacement.CalculateLocation(
			new Point(dropX, dropY),
			new Size(800, 600),
			new Rectangle(0, 0, 1920, 1080));

		Assert.Equal(new Point(expectedX, expectedY), location);
	}
}
