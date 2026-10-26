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
		// 空白だけの入力は表を含まないので、切り出さず空文字を返す
		if (string.IsNullOrWhiteSpace(clipboardHtml))
		{
			return string.Empty;
		}

		// CF_HTMLのオフセットはUTF-8バイト基準なので、文字インデックスより先に正規手順で切り出す
		// 範囲の切り出しに成功し、かつ中身があるときだけその断片を返す。失敗か空なら入らない
		if (TrySliceUtf8Range(clipboardHtml, "StartFragment", "EndFragment", out string fragment)
			&& fragment.Length > 0)
		{
			return fragment;
		}

		// オフセット不正な生成元向けに、仕様上のコメントマーカーへフォールバックする
		// 断片開始印の位置。無ければ -1 で範囲に使わない
		int markerStart = clipboardHtml.IndexOf("<!--StartFragment-->", StringComparison.OrdinalIgnoreCase);
		// 断片終了印の位置。開始より前なら範囲として使わない
		int markerEnd   = clipboardHtml.IndexOf("<!--EndFragment-->", StringComparison.OrdinalIgnoreCase);
		// 開始と終了が両方見つかり、終了が開始より後ろのときだけ印の内側を返す。一方が欠けても入らない
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
		// 空白だけの入力は文書が無いので空文字を返す
		if (string.IsNullOrWhiteSpace(clipboardHtml))
		{
			return string.Empty;
		}

		// 文書の開始と終了が両方取れ、かつ中身があるときだけその範囲を返す。失敗か空なら入らない
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
		// ヘッダ外側を含む文書。取れなければヘッダ除去後で、空のこともある
		string document = ExtractHtmlDocument(clipboardHtml);
		// 断片。table 開始が断片の外にあるときは中身が空に近いことがある
		string fragment = ExtractFragment(clipboardHtml);
		// ExcelはFragment外にtable開始タグを置くことがあるため、文書全体から優先して探す
		foreach (string candidate in new[] { document, fragment, clipboardHtml })
		{
			// table 開始がある候補だけを変換元にする。無ければ次の候補へ進む
			if (IndexOfOpenTag(candidate, "table", 0) >= 0)
			{
				return candidate;
			}
		}

		foreach (string candidate in new[] { fragment, document, clipboardHtml })
		{
			// 行、セル、見出しセルのどれかがあれば table で包む。三つとも無ければ入らない
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
		// 表を探す基準の HTML。table も行も無ければ文書か断片で、空なら表は無い
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
		// 空白だけのテキストは表にしないので空文字を返す
		if (string.IsNullOrWhiteSpace(text))
		{
			return string.Empty;
		}

		// 改行を LF に揃えた本文。空行の判定はこの文字列で行う
		string normalized = text.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n');
		// タブで分けた行。先頭の空行は入れず、末尾の空行は後で捨てる
		List<List<string>> rows = [];
		foreach (string line in normalized.Split('\n'))
		{
			// 最初の行が空ならヘッダ前の空行として捨てる。行が既にあれば空行も残す。どちらかが欠けても入らない
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
		// 表を探す基準の HTML。table が無ければ空文字を返す
		string source = NormalizeTableSource(html);
		// table 開始が無い HTML は変換対象が無いので空文字を返す
		if (IndexOfOpenTag(source, "table", 0) < 0)
		{
			return string.Empty;
		}

		// 表の前後にある説明文も捨てず、変換済み表と同じ出力順で連結する
		List<string> parts = [];
		// 未処理の開始位置。表を読み終えるたびにその終端へ進む
		int cursor         = 0;
		while (cursor < source.Length)
		{
			// 次の table 開始。無ければ -1 で残りを本文にする
			int tableStart = IndexOfOpenTag(source, "table", cursor);
			// これ以降に table が無いので、残りを本文にして走査を終える
			if (tableStart < 0)
			{
				AppendPlainText(parts, source[cursor..]);
				break;
			}

			// 表の前に本文があるときだけ、その区間を部品へ足す。直後から始まる表では入らない
			if (tableStart > cursor)
			{
				AppendPlainText(parts, source[cursor..tableStart]);
			}

			// 閉じタグまで読めない壊れた table は、残りを本文にして走査を終える
			if (!TryReadElement(source, tableStart, "table", out string tableHtml, out int tableEnd))
			{
				AppendPlainText(parts, source[tableStart..]);
				break;
			}

			// 1 つの table を変換した Markdown。中身を読めなければ空で部品に足さない
			string markdown = ConvertTable(tableHtml, resolveImageMarkup, ParseCssClassAlignments(source));
			// 変換結果に文字があるときだけ部品へ足す。空の表は捨てる
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
		// タグを除いて詰めた本文。空白だけなら空で部品に足さない
		string text = NormalizePlainText(StripTagsToText(html));
		// 本文が残っているときだけ部品へ足す
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
		// 内側を読めない table は表にしない
		if (!TryReadInner(tableHtml, "table", out string inner))
		{
			return string.Empty;
		}

		// rowspan/colspanで先に占有される座標を扱えるよう、可変の二次元グリッドへ展開する
		// 未使用の座標は null。結合の予約は空文字
		List<List<string?>> grid = [];
		// 今展開している行。0 始まり。行を読み終えるたびに 1 進む
		int rowIndex = 0;
		foreach (string rowHtml in FindElementsOutsideNestedTables(inner, "tr"))
		{
			// 内側を読めない行は飛ばし、行番号も進めない
			if (!TryReadInner(rowHtml, "tr", out string rowInner))
			{
				continue;
			}

			EnsureGridRow(grid, rowIndex);
			// 次に置く列。結合で埋まっていれば空きまで進む。0 始まり
			int column = 0;
			foreach (string cellHtml in FindElementsOutsideNestedTables(rowInner, "td", "th"))
			{
				while (CellTaken(grid, rowIndex, column))
				{
					column++;
				}

				// 横の結合数。読めなければ 1 で結合なし
				int colspan = Math.Max(1, ReadPositiveAttribute(cellHtml, "colspan"));
				// 縦の結合数。読めなければ 1 で結合なし
				int rowspan = Math.Max(1, ReadPositiveAttribute(cellHtml, "rowspan"));
				// 画像とテキストを出現順につないだセル本文
				string cell = ConvertCell(cellHtml, resolveImageMarkup);
				// 属性、style、クラスの順で補完した配置。決まらなかった軸は null
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

		// null を空文字にした行。セルが無い行は除く。0 件なら空の表
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
		// th で始まらなければ td として内側を読む
		string tagName = IsOpenTagAt(cellHtml, 0, "th") ? "th" : "td";
		// 内側を読めなければ要素全体を本文として扱う
		if (!TryReadInner(cellHtml, tagName, out string inner))
		{
			inner = cellHtml;
		}

		// セル中の文字列と画像を出現順に走査し、画像だけを添付用Markdownへ差し替える
		List<string> pieces = [];
		// 未処理の開始位置。画像か入れ子表を読み終えるたびにその終端へ進む
		int cursor          = 0;
		while (cursor < inner.Length)
		{
			// 次の画像開始。無ければ -1 で残りはテキスト
			int imageStart  = IndexOfNextImageTag(inner, cursor, out string imageTagName);
			// 次の入れ子 table。無ければ -1
			int nestedStart = IndexOfOpenTag(inner, "table", cursor);
			// 入れ子表があり、画像より手前か画像が無いときだけ表を読み飛ばす。表が無ければ入らない
			if (nestedStart >= 0 && (imageStart < 0 || nestedStart < imageStart))
			{
				// 入れ子表を親セルの本文へ二重展開しないよう、その要素全体を読み飛ばす
				AppendCellText(pieces, inner[cursor..nestedStart]);
				// 閉じまで読めた入れ子は終端へ進む。読めなければ走査を止める
				if (TryReadElement(inner, nestedStart, "table", out _, out int nestedEnd))
				{
					cursor = nestedEnd;
					continue;
				}

				break;
			}

			// これ以降に画像が無いので、残りをテキストにして終える
			if (imageStart < 0)
			{
				AppendCellText(pieces, inner[cursor..]);
				break;
			}

			AppendCellText(pieces, inner[cursor..imageStart]);
			// 画像要素を取り出せなければ、壊れたタグとして走査を止める
			if (!TryReadElement(inner, imageStart, imageTagName, out string imgHtml, out int imageEnd))
			{
				break;
			}

			// 画像の元 URL。どれも空なら null でその画像は捨てる
			string? source = ReadImageSource(imgHtml);
			// URL があるときだけ挿入文字列へ変える。空の URL では入らない
			if (!string.IsNullOrWhiteSpace(source))
			{
				// 呼び出し元が返した挿入文字列。null や空ならその画像は捨てる
				string? markup = resolveImageMarkup(source);
				// 空でない挿入文字列だけセルへ足す
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
		// タグを除いて詰めたセル断片。空白だけなら空で足さない
		string text = NormalizePlainText(StripTagsToText(html));
		// 文字が残っているときだけ断片へ足す
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
		// セル末尾へ書く属性。1 行 1 列で既定配置なら空のまま本文だけ
		List<string> parts = [];
		// 横結合が 2 以上のときだけ書く。1 以下は結合なしとして入れない
		if (colspan > 1)
		{
			parts.Add("colspan=" + colspan.ToString(CultureInfo.InvariantCulture));
		}

		// 縦結合が 2 以上のときだけ書く
		if (rowspan > 1)
		{
			parts.Add("rowspan=" + rowspan.ToString(CultureInfo.InvariantCulture));
		}

		// center と right だけを書く。left と null は既定なので入れない
		if (align is "center" or "right")
		{
			parts.Add("align=" + align);
		}

		// middle と bottom だけを書く。top と null は既定なので入れない
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
		// 属性の水平配置。未指定や未知は null で、style へ進む
		string? align = NormalizeAlign(ReadAttribute(cellHtml, "align"));
		// 属性の垂直配置。未指定や未知は null
		string? valign = NormalizeValign(ReadAttribute(cellHtml, "valign"));
		// style 属性。無ければ null で宣言は読まない
		string? style = ReadAttribute(cellHtml, "style");
		// 属性で水平が決まっていないときだけ text-align を見る
		if (align is null)
		{
			align = NormalizeAlign(ReadCssDeclaration(style, "text-align"));
		}

		// 属性で垂直が決まっていないときだけ vertical-align を見る
		if (valign is null)
		{
			valign = NormalizeValign(ReadCssDeclaration(style, "vertical-align"));
		}

		// どちらかの軸が未定で、かつクラス配置があるときだけクラスを見る。両方決まっているかクラスが空なら入らない
		if ((align is null || valign is null) && classAlignments.Count > 0)
		{
			foreach (string className in ReadClassNames(cellHtml))
			{
				// このクラスに配置が無ければ次のクラスへ進む
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
		// クラス名から配置。同じクラスは後の宣言で欠けた軸だけを補う
		Dictionary<string, CellAlignment> result = new(StringComparer.OrdinalIgnoreCase);
		foreach (Match block in StyleBlockPattern.Matches(html))
		{
			// コメント印を除いた CSS。配置を持たない規則は捨てる
			string css = block.Groups[1].Value
				.Replace("<!--", string.Empty, StringComparison.Ordinal)
				.Replace("-->", string.Empty, StringComparison.Ordinal);
			foreach (Match rule in CssRulePattern.Matches(css))
			{
				// セレクタ部。@ 規則はクラス配置にしない
				string selectors = rule.Groups["selectors"].Value;
				// メディアクエリなどの @ 規則はクラス配置として読まない
				if (selectors.Contains('@', StringComparison.Ordinal))
				{
					continue;
				}

				// この規則の水平配置。未知は null
				string? align = NormalizeAlign(ReadCssDeclaration(rule.Groups["body"].Value, "text-align"));
				// この規則の垂直配置。未知は null
				string? valign = NormalizeValign(ReadCssDeclaration(rule.Groups["body"].Value, "vertical-align"));
				// どちらの軸も無い規則は捨てる。片方だけでも残す
				if (align is null && valign is null)
				{
					continue;
				}

				foreach (Match classMatch in CssClassSelectorPattern.Matches(selectors))
				{
					// セレクタに現れたクラス名。要素セレクタは取らない
					string name = classMatch.Groups[1].Value;
					// 初出のクラスは、この規則の配置をそのまま入れる
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
		// class 属性。無いか空白ならクラスは空
		string? raw = ReadAttribute(cellHtml, "class");
		// クラス属性が無い、または空白だけのセルはクラス配置を見ない
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
		// 宣言が無い style は値も無い
		if (string.IsNullOrWhiteSpace(css))
		{
			return null;
		}

		// 指定プロパティの一致。見つからなければ Success は false
		Match match = Regex.Match(
			css,
			$@"(?:^|;)\s*{Regex.Escape(name)}\s*:\s*([^;]+)",
			RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
		// そのプロパティが宣言に無いときは未指定
		if (!match.Success)
		{
			return null;
		}

		// セミコロン手前の値。前後の空白は除く
		string raw = match.Groups[1].Value.Trim();
		// !important の位置。無ければ -1 で値全体を返す
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
		// 空白は水平配置が未指定
		if (string.IsNullOrWhiteSpace(value))
		{
			return null;
		}

		// 比較用に空白を除き小文字にした値
		string lower = value.Trim().ToLowerInvariant();
		return lower switch
		{
			// 中央はそのまま
			"center" => "center",
			// right と end は右寄せに揃える
			"right" or "end" => "right",
			// left、両端揃え、start は左寄せに揃える
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
		// 空白は垂直配置が未指定
		if (string.IsNullOrWhiteSpace(value))
		{
			return null;
		}

		// 比較用に空白を除き小文字にした値
		string lower = value.Trim().ToLowerInvariant();
		return lower switch
		{
			// middle と center は中央寄せに揃える
			"middle" or "center" => "middle",
			// 下寄せ
			"bottom" => "bottom",
			// top と baseline は上寄せに揃える
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
			// この行のセル列。足りない列は null の空きとして足す
			List<string?> line = grid[row + rowOffset];
			while (line.Count < column + colspan)
			{
				line.Add(null);
			}

			for (int colOffset = 0; colOffset < colspan; colOffset++)
			{
				// 結合範囲の左上だけ本文を置く。それ以外は予約の空文字。どちらかが 0 でなければ起点ではない
				bool origin = rowOffset == 0 && colOffset == 0;
				// まだ空いている座標だけ書く。先に別セルが入っていれば上書きしない
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
		// 最大列数。行が空、またはセルが無い行だけなら 0 で表にしない
		int columns = rows.Count == 0 ? 0 : rows.Max(static row => row.Count);
		// 列が無い表は空文字を返す
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

		// 空ヘッダ行。列数ぶんの空白セル
		string header = "|" + string.Join("|", Enumerable.Repeat("   ", columns)) + "|";
		// 区切り行。列数ぶんの ---
		string separator = "|" + string.Join("|", Enumerable.Repeat("---", columns)) + "|";
		// ヘッダ、区切り、本文を改行でつなぐバッファ
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
		// 改行を br にした本文。| のエスケープ前
		string normalized = value
			.Replace("\r\n", "\n", StringComparison.Ordinal)
			.Replace('\r', '\n')
			.Replace("\n", "<br>", StringComparison.Ordinal);
		// エスケープを足す余白を持った出力
		StringBuilder builder = new(normalized.Length + 8);
		for (int index = 0; index < normalized.Length; index++)
		{
			// 今見ている文字。| の直前のバックスラッシュ本数で重ねるかを決める
			char character = normalized[index];
			// 表の区切りになる | だけ、未エスケープならバックスラッシュを足す
			if (character == '|')
			{
				// 既に奇数本のバックスラッシュでエスケープ済みなら、重ねて追加しない
				// 直前から続くバックスラッシュの本数。0 は未エスケープ
				int slashes = 0;
				for (int cursor = index - 1; cursor >= 0 && normalized[cursor] == '\\'; cursor--)
				{
					slashes++;
				}

				// 偶数本は未エスケープなので 1 本足す。奇数本は既にエスケープ済み
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
			// この属性の URL。空なら次の属性を見る
			string? value = ReadAttribute(imgHtml, name);
			// 空白でない最初の URL を採用する。空の属性では入らない
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
		// img の開始。無ければ -1
		int img = IndexOfOpenTag(html, "img", start);
		// VML 画像の開始。無ければ -1
		int vml = IndexOfOpenTag(html, "v:imagedata", start);
		// どちらも無いときは画像が無い
		if (img < 0 && vml < 0)
		{
			return -1;
		}

		// img があり、VML が無いか img の方が手前のとき img を採用する。img が無ければ入らない
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
		// 属性の文字列。読めなければ null で結合なしの 1 として扱う
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
		// 開始タグの終わり。無ければ -1 で要素全体を属性の探索範囲にする
		int tagEnd = html.IndexOf('>');
		// > までの開始タグ。> が無ければ全体
		string open = tagEnd >= 0 ? html[..(tagEnd + 1)] : html;
		// 二重引用、単一引用、引用なしの順で値を取る
		Regex pattern = new(
			$@"{Regex.Escape(name)}\s*=\s*(?:""([^""]*)""|'([^']*)'|([^\s>]+))",
			RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
		// 開始タグ内の一致。無ければ属性は無い
		Match match = pattern.Match(open);
		// 属性が無いときは null
		if (!match.Success)
		{
			return null;
		}

		// 引用の種類に応じた生の値。前後の空白はデコード前に除く
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
		// 親表の外側で見つかった要素。出現順
		List<string> found = [];
		// 次に見る文字位置
		int cursor         = 0;
		// 親表の行・セルだけを返すため、入れ子table内では対象タグを収集しない
		// 今入っている入れ子 table の深さ。0 は親の直下
		int nestedTables   = 0;
		while (cursor < html.Length)
		{
			// コメントはタグとして見ず、終わりの次へ進む
			if (StartsWithComment(html, cursor, out int commentEnd))
			{
				cursor = commentEnd;
				continue;
			}

			// 入れ子の外だけ、指定タグを集める。深さ 1 以上では入らない
			if (nestedTables == 0)
			{
				foreach (string name in names)
				{
					// この位置がその名前の開始タグなら、要素全体を採取する
					if (IsOpenTagAt(html, cursor, name))
					{
						// 要素全体を取り出せたときだけ一覧へ足し、終端へ進む。壊れた開始は次の文字へ進む
						if (TryReadElement(html, cursor, name, out string element, out int end))
						{
							found.Add(element);
							cursor = end;
							goto Next;
						}
					}
				}
			}

			// 入れ子 table の開始で深さを増やす。収集対象にはしない
			if (IsOpenTagAt(html, cursor, "table"))
			{
				nestedTables++;
				cursor = SkipOpenTag(html, cursor);
				continue;
			}

			// 入れ子 table の閉じで深さを戻す。0 未満にはしない
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
		// 開始タグの >。無ければ -1 で内側を決められない
		int openEnd = elementHtml.IndexOf('>');
		// 開始タグが閉じていなければ失敗
		if (openEnd < 0)
		{
			return false;
		}

		// 名前が指定されていて自己終了なら、内側は空のまま成功
		if (name is not null && IsSelfClosing(elementHtml[..(openEnd + 1)], name))
		{
			return true;
		}

		// 対応する閉じの開始。名前が null なら最後の </。無ければ -1
		int closeStart = name is null
			? elementHtml.LastIndexOf("</", StringComparison.Ordinal)
			: elementHtml.LastIndexOf("</" + name, StringComparison.OrdinalIgnoreCase);
		// 閉じが開始より前、または無いときは開始の後ろ全部を内側にする
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
		// その位置が開始タグでなければ要素として取れない
		if (!IsOpenTagAt(html, start, name))
		{
			return false;
		}

		// 開始タグの >。無ければ要素を確定できない
		int openEnd = html.IndexOf('>', start);
		// > が無い壊れた開始は失敗
		if (openEnd < 0)
		{
			return false;
		}

		// 画像、末尾が /、または空要素なら開始タグだけで 1 要素にする。どれにも当てはまらなければ深さを追う
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
		// 開始を 1 として、同名の開きで増え、閉じで減る。0 が対応する閉じ
		int depth  = 1;
		// 開始タグの次から閉じを探す
		int cursor = openEnd + 1;
		while (cursor < html.Length)
		{
			// コメント内のタグらしき文字は深さに数えない
			if (StartsWithComment(html, cursor, out int commentEnd))
			{
				cursor = commentEnd;
				continue;
			}

			// 同名の開始で深さを増やす
			if (IsOpenTagAt(html, cursor, name))
			{
				depth++;
				cursor = SkipOpenTag(html, cursor);
				continue;
			}

			// 同名の閉じで深さを減らす。0 になった閉じがこの要素の終わり
			if (IsCloseTagAt(html, cursor, name))
			{
				depth--;
				// この閉じタグの次
				int closeEnd = SkipCloseTag(html, cursor);
				// 最初の開始と対になる閉じ。入れ子の閉じでは入らない
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
			// この位置が指定名の開始ならそこを返す
			if (IsOpenTagAt(html, index, name))
			{
				return index;
			}

			// コメントは中をタグとして見ず、終わりの直前へ進めて次のループで飛び越す
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
		// 範囲外、または < で始まらなければ開始タグではない
		if (index >= html.Length || html[index] != '<')
		{
			return false;
		}

		// 閉じ、コメント、処理指令は開始タグにしない。どれか一つでも入る
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
		// </ で始まらなければ閉じタグではない。長さ不足でも入る
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
		// 名前が末尾を越えるときは一致しない
		if (nameStart + name.Length > html.Length)
		{
			return false;
		}

		// 大文字小文字を無視して名前が違うときは別タグ
		if (!html.AsSpan(nameStart, name.Length).Equals(name, StringComparison.OrdinalIgnoreCase))
		{
			return false;
		}

		// 名前の直後。終端なら区切りが無くても一致とみなす
		int after = nameStart + name.Length;
		// 文字列末尾で終わった名前は、続きの文字が無くてもタグ名として一致
		if (after >= html.Length)
		{
			return true;
		}

		// 名前の次の文字。空白、>、/ ならタグ名の区切り
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
		// img、imagedata、br、col は内側を持たない。どれか一つでも自己終了
		if (name.Equals("img", StringComparison.OrdinalIgnoreCase)
			|| name.EndsWith("imagedata", StringComparison.OrdinalIgnoreCase)
			|| name.Equals("br", StringComparison.OrdinalIgnoreCase)
			|| name.Equals("col", StringComparison.OrdinalIgnoreCase))
		{
			return true;
		}

		// 最後の /。無ければ -1
		int lastSlash = openTag.LastIndexOf('/');
		// 最後の >。/ の直後でなければ自己終了ではない
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
		// タグの >。無ければ -1 で終端まで飛ばす
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
		// <! で始まらなければコメントではない。長さ不足でも入る
		if (index + 3 >= html.Length || html[index] != '<' || html[index + 1] != '!')
		{
			return false;
		}

		// --> の位置。無ければ -1 で終端までコメントとみなす
		int close = html.IndexOf("-->", index, StringComparison.Ordinal);
		// 閉じが無いコメントは終端まで読み飛ばす
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
		// 空はそのまま空文字。タグ除去はしない
		if (string.IsNullOrEmpty(html))
		{
			return string.Empty;
		}

		// HTMLパーサーを使わず、表示に不要なstyle/scriptを除外しつつ改行相当タグだけ保存する
		StringBuilder builder = new(html.Length);
		// 次に見る文字位置
		int cursor            = 0;
		while (cursor < html.Length)
		{
			// コメントは本文に残さない
			if (StartsWithComment(html, cursor, out int commentEnd))
			{
				cursor = commentEnd;
				continue;
			}

			// タグの開始。本文の < 以外は下で 1 文字足す
			if (html[cursor] == '<')
			{
				// style 開始であり、要素全体を読めたときだけ中身を捨てる。どちらかが欠けても入らない
				if (IsOpenTagAt(html, cursor, "style")
					&& TryReadElement(html, cursor, "style", out _, out int styleEnd))
				{
					cursor = styleEnd;
					continue;
				}

				// script 開始であり、要素全体を読めたときだけ中身を捨てる。どちらかが欠けても入らない
				if (IsOpenTagAt(html, cursor, "script")
					&& TryReadElement(html, cursor, "script", out _, out int scriptEnd))
				{
					cursor = scriptEnd;
					continue;
				}

				// このタグの >。無ければ -1 で残りは本文にしない
				int tagEnd = html.IndexOf('>', cursor);
				// > が無い壊れたタグは、以降を捨てて終える
				if (tagEnd < 0)
				{
					break;
				}

				// > までを含むタグ文字列。改行相当なら改行を残す
				string tag = html[cursor..(tagEnd + 1)];
				// 表示上の改行として残すタグだけ改行を足す
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
		// ノーブレークスペースを空白にし、行末の空白を除いたテキスト
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
		// ヘッダのキーと位置。同じキーは後の行で上書きする
		Dictionary<string, int> offsets = [];
		foreach (Match match in CfHtmlOffsetPattern.Matches(clipboardHtml))
		{
			offsets[match.Groups[1].Value] = int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture);
		}

		// 開始か終了が無い、負、または終了が開始以下なら範囲にしない。どれか一つでも入る
		if (!offsets.TryGetValue(startKey, out int start) || !offsets.TryGetValue(endKey, out int end)
			|| start < 0 || end <= start)
		{
			return false;
		}

		// 仕様どおりのUTF-8バイト位置を優先し、非準拠アプリの文字位置指定も救済する
		// 文字列全体の UTF-8 バイト
		byte[] bytes = Encoding.UTF8.GetBytes(clipboardHtml);
		// 終了がバイト長以内のときだけバイト位置で切る。中身が空なら失敗
		if (end <= bytes.Length)
		{
			slice = Encoding.UTF8.GetString(bytes, start, end - start);
			return slice.Length > 0;
		}

		// バイト長を越えても文字長以内なら、文字位置として切る
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
		// Version: で始まらなければヘッダではないので、引数のまま返す
		if (!clipboardHtml.StartsWith("Version:", StringComparison.OrdinalIgnoreCase))
		{
			return clipboardHtml;
		}

		// 最初の <。無ければ -1 でヘッダ除去後も引数のまま
		int htmlStart = clipboardHtml.IndexOf('<');
		return htmlStart >= 0 ? clipboardHtml[htmlStart..] : clipboardHtml;
	}
}
