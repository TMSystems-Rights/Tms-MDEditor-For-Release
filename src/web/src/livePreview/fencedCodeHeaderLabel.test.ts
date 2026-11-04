/**
 * 開始フェンスの情報文字列から、ラベルに出す言語名とタイトルを読む処理を検証する
 * ウィジェットの DOM は作らず、解釈の結果だけを見る
 * @file
 */
import { describe, expect, it } from 'vitest';
import { parseFencedCodeHeader } from './fencedCodeHeaderLabel';

describe('parseFencedCodeHeader', () => {
	it('言語名だけのときはタイトルを空にする', () => {
		expect(parseFencedCodeHeader('java')).toEqual({ language: 'java', title: '' });
	});

	it('クォート無しのタイトルは空白までの語だけを読む', () => {
		expect(parseFencedCodeHeader('java title:クラスサンプル その１')).toEqual({ language: 'java', title: 'クラスサンプル' });
	});

	it('ダブルクォートで囲ったタイトルは空白を含めて中身を読む', () => {
		expect(parseFencedCodeHeader('java title:"クラスサンプル その２"')).toEqual({ language: 'java', title: 'クラスサンプル その２' });
	});

	it('全角空白もクォート無しのタイトルの区切りにする', () => {
		expect(parseFencedCodeHeader('bash title:テスト　その３')).toEqual({ language: 'bash', title: 'テスト' });
	});

	it('閉じクォートが無いタイトルはクォート無しの語として読む', () => {
		expect(parseFencedCodeHeader('java title:"未完 の値')).toEqual({ language: 'java', title: '"未完' });
	});

	it('タイトル指定から始まるときは言語名を空にする', () => {
		expect(parseFencedCodeHeader('title:テスト')).toEqual({ language: '', title: 'テスト' });
	});

	it('空のクォートはタイトル無しとして扱う', () => {
		expect(parseFencedCodeHeader('text title:""')).toEqual({ language: 'text', title: '' });
	});

	it('語の途中の title: はタイトル指定にしない', () => {
		expect(parseFencedCodeHeader('text subtitle:abc')).toEqual({ language: 'text', title: '' });
	});

	it('空白だけの情報文字列は言語名もタイトルも空にする', () => {
		expect(parseFencedCodeHeader('   ')).toEqual({ language: '', title: '' });
	});
});
