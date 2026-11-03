import { describe, expect, it } from "vitest";
import type { RaceRow } from "../client/api";
import { PREDICTION_MARKS } from "../../packages/core/src/analyzer/parse-response";
import type { AnalysisDetail, AnalysisHorse } from "../client/api-analysis";
import { PLACE_ODDS_NOTE } from "../src/place-odds-format";
import { WIN_ODDS_NOTE } from "../src/win-odds-format";
import { buildResultModel, DEFAULT_HORSE_SORT, firstSortDir, KNOWN_MARK_ORDER, LABEL_ADJUSTED_PROB, LABEL_CONCERNS, LABEL_HIGHLIGHTS, LABEL_PRIOR, NO_ALLOCATION_NOTE, UNSET_ALLOCATION_NOTE, UNSET_ALLOCATION_NOTE_VIEWER, nextHorseSort, type HorseSort, type HorseSortKey, type ResultSource } from "../client/result";
import { LABEL_CONCERNS as EXE_LABEL_CONCERNS, LABEL_HIGHLIGHTS as EXE_LABEL_HIGHLIGHTS, MARK_LEGEND } from "../../packages/core/src/view/format";
import { UNSET_BANKROLL_ONLY_NOTE, UNSET_INDETERMINATE_NOTE, UNSET_PER_RACE_CAP_ONLY_NOTE } from "../../packages/core/src/view/allocation-proposal-view";
import { BET_ALLOCATION_UNSET_NOTE, placeBetUnavailableMessage } from "../../packages/core/src/view/bet-allocation-view";
import type { Route } from "../client/route";

/**
 * Issue #185: 結果画面の表示用データ(純関数)。見出し・分析時刻・分析モデル・馬ごとのカード(3着内率・複勝オッズ下限・EV)・配分(exe の `buildAllocationProposalView` を流用)。
 * 表示の決定: 印は `mark` が non-null のときだけ・モデルが null なら「LLM 未使用(統計のみ)」。
 * **Issue #195**: 補正後の3着内率・根拠は、**LLM が効いたとき(モデル ID があるとき)だけ**出す(LLM なしでは補正後が 3着内率と同じ値になり、同じ値が2行並ぶだけのため)。
 * 理由(`llmNote`)は、モデルの有無に関係なく、null でなければ出す(印の制約違反は、モデルがあって理由もある)。
 */

const RACE_ID = "202603020211";
const ROUTE: Route = { date: "20260628", venue: "central", race: null, analysis: 7, settings: false };

function horse(umaban: number, over: Partial<AnalysisHorse> = {}): AnalysisHorse {
  return { umaban, name: `馬${umaban}`, prior: 0.2, adjustedProb: 0.18, placeOddsMin: 1.8, ev: 1.05, isPositive: false, mark: null, reason: null, highlights: [], concerns: [], winProb: null, fairWinOdds: null, winOdds: null, fairPlaceOdds: null, actualPlaceOddsMin: null, actualPlaceOddsMax: null, ...over };
}

const ALLOCATION = {
  route: "mixed",
  unavailableReason: null,
  fallbackReason: "no-combo-candidates",
  skipReasonCode: null,
  bankroll: 10000,
  perRaceCap: 3000,
  kellyFraction: 0.25,
  evThreshold: 1.1,
  includeComboOdds: true,
  includeWide: true,
  includeTrio: false,
  includeQuinella: null,
  includeExacta: true,
  includeTrifecta: false,
  includeBracketQuinella: null,
  betUnit: 100,
  oddsStatus: "result",
  bets: [
    { betType: "place", comboKey: "01", stake: 300, odds: 1.8, ev: 1.2 },
    { betType: "wide", comboKey: "0102", stake: 200, odds: null, ev: null },
  ],
} as const;

function analysis(over: Partial<AnalysisDetail> = {}): AnalysisDetail {
  return {
    id: 7,
    raceId: RACE_ID,
    analyzedAt: "2026-06-28T05:00:00.000Z",
    kaisaiDate: "20260628",
    evEstimated: false,
    model: null,
    llmNote: null,
    llmCalls: null,
    race: { venueName: "福島", raceNumber: 11, raceName: "テストステークス", grade: null, oddsStatus: "result", placeBasis: "top3" },
    horses: [horse(1), horse(2)],
    allocation: { ...ALLOCATION, bets: [...ALLOCATION.bets] },
    detail: "present",
    ...over,
  };
}

const ready = (a: AnalysisDetail): ResultSource => ({ kind: "ready", analysis: a });

function content(a: AnalysisDetail, route: Route = ROUTE) {
  const model = buildResultModel({ route, source: ready(a) });
  expect(model.content, "前提: 内容が出る状態").not.toBeNull();
  return model.content!;
}

describe("見出しのグレード(Issue #250)", () => {
  const withRace = (over: Partial<AnalysisDetail["race"]>) => analysis({ race: { venueName: "東京", raceNumber: 11, raceName: "アイルランドT", grade: null, oddsStatus: null, placeBasis: "top3", ...over } });

  it.each([
    ["中央の G3", "G3", "東京11R アイルランドT(G3)"],
    ["障害の J・G2", "J・G2", "東京11R アイルランドT(J・G2)"],
    ["地方の Jpn1", "Jpn1", "東京11R アイルランドT(Jpn1)"],
    ["地方の重賞", "重賞", "東京11R アイルランドT(重賞)"],
    ["OP は付けない", "OP", "東京11R アイルランドT"],
    ["L は付けない", "L", "東京11R アイルランドT"],
    ["グレードなし(過去の分析・null)", null, "東京11R アイルランドT"],
  ] as const)("%s", (_name, grade, expected) => {
    expect(content(withRace({ grade })).title).toBe(expected);
  });

  it("レース名が無い(null。地方の分析など)ときは、グレードだけを後ろに付けない", () => {
    // 前提: レース名があれば付く
    expect(content(withRace({ grade: "G3" })).title).toBe("東京11R アイルランドT(G3)");
    expect(content(withRace({ raceName: null, grade: "G3" })).title).toBe("東京11R");
    expect(content(withRace({ raceName: "", grade: "G3" })).title).toBe("東京11R");
  });
});

describe("見出し・分析時刻・分析モデル", () => {
  it("見出し: 場名・R・レース名。null の部分は省き、全部無ければレース ID", () => {
    expect(content(analysis()).title).toBe("福島11R テストステークス");
    expect(content(analysis({ race: { venueName: null, raceNumber: 11, raceName: "テストステークス", grade: null, oddsStatus: null, placeBasis: "top3" } })).title).toBe("11R テストステークス");
    expect(content(analysis({ race: { venueName: "福島", raceNumber: null, raceName: null, grade: null, oddsStatus: null, placeBasis: "top3" } })).title).toBe("福島");
    expect(content(analysis({ race: { venueName: null, raceNumber: null, raceName: null, grade: null, oddsStatus: null, placeBasis: "top3" } })).title).toBe(`レース ${RACE_ID}`);
  });

  it("分析時刻は JST(UTC の 15:00 以降は翌日)", () => {
    expect(content(analysis()).analyzedAt).toBe("2026-06-28 14:00");
    expect(content(analysis({ analyzedAt: "2026-06-28T15:00:00.000Z" })).analyzedAt).toBe("2026-06-29 00:00");
  });

  it("分析モデル: null なら「LLM 未使用(統計のみ)」、あればその名前", () => {
    expect(content(analysis({ model: null })).model).toBe("LLM 未使用(統計のみ)");
    expect(content(analysis({ model: "claude-sonnet-x" })).model).toBe("claude-sonnet-x");
  });
});

