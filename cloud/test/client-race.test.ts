import { describe, expect, it } from "vitest";
import type { BoardRow, MorningPriorView, RaceRow } from "../client/api";
import type { AnalysisDetail } from "../client/api-analysis";
import { buildRaceModel, latestAnalysisIdOf, runButtonLabel, type RaceModelInput, type RunUi } from "../client/race";
import { buildResultModel, NO_ALLOCATION_NOTE, UNSET_ALLOCATION_NOTE, UNSET_ALLOCATION_NOTE_VIEWER } from "../client/result";
import type { Route } from "../client/route";

/**
 * Issue #185: レース画面の表示用データ(純関数)。朝の準備・発走前の 2 枚のカード(状態・失敗時のエラー文)・朝の prior の順位・過去の分析のリンク。
 * Issue #188: 発走前のカードに、最新の分析の結果(`card.result`)を最初から出す(旧「結果を見る」のリンクは廃止)。起動のボタン・失敗の注記は Issue #186(下の describe)。
 */

const RACE_ID = "202603020211";
const OTHER_RACE_ID = "202603020212";
const ROUTE: Route = { date: "20260628", venue: "central", race: RACE_ID, analysis: null, settings: false };

function row(raceId: string, mode: BoardRow["mode"], status: BoardRow["status"], over: Partial<BoardRow> = {}): BoardRow {
  return { raceId, mode, status, attempts: 0, error: null, queuedAt: 1, updatedAt: 2, prior: false, analysisId: null, ...over };
}

const PRIOR: MorningPriorView = {
  raceName: "福島民報杯",
  venueName: "福島",
  date: "2026-06-28",
  computedAt: 5000,
  rows: [
    { rank: 1, umaban: 3, horseName: "アルファ", prior: 0.523 },
    { rank: 2, umaban: 1, horseName: null, prior: 0.31 },
  ],
};

function input(over: Partial<RaceModelInput> = {}): RaceModelInput {
  return { route: ROUTE, status: { kind: "ready", rows: [], prior: null }, past: { kind: "ready", analyses: [] }, listRow: undefined, ...over };
}

function cards(model: ReturnType<typeof buildRaceModel>) {
  expect(model.cards, "前提: カードが出る状態").not.toBeNull();
  return model.cards!;
}

describe("カード(朝の準備・発走前)の状態: (race_id, mode) で板の行を引く", () => {
  it("別のレース・別のモードの行を取り違えない(同じレースの 2 モード・別レースの行が混ざる板で、それぞれの状態になる)", () => {
    const model = buildRaceModel(
      input({
        status: {
          kind: "ready",
          rows: [
            row(OTHER_RACE_ID, "morning", "failed", { error: "別レースの失敗" }),
            row(RACE_ID, "morning", "done", { prior: true }),
            row(OTHER_RACE_ID, "pre_race", "done", { analysisId: 99 }),
            row(RACE_ID, "pre_race", "queued"),
          ],
          prior: null,
        },
      }),
    );
    const [morning, preRace] = cards(model);
    expect(morning!.title).toBe("朝の準備");
    expect(morning!.badge).toEqual({ label: "完了", tone: "ok" });
    expect(morning!.error).toBeNull();
    expect(preRace!.title).toBe("発走前");
    expect(preRace!.badge).toEqual({ label: "待ち", tone: "wait" });
    expect(preRace!.result).toBeNull(); // queued なので結果は無い。別レースの analysis_id(99)を拾わない
  });

  it("行が無ければ「未実行」。2 枚のカードは常に morning → pre_race の順", () => {
    const [morning, preRace] = cards(buildRaceModel(input()));
    expect([morning!.mode, preRace!.mode]).toEqual(["morning", "pre_race"]);
    expect(morning!.badge.label).toBe("未実行");
    expect(preRace!.badge.label).toBe("未実行");
  });

  const states: readonly [BoardRow["status"], string][] = [
    ["queued", "待ち"],
    ["fetched", "取得済み"],
    ["done", "完了"],
    ["failed", "失敗"],
  ];
  for (const [status, label] of states) {
    it(`状態 ${status} は「${label}」(朝・発走前の両方)`, () => {
      const [morning, preRace] = cards(buildRaceModel(input({ status: { kind: "ready", rows: [row(RACE_ID, "morning", status), row(RACE_ID, "pre_race", status)], prior: null } })));
      expect(morning!.badge.label).toBe(label);
      expect(preRace!.badge.label).toBe(label);
    });
  }

  it("失敗時だけエラー文(板の `error`)を出す。完了・待ちのときに error が残っていても出さない。長い文は 200 文字まで", () => {
    const failed = cards(buildRaceModel(input({ status: { kind: "ready", rows: [row(RACE_ID, "morning", "failed", { error: "ソケット接続に失敗しました" })], prior: null } })))[0]!;
    expect(failed.error).toBe("ソケット接続に失敗しました");
    for (const status of ["queued", "fetched", "done"] as const) {
      const card = cards(buildRaceModel(input({ status: { kind: "ready", rows: [row(RACE_ID, "morning", status, { error: "古い失敗の文面" })], prior: null } })))[0]!;
      expect(card.error, status).toBeNull();
    }
    const long = cards(buildRaceModel(input({ status: { kind: "ready", rows: [row(RACE_ID, "pre_race", "failed", { error: "あ".repeat(500) })], prior: null } })))[1]!;
    expect(long.error).toBe("あ".repeat(200));
    const empty = cards(buildRaceModel(input({ status: { kind: "ready", rows: [row(RACE_ID, "pre_race", "failed", { error: "" })], prior: null } })))[1]!;
    expect(empty.error).toBeNull(); // 空文字のエラー文は出さない
  });
});

