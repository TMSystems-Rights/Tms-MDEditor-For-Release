using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

public sealed class SingleInstanceManagerTests
{
	[Fact]
	public void Secondary_instance_forwards_startup_arguments_to_primary()
	{
		string scope = $"test-{Guid.NewGuid():N}";
		var logger = new Logger();
		using var primary = new SingleInstanceManager(logger, scope);
		using var secondary = new SingleInstanceManager(logger, scope);
		string[]? received = null;
		using var receivedSignal = new ManualResetEventSlim();

		Assert.True(primary.TryBecomePrimary());
		Assert.False(secondary.TryBecomePrimary());
		primary.StartListening(args =>
		{
			received = args;
			receivedSignal.Set();
		});

		Assert.True(secondary.TryForwardToPrimary(["C:\\temp\\sample.md"]));
		Assert.True(receivedSignal.Wait(TimeSpan.FromSeconds(5)));

		Assert.NotNull(received);
		Assert.Equal(["C:\\temp\\sample.md"], received!);
	}
}
