/**
 * 芝の開催進行に「連続開催の通算の日数」と「いまの柵の日数」を足す計算(Issue #519)の純関数テスト。
 *
 * 入力は、レース ID・コース種別・今日の柵・開催日・過去の行(D1 の kaisai_days の行。読めなかったときは null)。
 * 日割は 2026 年の中山・東京に倣った値だが、テストの入力として自分で組んだ表であり、JRA の公式の日割そのものではない。
 *  - 2回中山 2/28〜3/22(8 日)→ 3回中山 3/28〜(間隔 6 日で連続)
 *  - 5回中山 2025/12/28(8 日目) → 1回中山 2026/1/4(間隔 7 日で連続。年またぎ)
 *  - 3回東京 6/21(8 日目) → 4回東京 10/3(間隔 104 日で連続しない)
 *
 * 判定の規則(ゲートで合意):
 *  - 今の回の 1〜N−1 日目が全部そろわなければ、新しい値は両方とも出さない(いまの文のまま)。
 *  - 回 K が 2 以上のとき、前の回は (同じ年, K−1) でなければならない。違えばデータ欠落とみなし、両方とも出さない。
 *  - 「連続しない」と言うのは、P が (Y, K−1) で、その回の 1〜P.日次がそろっていて、間隔が 7 日を超えるときだけ(K=1 は P が無い・間隔超過でも「連続しない」)。
 *  - 柵の日数は、連続の範囲の中で今日から遡る。違う柵に当たったら止め、柵が NULL の日に当たったら出さない。
 */

import { describe, expect, it } from "vitest";
import { assessTurfWear, type KaisaiDayRow } from "../../src/analyzer/turf-wear.js";
import type { CourseType } from "../../src/scraper/types.js";

const NEUTRAL_SUFFIX =
  "開催が進むほど芝の状態(特に内側)は変化しうるが、内外・前後の有利は断定しない材料として扱うこと。";

const NAKAYAMA = "06";
const TOKYO = "05";

const pad2 = (n: number): string => String(n).padStart(2, "0");
/** 12 桁のレース ID(年4・場2・回2・日次2・R2)。 */
const rid = (year: number, track: string, kai: number, nichi: number): string => `${year}${track}${pad2(kai)}${pad2(nichi)}11`;

/** 1 つの回の行(日次 1..dates.length)。fences は全日共通の 1 値か、日ごとの配列。 */
function meeting(
  track: string,
  year: number,
  kai: number,
  dates: readonly string[],
  fences: string | null | readonly (string | null)[],
): KaisaiDayRow[] {
  return dates.map((kaisaiDate, i) => ({
    trackCode: track,
    year,
    kai,
    nichi: i + 1,
    kaisaiDate,
    fence: Array.isArray(fences) ? ((fences as readonly (string | null)[])[i] ?? null) : (fences as string | null),
  }));
}

const NAKAYAMA_2026_2 = ["20260228", "20260301", "20260307", "20260308", "20260314", "20260315", "20260321", "20260322"];
const NAKAYAMA_2026_3 = ["20260328", "20260329", "20260404", "20260405", "20260411", "20260412", "20260418", "20260419"];
const NAKAYAMA_2025_5 = ["20251206", "20251207", "20251213", "20251214", "20251220", "20251221", "20251227", "20251228"];
const NAKAYAMA_2026_1 = ["20260104", "20260105", "20260110", "20260111", "20260117", "20260118", "20260124", "20260125"];
const NAKAYAMA_2025_4 = ["20251101", "20251102", "20251108", "20251109", "20251115", "20251116", "20251122", "20251123"];
const TOKYO_2026_3 = ["20260530", "20260531", "20260606", "20260607", "20260613", "20260614", "20260620", "20260621"];

/**
 * 2026 年の中山 1回(全日・柵A)と 2回(全日。柵は引数)。
 * 回 K≥2 の連続の判定は、前の回のさらに前の回(2回の前の 1回)の行があって初めて「2回の初日で連続が切れる」と言えるので、2回を使う場面では 1回もそろえる。
 * 1回の最終日(1/25)から 2回の初日(2/28)は 34 日で、連続しない。
 */