describe("馬のカード", () => {
  it("馬番・馬名・3着内率(prior)・複勝オッズの下限・EV を、exe の表記(3着内率 52.3%・オッズ小数 1 桁・EV 小数 2 桁)で出す。サーバの並び(馬番順)のまま", () => {
    const horses = content(analysis({ horses: [horse(3, { name: "アルファ", prior: 0.523, adjustedProb: 0.4, placeOddsMin: 2.34, ev: 1.234 }), horse(1, { name: null })] })).horses;
    expect(horses.map((h) => h.umaban)).toEqual([3, 1]);
    expect(horses[0]).toMatchObject({ umaban: 3, name: "アルファ", prior: "52.3%", odds: "2.3", ev: "1.23" });
    expect(horses[1]!.name).toBeNull();
  });

  it("3着内率は常に prior。LLM なし(モデルが null)では、補正後・根拠はデータに値があっても出さない(補正後の値・「AI補正後」の語が画面のデータのどこにも無い)", () => {
    const a = analysis({ model: null, horses: [horse(1, { prior: 0.2, adjustedProb: 0.18, reason: "秘密の根拠その1" }), horse(2, { prior: 0.3, adjustedProb: 0.373, reason: "秘密の根拠その2" })] });
    expect(a.horses.every((h) => h.prior !== h.adjustedProb), "前提: 補正後が prior と違う(同じ値だと、出ていないことを検出できない)").toBe(true);
    const model = buildResultModel({ route: ROUTE, source: ready(a) });
    expect(model.content!.horses.map((h) => [h.prior, h.adjusted, h.reason])).toEqual([
      ["20.0%", null, null],
      ["30.0%", null, null],
    ]);
    const text = JSON.stringify(model);
    expect(text).not.toContain("18.0%");
    expect(text).not.toContain("37.3%");
    expect(text).not.toContain("AI補正後");
    expect(text).not.toContain("秘密の根拠");
  });

  it("LLM が効いたとき(モデル ID がある)は、3着内率(prior)に加えて補正後の3着内率と根拠を出す。補正後は exe の表記(小数第1位のパーセント)、ラベルは exe の共有定数", () => {
    const a = analysis({ model: "claude-sonnet-x", horses: [horse(1, { prior: 0.2, adjustedProb: 0.25, reason: "調教の動きが良い" }), horse(2, { prior: 0.3, adjustedProb: 0.373, reason: null })] });
    const horses = content(a).horses;
    expect(horses.map((h) => [h.prior, h.adjusted, h.reason])).toEqual([
      ["20.0%", "25.0%", "調教の動きが良い"],
      ["30.0%", "37.3%", null], // 根拠が null の馬は、根拠の行を出さない(null)
    ]);
  });

  it("モデルが空文字・null のときは LLM なし(exe の analysisModelText と同じ扱い)。空文字のモデル名を「LLM が効いた」と読まない", () => {
    for (const model of [null, ""]) {
      const c = content(analysis({ model, horses: [horse(1, { prior: 0.2, adjustedProb: 0.25, reason: "根拠" })] }));
      expect(c.model, `model=${JSON.stringify(model)}`).toBe("LLM 未使用(統計のみ)");
      expect(c.horses[0]).toMatchObject({ adjusted: null, reason: null });
    }
  });

  it("根拠が空文字の馬は、根拠の行を出さない(null)", () => {
    expect(content(analysis({ model: "claude-x", horses: [horse(1, { reason: "" })] })).horses[0]!.reason).toBeNull();
  });

  describe("強調材料・懸念事項(Issue #198)。LLM が効いたとき(モデル ID があるとき)だけ", () => {
    const withPoints = (over: Partial<AnalysisHorse> = {}) => horse(1, { highlights: ["追い切り好時計", "内枠有利"], concerns: ["距離延長"], ...over });

    it("LLM が効いたとき: 項目を順序のまま、強調材料と懸念事項を取り違えずに出す", () => {
      const h = content(analysis({ model: "claude-x", horses: [withPoints()] })).horses[0]!;
      expect(h.highlights).toEqual(["追い切り好時計", "内枠有利"]);
      expect(h.concerns).toEqual(["距離延長"]);
    });

    it("LLM なし(モデル null・空文字): データに項目があっても、強調材料・懸念事項は空(画面のデータのどこにも無い)", () => {
      for (const model of [null, ""]) {
        const a = analysis({ model, horses: [withPoints()] });
        expect(a.horses[0]!.highlights.length, "前提: データには項目がある(空でないと、出ていないことを検出できない)").toBeGreaterThan(0);
        const model2 = buildResultModel({ route: ROUTE, source: ready(a) });
        const h = model2.content!.horses[0]!;
        expect([h.highlights, h.concerns], `model=${JSON.stringify(model)}`).toEqual([[], []]);
        const text = JSON.stringify(model2);
        expect(text).not.toContain("追い切り好時計");
        expect(text).not.toContain("距離延長");
      }
    });

    it("空文字・空白だけの項目は捨てる(空の箇条書きを出さない)。ほかの項目は文字列を加工せずそのまま", () => {
      const h = content(analysis({ model: "claude-x", horses: [withPoints({ highlights: ["", "  ", " 前後に空白 ", "強み"], concerns: ["\t", ""] })] })).horses[0]!;
      expect(h.highlights).toEqual([" 前後に空白 ", "強み"]);
      expect(h.concerns).toEqual([]);
    });

    it("馬ごとに独立(項目のある馬・片方だけの馬・両方空の馬)", () => {
      const c = content(analysis({ model: "claude-x", horses: [withPoints(), horse(2, { highlights: [], concerns: ["外枠"] }), horse(3)] }));
      expect(c.horses.map((h) => [h.highlights.length, h.concerns.length])).toEqual([
        [2, 1],
        [0, 1],
        [0, 0],
      ]);
    });
  });

  describe("LLM の所要時間・usage(Issue #198)", () => {
    const CALL = { ok: true, ms: 41_234, inputTokens: 15_001, outputTokens: 6_020, stopReason: "end_turn", model: "claude-sonnet-5-5", replayed: false, error: null } as const;
    const FAILED = { ok: false, ms: 180_001, inputTokens: null, outputTokens: null, stopReason: null, model: null, replayed: false, error: "種別=timeout" } as const;

    it("記録があれば、モデルの有無に関係なく出す(全回が失敗してフォールバックした分析は、モデルが null でも時間と失敗回数を見たい)", () => {
      const effective = content(analysis({ model: "claude-x", llmCalls: [CALL] })).llmUsage;
      expect(effective).toEqual({ summary: "LLM: 1回・41秒・入力 15,001・出力(思考を含む) 6,020 トークン", warnings: [] });
      const failedAll = content(analysis({ model: null, llmCalls: [FAILED, FAILED] })).llmUsage;
      expect(failedAll).toEqual({ summary: "LLM: 2回・6分00秒", warnings: ["失敗した呼び出しが 2 回ありました"] });
    });

    it("記録なし(null: LLM を呼ばなかった・旧い分析)・空配列は null(何も出さない)", () => {
      expect(content(analysis({ model: null, llmCalls: null })).llmUsage).toBeNull();
      expect(content(analysis({ model: "claude-x", llmCalls: null })).llmUsage).toBeNull();
      expect(content(analysis({ model: "claude-x", llmCalls: [] })).llmUsage).toBeNull();
    });

    it("再生・切り詰めは合計に含めたうえで警告になる(buildLlmUsage の結果と同じ)", () => {
      const calls = [{ ...CALL, stopReason: "max_tokens", outputTokens: 16_000 }, { ...CALL, replayed: true }];
      const u = content(analysis({ model: "claude-x", llmCalls: calls })).llmUsage!;
      expect(u.summary).toContain("LLM: 2回");
      expect(u.warnings).toHaveLength(2);
    });
  });

  it("オッズ・EV が null なら「-」(EV が null のときは推定の接尾辞も付けない)", () => {
    const h = content(analysis({ evEstimated: true, horses: [horse(1, { placeOddsMin: null, ev: null })] })).horses[0]!;
    expect(h.odds).toBe("-");
    expect(h.ev).toBe("-");
  });

  it("推定 EV(evEstimated)なら EV に「(推定)」の接尾辞。確定なら付けない", () => {
    expect(content(analysis({ evEstimated: true, horses: [horse(1, { ev: 1.05 })] })).horses[0]!.ev).toBe("1.05(推定)");
    expect(content(analysis({ evEstimated: false, horses: [horse(1, { ev: 1.05 })] })).horses[0]!.ev).toBe("1.05");
  });

  it("EV プラスの強調はサーバの isPositive に従う(EV が 1 を超えていても isPositive が false なら強調しない。逆も)", () => {
    const horses = content(analysis({ horses: [horse(1, { ev: 1.05, isPositive: false }), horse(2, { ev: 0.9, isPositive: true }), horse(3, { ev: null, isPositive: false })] })).horses;
    expect(horses.map((h) => h.positive)).toEqual([false, true, false]);
  });

  it("印は mark が non-null のときだけ(null・空文字でない文字列)。null なら印のキーが null", () => {
    const horses = content(analysis({ horses: [horse(1, { mark: "◎" }), horse(2, { mark: null }), horse(3, { mark: "▲" })] })).horses;
    expect(horses.map((h) => h.mark)).toEqual(["◎", null, "▲"]);
  });
});

describe("印の凡例(exe の MARK_LEGEND)", () => {
  it("印が1頭でもあるときだけ凡例を出す(exe の共有定数。全馬 null なら null)", () => {
    expect(content(analysis({ model: "claude-x", horses: [horse(1, { mark: null }), horse(2, { mark: "◎" })] })).markLegend).toBe(MARK_LEGEND);
    expect(content(analysis({ model: "claude-x", horses: [horse(1, { mark: null }), horse(2, { mark: null })] })).markLegend).toBeNull();
    expect(content(analysis({ model: null, horses: [horse(1)] })).markLegend).toBeNull();
  });
});

/**
 * Issue #211: 印の付いた馬の一覧(`markedHorses`。印・馬番・馬名だけ。数値は出さない)。
 * 並びは印の順(core の `PREDICTION_MARKS`)→ 同じ印の中は馬番の昇順。印の無い馬(null・空白だけ)は含めない。
 * `PREDICTION_MARKS` に無い印(API は文字列としてしか検証していない)は既知の印の後ろに、馬番の昇順で置く(落とさない)。
 * 凡例(`markLegend`)の出る条件は「一覧が空でない」と同じ。
 */
describe("印の付いた馬の一覧(Issue #211)", () => {
  const marked = (horses: AnalysisHorse[]) => content(analysis({ horses })).markedHorses;

  it("クライアントの印の順の定数は、core の PREDICTION_MARKS と(順序まで)一致する", () => {
    expect(PREDICTION_MARKS.length).toBeGreaterThan(0); // 前提: 比較対象が空でない
    expect([...KNOWN_MARK_ORDER]).toEqual([...PREDICTION_MARKS]);
  });

  it("印の順(◎〇▲△☆注)→ 同じ印の中は馬番の昇順。入力は意図的に逆順・混在にして、並べ替えが実際に起きていることを固定する", () => {
    const input = [
      horse(9, { mark: "注" }),
      horse(8, { mark: "☆" }),
      horse(7, { mark: "△" }),
      horse(6, { mark: "△" }),
      horse(5, { mark: "▲" }),
      horse(4, { mark: "〇" }),
      horse(3, { mark: "◎" }),
      horse(2, { mark: "〇" }),
    ];
    const out = marked(input);
    expect(out.map((m) => m.umaban)).not.toEqual(input.map((h) => h.umaban)); // 前提: 入力順のままではない(並べ替えが効いている)
    expect(out.map((m) => `${m.mark}${m.umaban}`)).toEqual(["◎3", "〇2", "〇4", "▲5", "△6", "△7", "☆8", "注9"]);
  });

  it("印の無い馬は含めない(null・空文字・空白だけ)。1頭も無ければ空配列", () => {
    const input = [horse(1, { mark: null }), horse(2, { mark: "◎" }), horse(3, { mark: "" }), horse(4, { mark: "  " })];
    expect(marked(input).map((m) => m.umaban)).toEqual([2]);
    expect(marked([horse(1), horse(2)])).toEqual([]);
  });

  it("未知の印(PREDICTION_MARKS に無い文字列)は、既知の印の後ろに馬番の昇順で置く。落とさない・クラッシュしない", () => {
    const out = marked([horse(1, { mark: "?" }), horse(2, { mark: "注" }), horse(3, { mark: "<img src=x>" }), horse(4, { mark: "◎" }), horse(0, { mark: "★" })]);
    expect(out.map((m) => m.umaban)).toEqual([4, 2, 0, 1, 3]);
    expect(out.map((m) => m.mark)).toEqual(["◎", "注", "★", "?", "<img src=x>"]);
  });

  it("同じ印・同じ馬番(想定外の重複)は、入力の順を保つ(安定)", () => {
    const out = marked([horse(5, { mark: "◎", name: "先" }), horse(5, { mark: "◎", name: "後" })]);
    expect(out.map((m) => m.name)).toEqual(["先", "後"]);
  });

  it("1行は印・馬番・馬名だけ(数値を持たない)。馬名が null・空文字なら馬名は null", () => {
    const out = marked([horse(1, { mark: "◎", name: "エートラックス" }), horse(2, { mark: "〇", name: null }), horse(3, { mark: "▲", name: "" })]);
    expect(out).toEqual([
      { umaban: 1, name: "エートラックス", mark: "◎", markRepair: null },
      { umaban: 2, name: null, mark: "〇", markRepair: null },
      { umaban: 3, name: null, mark: "▲", markRepair: null },
    ]);
  });

  it("凡例は一覧が空でないときだけ(印が空白だけの馬しかいなければ、一覧も凡例も出ない)。LLM の有無によらない", () => {
    const onlyBlank = content(analysis({ model: "claude-x", horses: [horse(1, { mark: "  " })] }));
    expect(onlyBlank.markedHorses).toEqual([]);
    expect(onlyBlank.markLegend).toBeNull();
    for (const model of [null, "claude-x"]) {
      const c = content(analysis({ model, horses: [horse(1, { mark: "◎" })] }));
      expect(c.markedHorses).toHaveLength(1);
      expect(c.markLegend).toBe(MARK_LEGEND);
    }
  });

  it("馬ごとの評価(horses)の並び・印は変えない(既存の馬カードの印は mark のまま)", () => {
    const c = content(analysis({ horses: [horse(3, { mark: "▲" }), horse(1, { mark: "◎" }), horse(2, { mark: "" })] }));
    expect(c.horses.map((x) => x.umaban)).toEqual([3, 1, 2]);
    expect(c.horses.map((x) => x.mark)).toEqual(["▲", "◎", ""]);
  });
});

describe("LLM を使わなかった・一部しか使わなかった理由(llmNote。Issue #195)", () => {
  const NO_KEY = "LLM の API キーが未登録のため、LLM を使わず統計のみで分析しました";
  const MARKS = "印の制約違反のため、印は付けていません(3着内率の補正は反映しています)";

  it("理由は、モデルの有無に関係なく、null でなければそのまま出す(LLM なし+理由 / LLM あり+理由〈印の制約違反〉 / 理由なし)", () => {
    expect(content(analysis({ model: null, llmNote: NO_KEY })).llmNote).toBe(NO_KEY);
    expect(content(analysis({ model: "claude-x", llmNote: MARKS })).llmNote).toBe(MARKS);
    expect(content(analysis({ model: "claude-x", llmNote: null })).llmNote).toBeNull();
    expect(content(analysis({ model: null, llmNote: null })).llmNote).toBeNull(); // 過去の分析
  });

  it("印の制約違反(モデルあり・理由あり・印なし): 補正後は出し、印は出ない。モデル名は理由と独立に出る", () => {
    const c = content(analysis({ model: "claude-x", llmNote: MARKS, horses: [horse(1, { adjustedProb: 0.25, mark: null })] }));
    expect(c.model).toBe("claude-x");
    expect(c.horses[0]).toMatchObject({ adjusted: "25.0%", mark: null });
  });
});

describe("詳細の状態の注記(detail)", () => {
  it("present なら注記なし。missing と none は別の文言", () => {
    const present = content(analysis({ detail: "present" })).detailNote;
    const missing = content(analysis({ detail: "missing" })).detailNote;
    const none = content(analysis({ detail: "none" })).detailNote;
    expect(present).toBeNull();
    expect(missing).toEqual(expect.any(String));
    expect(none).toEqual(expect.any(String));
    expect(missing).not.toBe(none);
    expect(missing).toContain("取得できませんでした");
    expect(none).toContain("保存されていません");
  });
});

