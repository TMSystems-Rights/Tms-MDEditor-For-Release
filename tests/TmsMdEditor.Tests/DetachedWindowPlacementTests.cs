using System.Drawing;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

public sealed class DetachedWindowPlacementTests
{
	[Fact]
	public void CalculateLocation_places_tab_near_drop_point()
	{
		Point location = DetachedWindowPlacement.CalculateLocation(
			new Point(900, 500),
			new Size(800, 600),
			new Rectangle(0, 0, 1920, 1080));

		Assert.Equal(new Point(780, 460), location);
	}

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
