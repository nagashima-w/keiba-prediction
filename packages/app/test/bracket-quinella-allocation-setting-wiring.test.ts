/**
 * bracket-quinella-allocation-setting-wiring.test.ts — 設定「枠連を配分に含める」の配管
 * (#26-E3a・Issue #149)と、その配分への接続(#26-E3b・Issue #150)を固定するテスト。
 *
 * `trifecta-allocation-setting-wiring.test.ts`(三連単版。#25-E3a→#25-E3b)と同じ構造を踏襲する。
 *
 * ## 経緯
 * Issue #149(#26-E3a)確定スコープ時点では、`AppSettings.includeBracketQuinellaInAllocation` を
 * 保存・IPC・`MixedAllocationSettings`・キャッシュキーまで配管するだけで、候補ビルダー
 * (`resolveMixedBetTypes`)・D-2フォールバック規則の条件②(`isComboBetTypesOff`)・条件③
 * (`comboCandidateCount`)は変更しなかった。このファイルは当時、それを「値を変えても結果が
 * 一切変わらない(未接続)」という値比較で固定していた。
 *
 * **Issue #150(#26-E3b)でその3点を接続した**ため、本ファイルは「値を変えると結果が変わる」形に
 * 反転した(三連単の#138→#139と同じ)。
 *
 * **Issue #151(#26-E3c)で「配分記録」のテストを再度反転した**(メタ行に`include_bracket_quinella`列を
 * 加え、`settingsColumnsOf`が枠連の項目を写すようになったため。三連単の#139→#140と同じ)。
 * 旧→新の対応表は下の表の最終行(Issue #150版→Issue #151版)を参照。
 *
 * ## 旧テスト→新テストの対応表(何を保証していたか)
 *
 * | 旧テスト(#149時点) | 何を保証していたか | 新テスト(#150) | 何を保証するようになったか |
 * |---|---|---|---|
 * | 「mixed経路でincludeBracketQuinellaInAllocationをtrue/falseに変えても、kind・result全体がビット一致し、枠連の買い目が入らないこと」 | 値によらず結果が変わらない(=`resolveMixedBetTypes`が未接続)/枠連の買い目が配分に入らない/配分自体は空でない | 「ONなら枠連の買い目が配分に入り、OFFなら入らず、両者は一致しないこと」 | `resolveMixedBetTypes`が値を読む/ONで枠連の買い目が入る(枠番の範囲・hitProb>0)/OFFで入らない/配分自体は両方とも空でない |
 * | 「isComboBetTypesOff配線(条件②)経路で値を変えても結果・理由コードが変わらないこと」 | 条件②の判定式が枠連を見ない(値によらず`combo-bet-types-off`) | 「他5券種OFFのまま枠連だけ切り替えると、`combo-bet-types-off`になるかどうかが切り替わること」 | 条件②が枠連を見る(ONなら`mixed`へ入り、OFFなら`combo-bet-types-off`) |
 * | (#149時点に無し) | — | 「条件③: 他券種の候補が0件で枠連候補だけあるとき、ONなら`mixed`、OFFなら`no-combo-candidates`」 | 条件③(`comboCandidateCount`)が枠連を数える(#148の申し送り: 数えないと枠連候補だけのレースが`no-combo-candidates`になる) |
 * | 「配分記録(メタ行・買い目)も、値を変えて一致すること」 | 記録全体が一致(=枠連の買い目が記録に入らない)/メタ行の列は据え置き | 「配分記録: 買い目に枠連が入り(comboKeyは枠番4桁)、メタ行は値に依らず一致すること」 | 買い目の記録に枠連が入る/メタ行(枠連の列は#151まで無い)は変わらない(**弱めていない**: メタ行の据え置きは引き続きtoEqualで固定) |
 * | 「配分記録: 買い目に枠連が入り(comboKeyは枠番4桁)、メタ行は値に依らず一致すること」(#150) | 買い目の記録に枠連が入る(枠番4桁の昇順・stake>0)/OFFでは入らない/OFF側の買い目も空でない/メタ行がONとOFFで完全一致 | 「配分記録: 買い目に枠連が入り、メタ行はincludeBracketQuinellaだけがON/OFFを反映すること」(#151) | 買い目についての4点(枠連が入る・枠番4桁昇順・stake>0・OFFでは入らない・OFF側も空でない)は**同じアサーションのまま** ／ メタ行は「完全一致」から「`includeBracketQuinella`がON側true・OFF側falseで、それ以外のメタ列は`{...off, includeBracketQuinella: on側の値}`のtoEqualで完全一致」へ(**弱めていない**: 枠連以外のメタ列の不変は引き続きtoEqualで固定し、加えて枠連の列の値そのものも固定した) |
 *
 * ## 空振り(vacuous pass)の防止
 * 枠連オッズが実在し、`betTypes`に枠連を明示すれば枠連候補が実際に作られる(=接続すれば配分が
 * 変わりうる)ことを、各テストで無条件`expect`により先に固定する。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildAllocationRecord } from "../src/main/allocation-record.js";
import type { AnalysisRow } from "../src/shared/analysis-types.js";
import { buildMixedCandidates, type MixedCandidateBuildInput } from "../src/shared/mixed-candidates.js";
import {
  buildMixedRaceAllocation,
  buildMixedRaceAllocationWithOutcome,
  type MixedAllocationSettings,
} from "../src/shared/mixed-race-allocation.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.join(currentDir, "../src/renderer");

/** 馬番→枠番を明示した行(枠連の的中判定は枠番を読む。馬番≠枠番にして取り違えを防ぐ)。 */
function row(umaban: number, wakuban: number): AnalysisRow {
  return {
    umaban,
    wakuban,
    horseName: `${umaban}番`,
    prior: 0.3,
    adjustedProb: 0.5,
    placeOddsMin: 3,
    winOdds: 10,
    ev: 1.5,
    isPositive: true,
    reason: null,
    highlights: [],
    concerns: [],
    careerRunCount: 999,
    mark: null,
    evEstimated: false,
    conditionChangeTags: [],
  };
}

