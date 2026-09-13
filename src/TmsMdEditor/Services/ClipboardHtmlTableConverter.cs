using System.Globalization;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace TmsMdEditor.Services;

/// <summary>
/// クリップボード HTML の表を GFM 表へ変換する
/// </summary>
internal static class ClipboardHtmlTableConverter
{
	private static readonly Regex CfHtmlOffsetPattern = new(
		@"^(StartHTML|EndHTML|StartFragment|EndFragment):(\d+)\s*$",
		RegexOptions.IgnoreCase | RegexOptions.Multiline | RegexOptions.CultureInvariant);

	/// <summary>
	/// CF_HTML ヘッダを除いた HTML 断片を返す
	/// </summary>
	/// <param name="clipboardHtml">クリップボードの HTML</param>
	/// <returns>表を含む HTML</returns>
	public static string ExtractFragment(string clipboardHtml)
	{
		if (string.IsNullOrWhiteSpace(clipboardHtml))
		{
			return string.Empty;
		}

		if (TrySliceUtf8Range(clipboardHtml, "StartFragment", "EndFragment", out string fragment)
			&& fragment.Length > 0)
		{
			return fragment;
		}

		int markerStart = clipboardHtml.IndexOf("<!--StartFragment-->", StringComparison.OrdinalIgnoreCase);
		int markerEnd   = clipboardHtml.IndexOf("<!--EndFragment-->", StringComparison.OrdinalIgnoreCase);
		if (markerStart >= 0 && markerEnd > markerStart)
		{
			return clipboardHtml[(markerStart + "<!--StartFragment-->".Length)..markerEnd];
		}

		return StripCfHtmlHeader(clipboardHtml);
	}

	/// <summary>
	/// CF_HTML の文書全体（StartHTML〜EndHTML）を返す
	/// </summary>
	/// <param name="clipboardHtml">クリップボードの HTML</param>
	/// <returns>HTML 文書</returns>
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
	/// Excel 断片のように table が欠けていても変換できる HTML を返す
	/// </summary>
	/// <param name="clipboardHtml">クリップボードの HTML</param>
	/// <returns>表を含む HTML</returns>
	public static string NormalizeTableSource(string clipboardHtml)
	{
		string document = ExtractHtmlDocument(clipboardHtml);
		string fragment = ExtractFragment(clipboardHtml);
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
	/// HTML に表が含まれるか判定する
	/// </summary>
	/// <param name="html">HTML</param>
	/// <returns>表があれば true</returns>
	public static bool ContainsTable(string html)
	{
		string source = NormalizeTableSource(html);
		return IndexOfOpenTag(source, "table", 0) >= 0;
	}

	/// <summary>
	/// Excel / スプレッドシート由来の HTML か判定する
	/// </summary>
	/// <param name="html">HTML</param>
	/// <returns>Excel 系なら true</returns>
	public static bool LooksLikeExcelHtml(string html)
	{
		return html.Contains("Excel.Sheet", StringComparison.OrdinalIgnoreCase)
			|| html.Contains("urn:schemas-microsoft-com:office:excel", StringComparison.OrdinalIgnoreCase)
			|| html.Contains("xmlns:x=\"urn:schemas-microsoft-com:office:excel\"", StringComparison.OrdinalIgnoreCase)
			|| html.Contains("ProgId content=Excel", StringComparison.OrdinalIgnoreCase);
	}

	/// <summary>
	/// タブ区切りテキストを空ヘッダの GFM 表にする
	/// </summary>
	/// <param name="text">Unicode テキスト</param>
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
	/// 1 セルだけの GFM 表を返す
	/// </summary>
	/// <param name="cell">セル内容</param>
	/// <returns>Markdown 表</returns>
	public static string SingleCellTable(string cell)
	{
		return RenderGfmTable([[EscapeCell(cell)]]);
	}

	/// <summary>
	/// HTML 内の表を GFM 表へ変換する。表以外はプレーンテキストにする
	/// </summary>
	/// <param name="html">HTML</param>
	/// <param name="resolveImageMarkup">画像 URL を挿入文字列へ変換する</param>
	/// <returns>Markdown。表が無ければ空文字</returns>
	public static string ToMarkdown(string html, Func<string, string?> resolveImageMarkup)
	{
		string source = NormalizeTableSource(html);
		if (IndexOfOpenTag(source, "table", 0) < 0)
		{
			return string.Empty;
		}

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

			string markdown = ConvertTable(tableHtml, resolveImageMarkup);
			if (markdown.Length > 0)
			{
				parts.Add(markdown);
			}

			cursor = tableEnd;
		}

		return string.Join("\n\n", parts.Where(static part => part.Length > 0));
	}