describe("配分(exe の buildAllocationProposalView を流用)", () => {
  it("配分あり: 買い目(券種・組合せ・金額・オッズ・EV)・フォールバックの注記・実効設定が出る", () => {
    const allocation = content(analysis()).allocation;
    expect(allocation.kind).toBe("allocated");
    expect(allocation.notices).toEqual(["組合せ券種にEVプラスの候補が無かったため複勝のみの配分になっています。"]);
    expect(allocation.bets).toEqual([
      { betTypeLabel: "複勝", comboLabel: "1番", stake: "300円", odds: "1.8", ev: "1.20" },
      { betTypeLabel: "ワイド", comboLabel: "1-2", stake: "200円", odds: "-", ev: "-" },
    ]);
    expect(allocation.settingsRows).toContain("総資金: 10,000円");
    expect(allocation.settingsRows).toContain("馬連: 記録なし");
  });

  it("点数の上限(Issue #578): 実効設定に『単勝の点数の上限』『複勝の点数の上限』が出る(値・上限なし・記録なし)", () => {
    const rowsOf = (caps: { maxWinBets: number | null; maxPlaceBets: number | null }) => content(analysis({ allocation: { ...analysis().allocation!, ...caps } })).allocation.settingsRows;
    expect(rowsOf({ maxWinBets: 2, maxPlaceBets: 0 })).toEqual(expect.arrayContaining(["単勝の点数の上限: 2 点", "複勝の点数の上限: 上限なし"]));
    expect(rowsOf({ maxWinBets: null, maxPlaceBets: null })).toEqual(expect.arrayContaining(["単勝の点数の上限: 記録なし", "複勝の点数の上限: 記録なし"]));
  });

  it("fallbackReason が null ならフォールバックの注記は出ない(値があるときだけ出る)", () => {
    const allocation = content(analysis({ allocation: { ...ALLOCATION, bets: [...ALLOCATION.bets], fallbackReason: null } })).allocation;
    expect(allocation.notices).toEqual([]);
  });

  it("見送り(cap-too-small)は、記録された単位額を文言に使う(null なら「単位額が記録されていません」)", () => {
    const skip = { ...ALLOCATION, bets: [], route: "place-only", skipReasonCode: "cap-too-small" };
    const withUnit = content(analysis({ allocation: { ...skip, betUnit: 100 } })).allocation;
    expect(withUnit.kind).toBe("skip");
    expect(withUnit.notices[0]).toBe("1レースの上限が100円未満のため配分できません");
    const withoutUnit = content(analysis({ allocation: { ...skip, betUnit: null, fallbackReason: null } })).allocation;
    expect(withoutUnit.notices).toEqual(["1レースの上限が最小賭け金単位を下回るため配分できません(単位額が記録されていません)"]);
  });

  describe("配分が unset(総資金・1レース上限が未設定。cloud の既定値は 0 なので、ほぼ全件がこの状態)", () => {
    const unset = (over: Record<string, unknown> = {}) => ({ ...ALLOCATION, bets: [], route: "unset", fallbackReason: null, skipReasonCode: null, bankroll: 0, perRaceCap: 0, ...over });

    it("cloud 専用の文言をリテラルで 1 回固定する(文言を変えるときは、意図してここを直す)。設定の画面(トップの「設定」)を案内し、「設定画面で」「D1」「今後追加」を含まない", () => {
      expect(UNSET_ALLOCATION_NOTE).toBe(
        "配分の提案は出ていません。クラウド版の「馬券用の総資金」と「1レースの上限」が未設定です(トップの「設定」から入れられます)。",
      );
    });

    it("案内する先は実在する設定の画面(Issue #189): 「設定」への入口を案内し、「今後追加」「D1」「cloud_settings」(旧文言の、画面が無い前提)を含まない", () => {
      expect(UNSET_ALLOCATION_NOTE).toContain("トップの「設定」");
      for (const old of ["今後追加", "D1", "cloud_settings", "設定画面で"]) {
        expect(UNSET_ALLOCATION_NOTE, old).not.toContain(old);
      }
    });

    it("両方が未設定(0)のときだけ、exe の「設定画面で…入力してください」を cloud 専用の文言に差し替える。「設定画面で」を含まない。実効設定の行は残る", () => {
      const allocation = content(analysis({ allocation: unset() })).allocation;
      expect(allocation.kind).toBe("unset");
      expect(allocation.notices).toEqual([UNSET_ALLOCATION_NOTE]);
      expect(JSON.stringify(allocation.notices)).not.toContain("設定画面で");
      expect(allocation.bets).toEqual([]);
      expect(allocation.settingsRows).toContain("総資金: 0円");
      expect(allocation.settingsRows).toContain("1レース上限: 0円");
    });

    it("片方だけ未設定・判定不能は、exe の対応する注記のまま(cloud の文言は入らない。直下の実効設定の行と矛盾しない)", () => {
      const cases: readonly [string, Record<string, unknown>, string][] = [
        ["総資金だけ 0", unset({ bankroll: 0, perRaceCap: 3000 }), UNSET_BANKROLL_ONLY_NOTE],
        ["1レース上限だけ 0", unset({ bankroll: 1_000_000, perRaceCap: 0 }), UNSET_PER_RACE_CAP_ONLY_NOTE],
        ["unset なのに両方が正(判定不能)", unset({ bankroll: 10000, perRaceCap: 3000 }), UNSET_INDETERMINATE_NOTE],
      ];
      for (const [name, allocation, exeNote] of cases) {
        const section = content(analysis({ allocation: allocation as never })).allocation;
        expect(section.kind, name).toBe("unset");
        expect(section.notices, name).toEqual([exeNote]);
        expect(section.notices, name).not.toContain(UNSET_ALLOCATION_NOTE);
      }
    });

    it("対照: 差し替える対象(exe の両方未設定の注記)は「設定画面で」を含み、他の 3 つの unset の注記は含まない(差し替えの条件が、設定画面に触れる 1 つだけ)", () => {
      expect(BET_ALLOCATION_UNSET_NOTE).toContain("設定画面で");
      for (const note of [UNSET_BANKROLL_ONLY_NOTE, UNSET_PER_RACE_CAP_ONLY_NOTE, UNSET_INDETERMINATE_NOTE]) {
        expect(note).not.toContain("設定画面");
      }
      expect(UNSET_ALLOCATION_NOTE).not.toBe(BET_ALLOCATION_UNSET_NOTE);
    });

    it("unset 以外(見送り・複勝対象外・配分あり・判定不能・yoso・invalid)は exe の文言のまま(差し替えない)。複勝対象外は exe の定数とも一致する", () => {
      expect(placeBetUnavailableMessage("not-sold")).toBe("複勝が発売されないため対象外です");
      const cases: readonly [string, Record<string, unknown>, string][] = [
        ["skip", { ...ALLOCATION, bets: [], route: "place-only", skipReasonCode: "cap-too-small", betUnit: 100, fallbackReason: null }, "1レースの上限が100円未満のため配分できません"],
        ["unavailable", { ...ALLOCATION, bets: [], route: "unavailable", unavailableReason: "not-sold", fallbackReason: null }, "複勝が発売されないため対象外です"],
        ["yoso", { ...ALLOCATION, bets: [], route: "yoso", fallbackReason: null }, "分析時点でオッズが未発売だったため、配分提案を行っていません。"],
        ["invalid", { ...ALLOCATION, bets: [], route: "invalid", fallbackReason: null }, "配分計算中にエラーが発生したため、配分を提案していません。"],
        ["indeterminate", { ...ALLOCATION, bets: [], route: "future-route", fallbackReason: null }, "配分提案の状態を判定できません(記録された種別が不明です)。"],
        ["allocated", { ...ALLOCATION, bets: [...ALLOCATION.bets] }, "組合せ券種にEVプラスの候補が無かったため複勝のみの配分になっています。"],
      ];
      for (const [kind, allocation, expectedNotice] of cases) {
        const section = content(analysis({ allocation: allocation as never })).allocation;
        expect(section.kind, kind).toBe(kind);
        expect(section.notices, kind).not.toContain(UNSET_ALLOCATION_NOTE);
        expect(section.notices.length, kind).toBeGreaterThan(0);
        expect(section.notices[0], kind).toBe(expectedNotice);
      }
    });
  });

  it("配分の記録が無い(null)ときは cloud 専用の文言(exe の「Issue #59より前の分析です」を出さない)", () => {
    const allocation = content(analysis({ allocation: null })).allocation;
    expect(allocation.kind).toBe("none");
    expect(allocation.notices).toEqual([NO_ALLOCATION_NOTE]);
    expect(allocation.bets).toEqual([]);
    expect(allocation.settingsRows).toEqual([]);
    expect(JSON.stringify(allocation)).not.toContain("#59");
  });

  it("未知の route は「判定不能」の注記(クライアントで落とさない・買い目を出さない)", () => {
    const allocation = content(analysis({ allocation: { ...ALLOCATION, bets: [...ALLOCATION.bets], route: "future-route" } })).allocation;
    expect(allocation.kind).toBe("indeterminate");
    expect(allocation.bets).toEqual([]);
  });
});

describe("取得の状態(読み込み中・失敗)と戻るリンク", () => {
  it("読み込み中・失敗は内容なし。失敗の文言をそのまま出し、一覧へ戻るリンクを持つ(日付・区分を保つ)", () => {
    const route: Route = { date: "20261003", venue: "nar", race: null, analysis: 7, settings: false };
    const loading = buildResultModel({ route, source: { kind: "loading" } });
    expect(loading).toMatchObject({ kind: "result", loading: true, error: null, content: null, backHref: "#date=20261003&venue=nar" });
    const failed = buildResultModel({ route, source: { kind: "error", message: "取得できません" } });
    expect(failed).toMatchObject({ loading: false, error: "取得できません", content: null, backHref: "#date=20261003&venue=nar" });
  });

  it("内容があるときの戻り先は、そのレースの画面。日付は分析の kaisaiDate を優先する(ハッシュの日付は既定の「今日」のことがある)", () => {
    const route: Route = { date: "20261007", venue: "central", race: null, analysis: 7, settings: false };
    expect(buildResultModel({ route, source: ready(analysis({ kaisaiDate: "20260628" })) }).backHref).toBe(`#date=20260628&venue=central&race=${RACE_ID}`);
  });

  it("kaisaiDate が null・実在しない日付なら、ハッシュの日付を使う。レース ID が 12 桁でなければ一覧へ", () => {
    const route: Route = { date: "20261007", venue: "nar", race: null, analysis: 7, settings: false };
    expect(buildResultModel({ route, source: ready(analysis({ kaisaiDate: null })) }).backHref).toBe(`#date=20261007&venue=nar&race=${RACE_ID}`);
    expect(buildResultModel({ route, source: ready(analysis({ kaisaiDate: "20260230" })) }).backHref).toBe(`#date=20261007&venue=nar&race=${RACE_ID}`);
    expect(buildResultModel({ route, source: ready(analysis({ raceId: "短い" })) }).backHref).toBe("#date=20260628&venue=nar"); // 日付は分析の開催日、レースは付けない
  });
});

describe("強調材料・懸念事項のラベル(Issue #199。exe の結果表と共有する定数)", () => {
  it("cloud の画面が使うラベルは、exe の `format.ts` の共有定数と同じ値で、文言は「強調材料」「懸念事項」", () => {
    expect(EXE_LABEL_HIGHLIGHTS).toBe("強調材料");
    expect(EXE_LABEL_CONCERNS).toBe("懸念事項");
    expect(LABEL_HIGHLIGHTS).toBe(EXE_LABEL_HIGHLIGHTS);
    expect(LABEL_CONCERNS).toBe(EXE_LABEL_CONCERNS);
  });
});

/**
 * Issue #240: 3着内率の上位5頭(`topProbs`。馬番・馬名・率・印)。
 * LLM が効いた分析(モデル ID あり)は補正後の3着内率(`adjustedProb`)、効いていない分析は3着内率(`prior`)で並べ、見出しで取り違えない。
 * 並びは率(生の数値)の降順 → 同率は馬番の昇順。5頭未満なら全頭。率が欠けた(非有限の)馬は除く。全頭が欠けていれば null。
 */
