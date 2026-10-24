// ==============================================
// クリップボード HTML の表変換
// ==============================================

// 状態は共有する正規表現だけである。ホストは HTML または TSV を渡し、GFM の文字列を受け取る

using System.Globalization;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace TmsMdEditor.Services;

/// <summary>
/// クリップボードの HTML 表を、結合と配置を残した GFM 表へ変換する
/// 表が無ければ空文字を返し、入れ子の表は親セルへ展開しない
/// </summary>
internal static class ClipboardHtmlTableConverter
{
	// ==============================================
	// 切り出しパターン
	// ==============================================

	/// <summary>
	/// CF_HTML ヘッダの開始・終了キーと、そのバイト位置。プロセスで共有し、実行中は変えない
	/// </summary>
	private static readonly Regex CfHtmlOffsetPattern = new(
		@"^(StartHTML|EndHTML|StartFragment|EndFragment):(\d+)\s*$",
		RegexOptions.IgnoreCase | RegexOptions.Multiline | RegexOptions.CultureInvariant);

	/// <summary>
	/// style 要素の中身。改行を含む CSS も 1 件として取る。実行中は変えない
	/// </summary>
	private static readonly Regex StyleBlockPattern = new(
		@"<style\b[^>]*>(.*?)</style>",
		RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.CultureInvariant);

	/// <summary>
	/// セレクタと宣言ブロック。入れ子の波括弧は対象にしない。実行中は変えない
	/// </summary>
	private static readonly Regex CssRulePattern = new(
		@"(?<selectors>[^{}]+)\{(?<body>[^{}]*)\}",
		RegexOptions.CultureInvariant);

	/// <summary>
	/// セレクタに現れるクラス名。要素セレクタは取らない。実行中は変えない
	/// </summary>
	private static readonly Regex CssClassSelectorPattern = new(
		@"\.([A-Za-z_][\w\-]*)",
		RegexOptions.CultureInvariant);

	// ==============================================
	// 公開変換
	// ==============================================

	/// <summary>
	/// CF_HTML の断片だけを返す。オフセットが使えなければコメント印、それも無ければヘッダを除いた残り
	/// </summary>
	/// <param name="clipboardHtml">クリップボードの HTML。null や空白は空文字</param>
	/// <returns>表を含み得る HTML。空入力は空文字</returns>
	public static string ExtractFragment(string clipboardHtml)
	{
		if (string.IsNullOrWhiteSpace(clipboardHtml))
		{
			return string.Empty;
		}

		// CF_HTMLのオフセットはUTF-8バイト基準なので、文字インデックスより先に正規手順で切り出す
		if (TrySliceUtf8Range(clipboardHtml, "StartFragment", "EndFragment", out string fragment)
			&& fragment.Length > 0)
		{
			return fragment;
		}

		// オフセット不正な生成元向けに、仕様上のコメントマーカーへフォールバックする
		int markerStart = clipboardHtml.IndexOf("<!--StartFragment-->", StringComparison.OrdinalIgnoreCase);
		int markerEnd   = clipboardHtml.IndexOf("<!--EndFragment-->", StringComparison.OrdinalIgnoreCase);
		if (markerStart >= 0 && markerEnd > markerStart)
		{
			return clipboardHtml[(markerStart + "<!--StartFragment-->".Length)..markerEnd];
		}

		return StripCfHtmlHeader(clipboardHtml);
	}

	/// <summary>
	/// CF_HTML の文書全体を、StartHTML から EndHTML まで返す。取れなければヘッダを除いた残り
	/// </summary>
	/// <param name="clipboardHtml">クリップボードの HTML。null や空白は空文字</param>
	/// <returns>HTML 文書。断片より外側の table 開始を含むことがある</returns>
	public static string ExtractHtmlDocument(string clipboardHtml)
	{
		if (string.IsNullOrWhiteSpace(clipboardHtml))
		{
			return string.Empty;
		}

		if (TrySliceUtf8Range(clipboardHtml, "StartHTML", "EndHTML", out string document)
			&& document.Length > 0)
		{
			return document;
		}

		return StripCfHtmlHeader(clipboardHtml);
	}

	/// <summary>
	/// table が欠けた Excel 断片でも変換できるよう、文書全体を優先し、行やセルだけなら table で包む
	/// </summary>
	/// <param name="clipboardHtml">クリップボードの HTML</param>
	/// <returns>表を探す基準の HTML。table も行も無ければ文書か断片</returns>
	public static string NormalizeTableSource(string clipboardHtml)
	{
		string document = ExtractHtmlDocument(clipboardHtml);
		string fragment = ExtractFragment(clipboardHtml);
		// ExcelはFragment外にtable開始タグを置くことがあるため、文書全体から優先して探す
		foreach (string candidate in new[] { document, fragment, clipboardHtml })
		{
			if (IndexOfOpenTag(candidate, "table", 0) >= 0)
			{
				return candidate;
			}
		}

		foreach (string candidate in new[] { fragment, document, clipboardHtml })
		{
			if (IndexOfOpenTag(candidate, "tr", 0) >= 0
				|| IndexOfOpenTag(candidate, "td", 0) >= 0
				|| IndexOfOpenTag(candidate, "th", 0) >= 0)
			{
				return "<table>\n" + candidate + "\n</table>";
			}
		}

		return document.Length > 0 ? document : fragment;
	}

	/// <summary>
	/// 正規化した HTML に table 開始タグがあるかを返す
	/// </summary>
	/// <param name="html">クリップボード HTML または断片</param>
	/// <returns>table 開始タグがあれば true</returns>
	public static bool ContainsTable(string html)
	{
		string source = NormalizeTableSource(html);
		return IndexOfOpenTag(source, "table", 0) >= 0;
	}