const ANALYSIS: AnalysisDetail = {
  id: 12,
  raceId: RACE_ID,
  analyzedAt: "2026-06-28T05:00:00.000Z",
  kaisaiDate: "20260628",
  evEstimated: false,
  model: null,
  llmNote: null,
  llmCalls: null,
  race: { venueName: "福島", raceNumber: 11, raceName: "テストステークス", grade: null, oddsStatus: "result" },
  horses: [
    { umaban: 1, name: "アルファ", prior: 0.2, adjustedProb: 0.2, placeOddsMin: 1.8, ev: 1.2, isPositive: true, mark: null, reason: null, highlights: [], concerns: [], winProb: null, fairWinOdds: null, winOdds: null },
    { umaban: 2, name: "ブラボー", prior: 0.1, adjustedProb: 0.1, placeOddsMin: null, ev: null, isPositive: false, mark: "◎", reason: null, highlights: [], concerns: [], winProb: null, fairWinOdds: null, winOdds: null },
  ],
  allocation: null,
  detail: "present",
};

describe("最新の分析 id(`latestAnalysisIdOf`。取得するかどうか・カードに出すかどうかの唯一の判定。旧「結果を見る」の出す条件を引き継ぐ)", () => {
  it("そのレースの発走前が done で analysisId があれば、その id", () => {
    expect(latestAnalysisIdOf([row(RACE_ID, "pre_race", "done", { analysisId: 12 })], RACE_ID)).toBe(12);
  });

  it("完了でも analysisId が null なら null。完了以外(待ち・取得済み・失敗)で analysisId が残っていても null。朝の行の id は使わない。行が無ければ null", () => {
    expect(latestAnalysisIdOf([row(RACE_ID, "pre_race", "done", { analysisId: null })], RACE_ID)).toBeNull();
    for (const status of ["queued", "fetched", "failed"] as const) {
      expect(latestAnalysisIdOf([row(RACE_ID, "pre_race", status, { analysisId: 5 })], RACE_ID), status).toBeNull();
    }
    expect(latestAnalysisIdOf([row(RACE_ID, "morning", "done", { analysisId: 5, prior: true })], RACE_ID)).toBeNull();
    expect(latestAnalysisIdOf([], RACE_ID)).toBeNull();
  });

  it("別のレースの行の id を拾わない(2 レースが混ざる板で、自分のレースの id だけ)", () => {
    const rows = [row(OTHER_RACE_ID, "pre_race", "done", { analysisId: 99 }), row(RACE_ID, "pre_race", "done", { analysisId: 12 }), row(RACE_ID, "morning", "done", { analysisId: 77 })];
    expect(latestAnalysisIdOf(rows, RACE_ID)).toBe(12);
    expect(latestAnalysisIdOf(rows, OTHER_RACE_ID)).toBe(99);
    expect(latestAnalysisIdOf([row(OTHER_RACE_ID, "pre_race", "done", { analysisId: 99 })], RACE_ID)).toBeNull();
  });
});

