import { describe, expect, it } from "vitest";
import { allocateBets, type AllocationHorse, DEFAULT_BET_ALLOCATION_CONFIG } from "../../src/ev/bet-allocation.js";
import { DEFAULT_EV_CONFIG } from "../../src/ev/expected-value.js";
import {
  allocateGeneralBets,
  buildComboCandidates,
  buildComboOddsKey,
  DEFAULT_CANDIDATE_CAP,
  DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
  resolveComboOdds,
  type AllocationCandidate,
  type GeneralBetAllocationConfig,
} from "../../src/ev/combo-bet-allocation.js";
import {
  CONDITIONAL_BERNOULLI_MODEL,
  type JointModelHorse,
  type PlaceJointModel,
  type PlaceOutcome,
} from "../../src/ev/place-joint-model.js";

/**
 * combo-bet-allocation — 機能D-2a(Issue #14)。買い目が「馬の組」になる券種
 * (ワイド・三連複)への一般化。boss着手前ゲート2026-08-05のゴーサインに基づき実装。
 *
 * 設計の骨子(報告参照):
 *   - allocateGeneralBets: 券種非依存の配分エンジン(複勝1頭も・ワイド2頭組も・3連複3頭組も
 *     同じ AllocationCandidate[] として受け取れる。受け入れ条件8「券種混在」の土台)。
 *   - buildComboCandidates: ワイド・3連複向けの候補ビルダー(列挙+オッズ3状態解決+EV算出)。
 *     EV/isPositiveはここで計算する(odds Mapのキー生成・3状態解決を1本化。決定2)。
 */

/** テスト用の固定分布を返すスタブモデル。 */
function stubModel(distribution: readonly PlaceOutcome[]): PlaceJointModel {
  return { id: "stub", approximate: false, buildDistribution: () => distribution };
}

/** n頭・均等な複勝圏内確率(topFinishCount/n)のJointModelHorse配列を作る補助関数。 */
function evenHorses(n: number, topFinishCount: number): JointModelHorse[] {
  return Array.from({ length: n }, (_, i) => ({
    umaban: i + 1,
    placeProb: topFinishCount / n,
  }));
}

/** 全組合せに同一オッズを割り当てたオッズMapを作る補助関数(CONDITIONAL_BERNOULLI_MODEL用)。 */
function uniformOddsMap(n: number, comboSize: number, odds: number): Map<string, number | null> {
  const map = new Map<string, number | null>();
  const combo = (arr: number[], k: number, start: number, current: number[]): void => {
    if (current.length === k) {
      map.set(buildComboOddsKey(current), odds);
      return;
    }
    for (let i = start; i < arr.length; i++) {
      combo(arr, k, i + 1, [...current, arr[i]!]);
    }
  };
  combo(
    Array.from({ length: n }, (_, i) => i + 1),
    comboSize,
    0,
    [],
  );
  return map;
}