/** 馬番1..8を枠[1,2,2,3,4,5,6,7]に割り当てる(馬番≠枠番。複勝が対象になる8頭で、混在経路に入れる)。 */
const WAKUBANS = [1, 2, 2, 3, 4, 5, 6, 7];

function rows(): AnalysisRow[] {
  return WAKUBANS.map((wakuban, i) => row(i + 1, wakuban));
}

/** 全馬の2頭組合せに一律のワイドオッズを与える(枠連なしでも混在経路に入れるため)。 */
function wideOdds(odds: number): Record<string, number> {
  const record: Record<string, number> = {};
  for (let a = 1; a <= WAKUBANS.length; a++) {
    for (let b = a + 1; b <= WAKUBANS.length; b++) {
      record[`${String(a).padStart(2, "0")}${String(b).padStart(2, "0")}`] = odds;
    }
  }
  return record;
}

/**
 * 枠連の全買い目(キーは枠番4桁・昇順。同枠は2頭以上の枠だけ)に、ワイドより桁違いに有利な高オッズを
 * 与える(接続されれば配分が動く)。枠[1,2,2,3,4,5,6,7]なら、馬のいる枠は7つで同枠は枠2だけなので、
 * C(7,2)+1=22件。
 */
const BRACKET_COMBO_COUNT = 22;
function bracketOdds(odds: number): Record<string, number> {
  const record: Record<string, number> = {};
  const frames = [...new Set(WAKUBANS)].sort((x, y) => x - y);
  for (const a of frames) {
    for (const b of frames) {
      if (a > b) continue;
      if (a === b && WAKUBANS.filter((w) => w === a).length < 2) continue;
      record[`${String(a).padStart(2, "0")}${String(b).padStart(2, "0")}`] = odds;
    }
  }
  return record;
}

function raceWithBracket(): MixedCandidateBuildInput {
  return {
    oddsStatus: "result",
    rows: rows(),
    wideCombo: wideOdds(30),
    bracketQuinellaCombo: bracketOdds(9999),
  };
}

/** 枠連だけを配分対象にできる状態(ワイド〜三連単をOFF)から始めて上書きできるテスト用設定。 */
function settings(overrides: Partial<MixedAllocationSettings> = {}): MixedAllocationSettings {
  return {
    bankroll: 300000,
    perRaceCap: 20000,
    kellyFraction: 0.5,
    evThreshold: 1.0,
    includeComboOdds: true,
    includeWideInAllocation: true,
    includeTrioInAllocation: false,
    includeQuinellaInAllocation: false,
    includeExactaInAllocation: false,
    includeTrifectaInAllocation: false,
    includeBracketQuinellaInAllocation: true,
    ...overrides,
  };
}