describe("カードの結果(`card.result`。発走前のカードだけ。最新の分析があるときだけ)", () => {
  const doneRows = (id: number | null = 12): { kind: "ready"; rows: BoardRow[]; prior: null } => ({ kind: "ready", rows: [row(RACE_ID, "morning", "done", { prior: true, analysisId: 3 }), row(RACE_ID, "pre_race", "done", { analysisId: id })], prior: null });

  it("最新の分析が無ければ(未実行・実行中・失敗・id なし)null。朝のカードは常に null(朝の行に analysisId があっても)", () => {
    for (const status of ["queued", "fetched", "failed"] as const) {
      const [morning, preRace] = cards(buildRaceModel(input({ status: { kind: "ready", rows: [row(RACE_ID, "morning", "done", { prior: true, analysisId: 3 }), row(RACE_ID, "pre_race", status, { analysisId: 12 })], prior: null }, result: { kind: "ready", analysis: ANALYSIS } })));
      expect(morning!.result, status).toBeNull();
      expect(preRace!.result, status).toBeNull();
    }
    const [morning, preRace] = cards(buildRaceModel(input({ status: doneRows(null), result: { kind: "ready", analysis: ANALYSIS } })));
    expect(morning!.result).toBeNull();
    expect(preRace!.result).toBeNull();
  });

  it("最新の分析があり、結果のソースがまだ無い・取得中なら loading。このとき画面は「読み込み中」(更新を無効にする)", () => {
    for (const result of [undefined, { kind: "loading" } as const]) {
      const model = buildRaceModel(input({ status: doneRows(), ...(result === undefined ? {} : { result }) }));
      expect(cards(model)[1]!.result).toEqual({ kind: "loading" });
      expect(model.loading).toBe(true);
    }
  });

  it("結果の取得に失敗したら、固定の文言(error)。サーバの文面は持たない。更新は押せる(loading でない)", () => {
    const model = buildRaceModel(input({ status: doneRows(), result: { kind: "error", message: "分析を取得できません" } }));
    expect(cards(model)[1]!.result).toEqual({ kind: "error", message: "分析を取得できません" });
    expect(model.loading).toBe(false);
  });

  it("取得できたら ready。内容は結果画面と同じ変換(`buildResultModel` の content)。既定は開(open: true)。date・raceId を持つ(開閉の引数)", () => {
    const model = buildRaceModel(input({ status: doneRows(), result: { kind: "ready", analysis: ANALYSIS } }));
    const result = cards(model)[1]!.result;
    expect(result?.kind).toBe("ready");
    if (result?.kind !== "ready") return;
    expect(result.open).toBe(true);
    expect([result.date, result.raceId]).toEqual(["20260628", RACE_ID]);
    const same = buildResultModel({ route: ROUTE, source: { kind: "ready", analysis: ANALYSIS } }).content;
    expect(same, "前提: 結果画面の内容が出る").not.toBeNull();
    expect(result.content).toEqual(same);
    expect(result.content.horses.map((x) => x.umaban)).toEqual([1, 2]);
    expect(result.content.horses[1]!.mark).toBe("◎");
    expect(result.content.allocation.notices).toEqual([NO_ALLOCATION_NOTE]);
    expect(model.loading).toBe(false);
  });

  it("resultOpen: false なら open: false(内容は持つ)。開閉は取得を伴わない(content は同じ)", () => {
    const open = cards(buildRaceModel(input({ status: doneRows(), result: { kind: "ready", analysis: ANALYSIS } })))[1]!.result;
    const closed = cards(buildRaceModel(input({ status: doneRows(), result: { kind: "ready", analysis: ANALYSIS }, resultOpen: false })))[1]!.result;
    expect(open?.kind === "ready" && open.open).toBe(true);
    expect(closed?.kind).toBe("ready");
    if (closed?.kind !== "ready" || open?.kind !== "ready") return;
    expect(closed.open).toBe(false);
    expect(closed.content).toEqual(open.content);
  });

  it("状態の取得中・失敗(cards が null)なら、結果を取得中でも model.loading は状態の取得に従う(結果のカードは出ない)", () => {
    const model = buildRaceModel(input({ status: { kind: "error", message: "x" }, result: { kind: "loading" } }));
    expect(model.cards).toBeNull();
    expect(model.loading).toBe(false);
  });

  it("レース画面のモデルに「結果を見る」のリンク(resultHref)は無い", () => {
    const [, preRace] = cards(buildRaceModel(input({ status: doneRows(), result: { kind: "ready", analysis: ANALYSIS } })));
    expect(Object.keys(preRace!)).not.toContain("resultHref");
  });
});

