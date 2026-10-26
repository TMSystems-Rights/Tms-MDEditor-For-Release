// ==============================================
// 単一インスタンスと起動引数の転送
// ==============================================

// 最初のプロセスだけが Mutex と名前付きパイプを所有する
// 後続プロセスは引数を渡して終わり、ウィンドウの前面化は受け取った側が行う

using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace TmsMdEditor.Services;

/// <summary>
/// Mutex で最初のプロセスを決め、後続の起動引数を名前付きパイプで既存プロセスへ渡す
/// ポータブルと Debug は範囲を分け、待受はプライマリだけが開始できる
/// </summary>
internal sealed class SingleInstanceManager : IDisposable
{
	// ==============================================
	// 名前と所有
	// ==============================================

	/// <summary>
	/// Mutex 名の接頭辞。後ろへインスタンス範囲を付ける。Local スコープなので同一セッション内だけ
	/// </summary>
	private const string MutexPrefix = "Local\\TMS-MDEditor-";

	/// <summary>
	/// 名前付きパイプの接頭辞。Mutex と同じ範囲を後ろへ付け、別形態のプロセスへは渡さない
	/// </summary>
	private const string PipePrefix  = "TMS-MDEditor-";

	/// <summary>
	/// 後続プロセスが接続を試す回数。超えたら転送失敗として返す
	/// </summary>
	private const int ConnectRetryCount = 10;

	/// <summary>
	/// 1 回の接続待ちと、失敗後の再試行間隔。単位はミリ秒
	/// </summary>
	private const int ConnectTimeoutMs  = 200;

	/// <summary>
	/// このプロセスが取る Mutex 名。生成後は変えない
	/// </summary>
	private readonly string _mutexName;

	/// <summary>
	/// 起動引数を流すパイプ名。Mutex と同じ範囲から作る
	/// </summary>
	private readonly string _pipeName;

	/// <summary>
	/// 転送失敗と待受エラーを記録するログ。Mutex の成否は戻り値で返す
	/// </summary>
	private readonly Logger _logger;

	/// <summary>
	/// 所有を判定した Mutex。TryBecomePrimary まで null。破棄時に解放する
	/// </summary>
	private Mutex? _mutex;

	/// <summary>
	/// パイプ待受を止めるキャンセル。StartListening から Dispose まで生きる
	/// </summary>
	private CancellationTokenSource? _cancellationTokenSource;

	/// <summary>
	/// 待受ループ。未開始は null。2 回目の StartListening は失敗させる
	/// </summary>
	private Task? _listenerTask;

	/// <summary>
	/// 起動引数を受け取ったときに呼ぶコールバック。待受開始まで null
	/// </summary>
	private Action<string[]>? _activationHandler;

	/// <summary>
	/// このプロセスが Mutex を新規作成したか。後続プロセスは false のまま転送側になる
	/// </summary>
	private bool _ownsMutex;

	/// <summary>
	/// Mutex を取得したスレッド。解放は同じスレッドでだけ行う。未所有は 0
	/// </summary>
	private int _mutexOwnerThreadId;

	/// <summary>
	/// 今の配布形態の範囲でマネージャーを作る。Mutex はまだ取らない
	/// </summary>
	/// <param name="logger">転送失敗と待受エラーを記録するログ</param>
	public SingleInstanceManager(Logger logger)
		: this(logger, GetInstanceScope())
	{
	}

	/// <summary>
	/// 指定した範囲で Mutex 名とパイプ名を決める。テストが本番の単一インスタンスと衝突しないために使う
	/// </summary>
	/// <param name="logger">転送失敗と待受エラーを記録するログ</param>
	/// <param name="scope">Mutex とパイプを他プロセスから分ける名前。空白だけは失敗</param>
	/// <exception cref="ArgumentException"><paramref name="scope"/> が空または空白</exception>
	internal SingleInstanceManager(Logger logger, string scope)
	{
		ArgumentException.ThrowIfNullOrWhiteSpace(scope);

		_logger    = logger;
		_mutexName = $"{MutexPrefix}{scope}";
		_pipeName  = $"{PipePrefix}{scope}";
	}

	// ==============================================
	// プライマリと転送
	// ==============================================

	/// <summary>
	/// 現プロセスが最初のインスタンスかを判定し、最初なら Mutex を所有する。2 回目は同じ結果を返す
	/// </summary>
	/// <returns>Mutex を新規作成できた、または既に所有していれば true</returns>
	public bool TryBecomePrimary()
	{
		// 判定済みなら Mutex を取り直さず、初回の所有結果を返す
		if (_mutex is not null)
		{
			return _ownsMutex;
		}

		// 新規作成できたか。false は既存プロセスがあり、このプロセスは所有しない
		_mutex = new Mutex(initiallyOwned: true, _mutexName, out bool createdNew);
		_ownsMutex = createdNew;
		_mutexOwnerThreadId = createdNew ? Environment.CurrentManagedThreadId : 0;
		return _ownsMutex;
	}

	/// <summary>
	/// 後続プロセスからの起動要求を、プライマリだけが非同期で受け始める
	/// </summary>
	/// <param name="activationHandler">起動引数を受け取るコールバック。null は失敗。パイプのスレッドから呼ばれる</param>
	/// <exception cref="InvalidOperationException">プライマリでない、または待受を既に開始している</exception>
	/// <exception cref="ArgumentNullException"><paramref name="activationHandler"/> が null</exception>
	public void StartListening(Action<string[]> activationHandler)
	{
		// 後続プロセスは待受を持たない
		if (!_ownsMutex)
		{
			throw new InvalidOperationException("最初のインスタンス以外では Named Pipe を開始できません。");
		}

		ArgumentNullException.ThrowIfNull(activationHandler);
		// 待受が既にある 2 回目は失敗させる。未開始の null では入らない
		if (_listenerTask is not null)
		{
			throw new InvalidOperationException("Named Pipe は既に開始されています。");
		}

		_activationHandler       = activationHandler;
		_cancellationTokenSource = new CancellationTokenSource();
		_listenerTask            = Task.Run(() => ListenAsync(_cancellationTokenSource.Token));
	}