/** 前提固定(空振り防止): 枠連を明示すれば、このレースから枠連の買い目候補が実際に作られること。 */
function expectBracketCandidatesExist(race: MixedCandidateBuildInput): void {
  const result = buildMixedCandidates(race, { betTypes: ["bracketQuinella"] });
  const bracket = result.candidates.filter((c) => c.betType === "bracketQuinella");
  expect(bracket).toHaveLength(BRACKET_COMBO_COUNT);
  // 桁違いの高オッズなので、全件が期待値プラス(配分に選ばれる資格がある)。
  expect(bracket.every((c) => c.ev !== null && c.ev > 1)).toBe(true);
}


/** 他5券種(ワイド・3連複・馬連・馬単・三連単)をすべてOFFにした設定(条件②の判定を枠連だけに委ねる)。 */
const OTHER_FIVE_OFF = {
  includeWideInAllocation: false,
  includeTrioInAllocation: false,
  includeQuinellaInAllocation: false,
  includeExactaInAllocation: false,
  includeTrifectaInAllocation: false,
} as const;

describe("buildMixedRaceAllocation: includeBracketQuinellaInAllocationの値で枠連の買い目が配分に入るかどうかが切り替わること(#26-E3b・resolveMixedBetTypesの接続)", () => {
  it("mixed経路(ワイドON・枠連の高オッズあり)で、ONなら枠連の買い目が配分に入り、OFFなら入らず、両者は一致しないこと", () => {
    const race = raceWithBracket();
    expectBracketCandidatesExist(race);

    const withBracketOn = buildMixedRaceAllocation(
      race,
      settings({ includeBracketQuinellaInAllocation: true }),
    );
    const withBracketOff = buildMixedRaceAllocation(
      race,
      settings({ includeBracketQuinellaInAllocation: false }),
    );
    // 前提固定: 実際に混在経路(kind="mixed")に到達していること(空振り防止)。
    expect(withBracketOn.kind).toBe("mixed");
    expect(withBracketOff.kind).toBe("mixed");
    if (withBracketOn.kind !== "mixed" || withBracketOff.kind !== "mixed") {
      throw new Error("前提が崩れた: kind='mixed'であること");
    }
    const bracketOn = withBracketOn.result.allocations.filter((a) => a.betType === "bracketQuinella");
    const bracketOff = withBracketOff.result.allocations.filter((a) => a.betType === "bracketQuinella");
    // ONなら枠連の買い目が入る(桁違いの高オッズなので必ず入る)。
    expect(bracketOn.length).toBeGreaterThan(0);
    expect(bracketOn.some((a) => a.stake > 0)).toBe(true);
    // 枠連の買い目のumabansは馬番ではなく枠番(1〜7のうち馬のいる枠。昇順・同枠可)で、hitProbは正。
    for (const a of bracketOn) {
      expect(a.umabans).toHaveLength(2);
      expect(a.umabans.every((w) => WAKUBANS.includes(w))).toBe(true);
      expect(a.umabans[0]!).toBeLessThanOrEqual(a.umabans[1]!);
      expect(a.hitProb).toBeGreaterThan(0);
    }
    // OFFなら入らない。
    expect(bracketOff).toHaveLength(0);
    // 前提: 両方とも混在配分自体は何かを配分している(空同士の比較ではないこと)。
    expect(withBracketOn.result.allocations.length).toBeGreaterThan(0);
    expect(withBracketOff.result.allocations.length).toBeGreaterThan(0);
    // 接続された結果、ビット一致しない(#149時点はここがtoEqualで一致していた)。
    expect(withBracketOff).not.toEqual(withBracketOn);
  });
});

describe("isComboBetTypesOff配線(D-2フォールバック規則の条件②): includeBracketQuinellaInAllocationの値でfallbackReasonが変わること(#26-E3b)", () => {
  it("他5券種OFFのまま枠連だけtrue/falseを切り替えると、combo-bet-types-offになるかどうかが切り替わること", () => {
    const race = raceWithBracket();
    expectBracketCandidatesExist(race);

    const withBracketOn = buildMixedRaceAllocationWithOutcome(
      race,
      settings({ ...OTHER_FIVE_OFF, includeBracketQuinellaInAllocation: true }),
    );
    expect(withBracketOn.outcome.route).toBe("mixed");
    expect(withBracketOn.outcome.fallbackReason).toBeNull();
    expect(withBracketOn.view.kind).toBe("mixed");

    const withBracketOff = buildMixedRaceAllocationWithOutcome(
      race,
      settings({ ...OTHER_FIVE_OFF, includeBracketQuinellaInAllocation: false }),
    );
    expect(withBracketOff.outcome.route).toBe("place-only");
    expect(withBracketOff.outcome.fallbackReason).toBe("combo-bet-types-off");
    expect(withBracketOff.view.kind).toBe("computed");
  });

  it("条件①(includeComboOdds=false)は枠連がONでも優先して成立すること(枠連の接続で条件①が弱まらない)", () => {
    const race = raceWithBracket();
    expectBracketCandidatesExist(race);
    const result = buildMixedRaceAllocationWithOutcome(
      race,
      settings({ includeComboOdds: false, includeBracketQuinellaInAllocation: true }),
    );
    expect(result.outcome.route).toBe("place-only");
    expect(result.outcome.fallbackReason).toBe("combo-odds-not-requested");
  });
});