describe("朝の prior の順位: 朝が完了していて prior があるときだけ", () => {
  const doneMorning = row(RACE_ID, "morning", "done", { prior: true });

  it("完了・prior ありなら、サーバの順位(rank)のまま、3着内率をパーセントで出す。馬名が無ければ null", () => {
    const [morning] = cards(buildRaceModel(input({ status: { kind: "ready", rows: [doneMorning], prior: PRIOR } })));
    expect(morning!.prior).toEqual([
      { rank: 1, umaban: 3, name: "アルファ", value: "52.3%" },
      { rank: 2, umaban: 1, name: null, value: "31.0%" },
    ]);
  });

  it("サーバが返した順を並べ替えない(クライアントで prior を再ソートしない)", () => {
    const reversed: MorningPriorView = { ...PRIOR, rows: [...PRIOR.rows].reverse() };
    const [morning] = cards(buildRaceModel(input({ status: { kind: "ready", rows: [doneMorning], prior: reversed } })));
    expect(morning!.prior!.map((p) => p.rank)).toEqual([2, 1]);
  });

  it("完了でない(待ち・取得済み・失敗)、板の prior フラグが false、prior 本体が null のどれでも出さない(失敗した再実行が、古い prior を新しい結果のように見せない)", () => {
    for (const status of ["queued", "fetched", "failed"] as const) {
      const card = cards(buildRaceModel(input({ status: { kind: "ready", rows: [row(RACE_ID, "morning", status, { prior: true })], prior: PRIOR } })))[0]!;
      expect(card.prior, status).toBeNull();
    }
    const noFlag = cards(buildRaceModel(input({ status: { kind: "ready", rows: [row(RACE_ID, "morning", "done", { prior: false })], prior: PRIOR } })))[0]!;
    expect(noFlag.prior).toBeNull();
    const noBody = cards(buildRaceModel(input({ status: { kind: "ready", rows: [doneMorning], prior: null } })))[0]!;
    expect(noBody.prior).toBeNull();
  });

  it("発走前のカードには prior を出さない", () => {
    const [, preRace] = cards(buildRaceModel(input({ status: { kind: "ready", rows: [doneMorning, row(RACE_ID, "pre_race", "done", { prior: true })], prior: PRIOR } })));
    expect(preRace!.prior).toBeNull();
  });
});

describe("取得の状態(読み込み中・失敗)", () => {
  it("状態の取得中はカードを出さず(読み込み中)、失敗なら注記を出す(カードは出さない=「未実行」と誤読させない)", () => {
    const loading = buildRaceModel(input({ status: { kind: "loading" } }));
    expect(loading.cards).toBeNull();
    expect(loading.loading).toBe(true);
    expect(loading.statusNotice).toBeNull();
    const failed = buildRaceModel(input({ status: { kind: "error", message: "状態を取得できません" } }));
    expect(failed.cards).toBeNull();
    expect(failed.statusNotice).toBe("状態を取得できません");
    expect(failed.loading).toBe(false);
  });

  it("過去の分析の取得中・失敗でも、カードは出る(互いに独立)。過去の分析の取得中も読み込み中として「更新」を無効にする", () => {
    const pastLoading = buildRaceModel(input({ past: { kind: "loading" } }));
    expect(pastLoading.cards).not.toBeNull();
    expect(pastLoading.loading).toBe(true);
    const pastFailed = buildRaceModel(input({ past: { kind: "error", message: "一覧を取得できません" } }));
    expect(pastFailed.cards).not.toBeNull();
    expect(pastFailed.past).toEqual({ kind: "error", message: "一覧を取得できません" });
    expect(pastFailed.loading).toBe(false);
  });
});

