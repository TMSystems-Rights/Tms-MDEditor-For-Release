using System.Text;
using TmsMdEditor.Services;

namespace TmsMdEditor.Tests;

public class ClipboardHtmlTableConverterTests
{
	[Fact]
	public void ExtractFragment_reads_cf_html_offsets()
	{
		const string prefix = "Version:0.9\r\nStartHTML:0000000105\r\nEndHTML:0000000200\r\nStartFragment:0000000141\r\nEndFragment:0000000180\r\n";
		string html          = prefix + "<html><body><!--StartFragment--><table><tr><td>A</td></tr></table><!--EndFragment--></body></html>";
		int start            = html.IndexOf("<!--StartFragment-->", StringComparison.Ordinal) + "<!--StartFragment-->".Length;
		int end              = html.IndexOf("<!--EndFragment-->", StringComparison.Ordinal);
		string patched       = string.Create(html.Length, html, static (span, value) => value.AsSpan().CopyTo(span));
		patched = patched
			.Replace("0000000141", start.ToString("D10"), StringComparison.Ordinal)
			.Replace("0000000180", end.ToString("D10"), StringComparison.Ordinal);

		string fragment = ClipboardHtmlTableConverter.ExtractFragment(patched);

		Assert.Contains("<table>", fragment, StringComparison.OrdinalIgnoreCase);
		Assert.DoesNotContain("Version:", fragment, StringComparison.Ordinal);
	}

	[Fact]
	public void ContainsTable_is_true_for_excel_like_html()
	{
		Assert.True(ClipboardHtmlTableConverter.ContainsTable("<html><body><table><tr><td>1</td></tr></table></body></html>"));
		Assert.False(ClipboardHtmlTableConverter.ContainsTable("<html><body><p>plain</p></body></html>"));
	}

	[Fact]
	public void ToMarkdown_uses_empty_header_and_data_rows()
	{
		const string html = "<table><tr><td>ユイ(クリスマス)</td><td>クリユイ</td><td>火</td></tr></table>";

		string markdown = ClipboardHtmlTableConverter.ToMarkdown(html, static _ => null);

		Assert.Equal(
			"|   |   |   |\n|---|---|---|\n|ユイ(クリスマス)|クリユイ|火|",
			markdown);
	}

	[Fact]
	public void ToMarkdown_emits_colspan_attribute()
	{
		const string html = "<table><tbody><tr><th colspan=\"3\">新キャラ</th></tr><tr><td>A</td><td>B</td><td>C</td></tr></tbody></table>";

		string markdown = ClipboardHtmlTableConverter.ToMarkdown(html, static _ => null);

		Assert.Equal(
			"|   |   |   |\n|---|---|---|\n|新キャラ{colspan=3}|||\n|A|B|C|",
			markdown);
	}

	[Fact]
	public void ToMarkdown_emits_align_and_valign_attributes()
	{
		const string html = "<table><tr><td align=\"right\" valign=\"middle\">100</td><td>左</td></tr></table>";

		string markdown = ClipboardHtmlTableConverter.ToMarkdown(html, static _ => null);

		Assert.Equal(
			"|   |   |\n|---|---|\n|100{align=right valign=middle}|左|",
			markdown);
	}

	[Fact]
	public void ToMarkdown_reads_inline_style_alignment()
	{
		const string html = "<table><tr><td style=\"text-align:center; vertical-align:bottom\">A</td></tr></table>";

		string markdown = ClipboardHtmlTableConverter.ToMarkdown(html, static _ => null);

		Assert.Equal("|   |\n|---|\n|A{align=center valign=bottom}|", markdown);
	}

	[Fact]
	public void ToMarkdown_reads_excel_class_alignment()
	{
		const string html = """
			<html><head><style>
			.xl65 { text-align:center; vertical-align:middle; }
			.xl66 { text-align:right; }
			</style></head><body>
			<table><tr><td class="xl65">A</td><td class=xl66>B</td></tr></table>
			</body></html>
			""";

		string markdown = ClipboardHtmlTableConverter.ToMarkdown(html, static _ => null);

		Assert.Equal(
			"|   |   |\n|---|---|\n|A{align=center valign=middle}|B{align=right}|",
			markdown);
	}