describe("D-2フォールバック規則の条件③(comboCandidateCount): 枠連の候補だけがあるレースはmixed経路へ入ること(#26-E3b。#148の申し送り)", () => {
  /** ワイドのオッズを持たない(=ワイド候補0件)が、枠連の高オッズだけがあるレース。 */
  function raceWithBracketOnly(): MixedCandidateBuildInput {
    return {
      oddsStatus: "result",
      rows: rows(),
      bracketQuinellaCombo: bracketOdds(9999),
    };
  }

  it("ワイドON・ワイド候補0件・枠連候補あり: 枠連ONならmixed(fallbackReason=null)、OFFならno-combo-candidates", () => {
    const race = raceWithBracketOnly();
    expectBracketCandidatesExist(race);
    // 前提固定(空振り防止): 枠連を除けばこのレースの組合せ候補は本当に0件であること。
    const withoutBracket = buildMixedCandidates(race, {
      betTypes: ["place", "win", "wide", "trio", "quinella", "exacta", "trifecta"],
    });
    expect(
      withoutBracket.candidates.filter((c) =>
        ["wide", "trio", "quinella", "exacta", "trifecta"].includes(c.betType),
      ),
    ).toHaveLength(0);

    const on = buildMixedRaceAllocationWithOutcome(
      race,
      settings({ includeBracketQuinellaInAllocation: true }),
    );
    expect(on.outcome.route).toBe("mixed");
    expect(on.outcome.fallbackReason).toBeNull();
    expect(on.view.kind).toBe("mixed");
    if (on.view.kind !== "mixed") {
      throw new Error("前提が崩れた: kind='mixed'であること");
    }
    expect(on.view.result.allocations.some((a) => a.betType === "bracketQuinella" && a.stake > 0)).toBe(true);

    const off = buildMixedRaceAllocationWithOutcome(
      race,
      settings({ includeBracketQuinellaInAllocation: false }),
    );
    expect(off.outcome.route).toBe("place-only");
    expect(off.outcome.fallbackReason).toBe("no-combo-candidates");
  });

  it("枠連ONでも枠連のオッズが無い(候補0件)レースは、従来どおりno-combo-candidatesになること(条件③が枠連の設定値だけでmixedへ倒れない)", () => {
    const race: MixedCandidateBuildInput = { oddsStatus: "result", rows: rows() };
    const result = buildMixedRaceAllocationWithOutcome(
      race,
      settings({ includeBracketQuinellaInAllocation: true }),
    );
    expect(result.outcome.route).toBe("place-only");
    expect(result.outcome.fallbackReason).toBe("no-combo-candidates");
  });
});

describe("配分記録: 枠連の買い目が記録に入り、メタ行はincludeBracketQuinellaだけがON/OFFを反映すること(#26-E3b・#26-E3c〈Issue #151〉)", () => {
  it("買い目にbet_type='bracketQuinella'(comboKeyは枠番4桁の昇順)が入り、OFFでは入らない。メタ行はincludeBracketQuinella以外がONとOFFで完全一致し、includeBracketQuinellaはON側true・OFF側false", () => {
    const race = raceWithBracket();
    expectBracketCandidatesExist(race);
    const onSettings = settings({ includeBracketQuinellaInAllocation: true });
    const offSettings = settings({ includeBracketQuinellaInAllocation: false });
    // 前提: 2つの設定は枠連の項目だけが異なる。
    expect(onSettings.includeBracketQuinellaInAllocation).not.toBe(
      offSettings.includeBracketQuinellaInAllocation,
    );
    const onOutcome = buildMixedRaceAllocationWithOutcome(race, onSettings);
    const offOutcome = buildMixedRaceAllocationWithOutcome(race, offSettings);
    expect(onOutcome.view.kind).toBe("mixed");
    expect(offOutcome.view.kind).toBe("mixed");
    const onRecord = buildAllocationRecord(onOutcome, onSettings, "result");
    const offRecord = buildAllocationRecord(offOutcome, offSettings, "result");

    const onBracketBets = onRecord.bets.filter((b) => b.betType === "bracketQuinella");
    expect(onBracketBets.length).toBeGreaterThan(0);
    for (const b of onBracketBets) {
      expect(b.comboKey).toMatch(/^0[1-8]0[1-8]$/);
      expect(b.comboKey.slice(0, 2) <= b.comboKey.slice(2)).toBe(true);
      expect(b.stake).toBeGreaterThan(0);
    }
    expect(offRecord.bets.filter((b) => b.betType === "bracketQuinella")).toHaveLength(0);
    // 前提: OFF側の買い目も空ではない(空との比較ではないこと)。
    expect(offRecord.bets.length).toBeGreaterThan(0);
    // メタ行: 枠連の列(Issue #151)はON側true・OFF側falseで設定を反映する。
    expect(onRecord.meta.includeBracketQuinella).toBe(true);
    expect(offRecord.meta.includeBracketQuinella).toBe(false);
    // それ以外のメタ列は不変(枠連の列だけを揃えれば完全一致する)。
    expect({ ...offRecord.meta, includeBracketQuinella: onRecord.meta.includeBracketQuinella }).toEqual(
      onRecord.meta,
    );
  });
});

