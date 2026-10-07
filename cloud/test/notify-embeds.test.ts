import { describe, expect, it } from "vitest";

import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import {
  buildAnalysisNotificationEmbed,
  buildFailureEmbed,
  buildManualSkipEmbed,
  buildMinimalAnalysisEmbed,
  buildSummaryEmbed,
  CAP_TEXT,
  embedLength,
  EMBED_LIMITS,
  failureText,
  fitEmbed,
  MANUAL_SKIP_TEXT,
  NO_START_TIME_TEXT,
  notificationText,
  type CloudEmbed,
  type RaceLabel,
} from "../src/notify-embeds";
import type { PlanProgress } from "../src/race-day-core";

/**
 * Issue #205(#166-D): Discord の通知の embed を組み立てる純関数。
 * 上限(description 4096・field value 1024・field name 256・field 25 個・embed 全体 6000)を、境界値の表で固定する(AC-D4)。長さは UTF-16 の `.length`(コードポイントより保守側)。
 */

const label = (over: Partial<RaceLabel> = {}): RaceLabel => ({ raceId: "202606040911", venueName: "中山", raceNumber: 11, raceName: "テストステークス", startTime: "15:40", ...over });

describe("fitEmbed(AC-D4: 上限の境界値)", () => {
  const field = (value: string, name = "f"): { name: string; value: string } => ({ name, value });
  const lines = (n: number, len: number): string => Array.from({ length: n }, (_, i) => `${String(i).padStart(2, "0")}${"あ".repeat(len - 2)}`).join("\n");

  it("前提: 上限の定数は Discord の仕様どおり(description 4096・field value 1024・field name 256・title 256・field 25・全体 6000)", () => {
    expect(EMBED_LIMITS).toEqual({ title: 256, description: 4096, fieldName: 256, fieldValue: 1024, fields: 25, total: 6000 });
  });

  it.each([
    [4095, false],
    [4096, false],
    [4097, true],
  ] as const)("description が %i 文字: 切り詰めの要否 %s。結果は常に 4096 以内で、超えたときだけ末尾が「…」", (length, truncated) => {
    const out = fitEmbed({ title: "t", description: "あ".repeat(length) });
    expect(out.description!.length).toBeLessThanOrEqual(4096);
    expect(out.description!.endsWith("…")).toBe(truncated);
    if (!truncated) {
      expect(out.description).toBe("あ".repeat(length)); // 収まるものは変えない
    }
  });

  it.each([
    [1023, false],
    [1024, false],
    [1025, true],
  ] as const)("field の value が %i 文字(1 行 40 文字の行の並び): 行単位で落とし、「…ほか N 件」を付ける(切ったかどうか %s)", (length, cut) => {
    // 40 文字の行(区切りの改行を含めて 41)の並びで、合計がちょうど length になるように最後の行を調整する。
    const rows: string[] = [];
    let total = 0;
    while (total < length) {
      const room = length - total - (rows.length > 0 ? 1 : 0);
      const row = "あ".repeat(Math.min(40, room));
      rows.push(row);
      total += row.length + (rows.length > 1 ? 1 : 0);
    }
    const value = rows.join("\n");
    expect(value.length).toBe(length); // 前提: 狙いの長さ
    const out = fitEmbed({ title: "t", fields: [field(value)] });
    const fitted = out.fields![0]!.value;
    expect(fitted.length).toBeLessThanOrEqual(1024);
    if (!cut) {
      expect(fitted).toBe(value);
    } else {
      const kept = fitted.split("\n").length - 1; // 最後の 1 行は「…ほか N 件」
      expect(fitted.split("\n").at(-1)).toBe(`…ほか ${rows.length - kept} 件`);
      expect(kept).toBeGreaterThan(0); // 空振り防止: 行は残っている
      expect(kept).toBeLessThan(rows.length); // 空振り防止: 実際に落ちている
    }
  });

  it("「…ほか N 件」の N は、落とした行の数ちょうど(残した行 + N = 元の行数)", () => {
    const value = lines(50, 30); // 50 行 × 30 文字
    const out = fitEmbed({ title: "t", fields: [field(value)] });
    const parts = out.fields![0]!.value.split("\n");
    const dropped = Number(/…ほか (\d+) 件/.exec(parts.at(-1)!)![1]);
    expect(parts.length - 1 + dropped).toBe(50);
    expect(dropped).toBeGreaterThan(0);
  });

  it("field の name が 257 文字 → 256 以内に切る。field が 26 個 → 25 個に切る", () => {
    const out = fitEmbed({ title: "t", fields: Array.from({ length: 26 }, (_, i) => field("v", i === 0 ? "あ".repeat(257) : `n${i}`)) });
    expect(out.fields).toHaveLength(25);
    expect(out.fields![0]!.name.length).toBeLessThanOrEqual(256);
    const exact = fitEmbed({ title: "t", fields: Array.from({ length: 25 }, (_, i) => field("v", `n${i}`)) });
    expect(exact.fields).toHaveLength(25); // 25 個ちょうどは落とさない
  });

  it("title が 257 文字 → 256 以内", () => {
    expect(fitEmbed({ title: "あ".repeat(257) }).title!.length).toBeLessThanOrEqual(256);
    expect(fitEmbed({ title: "あ".repeat(256) }).title).toBe("あ".repeat(256));
  });

  it.each([5999, 6000, 6001] as const)("embed 全体が %i 文字: 結果は 6000 以内。収まる入力は変えない", (target) => {
    // description 1000 + field 1020 × n で、全体をちょうど target にする(最後の field で調整)。
    const fields: { name: string; value: string }[] = [];
    let total = 1 + 1000; // title "t" + description
    while (total < target) {
      const room = target - total - 1; // name "f" の 1 文字
      const value = "あ".repeat(Math.min(1020, room));
      fields.push({ name: "f", value });
      total += 1 + value.length;
    }
    const input: CloudEmbed = { title: "t", description: "あ".repeat(1000), fields };
    expect(embedLength(input)).toBe(target); // 前提: 狙いの長さ
    expect(fields.length).toBeGreaterThan(3); // 前提: 複数の field にまたがっている
    const out = fitEmbed(input);
    expect(embedLength(out)).toBeLessThanOrEqual(6000);
    if (target <= 6000) {
      expect(out).toEqual(input);
    } else {
      expect(embedLength(out)).toBeGreaterThan(5000); // 空振り防止: 必要以上に落としていない
    }
  });

  it("全体の超過は末尾の field から落とす(先頭の field は残る)。それでも超える極端な入力は、description を切って収める", () => {
    const fields = Array.from({ length: 6 }, (_, i) => field(Array.from({ length: 20 }, (_, j) => `${i}-${j}${"あ".repeat(46)}`).join("\n"), `v${i}`));
    const out = fitEmbed({ title: "t", description: "あ".repeat(4096), fields });
    expect(embedLength(out)).toBeLessThanOrEqual(6000);
    expect(out.fields![0]!.value.startsWith("0-0")).toBe(true); // 先頭の field は残る
    const extreme = fitEmbed({ title: "あ".repeat(256), description: "あ".repeat(4096), fields: Array.from({ length: 25 }, (_, i) => field("あ".repeat(1024), "あ".repeat(256) + i)) });
    expect(embedLength(extreme)).toBeLessThanOrEqual(6000);
    for (const f of extreme.fields ?? []) {
      expect(f.value.length).toBeGreaterThan(0); // Discord は空の value を拒否する
    }
  });

  it("サロゲートペア(𠮷)を割らない: 切り詰めた結果に孤立サロゲートが無い", () => {
    const out = fitEmbed({ title: "t", description: "𠮷".repeat(3000) }); // UTF-16 で 6000 単位
    expect(out.description!.length).toBeLessThanOrEqual(4096);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out.description!)).toBe(false);
  });
});