	/// <summary>
	/// Excel またはスプレッドシート由来の印が HTML に含まれるかを返す
	/// </summary>
	/// <param name="html">調べる HTML。大文字小文字は無視する</param>
	/// <returns>Excel の名前空間や ProgId があれば true</returns>
	public static bool LooksLikeExcelHtml(string html)
	{
		return html.Contains("Excel.Sheet", StringComparison.OrdinalIgnoreCase)
			|| html.Contains("urn:schemas-microsoft-com:office:excel", StringComparison.OrdinalIgnoreCase)
			|| html.Contains("xmlns:x=\"urn:schemas-microsoft-com:office:excel\"", StringComparison.OrdinalIgnoreCase)
			|| html.Contains("ProgId content=Excel", StringComparison.OrdinalIgnoreCase);
	}

	/// <summary>
	/// タブ区切りテキストを、空ヘッダ付きの GFM 表にする。末尾の空行は捨てる
	/// </summary>
	/// <param name="text">Unicode テキスト。null や空白は空文字。セル内の | はエスケープする</param>
	/// <returns>Markdown 表。空なら空文字</returns>
	public static string TsvToMarkdown(string text)
	{
		if (string.IsNullOrWhiteSpace(text))
		{
			return string.Empty;
		}

		string normalized = text.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n');
		List<List<string>> rows = [];
		foreach (string line in normalized.Split('\n'))
		{
			if (rows.Count == 0 && line.Length == 0)
			{
				continue;
			}

			rows.Add(line.Split('\t').Select(EscapeCell).ToList());
		}

		while (rows.Count > 0 && rows[^1].TrueForAll(static cell => cell.Length == 0))
		{
			rows.RemoveAt(rows.Count - 1);
		}

		return RenderGfmTable(rows);
	}

	/// <summary>
	/// 1 セルだけの GFM 表を返す。セル内の | と改行は表が割れない形にする
	/// </summary>
	/// <param name="cell">セル本文</param>
	/// <returns>空ヘッダと 1 行を持つ Markdown 表</returns>
	public static string SingleCellTable(string cell)
	{
		return RenderGfmTable([[EscapeCell(cell)]]);
	}

	/// <summary>
	/// HTML 内の表を GFM へ変換し、表の前後の文章も同じ順で残す。表が無ければ空文字
	/// </summary>
	/// <param name="html">変換する HTML。CF_HTML でも断片でもよい</param>
	/// <param name="resolveImageMarkup">画像 URL を挿入文字列へ変える。null や空を返した画像は捨てる</param>
	/// <returns>表と前後の本文を空行でつないだ Markdown。表が無ければ空文字</returns>
	public static string ToMarkdown(string html, Func<string, string?> resolveImageMarkup)
	{
		string source = NormalizeTableSource(html);
		if (IndexOfOpenTag(source, "table", 0) < 0)
		{
			return string.Empty;
		}

		// 表の前後にある説明文も捨てず、変換済み表と同じ出力順で連結する
		List<string> parts = [];
		int cursor         = 0;
		while (cursor < source.Length)
		{
			int tableStart = IndexOfOpenTag(source, "table", cursor);
			if (tableStart < 0)
			{
				AppendPlainText(parts, source[cursor..]);
				break;
			}

			if (tableStart > cursor)
			{
				AppendPlainText(parts, source[cursor..tableStart]);
			}

			if (!TryReadElement(source, tableStart, "table", out string tableHtml, out int tableEnd))
			{
				AppendPlainText(parts, source[tableStart..]);
				break;
			}

			string markdown = ConvertTable(tableHtml, resolveImageMarkup, ParseCssClassAlignments(source));
			if (markdown.Length > 0)
			{
				parts.Add(markdown);
			}

			cursor = tableEnd;
		}

		return string.Join("\n\n", parts.Where(static part => part.Length > 0));
	}

	// ==============================================
	// セルとグリッド
	// ==============================================

	/// <summary>
	/// 表の外側の HTML をタグ無しの本文にし、空でなければ部品へ足す
	/// </summary>
	/// <param name="parts">結合前の Markdown と本文</param>
	/// <param name="html">表の外側の HTML</param>
	private static void AppendPlainText(List<string> parts, string html)
	{
		string text = NormalizePlainText(StripTagsToText(html));
		if (text.Length > 0)
		{
			parts.Add(text);
		}
	}

	/// <summary>
	/// 1 つの table を、結合セルを占有した二次元グリッドから GFM 表にする
	/// </summary>
	/// <param name="tableHtml">table 要素全体</param>
	/// <param name="resolveImageMarkup">セル内画像を挿入文字列へ変える</param>
	/// <param name="classAlignments">CSS クラス名から水平・垂直配置。キーはクラス名で、直指定が優先される</param>
	/// <returns>GFM 表。中身を読めなければ空文字</returns>
	private static string ConvertTable(
		string tableHtml,
		Func<string, string?> resolveImageMarkup,
		IReadOnlyDictionary<string, CellAlignment> classAlignments)
	{
		if (!TryReadInner(tableHtml, "table", out string inner))
		{
			return string.Empty;
		}

		// rowspan/colspanで先に占有される座標を扱えるよう、可変の二次元グリッドへ展開する
		List<List<string?>> grid = [];
		int rowIndex = 0;
		foreach (string rowHtml in FindElementsOutsideNestedTables(inner, "tr"))
		{
			if (!TryReadInner(rowHtml, "tr", out string rowInner))
			{
				continue;
			}

			EnsureGridRow(grid, rowIndex);
			int column = 0;
			foreach (string cellHtml in FindElementsOutsideNestedTables(rowInner, "td", "th"))
			{
				while (CellTaken(grid, rowIndex, column))
				{
					column++;
				}

				int colspan = Math.Max(1, ReadPositiveAttribute(cellHtml, "colspan"));
				int rowspan = Math.Max(1, ReadPositiveAttribute(cellHtml, "rowspan"));
				string cell = ConvertCell(cellHtml, resolveImageMarkup);
				CellAlignment alignment = ReadCellAlignment(cellHtml, classAlignments);
				PlaceSpannedCell(
					grid,
					rowIndex,
					column,
					FormatCellSpan(cell, colspan, rowspan, alignment.Align, alignment.Valign),
					colspan,
					rowspan);
				column += colspan;
			}

			rowIndex++;
		}

		List<List<string>> rows = grid
			.Select(static row => row.Select(static cell => cell ?? string.Empty).ToList())
			.Where(static row => row.Count > 0)
			.ToList();
		return RenderGfmTable(rows);
	}