describe("過去の分析の一覧(結果の画面へのリンク)", () => {
  it("サーバの並び(新しい順)のまま、JST の分析時刻を表示し、href は buildHash の結果(日付・区分・分析 id)", () => {
    const model = buildRaceModel(
      input({
        route: { ...ROUTE, venue: "nar" },
        past: {
          kind: "ready",
          analyses: [
            { id: 9, analyzedAt: "2026-06-28T05:00:00.000Z", evEstimated: false, model: null },
            { id: 4, analyzedAt: "2026-06-27T15:30:00.000Z", evEstimated: true, model: null },
          ],
        },
      }),
    );
    expect(model.past).toEqual({
      kind: "ready",
      items: [
        { id: 9, label: "2026-06-28 14:00", href: "#date=20260628&venue=nar&analysis=9" },
        { id: 4, label: "2026-06-28 00:30", href: "#date=20260628&venue=nar&analysis=4" },
      ],
    });
  });

  it("0 件は空の一覧(ready の空配列)", () => {
    expect(buildRaceModel(input()).past).toEqual({ kind: "ready", items: [] });
  });
});

describe("見出し・戻るリンク", () => {
  const listRow: RaceRow = { raceId: RACE_ID, venueName: "福島", raceNumber: 11, raceName: "福島民報杯", courseType: "芝", distance: 1800, entryCount: 16, grade: null, startTime: null };

  it("一覧の行があればそこから(場名・R・レース名)。無ければ朝の prior から。どちらも無ければレース ID", () => {
    expect(buildRaceModel(input({ listRow })).title).toBe("福島11R 福島民報杯");
    expect(buildRaceModel(input({ listRow: { ...listRow, venueName: null } })).title).toBe("11R 福島民報杯");
    expect(buildRaceModel(input({ status: { kind: "ready", rows: [], prior: PRIOR } })).title).toBe("福島11R 福島民報杯");
    expect(buildRaceModel(input({ status: { kind: "ready", rows: [], prior: { ...PRIOR, raceName: null, venueName: null } } })).title).toBe("11R");
    expect(buildRaceModel(input()).title).toBe(`レース ${RACE_ID}`);
    expect(buildRaceModel(input({ status: { kind: "loading" } })).title).toBe(`レース ${RACE_ID}`);
  });

  it("Issue #236: 一覧の行から作る見出しだけ、末尾に「 HH:MM発走」を付ける(時刻なしの行・prior・ID だけの経路では付けない)", () => {
    expect(buildRaceModel(input({ listRow: { ...listRow, startTime: "15:40" } })).title).toBe("福島11R 福島民報杯 15:40発走");
    expect(buildRaceModel(input({ listRow: { ...listRow, venueName: null, startTime: "09:05" } })).title).toBe("11R 福島民報杯 09:05発走");
    // 前提: 時刻なし(null)の一覧の行は従来のまま
    expect(buildRaceModel(input({ listRow })).title).toBe("福島11R 福島民報杯");
    // 一覧のキャッシュが無い経路(prior・ID だけ)は、時刻を持たないので出さない
    expect(buildRaceModel(input({ status: { kind: "ready", rows: [], prior: PRIOR } })).title).toBe("福島11R 福島民報杯");
    expect(buildRaceModel(input()).title).toBe(`レース ${RACE_ID}`);
  });

  it.each([
    ["中央の G3(発走時刻つき)", "G3", "15:45", "福島11R 福島民報杯(G3) 15:45発走"],
    ["障害の J・G1", "J・G1", null, "福島11R 福島民報杯(J・G1)"],
    ["地方の Jpn1", "Jpn1", "20:05", "福島11R 福島民報杯(Jpn1) 20:05発走"],
    ["OP は付けない", "OP", "15:45", "福島11R 福島民報杯 15:45発走"],
    ["L は付けない", "L", null, "福島11R 福島民報杯"],
    ["グレードなし(null)", null, "15:45", "福島11R 福島民報杯 15:45発走"],
  ] as const)("Issue #250: 一覧の行から作る見出しは、重賞だけレース名の直後に「(グレード)」を付ける — %s", (_name, grade, startTime, expected) => {
    expect(buildRaceModel(input({ listRow: { ...listRow, grade, startTime } })).title).toBe(expected);
  });

  it("Issue #250: 一覧のキャッシュが無い経路(prior・ID だけ)の見出しには、グレードを付けない(持っていない)", () => {
    // 前提: 同じ一覧の行ならグレードが付く
    expect(buildRaceModel(input({ listRow: { ...listRow, grade: "G3" } })).title).toBe("福島11R 福島民報杯(G3)");
    expect(buildRaceModel(input({ status: { kind: "ready", rows: [], prior: PRIOR } })).title).toBe("福島11R 福島民報杯");
  });

  it("一覧へ戻るリンクは、日付・区分を保つ(race を含めない)", () => {
    expect(buildRaceModel(input({ route: { ...ROUTE, date: "20261003", venue: "nar" } })).backHref).toBe("#date=20261003&venue=nar");
  });
});


