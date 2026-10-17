import { describe, expect, it } from "vitest";
import { parseRaceId, venueKindOfRaceId } from "../../packages/core/src/scraper/ids.js";
import type { AnalysisAllocationRecord } from "../../packages/core/src/ev/analysis-store-types.js";
import { assertClosePayload } from "../../cloud/src/analysis-close.js";
import { hasSyntheticClose, syntheticAdditionalInstruction, syntheticClosePayload, syntheticPromptVersion, syntheticRaceId } from "../measure-verify.js";

/** Issue #219: 検証の実測スクリプト(scripts/measure-verify.ts)の合成データの作り方の検査。測定そのもの(wrangler dev・/proc)は機械に依存するため固定しない。 */
describe("syntheticRaceId(合成のレース ID)", () => {
  it("1,301 件が互いに異なり、すべて 12 桁で、実在の形(parseRaceId を通る)。中央と地方が 7:3 で混ざる", () => {
    const ids = Array.from({ length: 1301 }, (_, i) => syntheticRaceId(i));
    expect(new Set(ids).size).toBe(1301);
    const kinds = ids.map((id) => venueKindOfRaceId(parseRaceId(id)));
    // 0〜1300: 10 件ごとに中央 7・地方 3。130 組 + 末尾の 1 件(中央)= 中央 911・地方 390
    expect(kinds.filter((k) => k === "central")).toHaveLength(911);
    expect(kinds.filter((k) => k === "nar")).toHaveLength(390);
  });
});

/** Issue #220: 版別比較の実測のため、合成の分析の版・追加指示を `--versions N`・`--instruction-length L` で変えられる。既定(N=1・L=0)は #219 の合成データと同じ。 */
describe("syntheticPromptVersion / syntheticAdditionalInstruction(合成の版・追加指示)", () => {
  it("N=1(既定)は #219 のとおり: 6 件に 1 件が版不明(null)、残りは 'v8'", () => {
    const versions = Array.from({ length: 12 }, (_, k) => syntheticPromptVersion(k + 1, 1));
    expect(versions.filter((v) => v === null)).toHaveLength(2);
    expect(new Set(versions.filter((v) => v !== null))).toEqual(new Set(["v8"]));
  });

  it("N>1: 版不明のほかに、ちょうど N 種類の版ができ、どの版にも分析が割り当たる(2,225 件・N=12 の場合)", () => {
    const versions = Array.from({ length: 2225 }, (_, k) => syntheticPromptVersion(k + 1, 12));
    const known = new Set(versions.filter((v): v is string => v !== null));
    expect(known.size).toBe(12);
    expect(versions.some((v) => v === null)).toBe(true);
    for (const v of known) expect(versions.filter((x) => x === v).length).toBeGreaterThan(50);
  });

  it("追加指示は L=0(既定)ならなし。L>0 なら 4 件に 1 件が L 文字、版ごとに別の文面", () => {
    expect(Array.from({ length: 20 }, (_, k) => syntheticAdditionalInstruction(k + 1, 5, 0)).every((x) => x === null)).toBe(true);
    const texts = Array.from({ length: 200 }, (_, k) => syntheticAdditionalInstruction(k + 1, 5, 300));
    expect(texts.filter((x) => x !== null)).toHaveLength(50);
    expect(texts.filter((x): x is string => x !== null).every((x) => x.length === 300)).toBe(true);
    expect(new Set(texts.filter((x) => x !== null)).size).toBeGreaterThan(1);
  });
});

/** Issue #352: 締切直前の再計算の行(analysis_close・analysis_close_bets)の実測用の合成。`--close-ratio R`(既定 0=なし)で、分析の割合 R に回 1・回 2 の ok の行を付ける。 */
describe("hasSyntheticClose / syntheticClosePayload(合成の再計算の行)", () => {
  it("R=0 は 1 件も付かず、R=1 は全件に付く。R=0.25 は 100 件中ちょうど 25 件(同じ引数なら同じ分析に付く)", () => {
    const pick = (ratio: number) => Array.from({ length: 100 }, (_, k) => hasSyntheticClose(k + 1, ratio));
    expect(pick(0).filter(Boolean)).toHaveLength(0);
    expect(pick(1).filter(Boolean)).toHaveLength(100);
    expect(pick(0.25).filter(Boolean)).toHaveLength(25);
    expect(pick(0.25)).toEqual(pick(0.25));
  });

  it("合成の行は ok の結果(保存の前の形の検査 assertClosePayload を通る)で、配分は分析時のもの(買い目の数が同じ)", () => {
    const allocation = { meta: { route: "mixed", unavailableReason: null, fallbackReason: null, skipReasonCode: null, comboOddsWide: null, comboOddsTrio: null, bankroll: 1, perRaceCap: 1, kellyFraction: 0.25, evThreshold: 1, includeComboOdds: false, includeWide: false, includeTrio: false, betUnit: 100 } as unknown as AnalysisAllocationRecord["meta"], bets: [{ betType: "place", comboKey: "01", stake: 100, odds: 2, ev: 1.1 }] };
    for (const round of [1, 2] as const) {
      const payload = syntheticClosePayload(round, allocation);
      expect(() => assertClosePayload(payload)).not.toThrow();
      expect(payload.status).toBe("ok");
      expect(payload.allocation!.bets).toHaveLength(1);
      expect(payload.round).toBe(round);
    }
  });
});