describe("3着内率の上位5頭(Issue #240)", () => {
  /** 馬番と率だけを指定する(prior と adjustedProb を別々に与えて、どちらで並べたかを区別できるようにする)。 */
  const h = (umaban: number, prior: number, adjustedProb: number, over: Partial<AnalysisHorse> = {}) => horse(umaban, { prior, adjustedProb, ...over });
  const top = (horses: AnalysisHorse[], model: string | null) => content(analysis({ model, horses })).topProbs;
  const umabans = (horses: AnalysisHorse[], model: string | null) => (top(horses, model)?.rows ?? []).map((r) => r.umaban);

  it("見出しは LLM の有無で変わる(あり: 「AI補正後の3着内率 上位5頭」、なし: 「3着内率 上位5頭」。exe の共有ラベルから組み立てる)", () => {
    expect(top([h(1, 0.3, 0.3)], "claude-x")?.heading).toBe(`${LABEL_ADJUSTED_PROB}の3着内率 上位5頭`);
    expect(top([h(1, 0.3, 0.3)], null)?.heading).toBe(`${LABEL_PRIOR} 上位5頭`);
    expect(top([h(1, 0.3, 0.3)], "")?.heading).toBe(`${LABEL_PRIOR} 上位5頭`); // 空文字も「効いていない」
    expect(top([h(1, 0.3, 0.3)], "claude-x")?.heading).toBe("AI補正後の3着内率 上位5頭");
    expect(top([h(1, 0.3, 0.3)], null)?.heading).toBe("3着内率 上位5頭");
  });

  it("LLM の有無で並べる値が変わる(prior と adjustedProb の順位が食い違う入力。表示する率も並べた値と同じ)", () => {
    const input = [h(1, 0.3, 0.1), h(2, 0.2, 0.2), h(3, 0.1, 0.3)];
    // 前提: 2つの値の順位は食い違っている(同じ順位だと、取り違えても検出できない)
    const byPrior = [...input].sort((a, b) => b.prior - a.prior).map((x) => x.umaban);
    const byAdjusted = [...input].sort((a, b) => b.adjustedProb - a.adjustedProb).map((x) => x.umaban);
    expect(byPrior).toEqual([1, 2, 3]);
    expect(byAdjusted).toEqual([3, 2, 1]);
    expect(umabans(input, "claude-x")).toEqual([3, 2, 1]);
    expect(umabans(input, null)).toEqual([1, 2, 3]);
    expect(top(input, "claude-x")?.rows.map((r) => r.rate)).toEqual(["30.0%", "20.0%", "10.0%"]);
    expect(top(input, null)?.rows.map((r) => r.rate)).toEqual(["30.0%", "20.0%", "10.0%"]);
    expect(top(input, "claude-x")?.rows[0]).toMatchObject({ umaban: 3, rate: "30.0%" }); // adjustedProb(馬3=0.3)を表示している
    expect(top(input, null)?.rows[0]).toMatchObject({ umaban: 1, rate: "30.0%" });
    expect(top([h(1, 0.31, 0.12)], "claude-x")?.rows[0]?.rate).toBe("12.0%");
    expect(top([h(1, 0.31, 0.12)], null)?.rows[0]?.rate).toBe("31.0%");
  });

  // 頭数の境界: 入力は馬番の昇順だが率は馬番の逆順(並べ替えが実際に起きる)。上位5頭は率の高い順に5頭まで。
  const RATES = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]; // 馬番 1..6 の率(馬6が最高)
  for (const [頭数, expected] of [
    [4, [4, 3, 2, 1]],
    [5, [5, 4, 3, 2, 1]],
    [6, [6, 5, 4, 3, 2]],
  ] as const) {
    it(`${頭数}頭: 率の降順で ${expected.length} 頭(5頭まで)`, () => {
      const input = RATES.slice(0, 頭数).map((r, i) => h(i + 1, r, r));
      expect(input).toHaveLength(頭数);
      for (const model of [null, "claude-x"]) {
        expect(umabans(input, model)).toEqual(expected);
      }
    });
  }

  it("同率は馬番の昇順(入力は馬番の逆順にして、並べ替えが効いていることを固定する)", () => {
    const input = [h(5, 0.2, 0.2), h(3, 0.4, 0.4), h(2, 0.2, 0.2), h(4, 0.4, 0.4)];
    for (const model of [null, "claude-x"]) {
      expect(umabans(input, model)).toEqual([3, 4, 2, 5]);
    }
  });

  it("5位と6位が同率なら、馬番の小さい方を残す(切れ目は同率の中の馬番順)", () => {
    const input = [h(9, 0.1, 0.1), h(8, 0.1, 0.1), h(1, 0.5, 0.5), h(2, 0.4, 0.4), h(3, 0.3, 0.3), h(4, 0.2, 0.2)];
    expect(input).toHaveLength(6);
    for (const model of [null, "claude-x"]) {
      expect(umabans(input, model)).toEqual([1, 2, 3, 4, 8]); // 馬9ではなく馬8が5位
    }
  });

  it("同率の判定は生の数値(表示は同じ「20.0%」でも、生の値が大きい方が先)", () => {
    const input = [h(1, 0.2, 0.2), h(2, 0.2004, 0.2004)];
    expect(top(input, null)?.rows.map((r) => r.rate)).toEqual(["20.0%", "20.0%"]); // 前提: 表示は同じ
    expect(umabans(input, null)).toEqual([2, 1]);
  });

  it("率が欠けた(非有限の)馬は一覧から除く。並べる値の側が欠けているときだけ(prior が NaN でも LLM ありなら adjustedProb で出る)", () => {
    const input = [h(1, 0.3, Number.NaN), h(2, 0.2, 0.2), h(3, Number.POSITIVE_INFINITY, 0.1), h(4, Number.NaN, 0.4)];
    expect(umabans(input, "claude-x")).toEqual([4, 2, 3]); // adjustedProb が NaN の馬1だけ除く
    expect(umabans(input, null)).toEqual([1, 2]); // prior が NaN の馬4・Infinity の馬3を除く(残りは prior の降順: 馬1=0.3 > 馬2=0.2)
  });

  it("全頭の率が欠けていれば null(節ごと出さない)。馬が0頭でも null", () => {
    expect(top([h(1, Number.NaN, Number.NaN), h(2, Number.NaN, Number.NaN)], null)).toBeNull();
    expect(top([h(1, Number.NaN, Number.NaN)], "claude-x")).toBeNull();
    expect(top([], "claude-x")).toBeNull();
    expect(top([h(1, 0.1, 0.1)], null)).not.toBeNull(); // 対照: 1頭あれば出る
  });

  it("1行は馬番・馬名・率・印。馬名が null・空文字なら null。印は markedHorses と同じ基準(null・空白だけは null、他は未知の印もそのまま)", () => {
    const input = [
      h(1, 0.6, 0.6, { name: "エコー", mark: "◎" }),
      h(2, 0.5, 0.5, { name: null, mark: "▲" }),
      h(3, 0.4, 0.4, { name: "", mark: null }),
      h(4, 0.3, 0.3, { name: "デルタ", mark: "  " }),
      h(5, 0.2, 0.2, { name: "ファイブ", mark: "?" }),
    ];
    expect(top(input, null)?.rows).toEqual([
      { umaban: 1, name: "エコー", rate: "60.0%", mark: "◎", repaired: false, shift: null },
      { umaban: 2, name: null, rate: "50.0%", mark: "▲", repaired: false, shift: null },
      { umaban: 3, name: null, rate: "40.0%", mark: null, repaired: false, shift: null },
      { umaban: 4, name: "デルタ", rate: "30.0%", mark: null, repaired: false, shift: null },
      { umaban: 5, name: "ファイブ", rate: "20.0%", mark: "?", repaired: false, shift: null },
    ]);
  });

  it("率の書式はカードと同じ(formatPercent: 小数第1位)。カードの prior・adjusted と同じ文字列", () => {
    const input = [h(1, 0.52345, 0.25049)];
    const c = content(analysis({ model: "claude-x", horses: input }));
    expect(c.topProbs?.rows[0]?.rate).toBe(c.horses[0]?.adjusted);
    const c2 = content(analysis({ model: null, horses: input }));
    expect(c2.topProbs?.rows[0]?.rate).toBe(c2.horses[0]?.prior);
    expect(c2.topProbs?.rows[0]?.rate).toBe("52.3%");
  });

  it("馬ごとの評価(horses)・印の付いた馬(markedHorses)は変えない", () => {
    const input = [h(3, 0.1, 0.1, { mark: "▲" }), h(1, 0.5, 0.5, { mark: "◎" }), h(2, 0.3, 0.3)];
    const c = content(analysis({ horses: input }));
    expect(c.horses.map((x) => x.umaban)).toEqual([3, 1, 2]);
    expect(c.markedHorses.map((m) => m.umaban)).toEqual([1, 3]);
    expect(c.topProbs?.rows.map((r) => r.umaban)).toEqual([1, 2, 3]);
  });
});

/**
 * Issue #312: 補正後の3着内率の横に、統計モデル(3着内率 = prior)からの変化量を添える(`HorseCard.adjustedShift`・`TopProbHorse.shift`)。
 * 書式は検証画面の補正幅(`formatAdjustment`)と同じ「+2.0pt」「-3.5pt」(ASCII のマイナス)。丸めて 0.0 になる差(絶対値 0.05pt 未満)は「±0.0pt」。
 * LLM が効いていない分析(補正後を出さない)・非有限の値では出さない(null)。
 */
