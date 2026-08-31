using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace TmsMdEditor.Services;

/// <summary>
/// 単一インスタンス起動と、後続プロセスから既存ウィンドウへの起動引数転送を管理する。
/// </summary>
internal sealed class SingleInstanceManager : IDisposable
{
	private const string MutexPrefix = "Local\\TMS-MDEditor-";
	private const string PipePrefix  = "TMS-MDEditor-";
	private const int ConnectRetryCount = 10;
	private const int ConnectTimeoutMs  = 200;

	private readonly string _mutexName;
	private readonly string _pipeName;
	private readonly Logger _logger;
	private Mutex? _mutex;
	private CancellationTokenSource? _cancellationTokenSource;
	private Task? _listenerTask;
	private Action<string[]>? _activationHandler;
	private bool _ownsMutex;
	private int _mutexOwnerThreadId;

	/// <summary>
	/// 既定の名前空間でマネージャーを初期化する。
	/// </summary>
	/// <param name="logger">ログ出力先</param>
	public SingleInstanceManager(Logger logger)
		: this(logger, GetInstanceScope())
	{
	}

	/// <summary>
	/// テスト用の名前空間でマネージャーを初期化する。
	/// </summary>
	/// <param name="logger">ログ出力先</param>
	/// <param name="scope">Mutex と Named Pipe を分離するための名前空間</param>
	internal SingleInstanceManager(Logger logger, string scope)
	{
		ArgumentException.ThrowIfNullOrWhiteSpace(scope);

		_logger    = logger;
		_mutexName = $"{MutexPrefix}{scope}";
		_pipeName  = $"{PipePrefix}{scope}";
	}

	/// <summary>
	/// 現プロセスが最初のインスタンスか判定し、最初なら Mutex を所有する。
	/// </summary>
	/// <returns>最初のインスタンスなら true</returns>
	public bool TryBecomePrimary()
	{
		if (_mutex is not null)
		{
			return _ownsMutex;
		}

		_mutex = new Mutex(initiallyOwned: true, _mutexName, out bool createdNew);
		_ownsMutex = createdNew;
		_mutexOwnerThreadId = createdNew ? Environment.CurrentManagedThreadId : 0;
		return _ownsMutex;
	}

	/// <summary>
	/// 後続プロセスからの起動要求を受け付ける。
	/// </summary>
	/// <param name="activationHandler">起動引数を受け取るコールバック</param>
	public void StartListening(Action<string[]> activationHandler)
	{
		if (!_ownsMutex)
		{
			throw new InvalidOperationException("最初のインスタンス以外では Named Pipe を開始できません。");
		}

		ArgumentNullException.ThrowIfNull(activationHandler);
		if (_listenerTask is not null)
		{
			throw new InvalidOperationException("Named Pipe は既に開始されています。");
		}

		_activationHandler       = activationHandler;
		_cancellationTokenSource = new CancellationTokenSource();
		_listenerTask            = Task.Run(() => ListenAsync(_cancellationTokenSource.Token));
	}

	/// <summary>
	/// 起動引数を最初のインスタンスへ転送する。
	/// </summary>
	/// <param name="args">転送するコマンドライン引数</param>
	/// <returns>転送に成功した場合 true</returns>
	public bool TryForwardToPrimary(string[] args)
	{
		string payload = JsonSerializer.Serialize(new ActivationRequest
		{
			Args = args.Where(arg => !string.IsNullOrWhiteSpace(arg)).ToArray(),
		});

		for (int attempt = 0; attempt < ConnectRetryCount; attempt++)
		{
			try
			{
				using var client = new NamedPipeClientStream(
					".",
					_pipeName,
					PipeDirection.Out,
					PipeOptions.None);
				client.Connect(ConnectTimeoutMs);

				using var writer = new StreamWriter(client, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false), leaveOpen: false)
				{
					AutoFlush = true,
				};
				writer.WriteLine(payload);
				return true;
			}
			catch (Exception ex) when (ex is IOException or TimeoutException)
			{
				if (attempt == ConnectRetryCount - 1)
				{
					_logger.Warn("instance", "既存インスタンスへの起動要求転送に失敗しました", new Dictionary<string, object?>
					{
						["error"] = ex.Message,
					});
					return false;
				}

				Thread.Sleep(ConnectTimeoutMs);
			}
		}

		return false;
	}

	/// <inheritdoc />
	public void Dispose()
	{
		if (_cancellationTokenSource is not null)
		{
			_cancellationTokenSource.Cancel();
			try
			{
				_listenerTask?.Wait(TimeSpan.FromSeconds(1));
			}
			catch (AggregateException)
			{
				// 終了中のパイプ待受例外は無視する。
			}
			finally
			{
				_cancellationTokenSource.Dispose();
			}
		}

		if (_ownsMutex && Environment.CurrentManagedThreadId == _mutexOwnerThreadId)
		{
			_mutex?.ReleaseMutex();
		}

		_mutex?.Dispose();
	}

	private async Task ListenAsync(CancellationToken cancellationToken)
	{
		while (!cancellationToken.IsCancellationRequested)
		{
			try
			{
				using var server = new NamedPipeServerStream(
					_pipeName,
					PipeDirection.In,
					1,
					PipeTransmissionMode.Byte,
					PipeOptions.Asynchronous);
				await server.WaitForConnectionAsync(cancellationToken);

				using var reader = new StreamReader(server, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, leaveOpen: false);
				string? payload = await reader.ReadLineAsync(cancellationToken);
				ActivationRequest? request = string.IsNullOrWhiteSpace(payload)
					? null
					: JsonSerializer.Deserialize<ActivationRequest>(payload);
				string[] args = request?.Args?
					.Where(arg => !string.IsNullOrWhiteSpace(arg))
					.ToArray() ?? [];

				_activationHandler?.Invoke(args);
			}
			catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
			{
				return;
			}
			catch (Exception ex)
			{
				_logger.Warn("instance", "単一インスタンスの Named Pipe 待受でエラーが発生しました", new Dictionary<string, object?>
				{
					["error"] = ex.Message,
				});
			}
		}
	}

	private static string GetInstanceScope()
	{
		string appDataFolder = Path.GetFileName(AppPaths.AppDataRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
		return string.Equals(appDataFolder, "tms-mdeditor-dev", StringComparison.OrdinalIgnoreCase)
			? "dev-v1"
			: "prod-v1";
	}

	private sealed class ActivationRequest
	{
		public string[] Args { get; init; } = [];
	}
}
