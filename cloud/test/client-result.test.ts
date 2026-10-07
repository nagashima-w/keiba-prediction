import { describe, expect, it } from "vitest";
import type { AnalysisDetail, AnalysisHorse } from "../client/api-analysis";
import { buildResultModel, NO_ALLOCATION_NOTE, UNSET_ALLOCATION_NOTE, type ResultSource } from "../client/result";
import { UNSET_BANKROLL_ONLY_NOTE, UNSET_INDETERMINATE_NOTE, UNSET_PER_RACE_CAP_ONLY_NOTE } from "../../packages/app/src/renderer/allocation-proposal-view";
import { BET_ALLOCATION_UNSET_NOTE, placeBetUnavailableMessage } from "../../packages/app/src/renderer/bet-allocation-view";
import type { Route } from "../client/route";

/**
 * Issue #185: 結果画面の表示用データ(純関数)。見出し・分析時刻・分析モデル・馬ごとのカード(3着内率・複勝オッズ下限・EV)・配分(exe の `buildAllocationProposalView` を流用)。
 * 表示の決定: 印は `mark` が non-null のときだけ・「AI補正後」は出さない(LLM なしでは 3着内率と同じ値のため)・モデルが null なら「LLM 未使用(統計のみ)」。
 */

const RACE_ID = "202603020211";
const ROUTE: Route = { date: "20260628", venue: "central", race: null, analysis: 7, settings: false };

function horse(umaban: number, over: Partial<AnalysisHorse> = {}): AnalysisHorse {
  return { umaban, name: `馬${umaban}`, prior: 0.2, adjustedProb: 0.18, placeOddsMin: 1.8, ev: 1.05, isPositive: false, mark: null, reason: null, ...over };
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
    race: { venueName: "福島", raceNumber: 11, raceName: "テストステークス" },
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

describe("見出し・分析時刻・分析モデル", () => {
  it("見出し: 場名・R・レース名。null の部分は省き、全部無ければレース ID", () => {
    expect(content(analysis()).title).toBe("福島11R テストステークス");
    expect(content(analysis({ race: { venueName: null, raceNumber: 11, raceName: "テストステークス" } })).title).toBe("11R テストステークス");
    expect(content(analysis({ race: { venueName: "福島", raceNumber: null, raceName: null } })).title).toBe("福島");
    expect(content(analysis({ race: { venueName: null, raceNumber: null, raceName: null } })).title).toBe(`レース ${RACE_ID}`);
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

  it("3着内率は prior を出す(LLM 補正後の adjustedProb ではない)。「AI補正後」の語・adjustedProb の値は、モデルがあっても画面のデータのどこにも出ない", () => {
    const a = analysis({ model: "claude-sonnet-x", horses: [horse(1, { prior: 0.2, adjustedProb: 0.18 }), horse(2, { prior: 0.3, adjustedProb: 0.373 })] });
    const model = buildResultModel({ route: ROUTE, source: ready(a) });
    const text = JSON.stringify(model);
    expect(text).toContain("20.0%");
    expect(text).toContain("30.0%");
    expect(text).not.toContain("18.0%");
    expect(text).not.toContain("37.3%");
    expect(text).not.toContain("AI補正後");
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
