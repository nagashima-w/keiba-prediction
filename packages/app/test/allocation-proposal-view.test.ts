/**
 * allocation-proposal-view(検証タブ「レース一覧」に配分提案〈分析時点〉を表示するための
 * 純関数モジュール。Issue #55)のテスト。
 *
 * 対象は `buildAllocationProposalView`(保存済み配分〈StoredAllocationView〉→表示状態の判別・
 * 注記・買い目行・実効設定行への変換)。VerifyView.tsx には本機能のroute/skipReasonCode分岐と
 * 文言リテラルを一切置かない設計制約があるため、その分岐・文言はすべてここで固定する。
 */
import { describe, expect, it } from "vitest";

import { placeSkipReasonText } from "@keiba/core/ev/bet-allocation";
import { comboSkipReasonText } from "@keiba/core/ev/combo-bet-allocation";

import type { StoredAllocationBetView, StoredAllocationView } from "../src/shared/analysis-types.js";
import {
  buildAllocationProposalView,
  CAP_TOO_SMALL_MISSING_UNIT_NOTE,
  FALLBACK_REASON_COMBO_BET_TYPES_OFF_NOTE,
  FALLBACK_REASON_COMBO_ODDS_NOT_REQUESTED_NOTE,
  FALLBACK_REASON_NO_COMBO_CANDIDATES_NOTE,
  FALLBACK_REASON_UNKNOWN_NOTE,
  INDETERMINATE_ALLOCATED_NO_BETS_NOTE,
  INDETERMINATE_UNKNOWN_ROUTE_NOTE,
  INVALID_NOTE,
  NO_RECORD_NOTE,
  SKIP_REASON_UNKNOWN_NOTE,
  UNAVAILABLE_REASON_MISSING_NOTE,
  UNSET_BANKROLL_ONLY_NOTE,
  UNSET_INDETERMINATE_NOTE,
  UNSET_PER_RACE_CAP_ONLY_NOTE,
  YOSO_NOTE,
} from "../src/renderer/allocation-proposal-view.js";
import { BET_ALLOCATION_UNSET_NOTE, placeBetUnavailableMessage } from "../src/renderer/bet-allocation-view.js";
import { formatEv, formatOdds } from "../src/renderer/format.js";
import { formatYen } from "../src/renderer/verify-format.js";

/** テスト用のStoredAllocationViewを最小構成で組み立てる。 */
function allocation(overrides: Partial<StoredAllocationView> = {}): StoredAllocationView {
  return {
    route: "mixed",
    unavailableReason: null,
    fallbackReason: null,
    skipReasonCode: null,
    bankroll: 10000,
    perRaceCap: 3000,
    kellyFraction: 0.5,
    evThreshold: 1.0,
    includeComboOdds: true,
    includeWide: true,
    includeTrio: true,
    betUnit: 100,
    oddsStatus: "result",
    bets: [],
    ...overrides,
  };
}

function bet(overrides: Partial<StoredAllocationBetView> = {}): StoredAllocationBetView {
  return {
    betType: "place",
    comboKey: "04",
    stake: 300,
    odds: 2.1,
    ev: 1.05,
    ...overrides,
  };
}

