// ==============================================
// 2つ目の起動引数を先のプロセスへ渡す
// ==============================================

// 同じ範囲の2つ目のプロセスはプライマリにならず、開くファイルのパスを先のプロセスへ届ける

using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

/// <summary>
/// テストごとに固有のスコープを使い、本番の単一インスタンスとは混ぜない
/// 先のプロセスが時間内に受け取らないときは失敗する
/// </summary>
public sealed class SingleInstanceManagerTests
{
	/// <summary>
	/// 同じスコープの2つ目はプライマリになれず、起動引数を先のプロセスへ届ける
	/// </summary>
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
