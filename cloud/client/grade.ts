/**
 * グレードの表示ラベル(Issue #250。純関数)。一覧の行・レース画面・結果画面の見出しと、Discord のタイトル(`src/notify-embeds.ts`)が同じ判定を使う。
 *
 * 出すのは**重賞だけ**(ユーザー指定): 中央の G1〜G3・J・G1〜J・G3、地方の Jpn1〜Jpn3 と「重賞」。
 * L(リステッド)・OP・条件クラスなど重賞ではないものと、想定外の文字列は出さない(推測して出さない)。
 * 入力は core の `RaceListEntry.grade` / `ShutubaRaceInfo.grade`(中央は実測した番号から作ったラベル、地方は生テキスト)。
 */

/** 表示する種類(完全一致)。全角数字・ローマ数字・小文字は、実測に無いので通さない。 */
const SHOWN_GRADES: ReadonlySet<string> = new Set(["G1", "G2", "G3", "J・G1", "J・G2", "J・G3", "Jpn1", "Jpn2", "Jpn3", "重賞"]);

/** 表示するグレードならそのラベル(前後の空白は除く)、表示しない・無いなら null。 */
export function gradeLabelForDisplay(grade: string | null | undefined): string | null {
  if (grade === null || grade === undefined) return null;
  const trimmed = grade.trim();
  return SHOWN_GRADES.has(trimmed) ? trimmed : null;
}

/**
 * レース名の直後に「(グレード)」を付ける(例: `アイルランドT(G3)`。netkeiba の title と同じ形)。
 * 表示しないグレードはレース名のまま。**レース名が空・null のときは空文字**(名前の無い見出しにグレードだけを付けない)。
 */
export function nameWithGrade(name: string | null, grade: string | null | undefined): string {
  if (name === null || name === "") return "";
  const label = gradeLabelForDisplay(grade);
  return label === null ? name : `${name}(${label})`;
}