describe("失敗・手動スキップの通知(G-D3。本文は理由ごとの固定文だけ)", () => {
  it("失敗の embed: 赤。タイトルは「会場 N R レース名」。本文は発走時刻と固定の理由文", () => {
    const out = buildFailureEmbed(label(), failureText("blocked"));
    expect(out.color).toBe(0xe74c3c);
    expect(out.title).toBe("中山 11R テストステークス");
    expect(out.description).toContain("発走 15:40");
    expect(out.description).toContain(failureText("blocked"));
  });

  it("失敗の理由文は 5 通り(started・blocked・fetch-exhausted・compute-exhausted・unknown)でそれぞれ異なる固定文", () => {
    const reasons = ["started", "blocked", "fetch-exhausted", "compute-exhausted", "unknown"] as const;
    const texts = reasons.map((r) => failureText(r));
    expect(new Set(texts).size).toBe(5);
    for (const text of texts) {
      expect(text.length).toBeGreaterThan(5);
    }
  });

  it("notificationText: 結果ごとの固定文(failed は理由ごと、昇格の時点のスキップは started・cap・no-start-time)。タスクのエラー文の生の値(message)は使わない。通知しない結果は unknown の固定文", () => {
    expect(notificationText({ kind: "failed", reason: "compute-exhausted", message: "生のエラー文 https://x" })).toBe(failureText("compute-exhausted"));
    expect(notificationText({ kind: "failed", reason: "unknown", message: null })).toBe(failureText("unknown"));
    expect(notificationText({ kind: "skipped", reason: "started" })).toBe(failureText("started"));
    expect(notificationText({ kind: "skipped", reason: "cap" })).toBe(CAP_TEXT);
    expect(notificationText({ kind: "skipped", reason: "no-start-time" })).toBe(NO_START_TIME_TEXT);
    expect(notificationText({ kind: "superseded" })).toBe(failureText("unknown"));
    expect(new Set([CAP_TEXT, NO_START_TIME_TEXT, failureText("started"), failureText("unknown")]).size).toBe(4); // 前提: 互いに別の文
  });

  it("手動スキップの embed: 灰色。固定文「手動の分析があるため、自動の分析は行いませんでした」", () => {
    expect(MANUAL_SKIP_TEXT).toBe("手動の分析があるため、自動の分析は行いませんでした");
    const out = buildManualSkipEmbed(label());
    expect(out.color).toBe(0x95a5a6);
    expect(out.description).toContain(MANUAL_SKIP_TEXT);
  });

  it("会場名が無いときは、レースID から導出する(中山=06)。レース番号・発走時刻が無くても落ちない", () => {
    expect(buildFailureEmbed(label({ venueName: null }), "x").title).toBe("中山 11R テストステークス");
    const bare = buildFailureEmbed(label({ venueName: null, raceNumber: null, raceName: null, startTime: null }), "x");
    expect(bare.title).toBe("中山");
    expect(bare.description).not.toContain("発走");
  });

  it("最小の分析完了の embed(材料を組み立てられなかったときの代替): 灰色で『画面で確認』を促す", () => {
    const out = buildMinimalAnalysisEmbed(label());
    expect(out.title).toBe("中山 11R テストステークス");
    expect(out.description).toContain("画面");
  });
});