	[Fact]
	public void ToMarkdown_omits_default_left_top_alignment()
	{
		const string html = "<table><tr><td align=\"left\" valign=\"top\" style=\"text-align:justify\">A</td></tr></table>";

		string markdown = ClipboardHtmlTableConverter.ToMarkdown(html, static _ => null);

		Assert.Equal("|   |\n|---|\n|A|", markdown);
	}

	[Fact]
	public void ToMarkdown_emits_rowspan_and_fills_occupied_cells()
	{
		const string html = "<table><tr><td rowspan=\"2\">A</td><td>B</td></tr><tr><td>C</td></tr></table>";

		string markdown = ClipboardHtmlTableConverter.ToMarkdown(html, static _ => null);

		Assert.Equal(
			"|   |   |\n|---|---|\n|A{rowspan=2}|B|\n||C|",
			markdown);
	}

	[Fact]
	public void ToMarkdown_inserts_resolved_images_and_keeps_text()
	{
		const string html = """
			<table><tr><td>
			<img data-original="https://example.com/a.png" src="placeholder.gif" alt="ヴルム">
			ヴルム(ヴァールムドラッペ)
			</td></tr></table>
			""";

		string markdown = ClipboardHtmlTableConverter.ToMarkdown(
			html,
			static src => src.Contains("a.png", StringComparison.Ordinal) ? "![[C:\\shots\\a.png]]" : null);

		Assert.Contains("![[C:\\shots\\a.png]]<br>ヴルム(ヴァールムドラッペ)", markdown, StringComparison.Ordinal);
	}

	[Fact]
	public void ToMarkdown_keeps_surrounding_text_and_multiple_tables()
	{
		const string html = "<p>前</p><table><tr><td>1</td></tr></table><p>中</p><table><tr><td>2</td></tr></table>";

		string markdown = ClipboardHtmlTableConverter.ToMarkdown(html, static _ => null);

		Assert.Equal(
			"前\n\n|   |\n|---|\n|1|\n\n中\n\n|   |\n|---|\n|2|",
			markdown);
	}

	[Fact]
	public void ToMarkdown_escapes_pipes_in_cells()
	{
		const string html = "<table><tr><td>A|B</td></tr></table>";

		string markdown = ClipboardHtmlTableConverter.ToMarkdown(html, static _ => null);

		Assert.Contains("|A\\|B|", markdown, StringComparison.Ordinal);
	}

	[Fact]
	public void ToMarkdown_returns_empty_when_no_table()
	{
		Assert.Equal(string.Empty, ClipboardHtmlTableConverter.ToMarkdown("<p>only text</p>", static _ => null));
	}

	[Fact]
	public void ExtractFragment_uses_utf8_byte_offsets()
	{
		string document =
			"<html><head><title>日本語タイトル</title></head><body><!--StartFragment--><table><tr><td>セル</td></tr></table><!--EndFragment--></body></html>";
		string cfHtml = BuildCfHtml(document, "<!--StartFragment-->", "<!--EndFragment-->");

		string fragment = ClipboardHtmlTableConverter.ExtractFragment(cfHtml);

		Assert.Contains("<table>", fragment, StringComparison.OrdinalIgnoreCase);
		Assert.Contains("セル", fragment, StringComparison.Ordinal);
		Assert.DoesNotContain("日本語タイトル", fragment, StringComparison.Ordinal);
	}

	[Fact]
	public void ToMarkdown_wraps_excel_fragment_that_is_only_rows()
	{
		const string rows = "<tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr>";
		string document =
			"<html xmlns:x=\"urn:schemas-microsoft-com:office:excel\"><head><meta name=ProgId content=Excel.Sheet></head><body>"
			+ rows
			+ "</body></html>";
		string cfHtml = BuildCfHtml(document, rows);

		Assert.True(ClipboardHtmlTableConverter.ContainsTable(cfHtml));
		Assert.True(ClipboardHtmlTableConverter.LooksLikeExcelHtml(cfHtml));
		Assert.Equal(
			"|   |   |\n|---|---|\n|A|B|\n|C|D|",
			ClipboardHtmlTableConverter.ToMarkdown(cfHtml, static _ => null));
	}

