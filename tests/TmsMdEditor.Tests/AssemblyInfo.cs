// ==============================================
// テストの並列実行を止める
// ==============================================

// AppPaths や PortableRuntime など、プロセスで共有する状態をテスト同士が同時に書き換えない

[assembly: Xunit.CollectionBehavior(DisableTestParallelization = true)]