// ---- 分析の embed(record から)----

function record(over: Partial<AnalysisRecord> = {}, snapshot: unknown = undefined): AnalysisRecord {
  return {
    raceId: "202606040911",
    analyzedAt: "2026-09-27T05:00:00.000Z",
    kaisaiDate: "20260927",
    evEstimated: false,
    horses: [
      { umaban: 1, prior: 0.3, adjustedProb: 0.42, placeOddsMin: 2.5, ev: 1.05, isPositive: true, contributions: null, mark: "◎" },
      { umaban: 2, prior: 0.2, adjustedProb: 0.25, placeOddsMin: 3, ev: 0.75, isPositive: false, contributions: null, mark: null },
      { umaban: 3, prior: 0.1, adjustedProb: 0.15, placeOddsMin: null, ev: null, isPositive: false, contributions: null, mark: null },
    ],
    raceSnapshot:
      snapshot !== undefined
        ? snapshot
        : {
            race: { raceName: "テストステークス", courseType: "芝", distance: 1600, oddsStatus: "result" },
            horses: [
              { umaban: 1, name: "アルファ" },
              { umaban: 2, name: "ブラボー" },
              { umaban: 3, name: null },
            ],
          },
    ...over,
  } as AnalysisRecord;
}

describe("buildAnalysisNotificationEmbed(AC-D1: 狙い目あり=緑・なし=灰・LLM なし=理由の固定文)", () => {
  const effective = { effective: true, note: null } as const;

  it("狙い目あり(isPositive の馬がいる): 緑。馬番・馬名・補正後確率・複勝下限・EV の行がある。タイトルは「会場 レース名」、メタ行に日付・コース・距離", () => {
    const out = buildAnalysisNotificationEmbed(record(), effective, label());
    expect(out.color).toBe(0x2ecc71);
    expect(out.title).toBe("中山 テストステークス");
    expect(out.description).toContain("2026/09/27 / 中山 / 芝1600m");
    expect(out.description).toContain("◎ 1番 アルファ AI補正後42.0% 複勝下限2.5 EV1.05");
    expect(out.description).not.toContain("ブラボー"); // EV プラスでない馬は出さない
    expect(out.description).toContain("LLM補正: 実行");
  });

  it("狙い目なし(isPositive の馬がいない): 灰色。「該当なし」", () => {
    const none = record({ horses: record().horses.map((h) => ({ ...h, isPositive: false })) });
    const out = buildAnalysisNotificationEmbed(none, effective, label());
    expect(out.color).toBe(0x95a5a6);
    expect(out.description).toContain("該当なし");
  });

  it("LLM が効かなかった(note あり): 「LLM補正: スキップ」と、固定の理由文(note)が description に載る。色は狙い目の有無のまま", () => {
    const note = "LLM の API キーが未登録のため、LLM を使わず統計のみで分析しました";
    const out = buildAnalysisNotificationEmbed(record(), { effective: false, note }, label());
    expect(out.description).toContain("LLM補正: スキップ");
    expect(out.description).toContain(`LLM補正の注記: ${note}`);
    expect(out.color).toBe(0x2ecc71);
    const marksDropped = buildAnalysisNotificationEmbed(record(), { effective: true, note: "印の制約違反のため、印は付けていません(3着内率の補正は反映しています)" }, label());
    expect(marksDropped.description).toContain("LLM補正: 実行"); // 補正は効いている
    expect(marksDropped.description).toContain("LLM補正の注記: 印の制約違反");
  });

  it("note が無いときは注記の行を出さない", () => {
    expect(buildAnalysisNotificationEmbed(record(), effective, label()).description).not.toContain("注記");
  });

  it("馬名が無い馬は「N番」で代用する(狙い目の馬の行)", () => {
    const nameless = record({}, { race: { raceName: "R", courseType: "ダ", distance: 1200, oddsStatus: "result" }, horses: [{ umaban: 1, name: null }] });
    expect(buildAnalysisNotificationEmbed(nameless, effective, label()).description).toContain("1番 1番 AI補正後");
  });

  it("発売中(middle)・予想(yoso)のオッズは注記が付く(core の embed のまま)", () => {
    const yoso = record({}, { race: { raceName: "R", courseType: "芝", distance: 1600, oddsStatus: "yoso" }, horses: [] });
    expect(buildAnalysisNotificationEmbed(yoso, effective, label()).description).toContain("複勝未発売");
  });

  it("推定 EV(record.evEstimated)の馬の行には「(推定)」が付く", () => {
    const out = buildAnalysisNotificationEmbed(record({ evEstimated: true }), effective, label());
    expect(out.description).toContain("EV1.05(推定)");
  });

  it.each([
    ["スナップショットが無い", null],
    ["race が無い", { horses: [] }],
    ["distance が数でない", { race: { raceName: "R", courseType: "芝", distance: "1600", oddsStatus: "result" }, horses: [] }],
    ["oddsStatus が未知の値", { race: { raceName: "R", courseType: "芝", distance: 1600, oddsStatus: "x" }, horses: [] }],
    ["horses が配列でない", { race: { raceName: "R", courseType: "芝", distance: 1600, oddsStatus: "result" }, horses: 1 }],
  ] as const)("スナップショットが想定の形でない(%s): 投げる(呼び出し側が最小の embed に代える)", (_name, snapshot) => {
    expect(() => buildAnalysisNotificationEmbed(record({}, snapshot), effective, label())).toThrow();
  });

  it("開催日が無い(kaisaiDate が null)ときは、日付を空にせず落ちもしない(メタ行は会場・コースだけ)", () => {
    const out = buildAnalysisNotificationEmbed(record({ kaisaiDate: null }), effective, label());
    expect(out.description).toContain("中山 / 芝1600m");
  });
});