	[Fact]
	public void ToMarkdown_uses_document_table_when_fragment_omits_it()
	{
		const string rows = "<tr><td>一</td><td>二</td></tr>";
		string document = "<html><body><table>" + rows + "</table></body></html>";
		string cfHtml   = BuildCfHtml(document, rows);

		Assert.Equal(
			"|   |   |\n|---|---|\n|一|二|",
			ClipboardHtmlTableConverter.ToMarkdown(cfHtml, static _ => null));
	}

	[Fact]
	public void ToMarkdown_keeps_table_when_cell_has_self_closing_img()
	{
		const string html = """<table><tr><td><img src="https://example.com/a.png"/></td></tr></table>""";

		string markdown = ClipboardHtmlTableConverter.ToMarkdown(
			html,
			static src => src.Contains("a.png", StringComparison.Ordinal) ? "![[C:\\shots\\a.png]]" : null);

		Assert.Equal("|   |\n|---|\n|![[C:\\shots\\a.png]]|", markdown);
	}

	[Fact]
	public void ToMarkdown_reads_excel_vml_imagedata()
	{
		const string html = """
			<table><tr><td>
			<v:shape><v:imagedata src="file:///C:/tmp/a.png" o:title=""/></v:shape>
			名前
			</td></tr></table>
			""";

		string markdown = ClipboardHtmlTableConverter.ToMarkdown(
			html,
			static src => src.Contains("a.png", StringComparison.Ordinal) ? "![[C:\\shots\\a.png]]" : null);

		Assert.Contains("![[C:\\shots\\a.png]]<br>名前", markdown, StringComparison.Ordinal);
	}

	[Fact]
	public void TsvToMarkdown_converts_single_and_multiple_cells()
	{
		Assert.Equal("|   |\n|---|\n|hello|", ClipboardHtmlTableConverter.TsvToMarkdown("hello"));
		Assert.Equal(
			"|   |   |\n|---|---|\n|A|B|\n|C|D|",
			ClipboardHtmlTableConverter.TsvToMarkdown("A\tB\r\nC\tD\r\n"));
		Assert.Equal(string.Empty, ClipboardHtmlTableConverter.TsvToMarkdown("   \r\n"));
	}

	[Fact]
	public void SingleCellTable_wraps_image_markup()
	{
		Assert.Equal(
			"|   |\n|---|\n|![[C:\\shots\\a.png]]|",
			ClipboardHtmlTableConverter.SingleCellTable("![[C:\\shots\\a.png]]"));
	}

	private static string BuildCfHtml(string document, string fragment)
	{
		int fragmentStart = document.IndexOf(fragment, StringComparison.Ordinal);
		int fragmentEnd   = fragmentStart + fragment.Length;
		return BuildCfHtml(document, fragmentStart, fragmentEnd);
	}

	private static string BuildCfHtml(string document, string startMarker, string endMarker)
	{
		int markerStart = document.IndexOf(startMarker, StringComparison.Ordinal);
		int fragmentStart = markerStart + startMarker.Length;
		int fragmentEnd   = document.IndexOf(endMarker, StringComparison.Ordinal);
		return BuildCfHtml(document, fragmentStart, fragmentEnd);
	}

	private static string BuildCfHtml(string document, int fragmentStart, int fragmentEnd)
	{
		const string header =
			"Version:0.9\r\nStartHTML:0000000000\r\nEndHTML:0000000000\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n";
		int headerBytes    = Encoding.UTF8.GetByteCount(header);
		int startHtml      = headerBytes;
		int endHtml        = headerBytes + Encoding.UTF8.GetByteCount(document);
		int startFragment  = headerBytes + Encoding.UTF8.GetByteCount(document[..fragmentStart]);
		int endFragment    = headerBytes + Encoding.UTF8.GetByteCount(document[..fragmentEnd]);
		string patchedHeader = header
			.Replace("StartHTML:0000000000", $"StartHTML:{startHtml:D10}", StringComparison.Ordinal)
			.Replace("EndHTML:0000000000", $"EndHTML:{endHtml:D10}", StringComparison.Ordinal)
			.Replace("StartFragment:0000000000", $"StartFragment:{startFragment:D10}", StringComparison.Ordinal)
			.Replace("EndFragment:0000000000", $"EndFragment:{endFragment:D10}", StringComparison.Ordinal);
		return patchedHeader + document;
	}
}