describe("combo-bet-allocation(券種一般の配分最適化・機能D-2a)", () => {
  describe("buildComboOddsKey/resolveComboOdds(オッズキー正規化・3状態判別)", () => {
    it("キーは昇順2桁ゼロ埋め連結になること(netkeibaの実キー形式に一致)", () => {
      expect(buildComboOddsKey([1, 2])).toBe("0102");
      expect(buildComboOddsKey([2, 1])).toBe("0102"); // 入力順に依らない
      expect(buildComboOddsKey([1, 2, 3])).toBe("010203");
      expect(buildComboOddsKey([12, 3])).toBe("0312");
    });

    it("present(取得済み・値あり)/missing(欠損=null)/unfetched(未取得=キー不在)の3状態を区別すること", () => {
      const map = new Map<string, number | null>([
        ["0102", 3.5],
        ["0103", null],
        // "0203" はキーごと存在しない(未取得)
      ]);
      expect(resolveComboOdds(map, [1, 2])).toEqual({ state: "present", odds: 3.5 });
      expect(resolveComboOdds(map, [1, 3])).toEqual({ state: "missing" });
      expect(resolveComboOdds(map, [2, 3])).toEqual({ state: "unfetched" });
    });
  });

  describe("buildComboCandidates: 候補列挙の頭数境界", () => {
    it("n=0,1はワイド(comboSize=2)候補0件(enumeratedCount===0)であること(C(n,2)=0)", () => {
      for (const n of [0, 1]) {
        const horses = evenHorses(n, 3);
        const oddsMap = uniformOddsMap(n, 2, 3);
        const result = buildComboCandidates(horses, 3, 2, oddsMap);
        expect(result.diagnostics.enumeratedCount).toBe(0);
      }
    });

    it("n=2ではワイド候補がちょうど1件になること(C(2,2)=1。組合せ論的な境界であり0ではない)", () => {
      // 継承したブリーフ原文は「n=0,1,2→0件」だったが、C(2,2)=1は数学的に非退化な1件であり
      // 誤り(三連複側の「n=3でちょうど1件」と同じ境界構造)。Red実行で実際に1が返ったことを
      // 契機に、組合せ論の事実に合わせて期待値を訂正した(報告参照)。
      const horses = evenHorses(2, 3);
      const oddsMap = uniformOddsMap(2, 2, 3);
      const result = buildComboCandidates(horses, 3, 2, oddsMap);
      expect(result.diagnostics.enumeratedCount).toBe(1);
    });

    it("n=3で3連複(comboSize=3)はちょうど1件、n<3では0件(enumeratedCount)であること", () => {
      const oddsMap3 = uniformOddsMap(3, 3, 5);
      const result3 = buildComboCandidates(evenHorses(3, 3), 3, 3, oddsMap3);
      expect(result3.diagnostics.enumeratedCount).toBe(1);

      for (const n of [0, 1, 2]) {
        const oddsMap = uniformOddsMap(n, 3, 5);
        const result = buildComboCandidates(evenHorses(n, 3), 3, 3, oddsMap);
        expect(result.diagnostics.enumeratedCount).toBe(0);
      }
    });
  });

  describe("k(topFinishCount)とplaceCountの分離(誤用の症状固定)", () => {
    it("topFinishCount=3(正しい)なら3連複が正のev候補を持ちうること(前提の無条件固定)", () => {
      // 3頭が必ず同着で3着以内(退化しない分布)になるスタブモデルで、確実に正のEVを作る。
      const horses = evenHorses(6, 3);
      const model = stubModel([{ placed: [1, 2, 3], probability: 1 }]);
      const oddsMap = uniformOddsMap(6, 3, 10); // hitProb=1(1,2,3のみ)×odds10 → 高EV
      const result = buildComboCandidates(horses, 3, 3, oddsMap, DEFAULT_EV_CONFIG, model);
      // 前提: 少なくとも1件は正のEV候補になること(このテストの土台)。
      expect(result.diagnostics.judged.positiveCount).toBeGreaterThan(0);
    });

    it("topFinishCount=2をplaceCount流用で3連複に渡すと、的中確率が構造的に0になり全て非プラスになること(誤用の症状)", () => {
      // 5〜7頭の複勝相当で「対象人数2」を安易に流用した場合の症状を再現する。
      // topFinishCount=2だとraw distributionのplacedは常にサイズ2で、
      // 要素数3の組が部分集合として含まれることは組合せ論的に不可能(3>2)。
      const horses = evenHorses(6, 2);
      const oddsMap = uniformOddsMap(6, 3, 10); // オッズは十分あるが誤用のため全滅するはず
      const result = buildComboCandidates(horses, 2, 3, oddsMap);
      expect(result.diagnostics.enumeratedCount).toBeGreaterThan(0); // 列挙自体はされている
      expect(result.diagnostics.judged.positiveCount).toBe(0); // 誤用の症状: 的中確率0でEVも0
      expect(result.diagnostics.judged.notPositiveCount).toBe(result.diagnostics.enumeratedCount);
      expect(result.candidates).toHaveLength(0);
    });
  });

  describe("モデル非依存の恒等式4本(CONDITIONAL_BERNOULLI_MODEL、n=3,4,18)", () => {
    function sumWhere(dist: readonly PlaceOutcome[], pred: (placed: readonly number[]) => boolean): number {
      return dist.reduce((acc, o) => (pred(o.placed) ? acc + o.probability : acc), 0);
    }

    for (const n of [3, 4, 18]) {
      it(`n=${n}: Σ_i P(iが上位3着)=3、Σ_{i<j}P({i,j}⊆上位3着)=3、Σ_{i<j<k}P(3連複)=1、
          ワイド確率=Σ3連複確率 が成り立つこと`, () => {
        const horses = evenHorses(n, 3);
        // 均等ではない分布にするため、馬ごとに微妙にずらす(退化を避ける)。
        const skewed: JointModelHorse[] = horses.map((h, i) => ({
          umaban: h.umaban,
          placeProb: Math.min(0.95, Math.max(0.05, (3 / n) * (1 + (i % 3) * 0.1))),
        }));
        const dist = CONDITIONAL_BERNOULLI_MODEL.buildDistribution(skewed, 3);

        // 恒等式1: Σ_i P(i∈top3) = 3
        const umabans = skewed.map((h) => h.umaban);
        const sumSingles = umabans.reduce((acc, u) => acc + sumWhere(dist, (p) => p.includes(u)), 0);
        expect(sumSingles).toBeCloseTo(3, 8);

        // 恒等式2: Σ_{i<j} P({i,j}⊆top3) = C(3,2) = 3
        let sumPairs = 0;
        for (let a = 0; a < umabans.length; a++) {
          for (let b = a + 1; b < umabans.length; b++) {
            sumPairs += sumWhere(dist, (p) => p.includes(umabans[a]!) && p.includes(umabans[b]!));
          }
        }
        expect(sumPairs).toBeCloseTo(3, 8);

        // 恒等式3: Σ_{i<j<k} P({i,j,k}=top3) = 1
        if (n >= 3) {
          let sumTrios = 0;
          for (let a = 0; a < umabans.length; a++) {
            for (let b = a + 1; b < umabans.length; b++) {
              for (let c = b + 1; c < umabans.length; c++) {
                sumTrios += sumWhere(
                  dist,
                  (p) => p.includes(umabans[a]!) && p.includes(umabans[b]!) && p.includes(umabans[c]!),
                );
              }
            }
          }
          expect(sumTrios).toBeCloseTo(1, 8);

          // 恒等式4(券種間の整合): P(ワイド i-j) = Σ_k P(3連複 i-j-k)
          const i = umabans[0]!;
          const j = umabans[1]!;
          const wideProb = sumWhere(dist, (p) => p.includes(i) && p.includes(j));
          let sumTrioForPair = 0;
          for (const k of umabans) {
            if (k === i || k === j) continue;
            sumTrioForPair += sumWhere(dist, (p) => p.includes(i) && p.includes(j) && p.includes(k));
          }
          expect(sumTrioForPair).toBeCloseTo(wideProb, 8);
        }
      });
    }
  });

  describe("相関を無視していないことの構造検証(スタブモデル)", () => {
    it("iとjの周辺確率は同じでも、常に同時に上位3着になる分布では独立積(0.25)より高いhitProb(0.5)になり、continuousFractionが正になること", () => {
      const horses = evenHorses(5, 3);
      // 1と2は常に「両方placedか、両方placedでないか」のどちらか(完全相関)。
      // 周辺確率はP(1)=P(2)=0.5だが、独立を仮定した積(0.5*0.5=0.25)より
      // 実際の同時確率(0.5)の方がずっと大きい。
      const correlated = stubModel([
        { placed: [1, 2, 3], probability: 0.5 },
        { placed: [3, 4, 5], probability: 0.5 },
      ]);
      const oddsMap = uniformOddsMap(5, 2, 3); // odds=3, hitProb=0.5ならEV=1.5>1(正)
      const built = buildComboCandidates(horses, 3, 2, oddsMap, DEFAULT_EV_CONFIG, correlated);
      const pair12 = built.candidates.find((c) => c.umabans.join(",") === "1,2");
      // 前提(無条件expect): 1-2ワイドが候補として存在すること(EVプラス)。
      expect(pair12).toBeDefined();
      // hitProbは独立積(0.25)ではなく、相関を反映した実際の同時確率(0.5)であること
      // (独立仮定を採用していたら0.25*3=0.75<1でEVマイナスになり候補にすら残らないはず)。
      expect(pair12!.ev).toBeCloseTo(0.5 * 3, 10);
      expect(pair12!.ev).not.toBeCloseTo(0.25 * 3, 1);

      const result = allocateGeneralBets(
        horses,
        3,
        built.candidates,
        { ...DEFAULT_GENERAL_BET_ALLOCATION_CONFIG, bankroll: 100000, perRaceCap: 100000 },
        correlated,
      );
      const row = result.allocations.find((a) => a.umabans.join(",") === "1,2");
      expect(row).toBeDefined();
      expect(row!.hitProb).toBeCloseTo(0.5, 10);
      // EVプラスなので連続最適比率は正になるはず(退化していないことの確認)。
      expect(row!.continuousFraction).toBeGreaterThan(0);
    });

    it("iとjが絶対に同時に上位3着にならない分布では、ワイドi-jのhitProbが0になること", () => {
      const horses = evenHorses(5, 3);
      // i=1が3着以内のときj=2は絶対に3着以内にならない(排他的)。
      const exclusive = stubModel([
        { placed: [1, 3, 4], probability: 0.5 },
        { placed: [2, 3, 4], probability: 0.5 },
      ]);
      const oddsMap = uniformOddsMap(5, 2, 100); // オッズを高くしてもEVはhitProb=0なら0
      const built = buildComboCandidates(horses, 3, 2, oddsMap, DEFAULT_EV_CONFIG, exclusive);
      const pair12 = built.candidates.find((c) => c.umabans.join(",") === "1,2");
      // 排他的なので1-2ワイドはEVが必ず0になり、候補にすら残らないはず。
      expect(pair12).toBeUndefined();
    });
  });

  describe("オッズ3区分(欠損/未取得/候補外)が別々の理由・件数として出ること", () => {
    it("present/missing/unfetchedがdiagnosticsで別カウントになること", () => {
      const horses = evenHorses(4, 3); // C(4,2)=6組
      const oddsMap = new Map<string, number | null>();
      // 6組のうち: 1組present(高オッズで正EV)、2組missing(null)、残り3組unfetched(キー不在のまま)。
      const allCombos = [
        [1, 2],
        [1, 3],
        [1, 4],
        [2, 3],
        [2, 4],
        [3, 4],
      ];
      oddsMap.set(buildComboOddsKey(allCombos[0]!), 5); // present
      oddsMap.set(buildComboOddsKey(allCombos[1]!), null); // missing
      oddsMap.set(buildComboOddsKey(allCombos[2]!), null); // missing
      // allCombos[3..5] は未設定のまま(unfetched)

      const result = buildComboCandidates(horses, 3, 2, oddsMap);
      expect(result.diagnostics.enumeratedCount).toBe(6);
      expect(result.diagnostics.unjudged.oddsMissingCount).toBe(2);
      expect(result.diagnostics.unjudged.oddsUnfetchedCount).toBe(3);
      // 残り1組(present)はEVが計算され、judged(positive+notPositive)の合計が1になる。
      expect(result.diagnostics.judged.positiveCount + result.diagnostics.judged.notPositiveCount).toBe(1);
    });
  });

  describe("候補上限(候補cap)の境界", () => {
    it("既定上限は50であること(DEFAULT_CANDIDATE_CAP)", () => {
      expect(DEFAULT_CANDIDATE_CAP).toBe(50);
    });

    it("複勝相当(18件)の入力ではcapが発動しないこと(上限50>=18)", () => {
      const horses = evenHorses(18, 3);
      const candidates: AllocationCandidate[] = Array.from({ length: 18 }, (_, i) => ({
        umabans: [i + 1],
        odds: 3,
        ev: 1.5,
        isPositive: true,
      }));
      const result = allocateGeneralBets(horses, 3, candidates, {
        ...DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
        bankroll: 100000,
        perRaceCap: 100000,
      });
      expect(result.diagnostics.truncatedByCapCount).toBe(0);
      expect(result.diagnostics.candidateCount).toBe(18);
    });

    it("上限ちょうど(50件)では切り捨て0件、上限+1件(51件)では1件切り捨てられること", () => {
      const horses = evenHorses(18, 3);

      const at50 = allocateGeneralBets(horses, 3, makeAscendingUniqueCandidates(50), {
        ...DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
        bankroll: 100000,
        perRaceCap: 100000,
      });
      expect(at50.diagnostics.truncatedByCapCount).toBe(0);
      expect(at50.diagnostics.candidateCount).toBe(50);

      const at51 = allocateGeneralBets(horses, 3, makeAscendingUniqueCandidates(51), {
        ...DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
        bankroll: 100000,
        perRaceCap: 100000,
      });
      expect(at51.diagnostics.truncatedByCapCount).toBe(1);
      expect(at51.diagnostics.candidateCount).toBe(50);
    });

    it("上限による切り捨ての選抜はEV降順・タイブレーク馬番辞書順で決定的であること", () => {
      const horses = evenHorses(18, 3);
      const config: GeneralBetAllocationConfig = {
        ...DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
        bankroll: 100000,
        perRaceCap: 100000,
        candidateCap: 2,
      };
      const candidates: AllocationCandidate[] = [
        { umabans: [1, 2], odds: 3, ev: 1.1, isPositive: true }, // 最下位EV → 切り捨てられる
        { umabans: [3, 4], odds: 3, ev: 2.0, isPositive: true },
        { umabans: [5, 6], odds: 3, ev: 2.0, isPositive: true }, // 同値EV・馬番辞書順で3,4より後
      ];
      const result = allocateGeneralBets(horses, 3, candidates, config);
      expect(result.diagnostics.truncatedByCapCount).toBe(1);
      expect(result.diagnostics.candidateCount).toBe(2);
      const kept = result.allocations.map((a) => a.umabans.join(","));
      expect(kept.sort()).toEqual(["3,4", "5,6"]);
    });
  });

  describe("入力の正規化(馬番の組は昇順・重複なし)", () => {
    it("{3,3}のような不正な組(非昇順・重複含む)を渡すと例外を投げること", () => {
      const horses = evenHorses(4, 3);
      const bad: AllocationCandidate[] = [{ umabans: [3, 3], odds: 3, ev: 2, isPositive: true }];
      expect(() => allocateGeneralBets(horses, 3, bad)).toThrow();
    });

    it("降順など非昇順の組を渡すと例外を投げること", () => {
      const horses = evenHorses(4, 3);
      const bad: AllocationCandidate[] = [{ umabans: [2, 1], odds: 3, ev: 2, isPositive: true }];
      expect(() => allocateGeneralBets(horses, 3, bad)).toThrow();
    });

    it("同じ組の重複入力を渡すと例外を投げること(黙って通さない)", () => {
      const horses = evenHorses(4, 3);
      const dup: AllocationCandidate[] = [
        { umabans: [1, 2], odds: 3, ev: 2, isPositive: true },
        { umabans: [1, 2], odds: 3.5, ev: 2.1, isPositive: true },
      ];
      expect(() => allocateGeneralBets(horses, 3, dup)).toThrow();
    });

    it("馬番の組が空(umabans: [])の候補を渡すと例外を投げること(code-reviewer提案2)", () => {
      const horses = evenHorses(4, 3);
      const empty: AllocationCandidate[] = [{ umabans: [], odds: 3, ev: 2, isPositive: true }];
      expect(() => allocateGeneralBets(horses, 3, empty)).toThrow();
    });
  });

  describe("既存の防御が組合せでも生きること(betUnit/λ/greedySteps/bankroll/perRaceCapの異常値)", () => {
    const horses = evenHorses(5, 3);
    const candidates: AllocationCandidate[] = [
      { umabans: [1, 2], odds: 3, ev: 1.8, isPositive: true },
      { umabans: [1, 3], odds: 2.5, ev: 1.5, isPositive: true },
    ];

    it("betUnit=0/NaN/非整数でもNaN/Infinityが混入せず、既定betUnit相当の結果になること", () => {
      const base: GeneralBetAllocationConfig = {
        bankroll: 10000,
        perRaceCap: 10000,
        kellyFraction: 1,
        betUnit: 100,
        greedySteps: 1000,
        candidateCap: DEFAULT_CANDIDATE_CAP,
      };
      const expected = allocateGeneralBets(horses, 3, candidates, base);
      for (const betUnit of [0, Number.NaN, 33.5]) {
        const result = allocateGeneralBets(horses, 3, candidates, { ...base, betUnit });
        expect(Number.isFinite(result.totalStake)).toBe(true);
        expect(result.totalStake).toBe(expected.totalStake);
      }
    });

    it("kellyFraction=NaN/範囲外でも既定値0.5へフォールバックすること", () => {
      const base: GeneralBetAllocationConfig = {
        bankroll: 10000,
        perRaceCap: 10000,
        kellyFraction: 0.5,
        betUnit: 100,
        greedySteps: 1000,
        candidateCap: DEFAULT_CANDIDATE_CAP,
      };
      const expected = allocateGeneralBets(horses, 3, candidates, base);
      for (const kellyFraction of [Number.NaN, 1.5, -0.5]) {
        const result = allocateGeneralBets(horses, 3, candidates, { ...base, kellyFraction });
        expect(result.kellyFraction).toBe(0.5);
        expect(result.totalStake).toBe(expected.totalStake);
      }
    });

    it("bankroll<0/perRaceCap<0でも全出力が有限・非負であること", () => {
      const result = allocateGeneralBets(horses, 3, candidates, {
        bankroll: -10000,
        perRaceCap: -100,
        kellyFraction: 0.5,
        betUnit: 100,
        greedySteps: 1000,
        candidateCap: DEFAULT_CANDIDATE_CAP,
      });
      expect(Number.isFinite(result.resolvedBankroll)).toBe(true);
      expect(result.resolvedBankroll).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(result.effectivePerRaceCap)).toBe(true);
      expect(result.effectivePerRaceCap).toBeGreaterThanOrEqual(0);
      expect(result.skipReason).toBe("総資金が未設定のため配分を提案していません");
    });

    it("greedySteps=0でも既定1000相当の結果になること", () => {
      const base: GeneralBetAllocationConfig = {
        bankroll: 10000,
        perRaceCap: 10000,
        kellyFraction: 1,
        betUnit: 100,
        greedySteps: 1000,
        candidateCap: DEFAULT_CANDIDATE_CAP,
      };
      const expected = allocateGeneralBets(horses, 3, candidates, base);
      const result = allocateGeneralBets(horses, 3, candidates, { ...base, greedySteps: 0 });
      expect(result.totalStake).toBe(expected.totalStake);
    });

    it("candidateCap=NaN/Infinity/負値/0/非整数でも既定candidateCap(50)相当の結果になること", () => {
      // 他5フィールド(betUnit/kellyFraction/bankroll/perRaceCap/greedySteps)と同じ流儀
      // (code-reviewer指摘【要修正2】)。候補cap自体が観測できるよう、60件の一意なワイド候補
      // (既定cap=50を上回る)で truncatedByCapCount/candidateCount の一致を直接検証する。
      const horses18 = evenHorses(18, 3);
      const candidates60 = makeAscendingUniqueCandidates(60);
      const base: GeneralBetAllocationConfig = {
        bankroll: 100000,
        perRaceCap: 100000,
        kellyFraction: 1,
        betUnit: 100,
        greedySteps: 1000,
        candidateCap: DEFAULT_CANDIDATE_CAP,
      };
      const expected = allocateGeneralBets(horses18, 3, candidates60, base);
      // 前提(無条件expect): 既定candidateCapが実際に切り捨てを発動していること
      // (発動していなければ、この後の「フォールバック後も一致する」検証が空振りになる)。
      expect(expected.diagnostics.truncatedByCapCount).toBeGreaterThan(0);
      expect(expected.diagnostics.candidateCount).toBe(DEFAULT_CANDIDATE_CAP);

      for (const candidateCap of [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        -5,
        0,
        12.5,
      ]) {
        const result = allocateGeneralBets(horses18, 3, candidates60, { ...base, candidateCap });
        expect(result.diagnostics.candidateCount).toBe(DEFAULT_CANDIDATE_CAP);
        expect(result.diagnostics.truncatedByCapCount).toBe(expected.diagnostics.truncatedByCapCount);
        expect(result.totalStake).toBe(expected.totalStake);
      }
    });

    it("skipReasonの6分類すべてが組合せ経路でも成立すること(文言は『買い目』表現)", () => {
      const r1 = allocateGeneralBets(horses, 3, candidates, {
        ...DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
        bankroll: 0,
        perRaceCap: 10000,
      });
      expect(r1.skipReason).toBe("総資金が未設定のため配分を提案していません");

      const r5 = allocateGeneralBets(horses, 3, [], {
        ...DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
        bankroll: 10000,
        perRaceCap: 10000,
      });
      expect(r5.skipReason).toBe("EVプラスの買い目がないため見送りです");
    });
  });

  describe("券種混在(受け入れ条件8): umabans長1/2/3を1回のallocateGeneralBetsに混ぜて渡せること", () => {
    it("複勝1件・ワイド1件・3連複1件を混在させても、単一の最適化で全て扱われ辞書順で安定すること", () => {
      // code-reviewer指摘【要修正3】: 「API形状が対応している」ことをコンパイル可能性だけで
      // 済ませず、実際に umabans.length===1/2/3 を混在させた候補配列を1回呼び出しに渡し、
      // 3件とも同じ貪欲最適化に載って結果を返すことを直接検証する。
      const horses = evenHorses(6, 3);
      // 3候補がそれぞれ独立した専用outcomeでのみヒットするよう分離する(候補同士を
      // 同一outcomeに相乗りさせない。相乗りさせると完全相関の代替品になり、貪欲法が
      // 一方だけを選んで他方を0円にする〈正しい〉挙動と、的中判定バグによる0円が
      // 見分けられなくなるため)。{2,4,5}は「先頭馬番だけ一致」する誤判定(部分集合包含では
      // なく先頭要素の単純一致)を検出するための撹乱outcomeである: [2,3]の先頭2、[4,5,6]の
      // 先頭4がそれぞれ含まれるが、組の残りの馬番(3・6)は含まれない。的中判定が「全馬番の
      // 部分集合包含」ならこのoutcomeは[2,3]にも[4,5,6]にもヒットしないが、「先頭要素だけの
      // 一致」というバグがあると誤ってヒット扱いになり、hitProbが0.3ではなく0.4に膨らんで
      // 検出できる。
      const model = stubModel([
        { placed: [1, 7, 8], probability: 0.3 }, // [1] 専用
        { placed: [2, 3, 9], probability: 0.3 }, // [2,3] 専用
        { placed: [4, 5, 6], probability: 0.3 }, // [4,5,6] 専用
        { placed: [2, 4, 5], probability: 0.1 }, // 撹乱(先頭要素のみ一致・部分集合ではない)
      ]);
      // odds=5・正しいhitProb=0.3ならEV=1.5>1(正の妙味)で、貪欲最適化がstakeを配分するはず。
      const candidates: AllocationCandidate[] = [
        { umabans: [1], odds: 5, ev: 1.5, isPositive: true }, // 複勝相当(1頭)
        { umabans: [2, 3], odds: 5, ev: 1.5, isPositive: true }, // ワイド相当(2頭組)
        { umabans: [4, 5, 6], odds: 5, ev: 1.5, isPositive: true }, // 3連複相当(3頭組)
      ];

      const result = allocateGeneralBets(
        horses,
        3,
        candidates,
        { ...DEFAULT_GENERAL_BET_ALLOCATION_CONFIG, bankroll: 1000000, perRaceCap: 1000000 },
        model,
      );

      // 前提(無条件expect): 3件とも切り捨てられず、1回の最適化に載っていること。
      expect(result.diagnostics.candidateCount).toBe(3);
      expect(result.diagnostics.truncatedByCapCount).toBe(0);

      // 辞書順(umabans配列比較。長さではなく要素の値で決まる)で安定していること:
      // [1] < [2,3] < [4,5,6](先頭要素 1 < 2 < 4 で決まる。長さ混在でも崩れない)。
      expect(result.allocations.map((a) => a.umabans.join(","))).toEqual(["1", "2,3", "4,5,6"]);

      // 各買い目のhitProbが「全馬番の部分集合包含」で正しく導出されていること(撹乱outcome
      // {2,4,5}は[2,3]にも[4,5,6]にもヒットしないため、いずれも0.3のまま)。
      // 長さ混在でも同じ判定関数が正しく効いていることの直接証拠。
      for (const a of result.allocations) {
        expect(a.hitProb).toBeCloseTo(0.3, 10);
      }

      // 3件とも同一の貪欲最適化に載り、いずれも正の配分を得ていること
      // (型だけ受け入れて実際には別々に処理している、という誤魔化しではないことの直接証拠)。
      expect(result.betCount).toBe(3);
      for (const a of result.allocations) {
        expect(a.stake).toBeGreaterThan(0);
      }
    });
  });

  describe("数値の極端値(高オッズ×低確率)", () => {
    it("odds=3000・hitProb=1/2000でもwealth<=EPSガードが効き、NaN/Infinityが混入しないこと", () => {
      const horses = evenHorses(5, 3);
      const model = stubModel([
        { placed: [1, 2, 3], probability: 1 / 2000 },
        { placed: [], probability: 1 - 1 / 2000 },
      ]);
      const oddsMap = new Map<string, number | null>([[buildComboOddsKey([1, 2]), 3000]]);
      const built = buildComboCandidates(horses, 3, 2, oddsMap, DEFAULT_EV_CONFIG, model);
      const result = allocateGeneralBets(horses, 3, built.candidates, {
        ...DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
        bankroll: 100000,
        perRaceCap: 100000,
      }, model);
      expect(Number.isFinite(result.totalStake)).toBe(true);
      for (const a of result.allocations) {
        expect(Number.isFinite(a.stake)).toBe(true);
        expect(Number.isFinite(a.continuousFraction)).toBe(true);
      }
    });
  });

  describe("後方互換(複勝相当・単一要素combo): allocateBetsとの厳密一致(toBe)", () => {
    it("受け入れ条件6シナリオを単一要素comboで再現し、totalStake/各stake/kellyTargetStakeがtoBeで一致すること", () => {
      // bet-allocation.test.ts「受け入れ条件6」と同一の入力(placeCount=2・3頭・cap拘束)。
      const rawHorses: Array<{ umaban: number; placeProb: number; placeOddsMin: number }> = [
        { umaban: 1, placeProb: 0.6, placeOddsMin: 2.5 },
        { umaban: 2, placeProb: 0.5, placeOddsMin: 2.2 },
        { umaban: 3, placeProb: 0.1, placeOddsMin: 5 },
      ];
      const allocationHorses: AllocationHorse[] = rawHorses.map((h) => ({
        umaban: h.umaban,
        placeProb: h.placeProb,
        placeOddsMin: h.placeOddsMin,
        ev: h.placeProb * h.placeOddsMin,
        isPositive: h.placeProb * h.placeOddsMin > 1,
      }));
      const config = {
        bankroll: 1000000,
        perRaceCap: 800,
        kellyFraction: 1,
        betUnit: DEFAULT_BET_ALLOCATION_CONFIG.betUnit,
        greedySteps: DEFAULT_BET_ALLOCATION_CONFIG.greedySteps,
      };
      const expected = allocateBets(allocationHorses, 2, config);

      const jointHorses: JointModelHorse[] = rawHorses.map((h) => ({ umaban: h.umaban, placeProb: h.placeProb }));
      const candidates: AllocationCandidate[] = allocationHorses
        .filter((h) => h.isPositive && h.placeOddsMin !== null)
        .map((h) => ({ umabans: [h.umaban], odds: h.placeOddsMin!, ev: h.ev!, isPositive: true }));
      const actual = allocateGeneralBets(jointHorses, 2, candidates, {
        ...config,
        candidateCap: DEFAULT_CANDIDATE_CAP,
      });

      expect(actual.totalStake).toBe(expected.totalStake);
      expect(actual.kellyTargetStake).toBe(expected.kellyTargetStake);
      expect(actual.plannedStake).toBe(expected.plannedStake);
      expect(actual.capApplied).toBe(expected.capApplied);
      expect(actual.minimumStakeApplied).toBe(expected.minimumStakeApplied);
      expect(actual.exceedsKellyTarget).toBe(expected.exceedsKellyTarget);
      expect(actual.betCount).toBe(expected.betCount);
      expect(actual.isSkip).toBe(expected.isSkip);
      expect(actual.notDiversified).toBe(expected.notDiversified);

      // 各候補のstake/continuousFraction/scaledFractionがtoBeで一致すること(umaban対応)。
      for (const exp of expected.allocations.filter((a) => a.excludedReason === null)) {
        const act = actual.allocations.find((a) => a.umabans[0] === exp.umaban);
        expect(act).toBeDefined();
        expect(act!.stake).toBe(exp.stake);
        expect(act!.continuousFraction).toBe(exp.continuousFraction);
        expect(act!.scaledFraction).toBe(exp.scaledFraction);
      }
    });

    it("見送り6分類それぞれでisSkip/skipReasonの構造(非nullか否か)が一致すること", () => {
      const horses: AllocationHorse[] = [
        { umaban: 1, placeProb: 0.6, placeOddsMin: 3, ev: 1.8, isPositive: true },
      ];
      const jointHorses: JointModelHorse[] = [{ umaban: 1, placeProb: 0.6 }];
      const candidates: AllocationCandidate[] = [{ umabans: [1], odds: 3, ev: 1.8, isPositive: true }];

      const cases: Array<Partial<{ bankroll: number; perRaceCap: number; kellyFraction: number }>> = [
        { bankroll: 0, perRaceCap: 10000 }, // ①
        { bankroll: 10000, perRaceCap: 0 }, // ②
        { bankroll: 10000, perRaceCap: 50 }, // ③
        { bankroll: 10000, perRaceCap: 10000, kellyFraction: 0 }, // ④
      ];
      for (const c of cases) {
        const expected = allocateBets(horses, 1, { ...DEFAULT_BET_ALLOCATION_CONFIG, ...c });
        const actual = allocateGeneralBets(jointHorses, 1, candidates, {
          ...DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
          ...c,
        });
        expect(actual.isSkip).toBe(expected.isSkip);
        expect(actual.isSkip).toBe(true);
      }

      // ⑤候補0頭
      {
        const expected = allocateBets(
          [{ umaban: 1, placeProb: 0.3, placeOddsMin: 2, ev: 0.6, isPositive: false }],
          1,
          { ...DEFAULT_BET_ALLOCATION_CONFIG, bankroll: 10000, perRaceCap: 10000 },
        );
        const actual = allocateGeneralBets(jointHorses, 1, [], {
          ...DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
          bankroll: 10000,
          perRaceCap: 10000,
        });
        expect(actual.isSkip).toBe(expected.isSkip);
        expect(actual.isSkip).toBe(true);
      }

      // ⑥連続最適解ゼロ(妙味が極小)。stubModelで確実に到達させる。
      {
        const tinyModel = stubModel([
          { placed: [], probability: 0.5 },
          { placed: [1], probability: 0.5 },
        ]);
        const tinyHorse: AllocationHorse = {
          umaban: 1,
          placeProb: 0.5,
          placeOddsMin: 1.0000001,
          ev: 1.00000005,
          isPositive: true,
        };
        const expected = allocateBets(
          [tinyHorse],
          1,
          { ...DEFAULT_BET_ALLOCATION_CONFIG, bankroll: 10000, perRaceCap: 10000 },
          tinyModel,
        );
        const tinyCandidate: AllocationCandidate = {
          umabans: [1],
          odds: 1.0000001,
          ev: 1.00000005,
          isPositive: true,
        };
        const actual = allocateGeneralBets(
          jointHorses,
          1,
          [tinyCandidate],
          { ...DEFAULT_GENERAL_BET_ALLOCATION_CONFIG, bankroll: 10000, perRaceCap: 10000 },
          tinyModel,
        );
        expect(expected.skipReason).toBe("妙味が小さく、賭ける価値のある配分が見つかりませんでした");
        expect(actual.isSkip).toBe(expected.isSkip);
        expect(actual.isSkip).toBe(true);
        expect(actual.skipReason).toBe("妙味が小さく、賭ける価値のある配分が見つかりませんでした");
      }
    });
  });

  describe("出力の決定性", () => {
    it("同一入力で複数回呼んでも行の順序・値が安定していること(馬番配列の辞書順)", () => {
      const horses = evenHorses(6, 3);
      const candidates: AllocationCandidate[] = [
        { umabans: [3, 4], odds: 3, ev: 1.8, isPositive: true },
        { umabans: [1, 2], odds: 3, ev: 1.8, isPositive: true },
        { umabans: [2, 5], odds: 3, ev: 1.8, isPositive: true },
      ];
      const config = { ...DEFAULT_GENERAL_BET_ALLOCATION_CONFIG, bankroll: 10000, perRaceCap: 10000 };
      const r1 = allocateGeneralBets(horses, 3, candidates, config);
      const r2 = allocateGeneralBets(horses, 3, candidates, config);
      expect(r1.allocations.map((a) => a.umabans.join(","))).toEqual(
        r2.allocations.map((a) => a.umabans.join(",")),
      );
      // 辞書順: [1,2] < [2,5] < [3,4]
      expect(r1.allocations.map((a) => a.umabans.join(","))).toEqual(["1,2", "2,5", "3,4"]);
    });
  });
});

/** 上限境界テスト用: n=18頭から辞書順に count 件のユニークなワイド候補を作る補助関数。 */
function makeAscendingUniqueCandidates(count: number): AllocationCandidate[] {
  const combos: number[][] = [];
  for (let a = 1; a <= 18 && combos.length < count; a++) {
    for (let b = a + 1; b <= 18 && combos.length < count; b++) {
      combos.push([a, b]);
    }
  }
  return combos.map((c, i) => ({ umabans: c, odds: 3, ev: 2 + i * 0.0001, isPositive: true }));
}