	/// <summary>
	/// セル本文を、入れ子表を飛ばしながらテキストと画像の出現順でつなぐ
	/// </summary>
	/// <param name="cellHtml">td または th の要素全体</param>
	/// <param name="resolveImageMarkup">画像 URL を挿入文字列へ変える。空ならその画像は捨てる</param>
	/// <returns>GFM セルとして安全な 1 行。改行は br にする</returns>
	private static string ConvertCell(string cellHtml, Func<string, string?> resolveImageMarkup)
	{
		string tagName = IsOpenTagAt(cellHtml, 0, "th") ? "th" : "td";
		if (!TryReadInner(cellHtml, tagName, out string inner))
		{
			inner = cellHtml;
		}

		// セル中の文字列と画像を出現順に走査し、画像だけを添付用Markdownへ差し替える
		List<string> pieces = [];
		int cursor          = 0;
		while (cursor < inner.Length)
		{
			int imageStart  = IndexOfNextImageTag(inner, cursor, out string imageTagName);
			int nestedStart = IndexOfOpenTag(inner, "table", cursor);
			if (nestedStart >= 0 && (imageStart < 0 || nestedStart < imageStart))
			{
				// 入れ子表を親セルの本文へ二重展開しないよう、その要素全体を読み飛ばす
				AppendCellText(pieces, inner[cursor..nestedStart]);
				if (TryReadElement(inner, nestedStart, "table", out _, out int nestedEnd))
				{
					cursor = nestedEnd;
					continue;
				}

				break;
			}

			if (imageStart < 0)
			{
				AppendCellText(pieces, inner[cursor..]);
				break;
			}

			AppendCellText(pieces, inner[cursor..imageStart]);
			if (!TryReadElement(inner, imageStart, imageTagName, out string imgHtml, out int imageEnd))
			{
				break;
			}

			string? source = ReadImageSource(imgHtml);
			if (!string.IsNullOrWhiteSpace(source))
			{
				string? markup = resolveImageMarkup(source);
				if (!string.IsNullOrEmpty(markup))
				{
					pieces.Add(markup);
				}
			}

			cursor = imageEnd;
		}

		return EscapeCell(string.Join("<br>", pieces.Where(static piece => piece.Length > 0)));
	}

	/// <summary>
	/// セル内の HTML をプレーンテキストにし、空でなければ断片へ足す
	/// </summary>
	/// <param name="pieces">セル内のテキストと画像マークアップ</param>
	/// <param name="html">まだタグを含むセルの一部</param>
	private static void AppendCellText(List<string> pieces, string html)
	{
		string text = NormalizePlainText(StripTagsToText(html));
		if (text.Length > 0)
		{
			pieces.Add(text);
		}
	}

	/// <summary>
	/// セルの水平・垂直配置。未指定は null のままとし、GFM へは center と right、middle と bottom だけを書く
	/// </summary>
	/// <param name="Align">水平配置。left、center、right。不明や未指定は null</param>
	/// <param name="Valign">垂直配置。top、middle、bottom。不明や未指定は null</param>
	private readonly record struct CellAlignment(string? Align, string? Valign);

	/// <summary>
	/// 結合と配置を、セル末尾の {colspan=2} 形式で表す。1 行 1 列で既定配置なら本文だけ
	/// </summary>
	/// <param name="cell">エスケープ済みのセル本文</param>
	/// <param name="colspan">横の結合数。1 以下は書かない</param>
	/// <param name="rowspan">縦の結合数。1 以下は書かない</param>
	/// <param name="align">水平配置。center と right だけを書く。null は書かない</param>
	/// <param name="valign">垂直配置。middle と bottom だけを書く。null は書かない</param>
	/// <returns>セル本文、または本文に続けた属性</returns>
	private static string FormatCellSpan(
		string cell,
		int colspan,
		int rowspan,
		string? align = null,
		string? valign = null)
	{
		List<string> parts = [];
		if (colspan > 1)
		{
			parts.Add("colspan=" + colspan.ToString(CultureInfo.InvariantCulture));
		}

		if (rowspan > 1)
		{
			parts.Add("rowspan=" + rowspan.ToString(CultureInfo.InvariantCulture));
		}

		if (align is "center" or "right")
		{
			parts.Add("align=" + align);
		}

		if (valign is "middle" or "bottom")
		{
			parts.Add("valign=" + valign);
		}

		return parts.Count == 0 ? cell : cell + "{" + string.Join(" ", parts) + "}";
	}