describe("統計モデルからの変化量(Issue #312)", () => {
  const withShift = (prior: number, adjustedProb: number, model: string | null = "claude-x") => content(analysis({ model, horses: [horse(1, { prior, adjustedProb })] }));
  const cardShift = (prior: number, adjustedProb: number, model: string | null = "claude-x") => withShift(prior, adjustedProb, model).horses[0]!.adjustedShift;
  const topShift = (prior: number, adjustedProb: number, model: string | null = "claude-x") => withShift(prior, adjustedProb, model).topProbs?.rows[0]?.shift;

  // 丸めの境界(単位は 0〜1 の確率の差。±0.0005 が 0.05pt)。0.0005 ちょうどは浮動小数の誤差で向きが定まらないので、両側の値で固定する。
  const cases: readonly [string, number, number, string][] = [
    ["上がる", 0.2, 0.25, "+5.0pt"],
    ["下がる", 0.3, 0.265, "-3.5pt"],
    ["差が 0 ちょうど", 0.2, 0.2, "±0.0pt"],
    ["上がる側の境界の内側(+0.049pt)", 0.2, 0.20049, "±0.0pt"],
    ["上がる側の境界の外側(+0.051pt)", 0.2, 0.20051, "+0.1pt"],
    ["下がる側の境界の内側(-0.049pt)", 0.2, 0.19951, "±0.0pt"],
    ["下がる側の境界の外側(-0.051pt)", 0.2, 0.19949, "-0.1pt"],
    ["大きく上がる", 0.05, 0.6, "+55.0pt"],
    ["大きく下がる", 0.6, 0.05, "-55.0pt"],
    ["小数 1 桁へ丸める(+2.04pt)", 0.1, 0.1204, "+2.0pt"],
    ["小数 1 桁へ丸める(+2.06pt)", 0.1, 0.1206, "+2.1pt"],
  ];
  for (const [name, prior, adjusted, expected] of cases) {
    it(`${name}: ${expected}(カードと上位5頭の行で同じ文字列)`, () => {
      expect(cardShift(prior, adjusted)).toBe(expected);
      expect(topShift(prior, adjusted)).toBe(expected);
    });
  }

  it("前提: 境界の表の入力は、実際に補正後 ≠ prior で、表示のパーセントは(丸めると)同じに見える値を含む(出し分けを取り違えても検出できる)", () => {
    expect(cases.filter(([, p, a]) => p !== a).length).toBeGreaterThan(8);
    // 上の「±0.0pt」の行は、補正後と prior が内部では違う値(差が 0 でない)。0 ちょうどだけを ±0.0 と読む実装を弾く
    expect(0.20049 - 0.2).not.toBe(0);
    expect(withShift(0.2, 0.20049).horses[0]!.adjusted).toBe("20.0%");
  });

  it("LLM が効いていない(モデルが null・空文字)分析では、カードにも上位5頭の行にも出さない(補正後の値自体が出ないのと同じ規則)", () => {
    for (const model of [null, ""]) {
      expect(prior20vs25(model), `model=${JSON.stringify(model)}`).toEqual({ card: null, top: null });
    }
    // 対照: LLM が効けば出る
    expect(prior20vs25("claude-x")).toEqual({ card: "+5.0pt", top: "+5.0pt" });
    function prior20vs25(model: string | null) {
      const c = withShift(0.2, 0.25, model);
      return { card: c.horses[0]!.adjustedShift, top: c.topProbs?.rows[0]?.shift };
    }
  });

  it("prior・補正後のどちらかが非有限なら出さない(null。「NaNpt」を出さない)", () => {
    for (const [p, a] of [
      [Number.NaN, 0.2],
      [0.2, Number.NaN],
      [Number.POSITIVE_INFINITY, 0.2],
      [0.2, Number.NEGATIVE_INFINITY],
    ] as const) {
      expect(cardShift(p, a), `prior=${p} adjusted=${a}`).toBeNull();
    }
    // 上位5頭の行は並べる値(補正後)が有限なら残り、変化量だけ null(prior が非有限の馬)
    expect(topShift(Number.NaN, 0.2)).toBeNull();
    expect(withShift(Number.NaN, 0.2).topProbs?.rows).toHaveLength(1); // 前提: 行は残っている(null と「行が無い」を取り違えない)
  });

  it("上位5頭の行の変化量は、その馬自身の prior と補正後の差(並べ替えで取り違えない)", () => {
    const hs = [horse(1, { prior: 0.5, adjustedProb: 0.1 }), horse(2, { prior: 0.1, adjustedProb: 0.5 }), horse(3, { prior: 0.3, adjustedProb: 0.3 })];
    const c = content(analysis({ model: "claude-x", horses: hs }));
    expect(c.topProbs?.rows.map((r) => [r.umaban, r.shift])).toEqual([
      [2, "+40.0pt"],
      [3, "±0.0pt"],
      [1, "-40.0pt"],
    ]);
    expect(c.horses.map((x) => [x.umaban, x.adjustedShift])).toEqual([
      [1, "-40.0pt"],
      [2, "+40.0pt"],
      [3, "±0.0pt"],
    ]);
  });

  it("LLM なしの上位5頭の行は shift が null(率は prior で、比べる相手が無い)。行の他の項目は変えない", () => {
    const c = content(analysis({ model: null, horses: [horse(1, { prior: 0.3, adjustedProb: 0.1, name: "アイ", mark: "◎" })] }));
    expect(c.topProbs?.rows).toEqual([{ umaban: 1, name: "アイ", rate: "30.0%", mark: "◎", repaired: false, shift: null }]);
  });
});

describe("Issue #238: 閲覧者(readOnly)の配分の注記: 設定への案内を出さない(閲覧者は設定に入れない)", () => {
  const unsetAllocation = (over: Record<string, unknown> = {}) => ({ ...ALLOCATION, bets: [], route: "unset", fallbackReason: null, skipReasonCode: null, bankroll: 0, perRaceCap: 0, ...over });
  const section = (a: AnalysisDetail, readOnly: boolean) => {
    const model = buildResultModel({ route: ROUTE, source: ready(a), ...(readOnly ? { readOnly: true } : {}) });
    expect(model.content, "前提: 内容が出る状態").not.toBeNull();
    return model.content!.allocation;
  };

  it("両方が未設定: 管理者には従来の文言(トップの「設定」への案内つき)、閲覧者には案内の括弧書きを外した固定文言。リテラルで 1 回ずつ固定する", () => {
    expect(UNSET_ALLOCATION_NOTE).toBe("配分の提案は出ていません。クラウド版の「馬券用の総資金」と「1レースの上限」が未設定です(トップの「設定」から入れられます)。");
    expect(UNSET_ALLOCATION_NOTE_VIEWER).toBe("配分の提案は出ていません。クラウド版の「馬券用の総資金」と「1レースの上限」が未設定です。");
    const a = analysis({ allocation: unsetAllocation() });
    expect(section(a, false).notices).toEqual([UNSET_ALLOCATION_NOTE]);
    expect(section(a, true).notices).toEqual([UNSET_ALLOCATION_NOTE_VIEWER]);
  });

  it("閲覧者の文言に、設定への案内(「設定」「入れられます」「トップの」)が無い。実効設定の行・買い目・種別は管理者と同じ(値は閲覧者にもそのまま見せる)", () => {
    const a = analysis({ allocation: unsetAllocation() });
    const viewer = section(a, true);
    for (const word of ["「設定」", "設定から", "設定画面", "入れられます", "トップの", "ボタン"]) { // 「未設定」の語は含んでよい(案内の語だけを禁じる)
      expect(JSON.stringify(viewer.notices), word).not.toContain(word);
    }
    const admin = section(a, false);
    expect({ ...viewer, notices: null }).toEqual({ ...admin, notices: null });
    expect(viewer.settingsRows).toContain("総資金: 0円");
  });

  it("両方未設定以外の注記(配分なし・片方だけ未設定・判定不能・通常の配分)は、役割で変わらない", () => {
    const cases: readonly [string, AnalysisDetail][] = [
      ["配分の記録なし", analysis({ allocation: null })],
      ["総資金だけ 0", analysis({ allocation: unsetAllocation({ bankroll: 0, perRaceCap: 3000 }) })],
      ["1レース上限だけ 0", analysis({ allocation: unsetAllocation({ bankroll: 1_000_000, perRaceCap: 0 }) })],
      ["通常の配分", analysis({ allocation: ALLOCATION })],
    ];
    for (const [name, a] of cases) {
      expect(section(a, true), name).toEqual(section(a, false));
    }
  });

  it("ほかの案内(『設定から〜』『ボタンで〜』)が配分の注記に残らない: 閲覧者に出る注記すべてに、設定・ボタンへの案内の語が無い", () => {
    const inputs = [unsetAllocation(), unsetAllocation({ bankroll: 0, perRaceCap: 3000 }), unsetAllocation({ bankroll: 1_000_000, perRaceCap: 0 }), ALLOCATION];
    for (const allocation of inputs) {
      const notices = section(analysis({ allocation }), true).notices;
      for (const word of ["設定から", "設定画面", "トップの", "ボタン"]) {
        expect(JSON.stringify(notices), word).not.toContain(word);
      }
    }
    expect(NO_ALLOCATION_NOTE).not.toContain("設定");
  });
});

describe("単勝の想定・実際のオッズ(Issue #247)", () => {
  const withOdds = (umaban: number, fairWinOdds: number | null, winOdds: number | null, winProb: number | null = 0.1) => horse(umaban, { winProb, fairWinOdds, winOdds });
  const oddsOf = (a: AnalysisDetail) => content(a).horses.map((h) => h.winOdds);

  it("馬ごとに想定・実際を『8.5倍』『12.3倍』で出し、ラベルは『実際』(確定)。実際が想定より高い馬だけ higher=true", () => {
    const a = analysis({ horses: [withOdds(1, 8.5, 12.3), withOdds(2, 4.0, 3.0)] });
    expect(oddsOf(a)).toEqual([
      { fair: "8.5倍", actual: "12.3倍", actualLabel: "実際", higher: true },
      { fair: "4.0倍", actual: "3.0倍", actualLabel: "実際", higher: false },
    ]);
  });

  it("オッズの状態でラベルが変わる(middle=実際(暫定)・yoso=実際(予想))。強調の判定は状態に依らない", () => {
    for (const [status, label] of [["middle", "実際(暫定)"], ["yoso", "実際(予想)"], ["result", "実際"]] as const) {
      const a = analysis({ race: { venueName: "福島", raceNumber: 11, raceName: "テスト", grade: null, oddsStatus: status, placeBasis: "top3" }, horses: [withOdds(1, 8.5, 12.3)] });
      expect(oddsOf(a)[0], status).toEqual({ fair: "8.5倍", actual: "12.3倍", actualLabel: label, higher: true });
    }
  });

  it("欠損は『-』(想定だけ・実際だけ・両方)。強調なし", () => {
    const a = analysis({ horses: [withOdds(1, null, 12.3), withOdds(2, 8.5, null), withOdds(3, null, null, null)] });
    expect(oddsOf(a)).toEqual([
      { fair: "-", actual: "12.3倍", actualLabel: "実際", higher: false },
      { fair: "8.5倍", actual: "-", actualLabel: "実際", higher: false },
      { fair: "-", actual: "-", actualLabel: "実際", higher: false },
    ]);
  });

  it("LLM の有無に依らず出る(想定は補正後の3着内率から。LLM なしでは prior と同じ値)", () => {
    for (const model of [null, "claude-x"]) {
      const a = analysis({ model, horses: [withOdds(1, 8.5, 12.3)] });
      expect(oddsOf(a)[0]!.fair, String(model)).toBe("8.5倍");
    }
  });

  it("説明文は、想定か実際が1頭でもあるときだけ出す(全頭が『-』なら出さない)", () => {
    expect(content(analysis({ horses: [withOdds(1, 8.5, null)] })).winOddsNote).toBe(WIN_ODDS_NOTE);
    expect(content(analysis({ horses: [withOdds(1, null, 12.3)] })).winOddsNote).toBe(WIN_ODDS_NOTE);
    expect(content(analysis({ horses: [withOdds(1, null, null, null), withOdds(2, null, null, null)] })).winOddsNote).toBeNull();
  });

  it("勝率(winProb)は画面に出さない(カードのデータに勝率の項目が無く、勝率の数値もどこにも現れない)", () => {
    const c = content(analysis({ horses: [withOdds(1, 8.5, 12.3, 0.093817)] }));
    expect(Object.keys(c.horses[0]!)).not.toContain("winProb");
    const text = JSON.stringify(c);
    expect(text).not.toContain("0.093817");
    expect(text).not.toContain("9.4%");
  });

  it("閲覧者(readOnly)でも同じ内容", () => {
    const a = analysis({ horses: [withOdds(1, 8.5, 12.3)] });
    expect(buildResultModel({ route: ROUTE, source: ready(a), readOnly: true }).content!.horses[0]!.winOdds).toEqual(oddsOf(a)[0]);
  });
});