// ---- 朝のまとめ ----

type Row = PlanProgress["rows"][number];
type Venue = PlanProgress["venues"][number];

const row = (over: Partial<Row> & { raceId: string }): Row => ({
  venue: "central",
  venueName: "中山",
  raceNumber: 1,
  raceName: "R",
  grade: null,
  startTime: "10:00",
  dueMs: 1,
  disposition: "scheduled",
  skipReason: null,
  state: "promoted",
  morning: "done",
  ...over,
});
const venue = (over: Partial<Venue> & { venue: Venue["venue"] }): Venue => ({ state: "ok", attempts: 1, reason: null, listed: 12, targeted: 12, ...over });

function progress(over: Partial<PlanProgress> = {}): PlanProgress {
  const rows = over.rows ?? [row({ raceId: "202606040901" })];
  return {
    stage: "done",
    requestedAt: 1,
    finalizedAt: 2,
    offsetMinutes: 45,
    offsetSource: "settings",
    venues: [venue({ venue: "central" }), venue({ venue: "nar", listed: 0, targeted: 0 })],
    rows,
    morningAllTerminal: rows.every((r) => r.state === "skipped" || r.morning === "done" || r.morning === "failed"),
    ...over,
  };
}

describe("buildSummaryEmbed(AC-D3・AC-D5: 朝のまとめ)", () => {
  it("中央は場ごとに field、地方は「地方 交流重賞」の field。1つの embed に並ぶ。全部 OK なら緑", () => {
    const rows = [
      row({ raceId: "202606040901", raceNumber: 1, raceName: "中山1", venueName: "中山", startTime: "10:05" }),
      row({ raceId: "202609030901", raceNumber: 1, raceName: "阪神1", venueName: "阪神", startTime: "10:10" }),
      row({ raceId: "202636092711", venue: "nar", venueName: "水沢", raceNumber: 11, raceName: "地方Jpn", grade: "Jpn3", startTime: "20:10" }),
    ];
    const out = buildSummaryEmbed({ kaisaiDate: "20260927", progress: progress({ rows, venues: [venue({ venue: "central", listed: 2, targeted: 2 }), venue({ venue: "nar", listed: 12, targeted: 1 })] }) });
    expect(out.title).toBe("朝の準備 2026/09/27");
    expect(out.fields!.map((f) => f.name)).toEqual(["中山", "阪神", "地方 交流重賞"]);
    expect(out.fields![0]!.value).toBe("1R 中山1 10:05 準備OK");
    expect(out.fields![2]!.value).toBe("水沢 11R 地方Jpn 20:10 準備OK");
    expect(out.color).toBe(0x2ecc71);
    expect(out.description).toContain("対象 3 件(中央 2・地方 交流重賞 1)");
  });

  it("準備の成否: morning done=準備OK・failed=準備失敗・未完了(null・queued・fetched)。失敗があれば橙、未完了の件数は description に出る", () => {
    const rows = [
      row({ raceId: "202606040901", raceNumber: 1, morning: "done" }),
      row({ raceId: "202606040902", raceNumber: 2, morning: "failed" }),
      row({ raceId: "202606040903", raceNumber: 3, morning: "queued" }),
      row({ raceId: "202606040904", raceNumber: 4, morning: "fetched" }),
      row({ raceId: "202606040905", raceNumber: 5, morning: null }),
    ];
    const out = buildSummaryEmbed({ kaisaiDate: "20260927", progress: progress({ rows }) });
    const lines = out.fields![0]!.value.split("\n");
    expect(lines.map((l) => l.split(" ").at(-1))).toEqual(["準備OK", "準備失敗", "未完了", "未完了", "未完了"]);
    expect(out.description).toContain("準備OK 1 / 失敗 1 / 未完了 3");
    expect(out.color).toBe(0xe67e22);
  });

  it("未完了があるのに送るとき(保険の時刻)は、「未完了 N 件」を明示する。全部終端のときは言わない", () => {
    const pending = progress({ rows: [row({ raceId: "202606040901", morning: "queued" })], morningAllTerminal: false });
    expect(buildSummaryEmbed({ kaisaiDate: "20260927", progress: pending }).description).toContain("未完了 1 件のまま送信しています");
    expect(buildSummaryEmbed({ kaisaiDate: "20260927", progress: progress() }).description).not.toContain("のまま送信");
  });

  it("全レースが失敗: 赤。上限超過(cap)のスキップは失敗として数え、その旨を行に出す", () => {
    const rows = [
      row({ raceId: "202606040901", raceNumber: 1, morning: "failed" }),
      row({ raceId: "202606040902", raceNumber: 2, state: "skipped", skipReason: "cap", disposition: "skip", dueMs: null, morning: null }),
    ];
    const out = buildSummaryEmbed({ kaisaiDate: "20260927", progress: progress({ rows }) });
    expect(out.color).toBe(0xe74c3c);
    expect(out.fields![0]!.value).toContain("スキップ(上限超過)");
    expect(out.description).toContain("失敗 2"); // 準備失敗 1 + 上限超過 1
  });

  it("スキップ(計画の時点): 理由ごとの件数が description に出る。行にも理由が出る", () => {
    const skip = (raceId: string, reason: Row["skipReason"]): Row => row({ raceId, state: "skipped", skipReason: reason, disposition: "skip", dueMs: null, morning: null });
    const rows = [
      skip("202606040901", "started"),
      skip("202606040902", "started"),
      skip("202606040903", "too-late"),
      skip("202606040904", "no-start-time"),
      skip("202606040905", "manual"),
    ];
    const out = buildSummaryEmbed({ kaisaiDate: "20260927", progress: progress({ rows }) });
    expect(out.description).toContain("スキップ: 発走済み 2・時刻不明 1・間に合わない 1・手動の分析あり 1");
    expect(out.fields![0]!.value).toContain("スキップ(発走済み)");
    expect(out.fields![0]!.value).toContain("スキップ(時刻不明)");
  });

  it("地方の一覧の取得失敗: その旨を description と「地方 交流重賞」の field に出す(理由つき)。赤", () => {
    const out = buildSummaryEmbed({
      kaisaiDate: "20260927",
      progress: progress({ venues: [venue({ venue: "central" }), venue({ venue: "nar", state: "failed", reason: "blocked", listed: null, targeted: null })] }),
    });
    expect(out.description).toContain("地方の一覧を取得できませんでした");
    const nar = out.fields!.find((f) => f.name === "地方 交流重賞")!;
    expect(nar.value).toContain("取得できませんでした");
    expect(nar.value).toContain("取得制限");
    expect(out.color).toBe(0xe74c3c);
  });

  it("中央の一覧の取得失敗(対象 0 件の日): 「中央」の field に取得失敗を出す", () => {
    const out = buildSummaryEmbed({
      kaisaiDate: "20260927",
      progress: progress({ rows: [], venues: [venue({ venue: "central", state: "failed", reason: "failed", listed: null, targeted: null }), venue({ venue: "nar", listed: 0, targeted: 0 })] }),
    });
    expect(out.fields!.find((f) => f.name === "中央")!.value).toContain("取得できませんでした");
    expect(out.description).toContain("中央の一覧を取得できませんでした");
  });

  it.each([
    ["listed=0(一覧が空)", { listed: 0, targeted: 0 }, "一覧が空でした"],
    ["listed>0 で targeted=0(交流重賞なし)", { listed: 12, targeted: 0 }, "交流重賞はありません(一覧 12 件)"],
  ] as const)("地方が ok で対象なし: %s は別の文言", (_name, nar, text) => {
    const out = buildSummaryEmbed({ kaisaiDate: "20260927", progress: progress({ venues: [venue({ venue: "central" }), venue({ venue: "nar", ...nar })] }) });
    expect(out.fields!.find((f) => f.name === "地方 交流重賞")!.value).toContain(text);
  });

  it("offset の出どころが default-fallback のときは、設定を読めず既定値で計画したことを出す", () => {
    const out = buildSummaryEmbed({ kaisaiDate: "20260927", progress: progress({ offsetSource: "default-fallback" }) });
    expect(out.description).toContain("発走の 45 分前");
    expect(out.description).toContain("設定を読めなかった");
    expect(buildSummaryEmbed({ kaisaiDate: "20260927", progress: progress() }).description).not.toContain("設定を読めなかった");
  });

  it("会場名が無い中央の行は、レースID から導出した会場名の field に入る", () => {
    const out = buildSummaryEmbed({ kaisaiDate: "20260927", progress: progress({ rows: [row({ raceId: "202609030901", venueName: null })] }) });
    expect(out.fields![0]!.name).toBe("阪神");
  });

  describe("最大ケース(AC-D4): 中央 36 レース + 地方 Jpn。上限内に収まり、切り詰めが要らない", () => {
    const longName = "あ".repeat(30); // 20 文字に切られる
    const central36 = (venues: readonly [string, string][]): Row[] =>
      venues.flatMap(([name, code]) =>
        Array.from({ length: 12 }, (_, i) =>
          row({ raceId: `2026${code}0301${String(i + 1).padStart(2, "0")}`, venueName: name, raceNumber: i + 1, raceName: longName, startTime: "15:40", morning: i % 3 === 0 ? "failed" : "queued" }),
        ),
      );
    const jpn = (n: number): Row[] =>
      Array.from({ length: n }, (_, i) =>
        row({ raceId: `2026360927${String(i).padStart(2, "0")}`, venue: "nar", venueName: "大井", raceNumber: i + 1, raceName: longName, grade: "Jpn1", startTime: "20:10", state: "skipped", skipReason: "cap", disposition: "skip", dueMs: null, morning: null }),
      );

    it("36 + Jpn 12(最長の名前・最長のタグ「スキップ(上限超過)」)でも、全体 6000・各 field 1024 以内で、「…ほか」が出ない", () => {
      const rows = [...central36([["中山", "06"], ["阪神", "09"], ["小倉", "10"]]), ...jpn(12)];
      expect(rows.filter((r) => r.venue === "central")).toHaveLength(36); // 前提: 36 レース
      const out = buildSummaryEmbed({ kaisaiDate: "20260927", progress: progress({ rows, morningAllTerminal: false }) });
      expect(out.fields).toHaveLength(4);
      expect(embedLength(out)).toBeLessThanOrEqual(6000);
      for (const f of out.fields!) {
        expect(f.value.length).toBeLessThanOrEqual(1024);
        expect(f.value).not.toContain("…ほか");
      }
      expect(out.fields![0]!.value.split("\n")).toHaveLength(12); // 12 行すべて残っている
    });

    it("溢れる入力(地方 Jpn 60 件)は「…ほか N 件」にして、上限内に収める(N は落とした行数)", () => {
      const out = buildSummaryEmbed({ kaisaiDate: "20260927", progress: progress({ rows: jpn(60).map((r, i) => ({ ...r, raceId: `2026360927${String(i).padStart(2, "0")}` })), morningAllTerminal: true }) });
      expect(embedLength(out)).toBeLessThanOrEqual(6000);
      const nar = out.fields!.find((f) => f.name === "地方 交流重賞")!;
      expect(nar.value.length).toBeLessThanOrEqual(1024);
      const parts = nar.value.split("\n");
      const dropped = Number(/…ほか (\d+) 件/.exec(parts.at(-1)!)![1]);
      expect(dropped).toBeGreaterThan(0);
      expect(parts.length - 1 + dropped).toBe(60);
    });
  });
});