	/// <summary>
	/// セルの配置を、属性、style、CSS クラスの順で補完する。先に決まった軸は上書きしない
	/// </summary>
	/// <param name="cellHtml">td または th の要素</param>
	/// <param name="classAlignments">クラス名から配置。無ければ属性と style だけ</param>
	/// <returns>水平と垂直。決まらなかった軸は null</returns>
	private static CellAlignment ReadCellAlignment(
		string cellHtml,
		IReadOnlyDictionary<string, CellAlignment> classAlignments)
	{
		// セル直指定を優先し、不足分だけstyle、CSSクラスの順で補完する
		string? align = NormalizeAlign(ReadAttribute(cellHtml, "align"));
		string? valign = NormalizeValign(ReadAttribute(cellHtml, "valign"));
		string? style = ReadAttribute(cellHtml, "style");
		if (align is null)
		{
			align = NormalizeAlign(ReadCssDeclaration(style, "text-align"));
		}

		if (valign is null)
		{
			valign = NormalizeValign(ReadCssDeclaration(style, "vertical-align"));
		}

		if ((align is null || valign is null) && classAlignments.Count > 0)
		{
			foreach (string className in ReadClassNames(cellHtml))
			{
				if (!classAlignments.TryGetValue(className, out CellAlignment mapped))
				{
					continue;
				}

				align ??= mapped.Align;
				valign ??= mapped.Valign;
			}
		}

		return new CellAlignment(align, valign);
	}

	/// <summary>
	/// style 要素から、クラス名ごとの水平・垂直配置を集める。配置を持たない規則は捨てる
	/// </summary>
	/// <param name="html">style を含み得る HTML。表の外側も見る</param>
	/// <returns>クラス名をキーにした配置。同じクラスは後の宣言で欠けた軸だけを補う</returns>
	private static Dictionary<string, CellAlignment> ParseCssClassAlignments(string html)
	{
		Dictionary<string, CellAlignment> result = new(StringComparer.OrdinalIgnoreCase);
		foreach (Match block in StyleBlockPattern.Matches(html))
		{
			string css = block.Groups[1].Value
				.Replace("<!--", string.Empty, StringComparison.Ordinal)
				.Replace("-->", string.Empty, StringComparison.Ordinal);
			foreach (Match rule in CssRulePattern.Matches(css))
			{
				string selectors = rule.Groups["selectors"].Value;
				if (selectors.Contains('@', StringComparison.Ordinal))
				{
					continue;
				}

				string? align = NormalizeAlign(ReadCssDeclaration(rule.Groups["body"].Value, "text-align"));
				string? valign = NormalizeValign(ReadCssDeclaration(rule.Groups["body"].Value, "vertical-align"));
				if (align is null && valign is null)
				{
					continue;
				}

				foreach (Match classMatch in CssClassSelectorPattern.Matches(selectors))
				{
					string name = classMatch.Groups[1].Value;
					if (!result.TryGetValue(name, out CellAlignment existing))
					{
						result[name] = new CellAlignment(align, valign);
						continue;
					}

					result[name] = new CellAlignment(align ?? existing.Align, valign ?? existing.Valign);
				}
			}
		}

		return result;
	}

