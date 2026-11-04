/**
 * 開始フェンスの情報文字列から言語名とタイトルを読み、プレビュー行へラベルとして挿入する
 * エディタ状態は持たず、呼び出し側の entries へ装飾を足すだけである
 * @file
 */
import { Decoration, WidgetType } from '@codemirror/view';
import type { DecorationEntry } from './inlineDecorations';

/** 情報文字列の先頭の語。キャプチャは空白を除いた語 */
const FENCE_FIRST_WORD_PATTERN = /^\s*(\S+)/;
/** タイトル指定の語の判定。先頭の語がこれに一致するときは言語名にしない */
const FENCE_TITLE_KEY_PATTERN  = /^title:/;
/**
 * `title:値` のタイトル指定。キャプチャ 1 はダブルクォートの中身、2 はクォート無しの語
 * 閉じクォートが無いときはクォート無しの語として、`"` を含めて読む
 */
const FENCE_TITLE_PATTERN      = /(?:^|\s)title:[ \t]*(?:"([^"]*)"|(\S+))/;

/**
 * 開始フェンスのラベルに出す内容
 * 情報文字列の全体ではなく、表示に使う言語名とタイトルだけを持つ
 */
export type FencedCodeHeader = {
	/** 言語名。情報文字列の先頭の語で、無いときやタイトル指定から始まるときは空文字 */
	language: string;
	/** タイトル。`title:` の値で、指定が無いときや値が空のときは空文字 */
	title: string;
};

/**
 * 開始フェンスの言語名とタイトルを文字として描くウィジェット
 * 生成後に内容は変えず、言語名かタイトルが変われば別インスタンスへ作り直す
 */
class FencedCodeHeaderLabelWidget extends WidgetType {
	/** 表示する言語名。空文字のときは言語名と区切りを描かない */
	readonly language: string;
	/** 表示するタイトル。空文字のときはタイトルと区切りを描かない */
	readonly title: string;

	/**
	 * 表示する言語名とタイトルを固定したウィジェットを作る
	 * @param header - ラベルに出す内容。言語名とタイトルの少なくとも一方は空でない
	 */
	constructor(header: FencedCodeHeader) {
		super();
		this.language = header.language;
		this.title    = header.title;
	}

	/**
	 * 基底の契約と同じ。言語名とタイトルがともに同じインスタンスだけを同一とみなす
	 * @param other - 比較対象のウィジェット
	 * @returns 相手も FencedCodeHeaderLabelWidget で language と title が一致すれば true
	 */
	eq(other: WidgetType): boolean {
		return other instanceof FencedCodeHeaderLabelWidget && other.language === this.language && other.title === this.title;
	}

	/**
	 * 基底の契約と同じ。クラス `cm-md-fenced-code-label` の span を返す
	 * 中は言語名 `cm-md-fenced-code-lang`、区切り `cm-md-fenced-code-title-sep`、タイトル `cm-md-fenced-code-title` の順で、空の部分は描かない
	 * @returns 言語名とタイトルを子に持つ span 要素
	 */
	toDOM(): HTMLElement {
		// ラベル全体。文字色と太さは CSS 変数とクラスセレクタに任せる
		const label     = document.createElement('span');
		label.className = 'cm-md-fenced-code-label';

		// 言語名があるときだけ、言語名の部分を描く
		if (this.language !== '') {
			label.appendChild(createLabelPart('cm-md-fenced-code-lang', this.language));
		}

		// 言語名とタイトルが両方あるときだけ、間に区切りを描く。どちらか一方なら区切りは要らない
		if (this.language !== '' && this.title !== '') {
			label.appendChild(createLabelPart('cm-md-fenced-code-title-sep', ': '));
		}

		// タイトルがあるときだけ、タイトルの部分を描く
		if (this.title !== '') {
			label.appendChild(createLabelPart('cm-md-fenced-code-title', this.title));
		}

		return label;
	}

	/**
	 * クリックをエディタへ渡し、開始フェンス行へキャレットを置けるようにする
	 * 基底はイベントを無視するが、このラベルは操作を持たないため無視しない
	 * @returns 常に false
	 */
	ignoreEvent(): boolean {
		return false;
	}
}

/**
 * ラベルの 1 部分になる span を作る
 * @param className - 部分ごとのクラス。スニペットが部分ごとに上書きするときのセレクタになる
 * @param text - 表示する文字列。HTML としては解釈しない
 * @returns クラスと文字列を設定した span 要素
 */
function createLabelPart(className: string, text: string): HTMLElement {
	// 部分の要素。文字列は textContent で入れ、タイトル内の記号をタグにしない
	const part       = document.createElement('span');
	part.className   = className;
	part.textContent = text;
	return part;
}

/**
 * フェンス情報文字列から、ラベルに出す言語名とタイトルを取り出す
 * タイトルは `title:値` で、値はクォート無しなら空白までの語、ダブルクォートで囲えばその中身とする
 * @param info - 開始フェンスの ``` より後ろの文字列。前後の空白を含んでもよい
 * @returns 言語名とタイトル。どちらも無いときは両方とも空文字
 */
export function parseFencedCodeHeader(info: string): FencedCodeHeader {
	// 先頭の語。情報文字列が空白だけなら空文字
	const firstWord  = FENCE_FIRST_WORD_PATTERN.exec(info)?.[1] ?? '';
	// タイトル指定。無ければ null
	const titleMatch = FENCE_TITLE_PATTERN.exec(info);

	// 言語名とタイトルの組
	return {
		// 先頭の語。`title:` から始まるときは言語名が書かれていないので空文字
		language: FENCE_TITLE_KEY_PATTERN.test(firstWord) ? '' : firstWord,
		// クォートの中身、無ければクォート無しの語。指定が無ければ空文字
		title: titleMatch ? (titleMatch[1] ?? titleMatch[2] ?? '') : ''
	};
}

/**
 * 開始フェンスの指定位置へ、言語名とタイトルのラベルウィジェットを挿入する
 * 文書の文字は置き換えない。言語名とタイトルがどちらも空のときは何も足さない
 * @param entries - 装飾を追加する配列。この関数が末尾へ push する
 * @param pos - 挿入位置。隠したフェンス記号と情報文字列の直後
 * @param header - ラベルに出す言語名とタイトル
 */
export function pushFencedCodeHeaderLabel(entries: DecorationEntry[], pos: number, header: FencedCodeHeader): void {
	// 言語名もタイトルも無いフェンスにはラベルを出さない。どちらか一方でもあれば出す
	if (header.language === '' && header.title === '') {
		return;
	}

	// 文字を置き換えないラベル。指定位置の後ろ側へ挿入する
	entries.push({
		// 挿入位置。点装飾なので終端と同じ
		from: pos,
		// 挿入位置。点装飾なので開始と同じ
		to: pos,
		// ラベルのウィジェット。文書の文字は残す
		decoration: Decoration.widget({
			// この言語名とタイトルのラベル。どちらかが変われば別インスタンス
			widget: new FencedCodeHeaderLabelWidget(header),
			// 位置の後ろ側。隠したフェンス記号の手前には出さない
			side: 1
		})
	});
}
