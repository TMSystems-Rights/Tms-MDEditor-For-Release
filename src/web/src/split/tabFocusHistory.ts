/**
 * ペインのタブ選択履歴を更新し、選択中のタブを外したあとに前面にするタブを決める
 * 履歴の保持はペイン側が持ち、ここでは新しい配列か ID を返すだけで DOM とエディタには触れない
 * @file
 */

/**
 * 選択したタブを履歴の末尾へ移した配列を返す
 * 同じタブが既にあれば前の位置から除くため、各タブは履歴に1回だけ現れる
 * @param history - 古い順のタブ ID。末尾が直近の選択
 * @param tabId - 新しく選択したタブ ID
 * @returns 更新後の履歴。引数の配列は変えない
 */
export function recordTabFocus(history: readonly string[], tabId: string): string[] {
	return [...history.filter((entry) => entry !== tabId), tabId];
}

/**
 * 選択中のタブを外したあとに選ぶタブを返す
 * 直前に選んでいたタブが残っていればそれを選ぶ。履歴に残るタブが無ければ外したタブの1つ左を選び、左端だったときは新しい左端を選ぶ
 * @param remainingTabIds - 外したあとに残るタブ ID。左から表示する順
 * @param history - 外したタブを除いた、古い順の選択履歴。末尾が直近
 * @param removedIndex - 外す前の並びでの位置。単位は添字
 * @returns 次に選ぶタブ ID。残るタブが無ければ null
 */
export function pickTabAfterRemoval(remainingTabIds: readonly string[], history: readonly string[], removedIndex: number): string | null {
	for (let index = history.length - 1; index >= 0; index--) {
		// 新しい方から見た履歴の1件。閉じ済みや別ペインへ移ったタブが混じることがある
		const tabId = history[index];
		// まだ並びに残っているときだけ、直前に選んでいたタブとして返す。残っていなければ1つ古い方を見る
		if (remainingTabIds.includes(tabId)) return tabId;
	}

	// 残るタブが無いときは選ぶものが無い
	if (remainingTabIds.length === 0) return null;

	// 外したタブの1つ左の添字。左端だったときは 0、範囲外の位置は末尾へ収める
	const leftIndex = Math.min(Math.max(removedIndex - 1, 0), remainingTabIds.length - 1);
	return remainingTabIds[leftIndex];
}