const kai12 = (fences2: string | null | readonly (string | null)[]): KaisaiDayRow[] => [
  ...meeting(NAKAYAMA, 2026, 1, NAKAYAMA_2026_1, "A"),
  ...meeting(NAKAYAMA, 2026, 2, NAKAYAMA_2026_2, fences2),
];
/** 2025 年の中山 4回(全日・柵A)と 5回(全日。柵は引数)。4回の最終日(11/23)から 5回の初日(12/6)は 13 日で、連続しない。 */
const kai45 = (fences5: string | null | readonly (string | null)[]): KaisaiDayRow[] => [
  ...meeting(NAKAYAMA, 2025, 4, NAKAYAMA_2025_4, "A"),
  ...meeting(NAKAYAMA, 2025, 5, NAKAYAMA_2025_5, fences5),
];

/** 今日(中山 2026 の回 kai・日次 nichi)の入力で assessTurfWear を呼ぶ。 */
const call = (
  raceId: string,
  fence: string | null,
  kaisaiDate: string,
  rows: readonly KaisaiDayRow[] | null,
  courseType: CourseType = "芝",
) => assessTurfWear(raceId, courseType, fence, { kaisaiDate, rows });

describe("assessTurfWear: 連続開催の通算と柵の日数(Issue #519)", () => {
  describe("実例に倣った正常系", () => {
    it("同じ年の連続: 2回(8日・柵B)→ 3回3日目(柵C)。通算11日目・2回から・柵Cは3日目(2回の柵Bで止まる)", () => {
      const rows = [...kai12("B"), ...meeting(NAKAYAMA, 2026, 3, NAKAYAMA_2026_3.slice(0, 2), "C")];
      const result = call(rid(2026, NAKAYAMA, 3, 3), "C", "20260404", rows);
      expect(result).toEqual({
        開催日次: 3,
        開催回次: 3,
        柵: "C",
        通算日次: 11,
        連続開始年: 2026,
        連続開始回: 2,
        柵日数: 3,
        note: `中央3回3日目(2回から連続開催で通算11日目。柵Cは3日目)。${NEUTRAL_SUFFIX}`,
      });
    });

    it("年またぎ(間隔 7 日): 前年5回(8日。最後の2日だけ柵A)→ 1回3日目(柵A)。「前年5回から」・通算11日目・柵Aは3日目", () => {
      // 5回は全日 D、1回の 1・2 日目と今日が A。A の日は 1回の 2 日 + 今日 = 3 日で、5回の D に当たって止まる。
      const rows = [
        ...kai45("D"),
        ...meeting(NAKAYAMA, 2026, 1, NAKAYAMA_2026_1.slice(0, 2), "A"),
      ];
      const result = call(rid(2026, NAKAYAMA, 1, 3), "A", "20260110", rows);
      expect(result).toEqual({
        開催日次: 3,
        開催回次: 1,
        柵: "A",
        通算日次: 11,
        連続開始年: 2025,
        連続開始回: 5,
        柵日数: 3,
        note: `中央1回3日目(前年5回から連続開催で通算11日目。柵Aは3日目)。${NEUTRAL_SUFFIX}`,
      });
    });

    it("連続の先頭まで全部同じ柵なら、連続の範囲の日数をそのまま出す(5回の8日+1回の2日+今日=11日目)", () => {
      const rows = [
        ...kai45("A"),
        ...meeting(NAKAYAMA, 2026, 1, NAKAYAMA_2026_1.slice(0, 2), "A"),
      ];
      const result = call(rid(2026, NAKAYAMA, 1, 3), "A", "20260110", rows);
      expect(result?.柵日数).toBe(11);
      expect(result?.通算日次).toBe(11);
      expect(result?.note).toBe(`中央1回3日目(前年5回から連続開催で通算11日目。柵Aは11日目)。${NEUTRAL_SUFFIX}`);
    });

    it("連続しない(3回東京 6/21 → 4回東京 10/3。間隔 104 日): N=1・通算は足さず、柵の日数は今日だけの 1 日目", () => {
      const rows = meeting(TOKYO, 2026, 3, TOKYO_2026_3, "A");
      const result = call(rid(2026, TOKYO, 4, 1), "C", "20261003", rows);
      expect(result).toEqual({
        開催日次: 1,
        開催回次: 4,
        柵: "C",
        通算日次: null,
        連続開始年: null,
        連続開始回: null,
        柵日数: 1,
        note: `中央4回1日目(柵Cは1日目)。${NEUTRAL_SUFFIX}`,
      });
    });

    it("N=1 で連続(2回の最終日 3/22 → 3回の初日 3/28): 初日は今日。通算は 1+8=9日目、柵Cは1日目(前の回が柵B)", () => {
      const rows = kai12("B");
      const result = call(rid(2026, NAKAYAMA, 3, 1), "C", "20260328", rows);
      expect(result?.通算日次).toBe(9);
      expect(result?.連続開始回).toBe(2);
      expect(result?.連続開始年).toBe(2026);
      expect(result?.柵日数).toBe(1);
      expect(result?.note).toBe(`中央3回1日目(2回から連続開催で通算9日目。柵Cは1日目)。${NEUTRAL_SUFFIX}`);
    });

    it("3つの回がつながる(1回・2回・3回): 通算は全部の日数の和、続き始めた回は一番前の回", () => {
      // 1回(2026/1/4〜1/25 の 8 日)→ 2回(2/1〜 8 日。間隔 7 日)→ 3回の 2 日目(間隔 7 日)。
      const kai1 = NAKAYAMA_2026_1; // 最終 1/25
      const kai2 = ["20260201", "20260207", "20260208", "20260214", "20260215", "20260221", "20260222", "20260228"]; // 最終 2/28
      const kai3Start = "20260307"; // 2/28 から 7 日
      const rows = [
        ...meeting(NAKAYAMA, 2026, 1, kai1, "A"),
        ...meeting(NAKAYAMA, 2026, 2, kai2, "A"),
        ...meeting(NAKAYAMA, 2026, 3, [kai3Start], "A"),
      ];
      // 3回の 2 日目(3/8)。1回の最終 1/25 → 2回の初日 2/1 は 7 日、2回の最終 2/28 → 3回の初日 3/7 は 7 日。
      const result = call(rid(2026, NAKAYAMA, 3, 2), "A", "20260308", rows);
      expect(result?.通算日次).toBe(8 + 8 + 2);
      expect(result?.連続開始回).toBe(1);
      expect(result?.柵日数).toBe(18);
    });
  });

  describe("連続の間隔の境界(P の日付から今の回の初日まで)", () => {
    // 2回(8日)の最終日 3/22 から、今の回の初日までの間隔を変える。
    const cases: Array<[string, string, boolean]> = [
      ["20260328", "6日", true],
      ["20260329", "7日", true],
      ["20260330", "8日", false],
    ];
    it.each(cases)("今の回の初日=%s(最終日 3/22 から%s)→ 連続=%s", (start, _label, continuing) => {
      const rows = kai12("B");
      const result = call(rid(2026, NAKAYAMA, 3, 1), "C", start, rows);
      expect(result).not.toBeNull();
      expect(result?.通算日次 !== null).toBe(continuing);
      expect(result?.通算日次).toBe(continuing ? 9 : null);
      // 連続しない場合でも「連続しない」と断定できる(前の回が (Y, K−1) で 1〜8 日がそろっている)ので、柵の日数は今の回の中だけで数える。
      expect(result?.柵日数).toBe(1);
    });
  });

  describe("欠けがあるときは新しい値を両方とも出さない(いまの文のまま)", () => {
    const base = (note: string) => `${note}。${NEUTRAL_SUFFIX}`;
    const empty = { 通算日次: null, 連続開始年: null, 連続開始回: null, 柵日数: null };

    it("今の回の 1〜N−1 日目に欠け(2 日目が無い)→ 出さない", () => {
      const cur = meeting(NAKAYAMA, 2026, 3, NAKAYAMA_2026_3.slice(0, 2), "C").filter((r) => r.nichi !== 2);
      const rows = [...kai12("B"), ...cur];
      const result = call(rid(2026, NAKAYAMA, 3, 3), "C", "20260404", rows);
      expect(cur).toHaveLength(1); // 前提: 欠けている
      expect(result).toEqual({ 開催日次: 3, 開催回次: 3, 柵: "C", ...empty, note: base("中央3回3日目(柵C)") });
    });

    it("前の回の途中の日(5 日目)が無い → 出さない(連続の判定ができない)", () => {
      const prev = kai12("B").filter((r) => !(r.kai === 2 && r.nichi === 5));
      const rows = [...prev, ...meeting(NAKAYAMA, 2026, 3, NAKAYAMA_2026_3.slice(0, 2), "C")];
      const result = call(rid(2026, NAKAYAMA, 3, 3), "C", "20260404", rows);
      expect(prev).toHaveLength(8 + 7); // 前提: 欠けている(1回 8 日 + 2回 7 日)
      expect(result).toEqual({ 開催日次: 3, 開催回次: 3, 柵: "C", ...empty, note: base("中央3回3日目(柵C)") });
    });

    it("K≥2 で、直前の行が (同じ年, K−1) の回でない(2回が丸ごと無く 1回だけある)→ データ欠落とみなして出さない", () => {
      const rows = [...meeting(NAKAYAMA, 2026, 1, NAKAYAMA_2026_1, "A"), ...meeting(NAKAYAMA, 2026, 3, NAKAYAMA_2026_3.slice(0, 2), "C")];
      const result = call(rid(2026, NAKAYAMA, 3, 3), "C", "20260404", rows);
      expect(result).toEqual({ 開催日次: 3, 開催回次: 3, 柵: "C", ...empty, note: base("中央3回3日目(柵C)") });
    });

    it("連続の途中の回(2回)の前の回(1回)の行が丸ごと無い → 2回が連続の先頭か判定できないので出さない", () => {
      const rows = [...meeting(NAKAYAMA, 2026, 2, NAKAYAMA_2026_2, "B"), ...meeting(NAKAYAMA, 2026, 3, NAKAYAMA_2026_3.slice(0, 2), "C")];
      const result = call(rid(2026, NAKAYAMA, 3, 3), "C", "20260404", rows);
      expect(result).toEqual({ 開催日次: 3, 開催回次: 3, 柵: "C", ...empty, note: base("中央3回3日目(柵C)") });
    });

    it("K≥2 で、今の回より前の行が 1 つも無い → 出さない(「連続しない」とは言わない)", () => {
      const rows = meeting(NAKAYAMA, 2026, 3, NAKAYAMA_2026_3.slice(0, 2), "C");
      const result = call(rid(2026, NAKAYAMA, 3, 3), "C", "20260404", rows);
      expect(result).toEqual({ 開催日次: 3, 開催回次: 3, 柵: "C", ...empty, note: base("中央3回3日目(柵C)") });
    });

    it("K≥2 で前の回が (Y, K−1) だが 1〜P.日次がそろっていない(間隔が 7 日を超えて連続しない側でも、欠けていれば断定しない)→ 出さない", () => {
      // 東京 3回の 8 日のうち 3 日目が無く、4回東京 10/3 と 104 日離れている。
      const prev = meeting(TOKYO, 2026, 3, TOKYO_2026_3, "A").filter((r) => r.nichi !== 3);
      const result = call(rid(2026, TOKYO, 4, 1), "C", "20261003", prev);
      expect(prev).toHaveLength(7);
      expect(result).toEqual({ 開催日次: 1, 開催回次: 4, 柵: "C", ...empty, note: base("中央4回1日目(柵C)") });
    });

    it("過去の行が読めなかった(rows=null)→ いまの文のまま", () => {
      const result = call(rid(2026, NAKAYAMA, 3, 3), "C", "20260404", null);
      expect(result).toEqual({ 開催日次: 3, 開催回次: 3, 柵: "C", ...empty, note: base("中央3回3日目(柵C)") });
    });

    it("日次の順に日付が増えていない行(壊れた行)→ 出さない", () => {
      const prev = kai12("B");
      const i = prev.findIndex((r) => r.kai === 2 && r.nichi === 4);
      prev[i] = { ...prev[i]!, kaisaiDate: "20260301" }; // 2回の 4 日目が 2 日目と同じ日付
      const rows = [...prev, ...meeting(NAKAYAMA, 2026, 3, NAKAYAMA_2026_3.slice(0, 2), "C")];
      const result = call(rid(2026, NAKAYAMA, 3, 3), "C", "20260404", rows);
      expect(result).toEqual({ 開催日次: 3, 開催回次: 3, 柵: "C", ...empty, note: base("中央3回3日目(柵C)") });
    });

    it("K≥2 の前の回が、年の違う K−1 回(2028 年 4 回の前に、2027 年 3 回はあるが 2028 年 3 回が丸ごと無い)→ データ欠落とみなして出さない", () => {
      // 2027 年の 3 回は全日そろっていて、その前の 2回との間隔も 7 日を超える(「同じ年」の確認を外すと、連続と判定されて通算が出る)。
      const kai2 = meeting(NAKAYAMA, 2027, 2, ["20271016", "20271017", "20271023", "20271024", "20271030", "20271031", "20271106", "20271107"], "A");
      const kai3 = meeting(NAKAYAMA, 2027, 3, ["20271204", "20271205", "20271211", "20271212", "20271218", "20271219", "20271224", "20271225"], "A");
      const cur = meeting(NAKAYAMA, 2028, 4, ["20280101", "20280102"], "A"); // 2027 年 3 回の最終日 12/25 から 7 日
      const result = call(rid(2028, NAKAYAMA, 4, 3), "A", "20280108", [...kai2, ...kai3, ...cur]);
      expect(result).toEqual({ 開催日次: 3, 開催回次: 4, 柵: "A", ...empty, note: base("中央4回3日目(柵A)") });
    });

    it("今の回の 2 日目の行が今日と同じ日付(壊れた行。今日以降の行は使わない)→ 出さない", () => {
      const cur = meeting(NAKAYAMA, 2026, 3, ["20260328", "20260404"], "C"); // 2 日目が今日(4/4)と同じ
      const result = call(rid(2026, NAKAYAMA, 3, 3), "C", "20260404", [...kai12("B"), ...cur]);
      expect(result).toEqual({ 開催日次: 3, 開催回次: 3, 柵: "C", ...empty, note: base("中央3回3日目(柵C)") });
    });

    it("開催日が YYYYMMDD の実在日でない → 出さない", () => {
      const rows = kai12("B");
      const result = call(rid(2026, NAKAYAMA, 3, 1), "C", "20260230", rows);
      expect(result).toEqual({ 開催日次: 1, 開催回次: 3, 柵: "C", ...empty, note: base("中央3回1日目(柵C)") });
    });
  });

  describe("K=1(前の回の番号が分からない)", () => {
    it("K=1 で、渡された行に今の回より前の行が無い → 連続しない。柵の日数は今の回の中だけで数える", () => {
      const rows = meeting(NAKAYAMA, 2026, 1, NAKAYAMA_2026_1.slice(0, 2), "A");
      const result = call(rid(2026, NAKAYAMA, 1, 3), "A", "20260110", rows);
      expect(result?.通算日次).toBeNull();
      expect(result?.柵日数).toBe(3);
      expect(result?.note).toBe(`中央1回3日目(柵Aは3日目)。${NEUTRAL_SUFFIX}`);
    });

    it("前年の最後の行が 7 日を超えて離れている → 連続しない", () => {
      const prev = meeting(NAKAYAMA, 2025, 5, NAKAYAMA_2025_5.slice(0, 7), "A"); // 最後が 12/27
      const rows = [...prev, ...meeting(NAKAYAMA, 2026, 1, NAKAYAMA_2026_1.slice(0, 2), "A")];
      // 12/27 → 1/4 は 8 日。
      const result = call(rid(2026, NAKAYAMA, 1, 3), "A", "20260110", rows);
      expect(result?.通算日次).toBeNull();
      expect(result?.note).toBe(`中央1回3日目(柵Aは3日目)。${NEUTRAL_SUFFIX}`);
    });

    it("前年の回の 1〜P.日次がそろっていなければ、間隔が 7 日以内でも出さない", () => {
      const prev = meeting(NAKAYAMA, 2025, 5, NAKAYAMA_2025_5, "A").filter((r) => r.nichi !== 4);
      const rows = [...prev, ...meeting(NAKAYAMA, 2026, 1, NAKAYAMA_2026_1.slice(0, 2), "A")];
      const result = call(rid(2026, NAKAYAMA, 1, 3), "A", "20260110", rows);
      expect(result?.通算日次).toBeNull();
      expect(result?.柵日数).toBeNull();
      expect(result?.note).toBe(`中央1回3日目(柵A)。${NEUTRAL_SUFFIX}`);
    });

    it("直前の行が同じ年の回(K=1 なのに同じ年の回がある)→ 矛盾したデータとして出さない", () => {
      // 2026 年の 2回の行が、1回の初日(1/4)より前の日付で入っている壊れたデータ。
      const earlier = meeting(NAKAYAMA, 2026, 2, ["20251227", "20251228"], "A");
      const rows = [...earlier, ...meeting(NAKAYAMA, 2026, 1, NAKAYAMA_2026_1.slice(0, 2), "A")];
      const result = call(rid(2026, NAKAYAMA, 1, 3), "A", "20260110", rows);
      expect(result?.通算日次).toBeNull();
      expect(result?.柵日数).toBeNull();
      expect(result?.note).toBe(`中央1回3日目(柵A)。${NEUTRAL_SUFFIX}`);
    });
  });

  describe("柵の日数", () => {
    it("柵が NULL の日に当たったら出さない(推測しない)。通算は出る", () => {
      const prev = kai12(["B", "B", "B", "B", "B", "B", "B", null]);
      const rows = [...prev, ...meeting(NAKAYAMA, 2026, 3, NAKAYAMA_2026_3.slice(0, 2), "C")];
      // 今日の柵 C → 3回の 2 日 + 今日 = 3 日、次は 2回の 8 日目(NULL)に当たる。
      const result = call(rid(2026, NAKAYAMA, 3, 3), "C", "20260404", rows);
      expect(result?.柵日数).toBeNull();
      expect(result?.通算日次).toBe(11);
      expect(result?.note).toBe(`中央3回3日目(2回から連続開催で通算11日目。柵C)。${NEUTRAL_SUFFIX}`);
    });

    it("今の回の中に柵が NULL の日があるときも、柵が違う日より先に NULL に当たれば出さない", () => {
      const rows = [
        ...kai12("B"),
        ...meeting(NAKAYAMA, 2026, 3, NAKAYAMA_2026_3.slice(0, 2), [null, "C"]),
      ];
      const result = call(rid(2026, NAKAYAMA, 3, 3), "C", "20260404", rows);
      expect(result?.柵日数).toBeNull();
      expect(result?.note).toBe(`中央3回3日目(2回から連続開催で通算11日目。柵C)。${NEUTRAL_SUFFIX}`);
    });

    it("柵の切り替え(A→B→C): 今日が C の 2 日目なら 2 日目(B の日で止まる。その前の A には進まない)", () => {
      const rows = meeting(NAKAYAMA, 2026, 3, NAKAYAMA_2026_3.slice(0, 5), ["A", "A", "B", "B", "C"]);
      const prev = kai12("A");
      const result = call(rid(2026, NAKAYAMA, 3, 6), "C", "20260412", [...prev, ...rows]);
      expect(result?.柵日数).toBe(2);
      expect(result?.note).toBe(`中央3回6日目(2回から連続開催で通算14日目。柵Cは2日目)。${NEUTRAL_SUFFIX}`);
    });

    it("今日の柵が分からない(芝だが柵不明 null)→ 柵の日数は出さないが、通算は出る", () => {
      const rows = [...kai12("B"), ...meeting(NAKAYAMA, 2026, 3, NAKAYAMA_2026_3.slice(0, 2), "C")];
      const result = call(rid(2026, NAKAYAMA, 3, 3), null, "20260404", rows);
      expect(result?.柵).toBeNull();
      expect(result?.柵日数).toBeNull();
      expect(result?.通算日次).toBe(11);
      expect(result?.note).toBe(`中央3回3日目(2回から連続開催で通算11日目)。${NEUTRAL_SUFFIX}`);
    });

    it("連続していなくて今日の柵が分からない → いまの文と同じ(括弧なし)", () => {
      const rows = meeting(TOKYO, 2026, 3, TOKYO_2026_3, "A");
      const result = call(rid(2026, TOKYO, 4, 1), null, "20261003", rows);
      expect(result?.note).toBe(`中央4回1日目。${NEUTRAL_SUFFIX}`);
      expect(result?.柵日数).toBeNull();
    });
  });

  describe("対象外・無視する行", () => {
    it("芝以外(ダ・障)は、履歴があっても null", () => {
      const rows = kai12("B");
      expect(call(rid(2026, NAKAYAMA, 3, 1), "C", "20260328", rows, "ダ")).toBeNull();
      expect(call(rid(2026, NAKAYAMA, 3, 1), "C", "20260328", rows, "障")).toBeNull();
    });

    it("地方のレース ID は、履歴があっても null", () => {
      const rows = meeting("54", 2026, 2, NAKAYAMA_2026_2, "B");
      expect(call("202654020111", "C", "20260328", rows)).toBeNull();
    });

    it("別の場の行・今日以降の日付の行(今日の行を含む)は無視する", () => {
      const noise: KaisaiDayRow[] = [
        ...meeting(TOKYO, 2026, 2, NAKAYAMA_2026_2, "B"), // 別の場: 無視(中山の 2回が無い扱いなので、出ない)
        ...meeting(NAKAYAMA, 2026, 3, NAKAYAMA_2026_3.slice(0, 3), "C"), // 3 日目(= 今日 4/4)の行を含む
      ];
      const own = [...kai12("B"), ...meeting(NAKAYAMA, 2026, 3, NAKAYAMA_2026_3.slice(0, 3), "C")];
      // 別の場だけ + 中山の 3回(今日の行を含む)では、2回が無いので出ない(K≥2 で直前の行が無い)。
      expect(call(rid(2026, NAKAYAMA, 3, 3), "C", "20260404", noise)?.通算日次).toBeNull();
      // 中山の 2回が加わった own では、今日の行(3 日目 = 4/4)が混ざっていても、混ざっていない場合と同じ結果になる。
      const withToday = call(rid(2026, NAKAYAMA, 3, 3), "C", "20260404", own);
      const without = call(rid(2026, NAKAYAMA, 3, 3), "C", "20260404", own.filter((r) => !(r.kai === 3 && r.nichi === 3)));
      expect(withToday).toEqual(without);
      expect(withToday?.通算日次).toBe(11);
    });

    it("回次が「00」(回次なし)のときは履歴を使わず、いまの文のまま", () => {
      const result = assessTurfWear("202606000811", "芝", "B", { kaisaiDate: "20260328", rows: [] });
      expect(result?.note).toBe(`中央8日目(柵B)。${NEUTRAL_SUFFIX}`);
      expect(result?.通算日次).toBeNull();
    });
  });

  describe("履歴を渡さない・null を渡したときは、いまの出力とバイト単位で同じ", () => {
    it.each([
      ["履歴なし(引数省略)", undefined],
      ["履歴 null", null],
    ])("%s: note はいまの文と同じ、新しい値は null", (_label, history) => {
      const result = history === undefined ? assessTurfWear("202605020811", "芝", "C") : assessTurfWear("202605020811", "芝", "C", history);
      expect(result).toEqual({
        開催日次: 8,
        開催回次: 2,
        柵: "C",
        通算日次: null,
        連続開始年: null,
        連続開始回: null,
        柵日数: null,
        note: `中央2回8日目(柵C)。${NEUTRAL_SUFFIX}`,
      });
    });
  });
});