describe("複勝の想定・実際の下限と上限(Issue #253)", () => {
  const withPlace = (umaban: number, fairPlaceOdds: number | null, actualPlaceOddsMin: number | null, actualPlaceOddsMax: number | null) =>
    horse(umaban, { fairPlaceOdds, actualPlaceOddsMin, actualPlaceOddsMax });
  const raceOf = (placeBasis: "top3" | "top2" | null, oddsStatus: string | null = "result"): AnalysisDetail["race"] => ({
    venueName: "福島",
    raceNumber: 11,
    raceName: "テスト",
    grade: null,
    oddsStatus,
    placeBasis,
  });
  const placeOf = (a: AnalysisDetail) => content(a).horses.map((h) => h.placeOdds);

  it("馬ごとに想定・実際を『2.0倍』『1.5〜2.3倍』で出し、見出しは『複勝』・ラベルは『実際』(確定)。実際の下限が想定より高い馬だけ higher=true", () => {
    const a = analysis({ race: raceOf("top3"), horses: [withPlace(1, 1.4, 1.5, 2.3), withPlace(2, 2.0, 1.5, 2.3)] });
    expect(placeOf(a)).toEqual([
      { heading: "複勝", fair: "1.4倍", actual: "1.5〜2.3倍", actualLabel: "実際", higher: true },
      { heading: "複勝", fair: "2.0倍", actual: "1.5〜2.3倍", actualLabel: "実際", higher: false },
    ]);
  });

  it("上限だけ想定より高い(想定が幅の中)は higher=false(下限で比べる)。上限は比較に使わない", () => {
    const a = analysis({ race: raceOf("top3"), horses: [withPlace(1, 2.0, 1.5, 9.9)] });
    expect(placeOf(a)[0]).toMatchObject({ actual: "1.5〜9.9倍", higher: false });
  });

  it("5〜7頭(placeBasis=top2)は見出しが『複勝(2着まで)』。想定の値は渡された値(サーバが2着内率から出したもの)をそのまま丸める", () => {
    const a = analysis({ race: raceOf("top2"), horses: [withPlace(1, 2.44, 1.5, 2.3)] });
    expect(placeOf(a)[0]).toEqual({ heading: "複勝(2着まで)", fair: "2.4倍", actual: "1.5〜2.3倍", actualLabel: "実際", higher: false });
  });

  it("想定が 1.0 倍未満は『1.0倍未満』で、強調なし(実際の下限が 1.0 でも)", () => {
    const a = analysis({ race: raceOf("top3"), horses: [withPlace(1, 0.9, 1.0, 1.2), withPlace(2, 0.96, 1.1, 1.3)] });
    expect(placeOf(a)).toEqual([
      { heading: "複勝", fair: "1.0倍未満", actual: "1.0〜1.2倍", actualLabel: "実際", higher: false },
      { heading: "複勝", fair: "1.0倍未満", actual: "1.1〜1.3倍", actualLabel: "実際", higher: false },
    ]);
  });

  it("上限が無い(過去の分析)は『1.5倍〜』。下限があれば強調の判定もできる", () => {
    const a = analysis({ race: raceOf("top3"), horses: [withPlace(1, 1.2, 1.5, null)] });
    expect(placeOf(a)[0]).toEqual({ heading: "複勝", fair: "1.2倍", actual: "1.5倍〜", actualLabel: "実際", higher: true });
  });

  it("オッズの状態でラベルが変わる(middle=実際(暫定)・yoso=実際(予想))。発売前(yoso)は複勝が未発売で実際は『-』", () => {
    expect(placeOf(analysis({ race: raceOf("top3", "middle"), horses: [withPlace(1, 1.4, 1.5, 2.3)] }))[0]).toMatchObject({ actualLabel: "実際(暫定)", higher: true });
    expect(placeOf(analysis({ race: raceOf("top3", "yoso"), horses: [withPlace(1, 1.4, null, null)] }))[0]).toEqual({ heading: "複勝", fair: "1.4倍", actual: "-", actualLabel: "実際(予想)", higher: false });
  });

  it("欠損は『-』(想定だけ・実際だけ・両方)。強調なし", () => {
    const a = analysis({ race: raceOf("top3"), horses: [withPlace(1, null, 1.5, 2.3), withPlace(2, 1.4, null, null), withPlace(3, null, null, null)] });
    expect(placeOf(a)).toEqual([
      { heading: "複勝", fair: "-", actual: "1.5〜2.3倍", actualLabel: "実際", higher: false },
      { heading: "複勝", fair: "1.4倍", actual: "-", actualLabel: "実際", higher: false },
      { heading: "複勝", fair: "-", actual: "-", actualLabel: "実際", higher: false },
    ]);
  });

  it("4頭以下(placeBasis=null): 渡された値が何であっても想定も実際も『-』(複勝が発売されないレースで値を出さない)", () => {
    const a = analysis({ race: raceOf(null), horses: [withPlace(1, 1.4, 1.5, 2.3)] });
    expect(placeOf(a)[0]).toEqual({ heading: "複勝", fair: "-", actual: "-", actualLabel: "実際", higher: false });
  });

  it("説明文は、基準があり、想定か実際の下限が1頭でもあるときだけ出す(全頭が『-』・placeBasis=null なら出さない)", () => {
    expect(content(analysis({ race: raceOf("top3"), horses: [withPlace(1, 1.4, null, null)] })).placeOddsNote).toBe(PLACE_ODDS_NOTE);
    expect(content(analysis({ race: raceOf("top2"), horses: [withPlace(1, null, 1.5, null)] })).placeOddsNote).toBe(PLACE_ODDS_NOTE);
    expect(content(analysis({ race: raceOf("top3"), horses: [withPlace(1, null, null, 2.3), withPlace(2, null, null, null)] })).placeOddsNote).toBeNull();
    expect(content(analysis({ race: raceOf(null), horses: [withPlace(1, 1.4, 1.5, 2.3)] })).placeOddsNote).toBeNull();
  });

  it("LLM の有無に依らず出る(想定は補正後の3着内率から)。閲覧者(readOnly)でも同じ内容", () => {
    for (const model of [null, "claude-x"]) {
      const a = analysis({ model, race: raceOf("top3"), horses: [withPlace(1, 1.4, 1.5, 2.3)] });
      expect(placeOf(a)[0]!.fair, String(model)).toBe("1.4倍");
    }
    const a = analysis({ race: raceOf("top3"), horses: [withPlace(1, 1.4, 1.5, 2.3)] });
    expect(buildResultModel({ route: ROUTE, source: ready(a), readOnly: true }).content!.horses[0]!.placeOdds).toEqual(placeOf(a)[0]);
  });

  it("単勝の想定・実際(Issue #247)は変わらない。複勝の値を単勝の欄に混ぜない", () => {
    const a = analysis({ race: raceOf("top3"), horses: [horse(1, { fairWinOdds: 8.5, winOdds: 12.3, fairPlaceOdds: 1.4, actualPlaceOddsMin: 1.5, actualPlaceOddsMax: 2.3 })] });
    expect(content(a).horses[0]!.winOdds).toEqual({ fair: "8.5倍", actual: "12.3倍", actualLabel: "実際", higher: true });
    expect(content(a).winOddsNote).toBe(WIN_ODDS_NOTE);
  });
});

describe("タイム指数の行と説明(Issue #359。サーバが組み立てた文字列をそのまま通す)", () => {
  it("馬ごとの timeIndexLine と、レースの timeIndexNote を内容に通す(加工しない)", () => {
    const a = analysis({
      horses: [horse(1, { timeIndexLine: "タイム指数 +1.2(レース内 2位)" }), horse(2, { timeIndexLine: "タイム指数 —" }), horse(3, { timeIndexLine: "タイム指数 +3.0(レース内 1位)" })],
      timeIndexNote: "タイム指数: 説明の文",
    });
    const c = content(a);
    expect(c.horses.map((h) => h.timeIndexLine)).toEqual(["タイム指数 +1.2(レース内 2位)", "タイム指数 —", "タイム指数 +3.0(レース内 1位)"]);
    expect(c.timeIndexNote).toBe("タイム指数: 説明の文");
  });

  it("null・キー無し(古いサーバの応答や固定データ)は null(行も説明も出さない)。LLM の有無・閲覧者かどうかに依らない", () => {
    const c = content(analysis({ horses: [horse(1), horse(2, { timeIndexLine: null })] }));
    expect(c.horses.map((h) => h.timeIndexLine)).toEqual([null, null]);
    expect(c.timeIndexNote).toBeNull();
    for (const model of [null, "claude-x"]) {
      const a = analysis({ model, horses: [horse(1, { timeIndexLine: "タイム指数 —" })], timeIndexNote: "説明" });
      for (const readOnly of [false, true]) {
        const built = buildResultModel({ route: ROUTE, source: ready(a), readOnly }).content!;
        expect(built.horses[0]!.timeIndexLine, `${String(model)}/${String(readOnly)}`).toBe("タイム指数 —");
        expect(built.timeIndexNote).toBe("説明");
      }
    }
  });
});

/**
 * Issue #546(#545-A の 1 段目): 結果の先頭の要約(`content.summary`)と、説明文の開閉(`notesOpen`)・分析 id(`id`)。
 * 要約の材料はクライアントのモデルにすでにある値だけ(サーバの応答は変えない)。発走時刻(`race.startTime`)だけは、サーバが返していたのをクライアントが読んでいなかったので `api-analysis.ts` で読む。
 */
