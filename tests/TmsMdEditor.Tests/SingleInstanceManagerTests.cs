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
		// 本番の単一インスタンスとぶつからない、このテストだけのスコープ
		string scope = $"test-{Guid.NewGuid():N}";
		// 両プロセスへ渡すログ。ファイルへは書かない
		var logger = new Logger();
		// 先にプライマリになる側。同じスコープの2つ目より前に作る
		using var primary = new SingleInstanceManager(logger, scope);
		// 後から同じスコープで起動した側。プライマリにはなれない
		using var secondary = new SingleInstanceManager(logger, scope);
		// 先のプロセスが受け取った起動引数。届く前は null
		string[]? received = null;
		// 受け取りを待つ合図。5秒以内にセットされなければ失敗する
		using var receivedSignal = new ManualResetEventSlim();

		Assert.True(primary.TryBecomePrimary());
		Assert.False(secondary.TryBecomePrimary());
		// 先のプロセスが受け取った引数を記録し、待ちを解く
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