// ============================================================================
// 画面(JSX直書きでレンダリングテスト基盤が無いためソース走査で確認する。
// exacta/trifecta-allocation-setting-wiring.test.ts・combo-odds-scope-guard.test.tsと同じ流儀)
// ============================================================================

describe("SettingsView.tsxが枠連の配分対象チェックボックスを持つこと(#26-E3b・Issue #150。#149時点は未表示だった)", () => {
  it("includeBracketQuinellaInAllocation・枠連配分対象切替・ALLOCATION_BET_TYPE_LABELS.bracketQuinellaを参照し、馬連の後・馬単の前(表示順の並び)に置かれていること", () => {
    const source = readFileSync(path.join(rendererDir, "SettingsView.tsx"), "utf8");
    // 前提固定(空振り防止): 既存のチェックボックスは実在すること(ファイルを正しく読めていることの確認)。
    expect(source).toContain("includeQuinellaInAllocation");
    expect(source).toContain("includeTrifectaInAllocation");
    expect(source).toContain("includeBracketQuinellaInAllocation");
    expect(source).toContain('"枠連配分対象切替"');
    expect(source).toContain("ALLOCATION_BET_TYPE_LABELS.bracketQuinella.checkbox");
    expect(source).toContain("ALLOCATION_BET_TYPE_LABELS.bracketQuinella.help");
    // 表示順(複勝→単勝→ワイド→馬連→枠連→馬単→三連複→三連単)に合わせ、馬連の後・馬単の前に置く。
    const quinella = source.indexOf("state.includeQuinellaInAllocation");
    const bracket = source.indexOf("state.includeBracketQuinellaInAllocation");
    const exacta = source.indexOf("state.includeExactaInAllocation");
    expect(quinella).toBeGreaterThan(-1);
    expect(bracket).toBeGreaterThan(quinella);
    expect(exacta).toBeGreaterThan(bracket);
  });
});

describe("VerifyView.tsxの配分ベースの内訳行・判定不能行に枠連が出ること(#26-E3b・Issue #150。#145で回収率検証の`overall`には合算済みだが内訳行には未表示だった)", () => {
  it("内訳(betCount・recoveryRate)と判定不能(unjudgedCount)の両方に枠連を、馬連の後・馬単の前の位置で表示していること", () => {
    const source = readFileSync(path.join(rendererDir, "VerifyView.tsx"), "utf8");
    for (const field of ["betCount", "recoveryRate", "unjudgedCount"] as const) {
      const q = source.indexOf(`report.proposedBet.quinella.${field}`);
      const b = source.indexOf(`report.proposedBet.bracketQuinella.${field}`);
      const e = source.indexOf(`report.proposedBet.exacta.${field}`);
      // 前提固定(空振り防止): 馬連・馬単は従来から表示されていること。
      expect(q, `quinella.${field}`).toBeGreaterThan(-1);
      expect(e, `exacta.${field}`).toBeGreaterThan(-1);
      expect(b, `bracketQuinella.${field}`).toBeGreaterThan(q);
      expect(e, `exacta.${field}が枠連の後`).toBeGreaterThan(b);
    }
    // 内訳行の枠連は「枠連」の語で表示すること(ラベルの直書き)。
    expect(source).toMatch(/枠連\{" "\}\s*\{report\.proposedBet\.bracketQuinella\.betCount/);
  });
});