/** Issue #186: 起動のボタン(D16 の文言)・起動の失敗・すでに実行中・prior の注記・追跡の注記。 */
describe("起動のボタン(文言・disabled・渡す値)", () => {
  type Status = BoardRow["status"] | undefined;
  const TABLE: readonly [BoardRow["mode"], Status, string, boolean][] = [
    // [モード, 板の状態, ボタンの文言, disabled]
    ["morning", undefined, "朝の準備を実行", false],
    ["morning", "done", "朝の準備をやり直す", false],
    ["morning", "failed", "再試行", false],
    ["morning", "queued", "待ち", true],
    ["morning", "fetched", "取得済み", true],
    ["pre_race", undefined, "発走前の分析を実行", false],
    ["pre_race", "done", "再実行(新しい分析として保存されます)", false],
    ["pre_race", "failed", "再試行", false],
    ["pre_race", "queued", "待ち", true],
    ["pre_race", "fetched", "取得済み", true],
  ];
  for (const [mode, status, label, disabled] of TABLE) {
    it(`${mode}・${status ?? "行なし"} → 「${label}」(disabled: ${disabled})`, () => {
      const rows = status === undefined ? [] : [row(RACE_ID, mode, status)];
      const card = cards(buildRaceModel(input({ status: { kind: "ready", rows, prior: null } }))).find((c) => c.mode === mode)!;
      expect(card.button!.label).toBe(label);
      expect(card.button!.disabled).toBe(disabled);
      expect(runButtonLabel(mode, status, false)).toBe(label);
    });
  }

  it("送信中は、板の状態によらず「送信中…」で disabled(二重押しを防ぐ)", () => {
    for (const status of [undefined, "done", "failed"] as const) {
      expect(runButtonLabel("morning", status, true)).toBe("送信中…");
      expect(runButtonLabel("pre_race", status, true)).toBe("送信中…");
    }
    const runs = new Map<BoardRow["mode"], RunUi>([["morning", { kind: "sending" }]]);
    const model = buildRaceModel(input({ status: { kind: "ready", rows: [row(RACE_ID, "morning", "done", { prior: true })], prior: null }, runs }));
    const [morning, preRace] = cards(model);
    expect(morning!.button).toMatchObject({ label: "送信中…", disabled: true });
    expect(preRace!.button).toMatchObject({ label: "発走前の分析を実行", disabled: false }); // もう一方のモードは別
  });

  it("ボタンが起動に渡す値(開催日・レース・モード)は、画面のレースと開催日・そのカードのモード(取り違えない)", () => {
    const route: Route = { date: "20260629", venue: "nar", race: OTHER_RACE_ID, analysis: null, settings: false };
    const [morning, preRace] = cards(buildRaceModel(input({ route })));
    expect(morning!.button).toMatchObject({ date: "20260629", raceId: OTHER_RACE_ID, mode: "morning" });
    expect(preRace!.button).toMatchObject({ date: "20260629", raceId: OTHER_RACE_ID, mode: "pre_race" });
  });

  it("状態を取得できていない(cards が null)ときはボタンを出さない(「未実行」と誤読させて起動させない)", () => {
    expect(buildRaceModel(input({ status: { kind: "loading" } })).cards).toBeNull();
    expect(buildRaceModel(input({ status: { kind: "error", message: "x" } })).cards).toBeNull();
  });
});