	/// <summary>
	/// 起動引数を最初のインスタンスへ 1 行の JSON で渡す。空の引数は除く
	/// </summary>
	/// <param name="args">転送するコマンドライン引数。空白だけの要素は除く</param>
	/// <returns>接続して書き終えたら true。再試行後も接続できなければ false</returns>
	public bool TryForwardToPrimary(string[] args)
	{
		// 空白だけの引数を除いた 1 行 JSON。接続前に作る
		string payload = JsonSerializer.Serialize(new ActivationRequest
		{
			// 空白だけの要素は送らない。全部空白なら空配列
			Args = args.Where(arg => !string.IsNullOrWhiteSpace(arg)).ToArray(),
		});

		for (int attempt = 0; attempt < ConnectRetryCount; attempt++)
		{
			try
			{
				// 既存プロセスへの送信側。サーバーは 1 本だけ
				using var client = new NamedPipeClientStream(
					".",
					_pipeName,
					PipeDirection.Out,
					PipeOptions.None);
				client.Connect(ConnectTimeoutMs);

				// BOM 無し UTF-8 で 1 行書いて閉じる。Flush は行のたびに行う
				using var writer = new StreamWriter(client, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false), leaveOpen: false)
				{
					AutoFlush = true,
				};
				writer.WriteLine(payload);
				return true;
			}
			catch (Exception ex) when (ex is IOException or TimeoutException)
			{
				// 再試行の最後だけ失敗を記録して false を返す。途中の失敗では入らず、待ってから次を試す
				if (attempt == ConnectRetryCount - 1)
				{
					_logger.Warn(LogCategory.Instance, "既存インスタンスへの起動要求転送に失敗しました", new Dictionary<string, object?>
					{
						[LogProperty.Error] = ex.Message,
					});
					return false;
				}

				Thread.Sleep(ConnectTimeoutMs);
			}
		}

		return false;
	}

	/// <summary>
	/// 待受を止め、取得スレッドと同じスレッドなら Mutex を解放して破棄する
	/// </summary>
	public void Dispose()
	{
		// 待受を開始していたときだけ止める。未開始の null では解放だけに進む
		if (_cancellationTokenSource is not null)
		{
			_cancellationTokenSource.Cancel();
			try
			{
				_listenerTask?.Wait(TimeSpan.FromSeconds(1));
			}
			catch (AggregateException)
			{
				// 終了中のパイプ待受例外は無視する
			}
			finally
			{
				_cancellationTokenSource.Dispose();
			}
		}

		// 所有していて、取得したスレッドと今のスレッドが同じときだけ Mutex を解放する。どちらかが欠けても入らない
		if (_ownsMutex && Environment.CurrentManagedThreadId == _mutexOwnerThreadId)
		{
			_mutex?.ReleaseMutex();
		}

		_mutex?.Dispose();
	}

	// ==============================================
	// パイプ待受
	// ==============================================

	/// <summary>
	/// 接続のたびに 1 行の JSON を読み、起動引数をコールバックへ渡す。キャンセルで戻る
	/// </summary>
	/// <param name="cancellationToken">待受を止めるトークン。取り消すと待受を終える</param>
	private async Task ListenAsync(CancellationToken cancellationToken)
	{
		while (!cancellationToken.IsCancellationRequested)
		{
			try
			{
				// 1 接続だけの受信側。次のループで作り直す
				using var server = new NamedPipeServerStream(
					_pipeName,
					PipeDirection.In,
					1,
					PipeTransmissionMode.Byte,
					PipeOptions.Asynchronous);
				await server.WaitForConnectionAsync(cancellationToken);

				// BOM を見ない UTF-8。1 行読んで閉じる
				using var reader = new StreamReader(server, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, leaveOpen: false);
				// 1 行。空や空白、切断で null のときは要求が無い
				string? payload = await reader.ReadLineAsync(cancellationToken);
				// 空行は null。JSON でなければ例外が外側の catch へ出る
				ActivationRequest? request = string.IsNullOrWhiteSpace(payload)
					? null
					: JsonSerializer.Deserialize<ActivationRequest>(payload);
				// 空白を除いた引数。要求が null なら空配列で、開くファイル無しとして渡す
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
				_logger.Warn(LogCategory.Instance, "単一インスタンスの Named Pipe 待受でエラーが発生しました", new Dictionary<string, object?>
				{
					[LogProperty.Error] = ex.Message,
				});
			}
		}
	}

	/// <summary>
	/// 今の実行形態から Mutex とパイプの範囲を決める。ポータブルは exe の場所、それ以外は AppData フォルダ名
	/// </summary>
	/// <returns>接尾辞。開発用、製品用、またはポータブルのハッシュ</returns>
	private static string GetInstanceScope()
	{
		// AppData ルートのフォルダ名。末尾の区切りは除く。ポータブルでは範囲の材料にしない
		string appDataFolder = Path.GetFileName(AppPaths.AppDataRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
		return PortableMode.ResolveInstanceScope(AppPaths.IsPortable, AppPaths.PortableExeDir, appDataFolder);
	}

	/// <summary>
	/// パイプで 1 行送る起動要求。引数以外の状態は持たない
	/// </summary>
	private sealed class ActivationRequest
	{
		/// <summary>
		/// 転送するコマンドライン引数。空白だけの要素は送る前に除く
		/// </summary>
		public string[] Args { get; init; } = [];
	}
}