describe("buildAllocationProposalView(表示状態の判別。AC3: 7状態+判定不能)", () => {
  it("記録なし(null)はkind='no-record'になること", () => {
    expect(buildAllocationProposalView(null).kind).toBe("no-record");
  });

  it("route='unset'はkind='unset'になること", () => {
    expect(buildAllocationProposalView(allocation({ route: "unset" })).kind).toBe("unset");
  });

  it("route='yoso'はkind='yoso'になること", () => {
    expect(buildAllocationProposalView(allocation({ route: "yoso" })).kind).toBe("yoso");
  });

  it("route='unavailable'はkind='unavailable'になること", () => {
    expect(
      buildAllocationProposalView(allocation({ route: "unavailable", unavailableReason: "not-sold" })).kind,
    ).toBe("unavailable");
  });

  it("route='invalid'はkind='invalid'になること", () => {
    expect(buildAllocationProposalView(allocation({ route: "invalid" })).kind).toBe("invalid");
  });

  it("route='place-only' ∧ skipReasonCode非nullはkind='skip'になること", () => {
    expect(
      buildAllocationProposalView(
        allocation({ route: "place-only", skipReasonCode: "kelly-zero" }),
      ).kind,
    ).toBe("skip");
  });

  it("route='mixed' ∧ skipReasonCode非nullはkind='skip'になること", () => {
    expect(
      buildAllocationProposalView(allocation({ route: "mixed", skipReasonCode: "no-edge" })).kind,
    ).toBe("skip");
  });

  it("route='place-only' ∧ skipReasonCode=null ∧ bets非空はkind='allocated'になること", () => {
    expect(
      buildAllocationProposalView(
        allocation({ route: "place-only", skipReasonCode: null, bets: [bet()] }),
      ).kind,
    ).toBe("allocated");
  });

  it("route='mixed' ∧ skipReasonCode=null ∧ bets非空はkind='allocated'になること", () => {
    expect(
      buildAllocationProposalView(
        allocation({ route: "mixed", skipReasonCode: null, bets: [bet({ betType: "wide", comboKey: "0407" })] }),
      ).kind,
    ).toBe("allocated");
  });

  it("未知のroute文字列はthrowせずkind='indeterminate'になること。notices自体もINDETERMINATE_UNKNOWN_ROUTE_NOTEに固定する(code-reviewer指摘1-b: kindのみの検査は条件A0を満たさない)", () => {
    const build = () => buildAllocationProposalView(allocation({ route: "SOMETHING_UNKNOWN" }));
    expect(build).not.toThrow();
    expect(build().kind).toBe("indeterminate");
    expect(build().notices).toEqual([INDETERMINATE_UNKNOWN_ROUTE_NOTE]);
    // 定数の中身そのものをリテラルで固定する(エクスポートした定数同士を比較するだけでは、
    // 定数の値が他の定数へ差し替えられても検出できないため。code-reviewer指摘1-bの再発防止)。
    expect(INDETERMINATE_UNKNOWN_ROUTE_NOTE).toBe(
      "配分提案の状態を判定できません(記録された種別が不明です)。",
    );
  });

  it.each(["place-only", "mixed"] as const)(
    "route=%s ∧ skipReasonCode=null ∧ bets=[](想定外・配分ありとも見送りとも決められない)はkind='indeterminate'になり、noticesもINDETERMINATE_ALLOCATED_NO_BETS_NOTEに固定されること",
    (route) => {
      const view = buildAllocationProposalView(allocation({ route, skipReasonCode: null, bets: [] }));
      expect(view.kind).toBe("indeterminate");
      expect(view.notices).toEqual([INDETERMINATE_ALLOCATED_NO_BETS_NOTE]);
      // 定数の中身そのものをリテラルで固定する(理由は上記と同じ)。
      expect(INDETERMINATE_ALLOCATED_NO_BETS_NOTE).toBe(
        "配分提案の状態を判定できません(見送りでも配分ありでもない記録です)。",
      );
    },
  );

  it("kindが8種の判別値のうち少なくとも7種、実際に異なる値として観測できること(区別できることの直接固定)", () => {
    const kinds = [
      buildAllocationProposalView(null).kind,
      buildAllocationProposalView(allocation({ route: "unset" })).kind,
      buildAllocationProposalView(allocation({ route: "yoso" })).kind,
      buildAllocationProposalView(allocation({ route: "unavailable", unavailableReason: "not-sold" })).kind,
      buildAllocationProposalView(allocation({ route: "invalid" })).kind,
      buildAllocationProposalView(allocation({ route: "mixed", skipReasonCode: "no-edge" })).kind,
      buildAllocationProposalView(allocation({ route: "mixed", skipReasonCode: null, bets: [bet()] })).kind,
      buildAllocationProposalView(allocation({ route: "SOMETHING_UNKNOWN" })).kind,
    ];
    expect(new Set(kinds).size).toBe(8);
  });
});