describe("起動の失敗・すでに実行中・prior の注記・追跡の注記", () => {
  it("起動の失敗の文言は、そのカードだけに出る(もう一方のモードに出さない)。失敗しても、ボタンは押せる", () => {
    const runs = new Map<BoardRow["mode"], RunUi>([["pre_race", { kind: "error", message: "起動に失敗した" }]]);
    const [morning, preRace] = cards(buildRaceModel(input({ runs })));
    expect(preRace!.runError).toBe("起動に失敗した");
    expect(morning!.runError).toBeNull();
    expect(preRace!.button!.disabled).toBe(false);
  });

  it("「すでに実行中」の注記は、板の状態が実行中(queued・fetched)の間だけ出る。完了・失敗に変われば出さない", () => {
    const runs = new Map<BoardRow["mode"], RunUi>([["morning", { kind: "already" }]]);
    const withStatus = (status: BoardRow["status"]) => cards(buildRaceModel(input({ status: { kind: "ready", rows: [row(RACE_ID, "morning", status)], prior: null }, runs })))[0]!.runInfo;
    expect(withStatus("queued")).toContain("すでに実行中");
    expect(withStatus("fetched")).toContain("すでに実行中");
    expect(withStatus("done")).toBeNull();
    expect(withStatus("failed")).toBeNull();
    expect(cards(buildRaceModel(input()))[0]!.runInfo).toBeNull(); // 何も押していない
  });

  it("prior の取り直しに失敗した注記は、朝のカードにだけ付く(カードの状態・prior の順位は残る)", () => {
    const model = buildRaceModel(input({ status: { kind: "ready", rows: [row(RACE_ID, "morning", "done", { prior: true })], prior: PRIOR, priorNotice: "順位を取得できませんでした" } }));
    const [morning, preRace] = cards(model);
    expect(morning!.priorNotice).toBe("順位を取得できませんでした");
    expect(preRace!.priorNotice).toBeNull();
    expect(morning!.badge).toEqual({ label: "完了", tone: "ok" });
    expect(morning!.prior).toHaveLength(2); // 古い順位が残る
    expect(cards(buildRaceModel(input()))[0]!.priorNotice).toBeNull();
  });

  it("追跡の停止の注記(tracking)は、渡した文言がそのまま出る。無ければ null", () => {
    expect(buildRaceModel(input({ tracking: "止めました" })).tracking).toBe("止めました");
    expect(buildRaceModel(input()).tracking).toBeNull();
  });
});

/**
 * Issue #191: 各カードに、何をするかの説明(1〜2行)を出す。文言は実際の挙動に合わせてある(#189 の着手前確認 §6)が、**ここでは文言を固定しない**(構造だけを見る)。
 * 説明は定数で、板の状態・prior・結果に依らず、カードがあれば必ずある。Issue 番号は画面に出さない。
 */