describe("要約(Issue #546)", () => {
  const ok = (label: string, diff: readonly string[], allocation: NonNullable<AnalysisDetail["allocation"]> = { ...ALLOCATION, bets: [...ALLOCATION.bets] }) => ({ label, summaryLines: ["再計算した", "15:40に実行"], allocation, diffLines: diff });
  const failed = (label: string, summary: string) => ({ label, summaryLines: [summary], allocation: null, diffLines: [] as string[] });
  const withClose = (rounds: NonNullable<AnalysisDetail["close"]>["rounds"]) => analysis({ close: { note: "注記", rounds } });
  const summaryOf = (a: AnalysisDetail) => content(a).summary;
  const raceWith = (startTime: string | null | undefined) => ({ venueName: "福島", raceNumber: 11, raceName: "テストステークス", grade: null, oddsStatus: "result", placeBasis: "top3" as const, ...(startTime === undefined ? {} : { startTime }) });

  it("分析時刻の行は、従来の結果の見出しの下の行と同じ文字(「分析時刻: 2026-06-28 14:00」)", () => {
    expect(summaryOf(analysis()).analyzedLine).toBe("分析時刻: 2026-06-28 14:00");
    expect(summaryOf(analysis({ analyzedAt: "2026-06-28T15:00:00.000Z" })).analyzedLine).toBe("分析時刻: 2026-06-29 00:00");
  });

  describe("発走時刻の行", () => {
    it("値があれば「発走時刻: HH:mm」。値はそのまま出す(補正しない)", () => {
      expect(summaryOf(analysis({ race: raceWith("15:45") })).startLine).toBe("発走時刻: 15:45");
      expect(summaryOf(analysis({ race: raceWith("09:05") })).startLine).toBe("発走時刻: 09:05");
    });

    it.each([
      ["null(詳細なし・地方など)", null],
      ["キー無し(古い応答)", undefined],
      ["空文字", ""],
      ["空白だけ", "  "],
    ] as const)("%s は行ごと出さない(null)", (_name, startTime) => {
      expect(summaryOf(analysis({ race: raceWith("15:45") })).startLine, "前提: 値があれば出る").not.toBeNull();
      expect(summaryOf(analysis({ race: raceWith(startTime) })).startLine).toBeNull();
    });
  });

  describe("買い目の行(点数と合計)", () => {
    const alloc = (bets: readonly { betType: string; comboKey: string; stake: number; odds: number | null; ev: number | null }[], over: Record<string, unknown> = {}) => ({ ...ALLOCATION, bets: [...bets], ...over }) as AnalysisDetail["allocation"];

    it("配分あり(再計算の回なし): 「買い目(分析時点) N点・合計 X円」。合計は賭け金の数値の和(3 桁区切り・オッズや EV が null の買い目も数える)", () => {
      const three = alloc([
        { betType: "place", comboKey: "01", stake: 700, odds: 1.8, ev: 1.2 },
        { betType: "wide", comboKey: "0102", stake: 500, odds: null, ev: null },
        { betType: "trio", comboKey: "010203", stake: 100, odds: 12.3, ev: 1.3 },
      ]);
      expect(summaryOf(analysis({ allocation: three })).betLine).toBe("買い目(分析時点) 3点・合計 1,300円");
      expect(content(analysis({ allocation: three })).allocation.bets, "前提: 配分の表と同じ点数").toHaveLength(3);
      expect(summaryOf(analysis()).betLine, "既定の配分(300 + 200)").toBe("買い目(分析時点) 2点・合計 500円");
    });

    it("買い目が 1 点だけでも点数と合計を出す(退化した入力)", () => {
      const one = alloc([{ betType: "place", comboKey: "01", stake: 300, odds: 1.8, ev: 1.2 }]);
      expect(summaryOf(analysis({ allocation: one })).betLine).toBe("買い目(分析時点) 1点・合計 300円");
    });

    it.each([
      ["配分の記録なし(null)", null],
      ["総資金・1レース上限が未設定", alloc([], { route: "unset", bankroll: 0, perRaceCap: 0 })],
      ["見送り", alloc([], { route: "place-only", skipReasonCode: "no-edge" })],
    ] as const)("%s は「配分なし」の 1 語だけ(注記・設定への案内は入れない)", (_name, allocation) => {
      expect(summaryOf(analysis({ allocation })).betLine).toBe("配分なし");
      expect(content(analysis({ allocation })).allocation.bets, "前提: 買い目は 0 点").toHaveLength(0);
    });
  });

  /**
   * 要約の買い目は**最新の配分**(Issue #546)。締切直前の再計算で再計算できた回(`allocation` が non-null)があれば、一番新しいその回の配分。無ければ分析時点の配分。
   * 見出しの語で出どころを区別する(利用者が、分析時点の額と再計算後の額を取り違えないため)。分析時点の配分と再計算の配分は、賭け金がすべて違う値にして、どちらから来たかを取り違えられないようにする。
   */
  describe("買い目の出どころ(最新の配分)", () => {
    const bet = (comboKey: string, stake: number) => ({ betType: "place", comboKey, stake, odds: 2.0, ev: 1.2 });
    const alloc = (bets: readonly ReturnType<typeof bet>[]) => ({ ...ALLOCATION, bets: [...bets] }) as NonNullable<AnalysisDetail["allocation"]>;
    const ANALYSIS_TIME = alloc([bet("01", 300), bet("02", 200)]); // 合計 500
    const R5 = alloc([bet("03", 900)]); // 発走5分前: 合計 900
    const R2 = alloc([bet("04", 1200), bet("05", 400), bet("06", 100)]); // 発走2分前: 合計 1,700
    const NONE = alloc([]); // 再計算の結果、買い目が 0 点
    const failedRound = (label: string) => ({ label, summaryLines: ["失敗(オッズを取り直せませんでした)"], allocation: null, diffLines: [] as string[] });
    const rounds = (...r: NonNullable<AnalysisDetail["close"]>["rounds"]) => analysis({ allocation: ANALYSIS_TIME, close: { note: "注記", rounds: r } });

    it.each([
      ["再計算の回なし(close が null)", analysis({ allocation: ANALYSIS_TIME, close: null }), "買い目(分析時点) 2点・合計 500円", ["300円", "200円"]],
      ["再計算の回が 1 つで ok", rounds(ok("発走5分前", ["x"], R5)), "買い目(発走5分前の再計算) 1点・合計 900円", ["900円"]],
      ["ok が最新(2 回とも ok。最新の回の配分を使う)", rounds(ok("発走5分前", ["x"], R5), ok("発走2分前", ["y"], R2)), "買い目(発走2分前の再計算) 3点・合計 1,700円", ["1,200円", "400円", "100円"]],
      ["最新が失敗で、前の回が ok(前の回の配分を使う)", rounds(ok("発走5分前", ["x"], R5), failedRound("発走2分前")), "買い目(発走5分前の再計算) 1点・合計 900円", ["900円"]],
      ["全部失敗・見送り(分析時点の配分を使う)", rounds(failedRound("発走5分前"), failedRound("発走2分前")), "買い目(分析時点) 2点・合計 500円", ["300円", "200円"]],
      ["再計算の結果が買い目 0 点(「配分なし」ではなく 0 点と合計 0 円。分析時点の額を残さない)", rounds(ok("発走2分前", ["配分は0点です"], NONE)), "買い目(発走2分前の再計算) 0点・合計 0円", []],
      ["分析時点の配分の記録がなく、再計算の回だけ ok(その回の配分)", analysis({ allocation: null, close: { note: "注記", rounds: [ok("発走2分前", ["x"], R2)] } }), "買い目(発走2分前の再計算) 3点・合計 1,700円", ["1,200円", "400円", "100円"]],
      ["分析時点の配分の記録がなく、再計算の回もない(配分なし)", analysis({ allocation: null, close: null }), "配分なし", []],
      ["分析時点が見送り(買い目 0 点)で、再計算の回もない(配分なし)", analysis({ allocation: { ...ALLOCATION, route: "place-only", skipReasonCode: "no-edge", bets: [] }, close: null }), "配分なし", []],
    ] as const)("%s", (_name, a, betLine, stakes) => {
      const summary = summaryOf(a);
      expect(summary.betLine).toBe(betLine);
      expect(summary.bets.map((b) => b.stake)).toEqual(stakes);
    });

    it("前提: 分析時点の配分の画面(配分の提案の表)は、再計算の回があっても分析時点のまま(要約だけが最新の配分)", () => {
      const c = content(rounds(ok("発走2分前", ["y"], R2)));
      expect(c.allocation.bets.map((b) => b.stake)).toEqual(["300円", "200円"]);
      expect(c.summary.bets.map((b) => b.stake)).toEqual(["1,200円", "400円", "100円"]);
    });

    it("要約の買い目の一覧は、配分の表と同じ部品・同じ並び(券種の表示順 → 組合せ)で作る。入力が逆順でも並べ直す", () => {
      const mixed = alloc([{ betType: "wide", comboKey: "0102", stake: 100, odds: 5, ev: 1.3 }, bet("03", 700)]); // 入力はワイドが先
      const viaClose = content(rounds(ok("発走2分前", ["x"], mixed))).summary.bets;
      const viaTable = content(analysis({ allocation: mixed, close: null })).allocation.bets;
      expect(viaClose, "前提: 2 行").toHaveLength(2);
      expect(viaClose[0]!.betTypeLabel, "前提: 券種が違う").not.toBe(viaClose[1]!.betTypeLabel);
      expect(viaClose.map((b) => b.stake), "複勝(700円)が先に並び直されている").toEqual(["700円", "100円"]);
      expect(viaClose).toEqual(viaTable);
    });
  });

  describe("締切直前の再計算の 1 行", () => {
    it("一番新しい「再計算できた回」のラベルと差分の 1 行目。後ろの回が失敗・見送りなら、その前の再計算できた回を使う", () => {
      const rounds = [ok("発走5分前", ["追加 1点・削除 0点・賭け金の変化 0点(合計 500円 → 600円)", "追加 複勝 3 100円"]), ok("発走2分前", ["分析時から変わりませんでした"])];
      expect(summaryOf(withClose(rounds)).closeLine).toBe("締切直前の再計算(発走2分前): 分析時から変わりませんでした");
      expect(summaryOf(withClose([rounds[0]!, failed("発走2分前", "失敗(オッズを取り直せませんでした)")])).closeLine).toBe("締切直前の再計算(発走5分前): 追加 1点・削除 0点・賭け金の変化 0点(合計 500円 → 600円)");
    });

    it("再計算できた回が無い・節が無い・古い応答(キー無し)は出さない(null)", () => {
      expect(summaryOf(withClose([ok("発走5分前", ["x"])])).closeLine, "前提: 再計算できた回があれば出る").not.toBeNull();
      expect(summaryOf(withClose([failed("発走5分前", "行わなかった(時刻を過ぎていたため行いませんでした)"), failed("発走2分前", "失敗(計算できませんでした)")])).closeLine).toBeNull();
      expect(summaryOf(analysis({ close: null })).closeLine).toBeNull();
      expect(summaryOf(analysis()).closeLine).toBeNull();
    });

    it("差分の行が無い回(分析時の配分が無い)は、状態の行の 1 行目(「再計算した」)で代える。「配分は0点です」もそのまま出す", () => {
      expect(summaryOf(withClose([ok("発走5分前", [])])).closeLine).toBe("締切直前の再計算(発走5分前): 再計算した");
      expect(summaryOf(withClose([ok("発走5分前", ["配分は0点です", "分析時から変わりませんでした"])])).closeLine).toBe("締切直前の再計算(発走5分前): 配分は0点です");
    });
  });

  it("要約は閲覧者(readOnly)でも同じ(配分の注記を要約に入れないので、役割による差が無い)", () => {
    const a = analysis({ race: raceWith("15:45"), close: { note: "注記", rounds: [ok("発走5分前", ["分析時から変わりませんでした"])] } });
    const admin = buildResultModel({ route: ROUTE, source: ready(a), readOnly: false }).content!.summary;
    const viewer = buildResultModel({ route: ROUTE, source: ready(a), readOnly: true }).content!.summary;
    expect(admin.startLine, "前提: 空でない要約").not.toBeNull();
    expect(viewer).toEqual(admin);
  });
});

describe("説明文の開閉の状態と分析 id(Issue #546)", () => {
  it("既定は閉じる(notesOpen=false)。入力で開く。分析 id を持つ(開閉の状態の鍵)", () => {
    expect(content(analysis()).notesOpen).toBe(false);
    const open = buildResultModel({ route: ROUTE, source: ready(analysis()), notesOpen: true }).content!;
    expect(open.notesOpen).toBe(true);
    expect(content(analysis({ id: 42 })).id).toBe(42);
  });
});

/**
 * Issue #546-2: 馬ごとの評価の表(`content.horseTable`)。列・並べ替え(向き・値の無い馬は末尾・同点は馬番)・並べ替え用の数値の出どころ。
 * 並べ替えの状態(`horseSort`)は `app.ts` が分析 id ごとにメモリに持ち、`buildResultModel` に渡す。保存しない。
 */