describe("unset: 未設定パターンを4通り区別する(AC3境界。boss差し戻し対応で想定外パターンを追加)", () => {
  it("総資金のみ0のとき、UNSET_BANKROLL_ONLY_NOTEに固定した専用注記になること", () => {
    const view = buildAllocationProposalView(allocation({ route: "unset", bankroll: 0, perRaceCap: 5000 }));
    expect(view.notices).toEqual([UNSET_BANKROLL_ONLY_NOTE]);
    // 定数の中身そのものをリテラルで固定する(輸入した定数同士のtoEqualだけでは、定数の中身が
    // 差し替えられても検出できない。code-reviewer指摘1-bの再発防止パターンを全定数へ適用)。
    expect(UNSET_BANKROLL_ONLY_NOTE).toBe(
      "総資金が0円のため配分提案を行っていません(1レース上限は設定済みです)。",
    );
  });

  it("1レース上限のみ0のとき、UNSET_PER_RACE_CAP_ONLY_NOTEに固定した専用注記になること", () => {
    const view = buildAllocationProposalView(allocation({ route: "unset", bankroll: 5000, perRaceCap: 0 }));
    expect(view.notices).toEqual([UNSET_PER_RACE_CAP_ONLY_NOTE]);
    expect(UNSET_PER_RACE_CAP_ONLY_NOTE).toBe(
      "1レースの上限が0円のため配分提案を行っていません(総資金は設定済みです)。",
    );
  });

  it("両方0のとき、既存のBET_ALLOCATION_UNSET_NOTEを再利用すること", () => {
    const view = buildAllocationProposalView(allocation({ route: "unset", bankroll: 0, perRaceCap: 0 }));
    expect(view.notices).toEqual([BET_ALLOCATION_UNSET_NOTE]);
  });

  it("route='unset'なのにbankroll・perRaceCapのどちらも0以下ではない(想定外)場合、数値を捏造せずUNSET_INDETERMINATE_NOTEに固定した代替文言を出すこと(boss差し戻し対応: 旧実装は最終elseがこの入力まで『1レース上限のみ0』と断定していた)", () => {
    const view = buildAllocationProposalView(allocation({ route: "unset", bankroll: 50000, perRaceCap: 5000 }));
    expect(view.kind).toBe("unset");
    expect(view.notices).toEqual([UNSET_INDETERMINATE_NOTE]);
    // 定数の中身そのものをリテラルで固定する(理由は他の定数と同じ)。
    expect(UNSET_INDETERMINATE_NOTE).toBe(
      "配分提案を行っていません(総資金・1レース上限のいずれが未設定だったかは記録から判定できません)。",
    );
  });

  it("4パターンの注記が互いに異なる値であること(Set.sizeだけに頼らず、各文言のリテラルtoBeも別途固定済み)", () => {
    const a = buildAllocationProposalView(allocation({ route: "unset", bankroll: 0, perRaceCap: 5000 })).notices[0];
    const b = buildAllocationProposalView(allocation({ route: "unset", bankroll: 5000, perRaceCap: 0 })).notices[0];
    const c = buildAllocationProposalView(allocation({ route: "unset", bankroll: 0, perRaceCap: 0 })).notices[0];
    const d = buildAllocationProposalView(
      allocation({ route: "unset", bankroll: 50000, perRaceCap: 5000 }),
    ).notices[0];
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
});

describe("unavailable: 理由欠損時は状態を保持し代替文言(boss裁定A。判定不能へ倒さない)", () => {
  it.each([
    ["two-place-only", "複勝が2着までとなり本ツールの3着内率推定と整合しないため配分提案を行いません"],
    ["not-sold", "複勝が発売されないため対象外です"],
    ["unknown", "出走頭数を判定できないため配分提案を行いません"],
  ] as const)(
    "unavailable_reason=%s(既知3値)はplaceBetUnavailableMessageの文言そのままに固定されること(code-reviewer指摘2巡目: KNOWN_UNAVAILABLE_REASONSの3値すべてをnoticesの値として個別に固定する。not-sold/unknownは1巡目まで未検査だった)",
    (reason, literalText) => {
      const view = buildAllocationProposalView(allocation({ route: "unavailable", unavailableReason: reason }));
      expect(view.kind).toBe("unavailable");
      expect(view.notices).toEqual([placeBetUnavailableMessage(reason)]);
      // 定数の中身そのものをリテラルで固定する(placeBetUnavailableMessageの戻り値を
      // そのまま期待値に使うだけでは、bet-allocation-view.ts側の文言マップが差し替えられても
      // 検出できないため、ハードコードした日本語文言との一致も別途確認する)。
      expect(placeBetUnavailableMessage(reason)).toBe(literalText);
    },
  );

  it("unavailable_reason=null(想定外)でもkindはunavailableのまま、指定の代替文言を出すこと", () => {
    const view = buildAllocationProposalView(allocation({ route: "unavailable", unavailableReason: null }));
    expect(view.kind).toBe("unavailable");
    expect(view.notices).toEqual([UNAVAILABLE_REASON_MISSING_NOTE]);
    expect(UNAVAILABLE_REASON_MISSING_NOTE).toBe(
      "出走頭数の条件により複勝の配分対象外です(理由の詳細が記録されていません)",
    );
  });

  it("unavailable_reasonが既知3値(not-sold/two-place-only/unknown)以外の未知の文字列(想定外)でも、kindはunavailableのまま、null時と同じ代替文言を出すこと(code-reviewer指摘1-a: JSDocが『null、または未知の値』と両方を明記しているのにnull側しかテストされていなかった)", () => {
    const view = buildAllocationProposalView(
      allocation({ route: "unavailable", unavailableReason: "SOMETHING_UNKNOWN_REASON" }),
    );
    expect(view.kind).toBe("unavailable");
    expect(view.notices).toEqual([UNAVAILABLE_REASON_MISSING_NOTE]);
  });

  it("既知3値・null・未知値の4種の代替文言が互いに異なる値であること(取り違え検出)", () => {
    const values = [
      placeBetUnavailableMessage("two-place-only"),
      placeBetUnavailableMessage("not-sold"),
      placeBetUnavailableMessage("unknown"),
      UNAVAILABLE_REASON_MISSING_NOTE,
    ];
    expect(new Set(values).size).toBe(4);
  });
});

describe("skip: cap-too-small ∧ bet_unit=null(想定外)。boss裁定A: 状態を保持し代替文言(数値を捏造しない)", () => {
  it("bet_unitが非nullなら従来どおりcoreの文言関数経由で数値を埋め込むこと", () => {
    const view = buildAllocationProposalView(
      allocation({ route: "place-only", skipReasonCode: "cap-too-small", betUnit: 300 }),
    );
    expect(view.kind).toBe("skip");
    expect(view.notices).toEqual([placeSkipReasonText("cap-too-small", 300)]);
    expect(view.notices[0]).toContain("300");
  });

  it("bet_unit=nullなら状態はskipのまま、指定の代替文言(数値なし)を使うこと", () => {
    const view = buildAllocationProposalView(
      allocation({ route: "mixed", skipReasonCode: "cap-too-small", betUnit: null }),
    );
    expect(view.kind).toBe("skip");
    expect(view.notices).toEqual([CAP_TOO_SMALL_MISSING_UNIT_NOTE]);
    expect(CAP_TOO_SMALL_MISSING_UNIT_NOTE).toBe(
      "1レースの上限が最小賭け金単位を下回るため配分できません(単位額が記録されていません)",
    );
  });
});

describe("skip: no-candidatesの文言がroute='place-only'とroute='mixed'で異なること(文言関数の取り違え検出)", () => {
  it("place-onlyはplaceSkipReasonText、mixedはcomboSkipReasonTextの文言になること", () => {
    const placeOnlyNotice = buildAllocationProposalView(
      allocation({ route: "place-only", skipReasonCode: "no-candidates", betUnit: 100 }),
    ).notices[0];
    const mixedNotice = buildAllocationProposalView(
      allocation({ route: "mixed", skipReasonCode: "no-candidates", betUnit: 100 }),
    ).notices[0];
    expect(placeOnlyNotice).not.toBe(mixedNotice);
    expect(placeOnlyNotice).toBe(placeSkipReasonText("no-candidates", 100));
    expect(mixedNotice).toBe(comboSkipReasonText("no-candidates", 100));
  });

  it("未知のskipReasonCode値でもthrowせず、SKIP_REASON_UNKNOWN_NOTEに固定した汎用文言にフォールバックすること(code-reviewer指摘1-b: toHaveLengthのみでは条件A0を満たさない)", () => {
    const build = () =>
      buildAllocationProposalView(allocation({ route: "mixed", skipReasonCode: "SOMETHING_UNKNOWN" }));
    expect(build).not.toThrow();
    expect(build().kind).toBe("skip");
    expect(build().notices).toEqual([SKIP_REASON_UNKNOWN_NOTE]);
    // 定数の中身そのものをリテラルで固定する(理由は上記と同じ)。
    expect(SKIP_REASON_UNKNOWN_NOTE).toBe("見送り理由の詳細が記録されていません。");
  });
});

describe("skip: KNOWN_SKIP_REASON_CODESの残り4値(bankroll-unset/cap-unset/kelly-zero/no-edge)もnoticesの値として固定すること(code-reviewer指摘2巡目: cap-too-small/no-candidatesの2値しかnoticesを値検査していなかった)", () => {
  it.each([
    ["bankroll-unset", "総資金が未設定のため配分を提案していません"],
    ["cap-unset", "1レースの上限が未設定のため配分を提案していません"],
    ["kelly-zero", "ケリー係数が0のため配分しません"],
    ["no-edge", "妙味が小さく、賭ける価値のある配分が見つかりませんでした"],
  ] as const)(
    "skipReasonCode=%s はroute='place-only'でも'mixed'でも同じ文言(%s)に固定されること",
    (code, literalText) => {
      const placeOnlyView = buildAllocationProposalView(
        allocation({ route: "place-only", skipReasonCode: code, betUnit: 100 }),
      );
      const mixedView = buildAllocationProposalView(
        allocation({ route: "mixed", skipReasonCode: code, betUnit: 100 }),
      );
      expect(placeOnlyView.kind).toBe("skip");
      expect(mixedView.kind).toBe("skip");
      expect(placeOnlyView.notices).toEqual([literalText]);
      expect(mixedView.notices).toEqual([literalText]);
      // core側の文言関数(独立にテスト済みのオラクル)と一致することも別途確認する。
      expect(placeSkipReasonText(code, 100)).toBe(literalText);
      expect(comboSkipReasonText(code, 100)).toBe(literalText);
    },
  );

  it("6分類(cap-too-small/no-candidatesを含む)の見送り文言が互いに異なる値であること(取り違え検出)", () => {
    const values = [
      placeSkipReasonText("bankroll-unset", 100),
      placeSkipReasonText("cap-unset", 100),
      placeSkipReasonText("cap-too-small", 100),
      placeSkipReasonText("kelly-zero", 100),
      placeSkipReasonText("no-candidates", 100),
      placeSkipReasonText("no-edge", 100),
    ];
    expect(new Set(values).size).toBe(6);
  });
});

describe("fallback_reason: 分岐はrouteではなくfallbackReason!==nullで行うこと(route='unavailable'経由でも消えないことを含む)", () => {
  it("route='place-only'由来(D-2フォールバックで複勝のみ・配分あり)でも、no-combo-candidatesの注記が末尾に付くこと", () => {
    const view = buildAllocationProposalView(
      allocation({
        route: "place-only",
        skipReasonCode: null,
        fallbackReason: "no-combo-candidates",
        bets: [bet()],
      }),
    );
    expect(view.notices).toEqual([FALLBACK_REASON_NO_COMBO_CANDIDATES_NOTE]);
    // 定数の中身そのものをリテラルで固定する(理由は他の定数と同じ)。
    expect(FALLBACK_REASON_NO_COMBO_CANDIDATES_NOTE).toBe(
      "ワイド・三連複にEVプラスの候補が無かったため複勝のみの配分になっています。",
    );
  });

  it("route='unavailable'由来(D-2フォールバックが頭数不可でunavailableになった場合)でも、combo-bet-types-offの注記がunavailableReasonの注記に続けて付くこと", () => {
    const view = buildAllocationProposalView(
      allocation({
        route: "unavailable",
        unavailableReason: "two-place-only",
        fallbackReason: "combo-bet-types-off",
      }),
    );
    expect(view.notices).toEqual([
      placeBetUnavailableMessage("two-place-only"),
      FALLBACK_REASON_COMBO_BET_TYPES_OFF_NOTE,
    ]);
    expect(FALLBACK_REASON_COMBO_BET_TYPES_OFF_NOTE).toBe(
      "ワイド・三連複が配分対象外の設定のため複勝のみの配分になっています。",
    );
  });

  it("route='mixed'由来(fallback未経由)ではfallback_reasonの注記が出ないこと", () => {
    const view = buildAllocationProposalView(
      allocation({
        route: "mixed",
        skipReasonCode: null,
        fallbackReason: null,
        bets: [bet({ betType: "wide", comboKey: "0407" })],
      }),
    );
    expect(view.notices).toEqual([]);
  });

  it("combo-odds-not-requestedの注記が出ること", () => {
    const view = buildAllocationProposalView(
      allocation({
        route: "place-only",
        skipReasonCode: null,
        fallbackReason: "combo-odds-not-requested",
        bets: [bet()],
      }),
    );
    expect(view.notices).toEqual([FALLBACK_REASON_COMBO_ODDS_NOT_REQUESTED_NOTE]);
    expect(FALLBACK_REASON_COMBO_ODDS_NOT_REQUESTED_NOTE).toBe(
      "組合せオッズを取得しない設定のため複勝のみの配分になっています。",
    );
  });

  it("未知のfallbackReason値(想定外)でもthrowせず、FALLBACK_REASON_UNKNOWN_NOTEに固定した汎用文言にフォールバックすること(1巡目まで未検査だった経路)", () => {
    const build = () =>
      buildAllocationProposalView(
        allocation({
          route: "place-only",
          skipReasonCode: null,
          fallbackReason: "SOMETHING_UNKNOWN_FALLBACK",
          bets: [bet()],
        }),
      );
    expect(build).not.toThrow();
    expect(build().notices).toEqual([FALLBACK_REASON_UNKNOWN_NOTE]);
    expect(FALLBACK_REASON_UNKNOWN_NOTE).toBe(
      "複勝のみの配分になっています(理由の詳細は記録されていません)。",
    );
  });
});

describe("未知のbet_type値でもthrowしないこと(境界。生値をそのまま表示)", () => {
  it("throwせず、生値をそのままbetTypeLabelに表示すること", () => {
    const build = () =>
      buildAllocationProposalView(
        allocation({
          route: "mixed",
          skipReasonCode: null,
          bets: [bet({ betType: "quinella", comboKey: "0407" })],
        }),
      );
    expect(build).not.toThrow();
    expect(build().bets[0]!.betTypeLabel).toBe("quinella");
  });
});

describe("買い目行(AC4)", () => {
  it("betType/comboKey/stake/odds/evの5フィールドすべてが行に現れ、互いに異なる値であること(2フィールドの入れ替え検出)", () => {
    const view = buildAllocationProposalView(
      allocation({
        route: "mixed",
        skipReasonCode: null,
        bets: [bet({ betType: "wide", comboKey: "0407", stake: 700, odds: 3.3, ev: 1.21 })],
      }),
    );
    const row = view.bets[0]!;
    expect(row.betTypeLabel).toBe("ワイド");
    expect(row.comboLabel).toBe("4-7");
    expect(row.stake).toBe(formatYen(700));
    expect(row.odds).toBe(formatOdds(3.3));
    expect(row.ev).toBe(formatEv(1.21));
    expect(new Set([row.betTypeLabel, row.comboLabel, row.stake, row.odds, row.ev]).size).toBe(5);
  });

  it("ラベルが複勝『4番』・ワイド『4-7』・3連複『4-7-9』になること", () => {
    const view = buildAllocationProposalView(
      allocation({
        route: "mixed",
        skipReasonCode: null,
        bets: [
          bet({ betType: "place", comboKey: "04", stake: 100, odds: 2, ev: 1.1 }),
          bet({ betType: "wide", comboKey: "0407", stake: 200, odds: 3, ev: 1.2 }),
          bet({ betType: "trio", comboKey: "040709", stake: 300, odds: 12, ev: 1.3 }),
        ],
      }),
    );
    expect(view.bets.map((b) => b.comboLabel)).toEqual(["4番", "4-7", "4-7-9"]);
  });

  it("odds/evがnullの行の表示も固定されること", () => {
    const view = buildAllocationProposalView(
      allocation({
        route: "mixed",
        skipReasonCode: null,
        bets: [bet({ odds: null, ev: null })],
      }),
    );
    expect(view.bets[0]!.odds).toBe(formatOdds(null));
    expect(view.bets[0]!.ev).toBe(formatEv(null));
  });

  it("並び順はview model側で決定的に決めること(入力順を崩しても券種順に並ぶ)", () => {
    const view = buildAllocationProposalView(
      allocation({
        route: "mixed",
        skipReasonCode: null,
        bets: [
          bet({ betType: "trio", comboKey: "040709", stake: 300, odds: 12, ev: 1.3 }),
          bet({ betType: "place", comboKey: "04", stake: 100, odds: 2, ev: 1.1 }),
          bet({ betType: "wide", comboKey: "0407", stake: 200, odds: 3, ev: 1.2 }),
        ],
      }),
    );
    expect(view.bets.map((b) => b.betTypeLabel)).toEqual(["複勝", "ワイド", "三連複"]);
  });

  it("comboKeyが復号不能(parseComboOddsKeyがnull)なら生キーをそのまま表示すること(bet_typeとの長さ不一致は検査しない)", () => {
    const view = buildAllocationProposalView(
      allocation({
        route: "mixed",
        skipReasonCode: null,
        bets: [bet({ betType: "wide", comboKey: "0X" })],
      }),
    );
    expect(view.bets[0]!.comboLabel).toBe("0X");
  });
});

describe("実効設定(AC5): 8項目がラベル+値の文字列配列として、列とラベルが取り違えなく対応すること", () => {
  it("1組目の値ベクトルで8行すべてが期待どおりであること", () => {
    const view = buildAllocationProposalView(
      allocation({
        route: "mixed",
        skipReasonCode: null,
        bankroll: 123400,
        perRaceCap: 56700,
        kellyFraction: 0.42,
        evThreshold: 1.08,
        includeWide: true,
        includeTrio: false,
        includeComboOdds: true,
        oddsStatus: "middle",
        bets: [],
      }),
    );
    expect(view.settingsRows).toEqual([
      `総資金: ${formatYen(123400)}`,
      `1レース上限: ${formatYen(56700)}`,
      `ケリー係数: 0.42`,
      `EV閾値: 1.08`,
      `ワイド: ON`,
      `三連複: OFF`,
      `組合せオッズ取得: ON`,
      `オッズ状態: 中間(発売中)`,
    ]);
  });

  it("2組目の異なる値ベクトルでも8行すべてが期待どおりであること(取り違え検出)", () => {
    const view = buildAllocationProposalView(
      allocation({
        route: "unset",
        bankroll: 0,
        perRaceCap: 99999,
        kellyFraction: 0.11,
        evThreshold: 2.5,
        includeWide: false,
        includeTrio: true,
        includeComboOdds: false,
        oddsStatus: "yoso",
      }),
    );
    expect(view.settingsRows).toEqual([
      `総資金: ${formatYen(0)}`,
      `1レース上限: ${formatYen(99999)}`,
      `ケリー係数: 0.11`,
      `EV閾値: 2.5`,
      `ワイド: OFF`,
      `三連複: ON`,
      `組合せオッズ取得: OFF`,
      `オッズ状態: 発売前`,
    ]);
  });

  it("oddsStatus='result'は『確定』になること", () => {
    const view = buildAllocationProposalView(allocation({ oddsStatus: "result" }));
    expect(view.settingsRows.at(-1)).toBe("オッズ状態: 確定");
  });

  it("oddsStatusが未知の値でもthrowせず、非null(生値)を返すこと", () => {
    const view = buildAllocationProposalView(allocation({ oddsStatus: "UNKNOWN_STATUS" }));
    expect(view.settingsRows.at(-1)).toBe("オッズ状態: UNKNOWN_STATUS");
  });

  it("記録なし(null)は実効設定が空配列であること", () => {
    expect(buildAllocationProposalView(null).settingsRows).toEqual([]);
  });

  it.each(["unset", "yoso", "invalid"] as const)(
    "route=%s(記録はある状態)でも実効設定8項目が出ること",
    (route) => {
      expect(buildAllocationProposalView(allocation({ route })).settingsRows).toHaveLength(8);
    },
  );

  it("route='unavailable'でも実効設定8項目が出ること", () => {
    expect(
      buildAllocationProposalView(
        allocation({ route: "unavailable", unavailableReason: "not-sold" }),
      ).settingsRows,
    ).toHaveLength(8);
  });

  it("判定不能(未知route)でも実効設定8項目が出ること(実効設定自体は正常な値のため)", () => {
    expect(buildAllocationProposalView(allocation({ route: "SOMETHING_UNKNOWN" })).settingsRows).toHaveLength(
      8,
    );
  });
});

describe("固定文言(AC3: yoso/invalid/記録なし)", () => {
  it("yosoは買い目が空で、noticesがYOSO_NOTEに固定されること(code-reviewer指摘・2巡目: toHaveLengthのみでは条件A0を満たさない。YOSO_NOTEをINVALID_NOTEへ差し替える変異で実際に検出漏れが実測された)", () => {
    const view = buildAllocationProposalView(allocation({ route: "yoso" }));
    expect(view.bets).toEqual([]);
    expect(view.notices).toEqual([YOSO_NOTE]);
    // 定数の中身そのものをリテラルで固定する(輸入した定数同士のtoEqualだけでは、他の定数の
    // 中身へ差し替えられても検出できない。まさに今回検出漏れとして実測された変異)。
    expect(YOSO_NOTE).toBe("分析時点でオッズが未発売だったため、配分提案を行っていません。");
  });

  it("invalidは買い目が空で、noticesがINVALID_NOTEに固定されること", () => {
    const view = buildAllocationProposalView(allocation({ route: "invalid" }));
    expect(view.bets).toEqual([]);
    expect(view.notices).toEqual([INVALID_NOTE]);
    expect(INVALID_NOTE).toBe("配分計算中にエラーが発生したため、配分を提案していません。");
  });

  it("記録なしは買い目・実効設定とも空で、noticesがNO_RECORD_NOTEに固定されること", () => {
    const view = buildAllocationProposalView(null);
    expect(view.bets).toEqual([]);
    expect(view.settingsRows).toEqual([]);
    expect(view.notices).toEqual([NO_RECORD_NOTE]);
    expect(NO_RECORD_NOTE).toBe("この分析には配分提案の記録がありません(Issue #59より前の分析です)。");
  });

  it("YOSO_NOTE・INVALID_NOTE・NO_RECORD_NOTEが互いに異なる値であること(3定数間の取り違え検出)", () => {
    expect(new Set([YOSO_NOTE, INVALID_NOTE, NO_RECORD_NOTE]).size).toBe(3);
  });
});