describe("カードの説明(Issue #191)", () => {
  const states: readonly [string, BoardRow[]][] = [
    ["未実行(板に行が無い)", []],
    ["実行中", [row(RACE_ID, "morning", "queued"), row(RACE_ID, "pre_race", "fetched")]],
    ["完了(朝の prior・発走前の分析あり)", [row(RACE_ID, "morning", "done", { prior: true }), row(RACE_ID, "pre_race", "done", { analysisId: 3 })]],
    ["失敗", [row(RACE_ID, "morning", "failed", { error: "x" }), row(RACE_ID, "pre_race", "failed", { error: "y" })]],
  ];

  for (const [name, rows] of states) {
    it(`${name}でも、朝の準備・発走前の両方のカードに、空でない説明がある。2枚の説明は違う文`, () => {
      const [morning, preRace] = cards(buildRaceModel(input({ status: { kind: "ready", rows, prior: PRIOR } })));
      expect(morning!.mode).toBe("morning");
      expect(preRace!.mode).toBe("pre_race");
      expect(morning!.description.trim().length).toBeGreaterThan(0);
      expect(preRace!.description.trim().length).toBeGreaterThan(0);
      expect(morning!.description).not.toBe(preRace!.description);
    });
  }

  it("説明は1〜2行の短い文(各 20〜200 文字)で、Issue 番号(#数字)・改行を含まない", () => {
    const [morning, preRace] = cards(buildRaceModel(input()));
    for (const card of [morning!, preRace!]) {
      expect(card.description.length).toBeGreaterThanOrEqual(20);
      expect(card.description.length).toBeLessThanOrEqual(200);
      expect(card.description).not.toMatch(/#\d/);
      expect(card.description).not.toContain("\n");
    }
  });

  // 文言そのものは固定しない。ただし、次の「事実の印」は、モードごとに固有の語として固定する(取り違え・事実の削除で赤になる)。
  it("朝の準備の説明は、戦績・調教を取得すること(調教は中央のみ)に触れ、LLM には触れない。発走前の説明は、LLM(キーの有無での違い・補正・印と根拠・EV)と配分の条件(資金・上限)に触れ、戦績には触れない。「現在は LLM を使いません」とは言わない", () => {
    const [morning, preRace] = cards(buildRaceModel(input()));
    expect(morning!.mode).toBe("morning");
    expect(preRace!.mode).toBe("pre_race");
    for (const word of ["戦績", "調教", "中央のみ"]) {
      expect(morning!.description, `朝の説明に「${word}」`).toContain(word);
    }
    expect(morning!.description).not.toContain("LLM");
    for (const word of ["LLM", "キー", "補正", "印", "根拠", "統計のみ", "EV", "資金", "上限"]) {
      expect(preRace!.description, `発走前の説明に「${word}」`).toContain(word);
    }
    expect(preRace!.description).not.toMatch(/LLM を使いません|LLM は使いません|LLM は未対応|現在は/); // キーが登録されていれば LLM を使う(嘘にならない書き方)
    expect(preRace!.description).not.toContain("戦績");
    // cloud のプロンプトに何が入っているか(調教・コメント・展開・同日の傾向・重賞の傾向)は、この文で約束しない
    for (const word of ["調教", "コメント", "展開", "傾向"]) {
      expect(preRace!.description, `発走前の説明に「${word}」を書かない`).not.toContain(word);
    }
  });

  it("発走前の説明は短い(スマホで1〜2行。150 文字以下)", () => {
    expect([...cards(buildRaceModel(input()))[1]!.description].length).toBeLessThanOrEqual(150);
  });

  it("状態を取得できていない(cards が null)ときは、説明も出ない(カードが無いので)", () => {
    expect(buildRaceModel(input({ status: { kind: "loading" } })).cards).toBeNull();
  });
});

describe("Issue #238: 閲覧者(readOnly)のレース画面: 分析の実行ボタンを出さない(カードと状態は同じ)", () => {
  it("管理者(既定)のカードにはボタンがある。readOnly は 2 枚とも button が null で、ほかの項目は管理者と同じ", () => {
    const status = { kind: "ready" as const, rows: [row(RACE_ID, "morning", "done", { prior: true }), row(RACE_ID, "pre_race", "failed", { error: "失敗" })], prior: PRIOR };
    const admin = cards(buildRaceModel(input({ status })));
    expect(admin).toHaveLength(2);
    expect(admin.every((c) => c.button !== null)).toBe(true);
    const viewer = cards(buildRaceModel(input({ status, readOnly: true })));
    expect(viewer).toHaveLength(2);
    expect(viewer.every((c) => c.button === null)).toBe(true);
    expect(viewer.map(({ button: _b, ...rest }) => rest)).toEqual(admin.map(({ button: _b, ...rest }) => rest));
  });
});

describe("Issue #238: 閲覧者(readOnly)のレース画面のカードの結果: 配分の注記に設定への案内を出さない", () => {
  const unset = { ...ANALYSIS, allocation: { route: "unset", unavailableReason: null, fallbackReason: null, skipReasonCode: null, bankroll: 0, perRaceCap: 0, kellyFraction: 0.25, evThreshold: 1.1, includeComboOdds: false, includeWide: true, includeTrio: true, includeQuinella: null, includeExacta: null, includeTrifecta: null, includeBracketQuinella: null, betUnit: 100, oddsStatus: "result", bets: [] } } as unknown as AnalysisDetail;
  const rows = [row(RACE_ID, "morning", "done", { prior: true, analysisId: 3 }), row(RACE_ID, "pre_race", "done", { analysisId: 12 })];
  const notices = (readOnly: boolean): readonly string[] => {
    const model = buildRaceModel(input({ status: { kind: "ready", rows, prior: null }, result: { kind: "ready", analysis: unset }, ...(readOnly ? { readOnly: true } : {}) }));
    const result = cards(model).find((c) => c.mode === "pre_race")!.result;
    expect(result?.kind, "前提: 結果が出る状態").toBe("ready");
    if (result?.kind !== "ready") throw new Error("前提が崩れた");
    return result.content.allocation.notices;
  };

  it("管理者には「トップの「設定」から入れられます」、閲覧者には案内の無い文言", () => {
    expect(notices(false)).toEqual([UNSET_ALLOCATION_NOTE]);
    expect(notices(true)).toEqual([UNSET_ALLOCATION_NOTE_VIEWER]);
    expect(notices(false)).not.toEqual(notices(true));
  });
});