	private static void AppendPlainText(List<string> parts, string html)
	{
		string text = NormalizePlainText(StripTagsToText(html));
		if (text.Length > 0)
		{
			parts.Add(text);
		}
	}

	private static string ConvertTable(string tableHtml, Func<string, string?> resolveImageMarkup)
	{
		if (!TryReadInner(tableHtml, "table", out string inner))
		{
			return string.Empty;
		}

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
				PlaceSpannedCell(grid, rowIndex, column, FormatCellSpan(cell, colspan, rowspan), colspan, rowspan);
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

	private static string ConvertCell(string cellHtml, Func<string, string?> resolveImageMarkup)
	{
		string tagName = IsOpenTagAt(cellHtml, 0, "th") ? "th" : "td";
		if (!TryReadInner(cellHtml, tagName, out string inner))
		{
			inner = cellHtml;
		}

		List<string> pieces = [];
		int cursor          = 0;
		while (cursor < inner.Length)
		{
			int imageStart  = IndexOfNextImageTag(inner, cursor, out string imageTagName);
			int nestedStart = IndexOfOpenTag(inner, "table", cursor);
			if (nestedStart >= 0 && (imageStart < 0 || nestedStart < imageStart))
			{
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

	private static void AppendCellText(List<string> pieces, string html)
	{
		string text = NormalizePlainText(StripTagsToText(html));
		if (text.Length > 0)
		{
			pieces.Add(text);
		}
	}

	private static string FormatCellSpan(string cell, int colspan, int rowspan)
	{
		if (colspan <= 1 && rowspan <= 1)
		{
			return cell;
		}

		List<string> parts = [];
		if (colspan > 1)
		{
			parts.Add("colspan=" + colspan.ToString(CultureInfo.InvariantCulture));
		}

		if (rowspan > 1)
		{
			parts.Add("rowspan=" + rowspan.ToString(CultureInfo.InvariantCulture));
		}

		return cell + "{" + string.Join(" ", parts) + "}";
	}

	private static void EnsureGridRow(List<List<string?>> grid, int row)
	{
		while (grid.Count <= row)
		{
			grid.Add([]);
		}
	}

	private static bool CellTaken(List<List<string?>> grid, int row, int column)
	{
		return row < grid.Count && column < grid[row].Count && grid[row][column] is not null;
	}

	private static void PlaceSpannedCell(
		List<List<string?>> grid,
		int row,
		int column,
		string text,
		int colspan,
		int rowspan)
	{
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

	private static string RenderGfmTable(List<List<string>> rows)
	{
		int columns = rows.Count == 0 ? 0 : rows.Max(static row => row.Count);
		if (columns == 0)
		{
			return string.Empty;
		}

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

	private static int ReadPositiveAttribute(string tagHtml, string name)
	{
		string? raw = ReadAttribute(tagHtml, name);
		return int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out int value)
			? value
			: 1;
	}

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

	private static List<string> FindElementsOutsideNestedTables(string html, params string[] names)
	{
		List<string> found = [];
		int cursor         = 0;
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

	private static bool IsCloseTagAt(string html, int index, string name)
	{
		if (index + 1 >= html.Length || html[index] != '<' || html[index + 1] != '/')
		{
			return false;
		}

		return MatchesTagName(html, index + 2, name);
	}

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

	private static int SkipOpenTag(string html, int start)
	{
		int end = html.IndexOf('>', start);
		return end < 0 ? html.Length : end + 1;
	}

	private static int SkipCloseTag(string html, int start)
	{
		return SkipOpenTag(html, start);
	}

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

	private static string StripTagsToText(string html)
	{
		if (string.IsNullOrEmpty(html))
		{
			return string.Empty;
		}

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

	private static string NormalizePlainText(string text)
	{
		string normalized = Regex.Replace(text.Replace('\u00a0', ' '), @"[ \t]+\n", "\n");
		normalized = Regex.Replace(normalized, @"\n{3,}", "\n\n");
		normalized = Regex.Replace(normalized, @"[ \t]{2,}", " ");
		return normalized.Trim();
	}

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