	/// <summary>
	/// 開始タグの class 属性を空白で分けて返す。無ければ空
	/// </summary>
	/// <param name="cellHtml">セル要素。開始タグより後ろの class は見ない</param>
	/// <returns>クラス名。空トークンは除く</returns>
	private static IEnumerable<string> ReadClassNames(string cellHtml)
	{
		string? raw = ReadAttribute(cellHtml, "class");
		if (string.IsNullOrWhiteSpace(raw))
		{
			yield break;
		}

		foreach (string token in raw.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries))
		{
			yield return token;
		}
	}

	/// <summary>
	/// CSS 宣言から指定したプロパティの値を取る。!important は除く
	/// </summary>
	/// <param name="css">宣言の列。null や空白は null</param>
	/// <param name="name">プロパティ名。大文字小文字は無視する</param>
	/// <returns>値。見つからなければ null</returns>
	private static string? ReadCssDeclaration(string? css, string name)
	{
		if (string.IsNullOrWhiteSpace(css))
		{
			return null;
		}

		Match match = Regex.Match(
			css,
			$@"(?:^|;)\s*{Regex.Escape(name)}\s*:\s*([^;]+)",
			RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
		if (!match.Success)
		{
			return null;
		}

		string raw = match.Groups[1].Value.Trim();
		int important = raw.IndexOf("!important", StringComparison.OrdinalIgnoreCase);
		return important >= 0 ? raw[..important].Trim() : raw;
	}

	/// <summary>
	/// 水平配置を left、center、right のどれかに揃える。未知と空白は未指定
	/// </summary>
	/// <param name="value">align または text-align の値。end は right、start と justify は left</param>
	/// <returns>left、center、right。該当しなければ null</returns>
	private static string? NormalizeAlign(string? value)
	{
		if (string.IsNullOrWhiteSpace(value))
		{
			return null;
		}

		string lower = value.Trim().ToLowerInvariant();
		return lower switch
		{
			"center" => "center",
			"right" or "end" => "right",
			"left" or "justify" or "start" => "left",
			_ => null,
		};
	}

	/// <summary>
	/// 垂直配置を top、middle、bottom のどれかに揃える。未知と空白は未指定
	/// </summary>
	/// <param name="value">valign または vertical-align の値。center は middle、baseline は top</param>
	/// <returns>top、middle、bottom。該当しなければ null</returns>
	private static string? NormalizeValign(string? value)
	{
		if (string.IsNullOrWhiteSpace(value))
		{
			return null;
		}

		string lower = value.Trim().ToLowerInvariant();
		return lower switch
		{
			"middle" or "center" => "middle",
			"bottom" => "bottom",
			"top" or "baseline" => "top",
			_ => null,
		};
	}

	/// <summary>
	/// 指定行までグリッドの行を足す。既存行は消さない
	/// </summary>
	/// <param name="grid">行ごとのセル。未使用は null</param>
	/// <param name="row">必要な行番号。0 始まり</param>
	private static void EnsureGridRow(List<List<string?>> grid, int row)
	{
		while (grid.Count <= row)
		{
			grid.Add([]);
		}
	}

	/// <summary>
	/// 結合で既に予約されたセルかを返す。範囲外は空いている
	/// </summary>
	/// <param name="grid">展開中のグリッド</param>
	/// <param name="row">行番号。0 始まり</param>
	/// <param name="column">列番号。0 始まり</param>
	/// <returns>その座標に値が入っていれば true</returns>
	private static bool CellTaken(List<List<string?>> grid, int row, int column)
	{
		return row < grid.Count && column < grid[row].Count && grid[row][column] is not null;
	}

	/// <summary>
	/// 結合範囲の起点へ本文を置き、残りの座標は空文字で予約して後続セルをずらす
	/// </summary>
	/// <param name="grid">書き込むグリッド</param>
	/// <param name="row">起点の行。0 始まり</param>
	/// <param name="column">起点の列。0 始まり</param>
	/// <param name="text">起点に書く本文。属性付きでもよい</param>
	/// <param name="colspan">横の幅。1 以上</param>
	/// <param name="rowspan">縦の高さ。1 以上</param>
	private static void PlaceSpannedCell(
		List<List<string?>> grid,
		int row,
		int column,
		string text,
		int colspan,
		int rowspan)
	{
		// 起点だけに内容を置き、結合範囲の残りは空文字で予約して後続セルをずらす
		for (int rowOffset = 0; rowOffset < rowspan; rowOffset++)
		{
			EnsureGridRow(grid, row + rowOffset);
			List<string?> line = grid[row + rowOffset];
			while (line.Count < column + colspan)
			{
				line.Add(null);
			}

			for (int colOffset = 0; colOffset < colspan; colOffset++)
			{
				bool origin = rowOffset == 0 && colOffset == 0;
				if (line[column + colOffset] is null)
				{
					line[column + colOffset] = origin ? text : string.Empty;
				}
			}
		}
	}

	// ==============================================
	// GFM の出力
	// ==============================================

	/// <summary>
	/// 行を、空ヘッダと区切り線を付けた GFM 表にする。短い行は空セルで最大列数まで埋める
	/// </summary>
	/// <param name="rows">セル文字列の行。列数は揃っていなくてよい</param>
	/// <returns>Markdown 表。行が空なら空文字。末尾改行は除く</returns>
	private static string RenderGfmTable(List<List<string>> rows)
	{
		int columns = rows.Count == 0 ? 0 : rows.Max(static row => row.Count);
		if (columns == 0)
		{
			return string.Empty;
		}

		// GFMは全行の列数が揃う必要があるため、最大列数まで空セルで埋める
		foreach (List<string> row in rows)
		{
			while (row.Count < columns)
			{
				row.Add(string.Empty);
			}
		}

		string header = "|" + string.Join("|", Enumerable.Repeat("   ", columns)) + "|";
		string separator = "|" + string.Join("|", Enumerable.Repeat("---", columns)) + "|";
		StringBuilder builder = new();
		builder.Append(header);
		builder.Append('\n');
		builder.Append(separator);
		builder.Append('\n');
		foreach (List<string> row in rows)
		{
			builder.Append('|');
			builder.Append(string.Join("|", row));
			builder.Append("|\n");
		}

		return builder.ToString().TrimEnd();
	}

	/// <summary>
	/// セル内の改行を br にし、まだエスケープされていない | の前へバックスラッシュを付ける
	/// </summary>
	/// <param name="value">セル本文。前後の空白は除く</param>
	/// <returns>GFM の 1 セルに入れられる文字列</returns>
	private static string EscapeCell(string value)
	{
		string normalized = value
			.Replace("\r\n", "\n", StringComparison.Ordinal)
			.Replace('\r', '\n')
			.Replace("\n", "<br>", StringComparison.Ordinal);
		StringBuilder builder = new(normalized.Length + 8);
		for (int index = 0; index < normalized.Length; index++)
		{
			char character = normalized[index];
			if (character == '|')
			{
				// 既に奇数本のバックスラッシュでエスケープ済みなら、重ねて追加しない
				int slashes = 0;
				for (int cursor = index - 1; cursor >= 0 && normalized[cursor] == '\\'; cursor--)
				{
					slashes++;
				}

				if (slashes % 2 == 0)
				{
					builder.Append('\\');
				}
			}

			builder.Append(character);
		}

		return builder.ToString().Trim();
	}

	// ==============================================
	// HTML の走査
	// ==============================================

	/// <summary>
	/// 画像要素から、元 URL を data-original、data-src、src、o:href の順で読む
	/// </summary>
	/// <param name="imgHtml">img または v:imagedata の要素</param>
	/// <returns>最初に見つかった URL。どれも空なら null</returns>
	private static string? ReadImageSource(string imgHtml)
	{
		foreach (string name in new[] { "data-original", "data-src", "src", "o:href" })
		{
			string? value = ReadAttribute(imgHtml, name);
			if (!string.IsNullOrWhiteSpace(value))
			{
				return value;
			}
		}

		return null;
	}

	/// <summary>
	/// 次の img または v:imagedata の開始位置を返す。より手前にある方を採用する
	/// </summary>
	/// <param name="html">探す HTML</param>
	/// <param name="start">探索開始の文字位置</param>
	/// <param name="name">見つかったタグ名。無ければ空文字</param>
	/// <returns>開始位置。無ければ -1</returns>
	private static int IndexOfNextImageTag(string html, int start, out string name)
	{
		name = string.Empty;
		int img = IndexOfOpenTag(html, "img", start);
		int vml = IndexOfOpenTag(html, "v:imagedata", start);
		if (img < 0 && vml < 0)
		{
			return -1;
		}

		if (img >= 0 && (vml < 0 || img <= vml))
		{
			name = "img";
			return img;
		}

		name = "v:imagedata";
		return vml;
	}

	/// <summary>
	/// 開始タグの正の整数属性を読む。読めなければ 1 として結合無し扱いにする
	/// </summary>
	/// <param name="tagHtml">属性を含む要素または開始タグ</param>
	/// <param name="name">colspan や rowspan などの属性名</param>
	/// <returns>読めた整数。不正なら 1</returns>
	private static int ReadPositiveAttribute(string tagHtml, string name)
	{
		string? raw = ReadAttribute(tagHtml, name);
		return int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out int value)
			? value
			: 1;
	}

	/// <summary>
	/// 最初の &gt; より前から属性値を読み、HTML デコードする
	/// </summary>
	/// <param name="html">要素または開始タグ</param>
	/// <param name="name">属性名。大文字小文字は無視する</param>
	/// <returns>デコードした値。無ければ null</returns>
	private static string? ReadAttribute(string html, string name)
	{
		int tagEnd = html.IndexOf('>');
		string open = tagEnd >= 0 ? html[..(tagEnd + 1)] : html;
		Regex pattern = new(
			$@"{Regex.Escape(name)}\s*=\s*(?:""([^""]*)""|'([^']*)'|([^\s>]+))",
			RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
		Match match = pattern.Match(open);
		if (!match.Success)
		{
			return null;
		}

		string raw = match.Groups[1].Success
			? match.Groups[1].Value
			: match.Groups[2].Success
				? match.Groups[2].Value
				: match.Groups[3].Value;
		return WebUtility.HtmlDecode(raw.Trim());
	}

	/// <summary>
	/// 入れ子 table の外側にある指定タグの要素だけを、出現順に返す
	/// </summary>
	/// <param name="html">親要素の内側</param>
	/// <param name="names">集めるタグ名。tr、td、th など</param>
	/// <returns>要素全体の文字列。入れ子の中は含めない</returns>
	private static List<string> FindElementsOutsideNestedTables(string html, params string[] names)
	{
		List<string> found = [];
		int cursor         = 0;
		// 親表の行・セルだけを返すため、入れ子table内では対象タグを収集しない
		int nestedTables   = 0;
		while (cursor < html.Length)
		{
			if (StartsWithComment(html, cursor, out int commentEnd))
			{
				cursor = commentEnd;
				continue;
			}

			if (nestedTables == 0)
			{
				foreach (string name in names)
				{
					if (IsOpenTagAt(html, cursor, name))
					{
						if (TryReadElement(html, cursor, name, out string element, out int end))
						{
							found.Add(element);
							cursor = end;
							goto Next;
						}
					}
				}
			}

			if (IsOpenTagAt(html, cursor, "table"))
			{
				nestedTables++;
				cursor = SkipOpenTag(html, cursor);
				continue;
			}

			if (IsCloseTagAt(html, cursor, "table"))
			{
				nestedTables = Math.Max(0, nestedTables - 1);
				cursor       = SkipCloseTag(html, cursor);
				continue;
			}

			cursor++;
			Next:
			;
		}

		return found;
	}

	/// <summary>
	/// 要素の開始タグと対応する閉じタグの間を返す。自己終了なら空文字で成功
	/// </summary>
	/// <param name="elementHtml">要素全体。名前が null なら最後の閉じタグまで</param>
	/// <param name="name">タグ名。null なら名前を限定しない</param>
	/// <param name="inner">内側。開始タグが無ければ空文字で失敗</param>
	/// <returns>開始タグがあれば true</returns>
	private static bool TryReadInner(string elementHtml, string? name, out string inner)
	{
		inner = string.Empty;
		int openEnd = elementHtml.IndexOf('>');
		if (openEnd < 0)
		{
			return false;
		}

		if (name is not null && IsSelfClosing(elementHtml[..(openEnd + 1)], name))
		{
			return true;
		}

		int closeStart = name is null
			? elementHtml.LastIndexOf("</", StringComparison.Ordinal)
			: elementHtml.LastIndexOf("</" + name, StringComparison.OrdinalIgnoreCase);
		if (closeStart <= openEnd)
		{
			inner = elementHtml[(openEnd + 1)..];
			return true;
		}

		inner = elementHtml[(openEnd + 1)..closeStart];
		return true;
	}

	/// <summary>
	/// 同じ名前の入れ子を深さで追い、対応する閉じタグまでの 1 要素を返す
	/// </summary>
	/// <param name="html">探す HTML</param>
	/// <param name="start">開始タグの位置</param>
	/// <param name="name">タグ名。img と imagedata は開始タグだけで終える</param>
	/// <param name="element">要素全体。失敗時は空文字。閉じタグが無くても残りがあれば返す</param>
	/// <param name="end">要素の次の位置。失敗して中身も無ければ start のまま</param>
	/// <returns>開始タグがあり、要素として取り出せれば true</returns>
	private static bool TryReadElement(string html, int start, string name, out string element, out int end)
	{
		element = string.Empty;
		end     = start;
		if (!IsOpenTagAt(html, start, name))
		{
			return false;
		}

		int openEnd = html.IndexOf('>', start);
		if (openEnd < 0)
		{
			return false;
		}

		if (name.Equals("img", StringComparison.OrdinalIgnoreCase)
			|| name.EndsWith("imagedata", StringComparison.OrdinalIgnoreCase)
			|| html[openEnd - 1] == '/'
			|| IsSelfClosing(html[start..(openEnd + 1)], name))
		{
			end     = openEnd + 1;
			element = html[start..end];
			return true;
		}

		// 同名要素の入れ子を深さで追跡し、対応する閉じタグまでを1要素として返す
		int depth  = 1;
		int cursor = openEnd + 1;
		while (cursor < html.Length)
		{
			if (StartsWithComment(html, cursor, out int commentEnd))
			{
				cursor = commentEnd;
				continue;
			}

			if (IsOpenTagAt(html, cursor, name))
			{
				depth++;
				cursor = SkipOpenTag(html, cursor);
				continue;
			}

			if (IsCloseTagAt(html, cursor, name))
			{
				depth--;
				int closeEnd = SkipCloseTag(html, cursor);
				if (depth == 0)
				{
					end     = closeEnd;
					element = html[start..end];
					return true;
				}

				cursor = closeEnd;
				continue;
			}

			cursor++;
		}

		end     = html.Length;
		element = html[start..];
		return element.Length > 0;
	}

	/// <summary>
	/// コメントを飛ばしながら、次の開始タグの位置を返す
	/// </summary>
	/// <param name="html">探す HTML</param>
	/// <param name="name">タグ名</param>
	/// <param name="start">探索開始の文字位置</param>
	/// <returns>開始位置。無ければ -1</returns>
	private static int IndexOfOpenTag(string html, string name, int start)
	{
		for (int index = start; index < html.Length; index++)
		{
			if (IsOpenTagAt(html, index, name))
			{
				return index;
			}

			if (StartsWithComment(html, index, out int commentEnd))
			{
				index = commentEnd - 1;
			}
		}

		return -1;
	}

	/// <summary>
	/// その位置が、指定名の開始タグかを返す。閉じタグ、コメント、処理指令は開始にしない
	/// </summary>
	/// <param name="html">調べる HTML</param>
	/// <param name="index">&lt; があるべき文字位置</param>
	/// <param name="name">タグ名。直後が空白、&gt;、/ で終わる必要がある</param>
	/// <returns>開始タグなら true</returns>
	private static bool IsOpenTagAt(string html, int index, string name)
	{
		if (index >= html.Length || html[index] != '<')
		{
			return false;
		}

		if (index + 1 < html.Length && (html[index + 1] == '/' || html[index + 1] == '!' || html[index + 1] == '?'))
		{
			return false;
		}

		return MatchesTagName(html, index + 1, name);
	}

	/// <summary>
	/// その位置が、指定名の閉じタグかを返す
	/// </summary>
	/// <param name="html">調べる HTML</param>
	/// <param name="index">&lt;/ があるべき文字位置</param>
	/// <param name="name">タグ名</param>
	/// <returns>閉じタグなら true</returns>
	private static bool IsCloseTagAt(string html, int index, string name)
	{
		if (index + 1 >= html.Length || html[index] != '<' || html[index + 1] != '/')
		{
			return false;
		}

		return MatchesTagName(html, index + 2, name);
	}

	/// <summary>
	/// タグ名が一致し、名前の直後がタグの区切り文字かを返す
	/// </summary>
	/// <param name="html">調べる HTML</param>
	/// <param name="nameStart">名前の開始位置。&lt; の次</param>
	/// <param name="name">期待するタグ名。大文字小文字は無視する</param>
	/// <returns>名前が完全一致し、続きが空白、&gt;、/、または終端なら true</returns>
	private static bool MatchesTagName(string html, int nameStart, string name)
	{
		if (nameStart + name.Length > html.Length)
		{
			return false;
		}

		if (!html.AsSpan(nameStart, name.Length).Equals(name, StringComparison.OrdinalIgnoreCase))
		{
			return false;
		}

		int after = nameStart + name.Length;
		if (after >= html.Length)
		{
			return true;
		}

		char next = html[after];
		return char.IsWhiteSpace(next) || next is '>' or '/';
	}

	/// <summary>
	/// 空要素、または末尾が /&gt; の開始タグかを返す
	/// </summary>
	/// <param name="openTag">開始タグの文字列</param>
	/// <param name="name">タグ名。img、imagedata、br、col は常に自己終了</param>
	/// <returns>内側を持たないタグなら true</returns>
	private static bool IsSelfClosing(string openTag, string name)
	{
		if (name.Equals("img", StringComparison.OrdinalIgnoreCase)
			|| name.EndsWith("imagedata", StringComparison.OrdinalIgnoreCase)
			|| name.Equals("br", StringComparison.OrdinalIgnoreCase)
			|| name.Equals("col", StringComparison.OrdinalIgnoreCase))
		{
			return true;
		}

		int lastSlash = openTag.LastIndexOf('/');
		int lastClose = openTag.LastIndexOf('>');
		return lastSlash >= 0 && lastClose == lastSlash + 1;
	}

	/// <summary>
	/// 開始タグの &gt; の次へ進む。&gt; が無ければ終端
	/// </summary>
	/// <param name="html">HTML</param>
	/// <param name="start">タグの開始位置</param>
	/// <returns>&gt; の次、または文字列長</returns>
	private static int SkipOpenTag(string html, int start)
	{
		int end = html.IndexOf('>', start);
		return end < 0 ? html.Length : end + 1;
	}

	/// <summary>
	/// 閉じタグの &gt; の次へ進む。開始タグと同じく &gt; を探す
	/// </summary>
	/// <param name="html">HTML</param>
	/// <param name="start">閉じタグの開始位置</param>
	/// <returns>&gt; の次、または文字列長</returns>
	private static int SkipCloseTag(string html, int start)
	{
		return SkipOpenTag(html, start);
	}

	/// <summary>
	/// その位置が HTML コメントなら、コメントの終わりを返す。閉じが無ければ終端までコメントとみなす
	/// </summary>
	/// <param name="html">HTML</param>
	/// <param name="index">&lt;! があるべき位置</param>
	/// <param name="end">コメントの次。コメントでなければ index のまま</param>
	/// <returns>&lt;! で始まるなら true</returns>
	private static bool StartsWithComment(string html, int index, out int end)
	{
		end = index;
		if (index + 3 >= html.Length || html[index] != '<' || html[index + 1] != '!')
		{
			return false;
		}

		int close = html.IndexOf("-->", index, StringComparison.Ordinal);
		if (close < 0)
		{
			end = html.Length;
			return true;
		}

		end = close + 3;
		return true;
	}

	/// <summary>
	/// style と script を除き、改行相当のタグだけを改行として残してテキストにする
	/// </summary>
	/// <param name="html">タグを含み得る文字列。空はそのまま</param>
	/// <returns>HTML デコードしたプレーンテキスト</returns>
	private static string StripTagsToText(string html)
	{
		if (string.IsNullOrEmpty(html))
		{
			return string.Empty;
		}

		// HTMLパーサーを使わず、表示に不要なstyle/scriptを除外しつつ改行相当タグだけ保存する
		StringBuilder builder = new(html.Length);
		int cursor            = 0;
		while (cursor < html.Length)
		{
			if (StartsWithComment(html, cursor, out int commentEnd))
			{
				cursor = commentEnd;
				continue;
			}

			if (html[cursor] == '<')
			{
				if (IsOpenTagAt(html, cursor, "style")
					&& TryReadElement(html, cursor, "style", out _, out int styleEnd))
				{
					cursor = styleEnd;
					continue;
				}

				if (IsOpenTagAt(html, cursor, "script")
					&& TryReadElement(html, cursor, "script", out _, out int scriptEnd))
				{
					cursor = scriptEnd;
					continue;
				}

				int tagEnd = html.IndexOf('>', cursor);
				if (tagEnd < 0)
				{
					break;
				}

				string tag = html[cursor..(tagEnd + 1)];
				if (IsBreakishTag(tag))
				{
					builder.Append('\n');
				}

				cursor = tagEnd + 1;
				continue;
			}

			builder.Append(html[cursor]);
			cursor++;
		}

		return WebUtility.HtmlDecode(builder.ToString());
	}

	/// <summary>
	/// 表示上の改行として残すタグかを返す
	/// </summary>
	/// <param name="tag">&gt; までを含むタグ文字列</param>
	/// <returns>br、p、div、tr、li の開始、または p と div と tr の閉じなら true</returns>
	private static bool IsBreakishTag(string tag)
	{
		return tag.StartsWith("<br", StringComparison.OrdinalIgnoreCase)
			|| tag.StartsWith("<p", StringComparison.OrdinalIgnoreCase)
			|| tag.StartsWith("</p", StringComparison.OrdinalIgnoreCase)
			|| tag.StartsWith("<div", StringComparison.OrdinalIgnoreCase)
			|| tag.StartsWith("</div", StringComparison.OrdinalIgnoreCase)
			|| tag.StartsWith("<tr", StringComparison.OrdinalIgnoreCase)
			|| tag.StartsWith("</tr", StringComparison.OrdinalIgnoreCase)
			|| tag.StartsWith("<li", StringComparison.OrdinalIgnoreCase);
	}

	/// <summary>
	/// 連続する空白と 3 行以上の改行を詰め、前後を除く。ノーブレークスペースは空白にする
	/// </summary>
	/// <param name="text">タグ除去後のテキスト</param>
	/// <returns>表示用に詰めたテキスト</returns>
	private static string NormalizePlainText(string text)
	{
		string normalized = Regex.Replace(text.Replace('\u00a0', ' '), @"[ \t]+\n", "\n");
		normalized = Regex.Replace(normalized, @"\n{3,}", "\n\n");
		normalized = Regex.Replace(normalized, @"[ \t]{2,}", " ");
		return normalized.Trim();
	}

	/// <summary>
	/// CF_HTML のオフセットで範囲を切る。バイト位置を優先し、収まらなければ文字位置も試す
	/// </summary>
	/// <param name="clipboardHtml">ヘッダ付きのクリップボード HTML</param>
	/// <param name="startKey">開始キー。StartFragment や StartHTML</param>
	/// <param name="endKey">終了キー。対応する End</param>
	/// <param name="slice">切り出した文字列。失敗時は空文字</param>
	/// <returns>範囲が取れて中身があれば true</returns>
	private static bool TrySliceUtf8Range(string clipboardHtml, string startKey, string endKey, out string slice)
	{
		slice = string.Empty;
		Dictionary<string, int> offsets = [];
		foreach (Match match in CfHtmlOffsetPattern.Matches(clipboardHtml))
		{
			offsets[match.Groups[1].Value] = int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture);
		}

		if (!offsets.TryGetValue(startKey, out int start) || !offsets.TryGetValue(endKey, out int end)
			|| start < 0 || end <= start)
		{
			return false;
		}

		// 仕様どおりのUTF-8バイト位置を優先し、非準拠アプリの文字位置指定も救済する
		byte[] bytes = Encoding.UTF8.GetBytes(clipboardHtml);
		if (end <= bytes.Length)
		{
			slice = Encoding.UTF8.GetString(bytes, start, end - start);
			return slice.Length > 0;
		}

		if (end <= clipboardHtml.Length)
		{
			slice = clipboardHtml[start..end];
			return slice.Length > 0;
		}

		return false;
	}

	/// <summary>
	/// Version: で始まる CF_HTML ヘッダを除き、最初の &lt; 以降を返す
	/// </summary>
	/// <param name="clipboardHtml">ヘッダ付き、または既に HTML の文字列</param>
	/// <returns>HTML。Version: で始まらなければ引数のまま</returns>
	private static string StripCfHtmlHeader(string clipboardHtml)
	{
		if (!clipboardHtml.StartsWith("Version:", StringComparison.OrdinalIgnoreCase))
		{
			return clipboardHtml;
		}

		int htmlStart = clipboardHtml.IndexOf('<');
		return htmlStart >= 0 ? clipboardHtml[htmlStart..] : clipboardHtml;
	}
}