describe("馬ごとの評価の表(Issue #546-2)", () => {
  /** 並びが各列で違う 4 頭(馬番 1〜4)。値の無い馬は列ごとに別の馬にする。 */
  const four = (): AnalysisHorse[] => [
    horse(1, { prior: 0.3, adjustedProb: 0.2, placeOddsMin: 3.0, ev: 0.9, winOdds: 12.0, mark: "◎" }),
    horse(2, { prior: 0.5, adjustedProb: 0.6, placeOddsMin: null, ev: 1.4, winOdds: 3.5, isPositive: true }),
    horse(3, { prior: 0.1, adjustedProb: 0.1, placeOddsMin: 1.5, ev: null, winOdds: null }),
    horse(4, { prior: 0.5, adjustedProb: 0.4, placeOddsMin: 2.0, ev: 1.0, winOdds: 40.0, mark: "▲" }),
  ];
  const withLlm = { model: "claude-test" };
  const tableOf = (a: AnalysisDetail, horseSort?: HorseSort, readOnly = false) => {
    const model = buildResultModel({ route: ROUTE, source: ready(a), readOnly, ...(horseSort === undefined ? {} : { horseSort }) });
    expect(model.content, "前提: 内容が出る状態").not.toBeNull();
    expect(model.content!.horseTable, "前提: 表が出る状態").not.toBeNull();
    return model.content!.horseTable!;
  };
  const order = (t: ReturnType<typeof tableOf>): number[] => t.rows.map((r) => r.umaban);
  const colKeys = (t: ReturnType<typeof tableOf>): string[] => t.columns.map((c) => c.key);

  it("既定の並べ替えは馬番の昇順(向きの初期値の定数も同じ)", () => {
    const t = tableOf(analysis({ horses: four().reverse() }));
    expect(order(t)).toEqual([1, 2, 3, 4]);
    expect(t.sort).toEqual({ key: "umaban", dir: "asc" });
    expect(DEFAULT_HORSE_SORT).toEqual({ key: "umaban", dir: "asc" });
  });

  it("列は 馬番・印・馬名・3着内率・(AI補正後)・EV・単勝・複勝下限。補正後は LLM が効いた分析だけ(全頭 null なら列ごと出さない)", () => {
    const plain = tableOf(analysis({ horses: four() }));
    expect(colKeys(plain)).toEqual(["umaban", "mark", "name", "prior", "ev", "winOdds", "placeOddsMin"]);
    expect(plain.columns.map((c) => c.label)).toEqual(["馬番", "印", "馬名", "3着内率", "EV", "単勝 実際", "複勝下限"]);
    expect(plain.rows.every((r) => r.adjusted === null), "前提: LLM なしは全頭 null").toBe(true);
    const llm = tableOf(analysis({ ...withLlm, horses: four() }));
    expect(colKeys(llm)).toEqual(["umaban", "mark", "name", "prior", "adjusted", "ev", "winOdds", "placeOddsMin"]);
    expect(llm.columns[4]!.label).toBe("AI補正後");
    expect(llm.rows.every((r) => r.adjusted !== null), "前提: LLM ありは全頭に値").toBe(true);
  });

  it("単勝の列見出しは、オッズの状態で「実際」「実際(暫定)」「実際(予想)」(予想値を確定値と取り違えない)", () => {
    const label = (oddsStatus: string | null) =>
      tableOf(analysis({ race: { venueName: "福島", raceNumber: 11, raceName: "x", grade: null, oddsStatus, placeBasis: "top3" }, horses: four() })).columns.find((c) => c.key === "winOdds")!.label;
    expect(label("result")).toBe("単勝 実際");
    expect(label("middle")).toBe("単勝 実際(暫定)");
    expect(label("yoso")).toBe("単勝 実際(予想)");
    expect(label(null)).toBe("単勝 実際");
  });

  it("並べ替えの向きの初期値: 3着内率・補正後・EV は大きい順、馬番・単勝・複勝下限は小さい順。同じ列をもう一度で逆、別の列に替えたら初期値", () => {
    const first = (key: HorseSortKey) => firstSortDir(key);
    expect(["prior", "adjusted", "ev"].map((k) => first(k as HorseSortKey))).toEqual(["desc", "desc", "desc"]);
    expect(["umaban", "winOdds", "placeOddsMin"].map((k) => first(k as HorseSortKey))).toEqual(["asc", "asc", "asc"]);
    expect(nextHorseSort({ key: "umaban", dir: "asc" }, "umaban")).toEqual({ key: "umaban", dir: "desc" });
    expect(nextHorseSort({ key: "umaban", dir: "desc" }, "umaban")).toEqual({ key: "umaban", dir: "asc" });
    expect(nextHorseSort({ key: "umaban", dir: "asc" }, "prior")).toEqual({ key: "prior", dir: "desc" });
    expect(nextHorseSort({ key: "prior", dir: "desc" }, "prior")).toEqual({ key: "prior", dir: "asc" });
    expect(nextHorseSort({ key: "prior", dir: "asc" }, "winOdds")).toEqual({ key: "winOdds", dir: "asc" });
  });

  it("3着内率の大きい順: 同点(馬番 2 と 4 が 50.0%)は馬番の昇順。小さい順でも同点は馬番の昇順", () => {
    const a = analysis({ horses: four() });
    expect(order(tableOf(a, { key: "prior", dir: "desc" }))).toEqual([2, 4, 1, 3]);
    expect(order(tableOf(a, { key: "prior", dir: "asc" }))).toEqual([3, 1, 2, 4]);
  });

  it("値の無い馬は向きによらず末尾(EV・単勝・複勝下限・補正後。末尾の中は馬番の昇順)", () => {
    const a = analysis({ ...withLlm, horses: four() });
    // EV: 馬 3 が null
    expect(order(tableOf(a, { key: "ev", dir: "desc" }))).toEqual([2, 4, 1, 3]);
    expect(order(tableOf(a, { key: "ev", dir: "asc" }))).toEqual([1, 4, 2, 3]);
    // 単勝: 馬 3 が null
    expect(order(tableOf(a, { key: "winOdds", dir: "asc" }))).toEqual([2, 1, 4, 3]);
    expect(order(tableOf(a, { key: "winOdds", dir: "desc" }))).toEqual([4, 1, 2, 3]);
    // 複勝下限: 馬 2 が null
    expect(order(tableOf(a, { key: "placeOddsMin", dir: "asc" }))).toEqual([3, 4, 1, 2]);
    expect(order(tableOf(a, { key: "placeOddsMin", dir: "desc" }))).toEqual([1, 4, 3, 2]);
    // 2 頭が null の末尾は馬番の昇順
    const two = analysis({ horses: [horse(1, { ev: null }), horse(2, { ev: 1.2 }), horse(3, { ev: null }), horse(4, { ev: 1.5 })] });
    expect(order(tableOf(two, { key: "ev", dir: "desc" }))).toEqual([4, 2, 1, 3]);
    expect(order(tableOf(two, { key: "ev", dir: "asc" }))).toEqual([2, 4, 1, 3]);
  });

  it("補正後の大きい順(LLM あり)。馬番の降順は null を持たないので単純に逆順", () => {
    const a = analysis({ ...withLlm, horses: four() });
    expect(order(tableOf(a, { key: "adjusted", dir: "desc" }))).toEqual([2, 4, 1, 3]);
    expect(order(tableOf(a, { key: "umaban", dir: "desc" }))).toEqual([4, 3, 2, 1]);
  });

  it("非有限の値(NaN・Infinity)は「値の無い馬」として末尾(整形済みの文字列を読み戻さない)", () => {
    const a = analysis({ horses: [horse(1, { ev: 1.0 }), horse(2, { ev: Number.NaN }), horse(3, { ev: Number.POSITIVE_INFINITY }), horse(4, { ev: 0.5 })] });
    expect(order(tableOf(a, { key: "ev", dir: "desc" }))).toEqual([1, 4, 2, 3]);
    expect(order(tableOf(a, { key: "ev", dir: "asc" }))).toEqual([4, 1, 2, 3]);
  });

  it("並べ替え用の数値は HorseCard が持つ。推定 EV も実数(値がある扱い)で、表示の文字列は「(推定)」付きのまま", () => {
    const a = analysis({ ...withLlm, evEstimated: true, horses: four() });
    const t = tableOf(a, { key: "ev", dir: "desc" });
    const top = t.rows[0]!;
    expect(top.umaban).toBe(2);
    expect(top.ev).toBe("1.40(推定)");
    expect(top.sortValues).toEqual({ prior: 0.5, adjusted: 0.6, ev: 1.4, winOdds: 3.5, placeOddsMin: null });
    expect(order(t), "前提: 推定でも EV の大きい順に並ぶ").toEqual([2, 4, 1, 3]);
    expect(t.rows.find((r) => r.umaban === 3)!.sortValues.ev, "ev が null の馬は null").toBeNull();
  });

  it("aria-sort・矢印・次の向き: 今の列だけ ascending/descending と矢印、ほかの並べ替えられる列は none。印・馬名は並べ替え対象外(sort が null)", () => {
    const t = tableOf(analysis({ ...withLlm, horses: four() }), { key: "prior", dir: "desc" });
    const byKey = Object.fromEntries(t.columns.map((c) => [c.key, c.sort]));
    expect(byKey["mark"]).toBeNull();
    expect(byKey["name"]).toBeNull();
    expect(byKey["prior"]).toEqual({ ariaSort: "descending", arrow: "▼", nextDir: "asc" });
    expect(byKey["umaban"]).toEqual({ ariaSort: "none", arrow: "", nextDir: "asc" });
    expect(byKey["ev"]).toEqual({ ariaSort: "none", arrow: "", nextDir: "desc" });
    const asc = tableOf(analysis({ horses: four() }), { key: "winOdds", dir: "asc" });
    expect(asc.columns.find((c) => c.key === "winOdds")!.sort).toEqual({ ariaSort: "ascending", arrow: "▲", nextDir: "desc" });
    expect(asc.columns.filter((c) => c.sort !== null && c.sort.ariaSort !== "none").map((c) => c.key), "前提: 並べ替え中の列は 1 つだけ").toEqual(["winOdds"]);
  });

  it("補正後の列が無い分析に補正後の並べ替えが残っていても、既定(馬番の昇順)に戻す", () => {
    const t = tableOf(analysis({ horses: four() }), { key: "adjusted", dir: "desc" });
    expect(t.sort).toEqual({ key: "umaban", dir: "asc" });
    expect(order(t)).toEqual([1, 2, 3, 4]);
  });

  it("カードの並び(content.horses)は並べ替えない(入力の順のまま)", () => {
    const a = analysis({ horses: four() });
    const c = buildResultModel({ route: ROUTE, source: ready(a), horseSort: { key: "prior", dir: "desc" } }).content!;
    expect(c.horses.map((x) => x.umaban)).toEqual([1, 2, 3, 4]);
    expect(c.horseTable!.rows.map((x) => x.umaban), "前提: 表は並べ替わっている").toEqual([2, 4, 1, 3]);
  });

  it("閲覧者と管理者で表の中身は同じ(#263 の差は表に持ち込まない)", () => {
    const a = analysis({ ...withLlm, horses: four() });
    const sort: HorseSort = { key: "ev", dir: "desc" };
    const admin = tableOf(a, sort, false);
    const viewer = tableOf(a, sort, true);
    expect(admin.rows.length, "前提: 空でない表").toBe(4);
    expect(viewer).toEqual(admin);
  });

  it("馬が 0 頭の分析は表を出さない(null)", () => {
    const c = buildResultModel({ route: ROUTE, source: ready(analysis({ horses: [] })) }).content!;
    expect(c.horseTable).toBeNull();
  });
});

/** Issue #571: 結果画面のパンくずと前後のレース(行き先はレース画面。日付は分析の開催日を優先する)。 */
describe("パンくずと前後のレース(Issue #571)", () => {
  const listRow = (raceId: string): RaceRow => ({ raceId, venueName: "福島", raceNumber: Number(raceId.slice(10)), raceName: `R${raceId.slice(10)}`, courseType: "芝", distance: 1800, entryCount: 16, grade: null, startTime: null });
  const SIBLINGS = ["202603020210", "202603020211", "202603020212", "202609020101"].map(listRow);

  it("内容があれば「一覧 › 6/28(日) › 福島 › 11R」。競馬場名は分析のレース情報(race.venueName)から。null なら節を省く", () => {
    const model = buildResultModel({ route: ROUTE, source: ready(analysis()) });
    expect(model.breadcrumb?.map((c) => c.label)).toEqual(["一覧", "6/28(日)", "福島", "11R"]);
    const noVenue = buildResultModel({ route: ROUTE, source: ready(analysis({ race: { ...analysis().race, venueName: null } })) });
    expect(noVenue.breadcrumb?.map((c) => c.label)).toEqual(["一覧", "6/28(日)", "11R"]);
  });

  it("日付は分析の kaisaiDate を優先(ハッシュの日付は既定の今日のことがある)。無効なら route の日付。リンクの区分は route の区分", () => {
    const route: Route = { date: "20261007", venue: "nar", race: null, analysis: 7, settings: false };
    const fromAnalysis = buildResultModel({ route, source: ready(analysis({ kaisaiDate: "20260628" })) });
    expect(fromAnalysis.breadcrumb?.[1]).toMatchObject({ label: "6/28(日)", href: "#date=20260628&venue=nar" });
    const fallback = buildResultModel({ route, source: ready(analysis({ kaisaiDate: null })) });
    expect(fallback.breadcrumb?.[1]).toMatchObject({ label: "10/7(水)", href: "#date=20261007&venue=nar" });
  });

  it("前後のレース: 行き先は前後のレースの「レース画面」(analysis を持たない)。日付は分析の開催日", () => {
    const route: Route = { date: "20261007", venue: "central", race: null, analysis: 7, settings: false };
    const model = buildResultModel({ route, source: ready(analysis({ kaisaiDate: "20260628" })), siblings: SIBLINGS });
    expect(model.neighbors).toEqual({
      prev: { label: "前のレース 10R", href: "#date=20260628&venue=central&race=202603020210" },
      next: { label: "次のレース 12R", href: "#date=20260628&venue=central&race=202603020212" },
    });
    expect(model.neighbors?.prev?.href).not.toContain("analysis=");
  });

  it("一覧が無い・読み込み中・失敗のときは前後なし(パンくずは内容があるときだけ)", () => {
    expect(buildResultModel({ route: ROUTE, source: ready(analysis()) }).neighbors).toBeNull();
    expect(buildResultModel({ route: ROUTE, source: ready(analysis()) }).breadcrumb).not.toBeNull();
    for (const source of [{ kind: "loading" }, { kind: "error", message: "取得できません" }] as const) {
      const model = buildResultModel({ route: ROUTE, source, siblings: SIBLINGS });
      expect(model.breadcrumb).toBeNull();
      expect(model.neighbors).toBeNull();
    }
  });

  it("race_id が 12 桁でない分析: パンくずの R と前後を出さない", () => {
    const model = buildResultModel({ route: ROUTE, source: ready(analysis({ raceId: "短い" })), siblings: SIBLINGS });
    expect(model.breadcrumb?.map((c) => c.label)).toEqual(["一覧", "6/28(日)", "福島"]);
    expect(model.neighbors).toBeNull();
  });

  it("閲覧者(readOnly)でも同じに出る", () => {
    const admin = buildResultModel({ route: ROUTE, source: ready(analysis()), siblings: SIBLINGS });
    const viewer = buildResultModel({ route: ROUTE, source: ready(analysis()), siblings: SIBLINGS, readOnly: true });
    expect(admin.neighbors, "前提: 管理者では前後が出る").toBeTruthy();
    expect(viewer.neighbors).toEqual(admin.neighbors);
  });
});
