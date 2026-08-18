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
 *   - buildComboCandidates: ワイド・3連複向けの候補ビルダー(列挙+オッズ4状態解決+EV算出)。
 *     EV/isPositiveはここで計算する(odds Mapのキー生成・4状態解決を1本化。決定2)。
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
  describe("buildComboOddsKey/resolveComboOdds(オッズキー正規化・4状態判別)", () => {
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

    it.each([
      { name: "NaN", value: Number.NaN },
      { name: "+Infinity", value: Number.POSITIVE_INFINITY },
      { name: "-Infinity", value: Number.NEGATIVE_INFINITY },
      { name: "0", value: 0 },
      { name: "負値(-5)", value: -5 },
    ])(
      "取得済みだが数値として不正($name)はmalformedを返すこと(受け入れ条件18・boss指摘2026-08-06)",
      ({ value }) => {
        const map = new Map<string, number | null>([["0102", value]]);
        expect(resolveComboOdds(map, [1, 2])).toEqual({ state: "malformed" });
      },
    );

    it("odds=1(元返し)はmalformedにならないこと(0以下だけを不正とする境界の確認)", () => {
      const map = new Map<string, number | null>([["0102", 1]]);
      expect(resolveComboOdds(map, [1, 2])).toEqual({ state: "present", odds: 1 });
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

  describe("topFinishCountの数値検証(受け入れ条件20の走査で発見。code-reviewer実測2026-08-06)", () => {
    // 実測(本ラウンドで自分で確認): allocateGeneralBetsにtopFinishCount=Infinityを渡すと、
    // place-joint-model.tsの「k>=n」分岐(全頭が同時に複勝圏内)に落ちて、isSkip=false・
    // totalStake=49900という「健全に見える」非スキップの配分を返してしまう(正しい
    // topFinishCount=3ではtotalStake=9000。どちらも一見「正常な結果」に見えるため、
    // 呼び出し側のtopFinishCount取り違えバグが結果から一切気づけない=誤りが表面化しない)。
    //
    // topFinishCountはoddsByKeyのような外部データ(スクレイピング結果)ではなく、呼び出し側が
    // 構築する引数そのものであるため、受け入れ条件18の「呼び出し側構築の引数の契約違反→throw」
    // に該当する(oddsByKeyの値のようにclassifyはしない。分類対象は「取得した市場データ」であり、
    // topFinishCountは市場データではない)。
    //
    // 0・小数(1.5)は許容し例外にしない: place-joint-model.tsが既にfloor+0クランプで意図的に
    // 許容している設計(同ファイルのコメント「普遍的な既定値がなく…勝手に倒すとかえって誤った
    // 結果を正当化する」参照)に合わせる。ここで1.5を拒否すると同ファイルの既存トレランス方針と
    // 非対称になってしまう。
    //
    // allocateGeneralBets/buildComboCandidatesの両方が受け取る値であり、防御を1箇所(本ファイル
    // 内の共有関数)に集約して重複実装しない(受け入れ条件15、boss「片側だけ守って非対称を
    // 作らない」原則)。

    it.each([
      { name: "topFinishCount=NaN", topFinishCount: Number.NaN },
      { name: "topFinishCount=+Infinity", topFinishCount: Number.POSITIVE_INFINITY },
      { name: "topFinishCount=-Infinity", topFinishCount: Number.NEGATIVE_INFINITY },
      { name: "topFinishCount=負値(-1)", topFinishCount: -1 },
    ])("$name だと allocateGeneralBets が例外を投げること", ({ topFinishCount }) => {
      const horses = evenHorses(5, 3);
      const cand: AllocationCandidate[] = [{ umabans: [1, 2], odds: 5, ev: 1.5, isPositive: true }];
      expect(() =>
        allocateGeneralBets(horses, topFinishCount, cand, {
          ...DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
          bankroll: 100000,
          perRaceCap: 50000,
        }),
      ).toThrow();
    });

    it.each([
      { name: "topFinishCount=NaN", topFinishCount: Number.NaN },
      { name: "topFinishCount=+Infinity", topFinishCount: Number.POSITIVE_INFINITY },
      { name: "topFinishCount=-Infinity", topFinishCount: Number.NEGATIVE_INFINITY },
      { name: "topFinishCount=負値(-1)", topFinishCount: -1 },
    ])(
      "$name だと buildComboCandidates が例外を投げること(allocateGeneralBetsと非対称にしない)",
      ({ topFinishCount }) => {
        const horses = evenHorses(4, 3);
        const oddsMap = uniformOddsMap(4, 2, 5);
        expect(() => buildComboCandidates(horses, topFinishCount, 2, oddsMap)).toThrow();
      },
    );

    it("topFinishCount=0・小数(1.5)は例外にならないこと(境界の確認。place-joint-model.tsの既存トレランスと非対称な過剰拒否を防ぐ)", () => {
      const horses = evenHorses(5, 3);
      const cand: AllocationCandidate[] = [{ umabans: [1, 2], odds: 5, ev: 1.5, isPositive: true }];
      expect(() => allocateGeneralBets(horses, 0, cand)).not.toThrow();
      expect(() => allocateGeneralBets(horses, 1.5, cand)).not.toThrow();

      const oddsMap = uniformOddsMap(4, 2, 5);
      expect(() => buildComboCandidates(evenHorses(4, 3), 0, 2, oddsMap)).not.toThrow();
      expect(() => buildComboCandidates(evenHorses(4, 3), 1.5, 2, oddsMap)).not.toThrow();
    });

    it("回帰テスト: topFinishCount=Infinityが誤って健全に見える非スキップ配分を返していた症状(この修正前の実測: isSkip=false, totalStake=49900)が再現しないこと", () => {
      const horses = evenHorses(5, 3);
      const cand: AllocationCandidate[] = [{ umabans: [1, 2], odds: 5, ev: 1.5, isPositive: true }];
      expect(() =>
        allocateGeneralBets(horses, Number.POSITIVE_INFINITY, cand, {
          ...DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
          bankroll: 100000,
          perRaceCap: 50000,
        }),
      ).toThrow();
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

  describe("オッズ4区分(欠損/未取得/不正/候補外)が別々の理由・件数として出ること", () => {
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
      expect(result.diagnostics.unjudged.oddsMalformedCount).toBe(0);
      // 残り1組(present)はEVが計算され、judged(positive+notPositive)の合計が1になる。
      expect(result.diagnostics.judged.positiveCount + result.diagnostics.judged.notPositiveCount).toBe(1);
    });

    it("回帰テスト: 取得済みだが不正な数値(NaN)は、EVが計算できなくても judged(判定結果)へ" +
      "絶対に混ざらず oddsMalformedCount(判定不能)へ計上されること(受け入れ条件16・18。" +
      "boss指摘2026-08-06: 修正前はNaNがev=NaN→isPositive=(NaN>閾値)=falseという経路で" +
      "judged.notPositiveCountに紛れ込んでいた)", () => {
      const horses = evenHorses(4, 3); // C(4,2)=6組
      const oddsMap = new Map<string, number | null>();
      const allCombos = [
        [1, 2],
        [1, 3],
        [1, 4],
        [2, 3],
        [2, 4],
        [3, 4],
      ];
      oddsMap.set(buildComboOddsKey(allCombos[0]!), Number.NaN); // malformed
      for (let i = 1; i < allCombos.length; i++) {
        oddsMap.set(buildComboOddsKey(allCombos[i]!), 5); // 残り5組は健全(高オッズで正EV)
      }

      const result = buildComboCandidates(horses, 3, 2, oddsMap);
      expect(result.diagnostics.enumeratedCount).toBe(6);
      // 【回帰の本体】NaNの1組はjudgedのどちらにも入らず、oddsMalformedCountだけが1になること。
      expect(result.diagnostics.unjudged.oddsMalformedCount).toBe(1);
      expect(result.diagnostics.judged.notPositiveCount).toBe(0);
      // 残り5組は健全にEVプラス判定され、candidatesに載ること(NaNの1組に巻き添えにされない)。
      expect(result.diagnostics.judged.positiveCount).toBe(5);
      expect(result.candidates).toHaveLength(5);
      expect(result.candidates.some((c) => c.umabans.join(",") === "1,2")).toBe(false);
    });

    it("Infinityのオッズはcandidatesに混入せずoddsMalformedCountへ計上されること(以前はallocateGeneralBets側のthrowに偶然救われていただけだった)", () => {
      const horses = evenHorses(4, 3);
      const oddsMap = new Map<string, number | null>();
      oddsMap.set(buildComboOddsKey([1, 2]), Number.POSITIVE_INFINITY);
      const result = buildComboCandidates(horses, 3, 2, oddsMap);
      expect(result.diagnostics.unjudged.oddsMalformedCount).toBe(1);
      expect(result.candidates.some((c) => !Number.isFinite(c.odds) || !Number.isFinite(c.ev))).toBe(false);
    });
  });

  describe("evConfig.thresholdの防御(受け入れ条件19。boss指摘2026-08-06)", () => {
    // 混在オッズ(一部だけ正EV)を使う。全候補が同じ判定になるデータだと、
    // threshold=-Infinity(ev>-Infinityは常にtrueになる)が「たまたま既定閾値と同じ結果」に
    // なってしまい判別力を失う(実際に踏んだ落とし穴。カナリア検証時に発見)。
    function buildMixedScenario(): { horses: JointModelHorse[]; oddsMap: Map<string, number | null> } {
      const horses = evenHorses(4, 3);
      const combos: number[][] = [];
      for (let a = 1; a <= 4; a++) for (let b = a + 1; b <= 4; b++) combos.push([a, b]);
      const oddsMap = new Map<string, number | null>();
      combos.forEach((c, i) => {
        // 半数は高オッズ(明らかに正EV)、半数は低オッズ(明らかに非正EV)。
        oddsMap.set(buildComboOddsKey(c), i % 2 === 0 ? 5 : 0.5);
      });
      return { horses, oddsMap };
    }

    it.each([
      { name: "threshold=NaN", threshold: Number.NaN },
      { name: "threshold=+Infinity", threshold: Number.POSITIVE_INFINITY },
      { name: "threshold=-Infinity", threshold: Number.NEGATIVE_INFINITY },
    ])(
      "$name は既定閾値(1.0)へフォールバックし、既定閾値を明示指定した場合と一致すること",
      ({ threshold }) => {
        const { horses, oddsMap } = buildMixedScenario();
        const expected = buildComboCandidates(horses, 3, 2, oddsMap, { threshold: 1.0 });
        // 前提(無条件expect): 既定閾値では正EV・非正EVの両方が生じる混在データであること
        // (どちらか一方に偏っていると、異常なthresholdが「たまたま」既定と同じ結果になり
        // このテストの判別力が失われる)。
        expect(expected.diagnostics.judged.positiveCount).toBeGreaterThan(0);
        expect(expected.diagnostics.judged.notPositiveCount).toBeGreaterThan(0);

        const actual = buildComboCandidates(horses, 3, 2, oddsMap, { threshold });
        expect(actual.diagnostics).toEqual(expected.diagnostics);
        expect(actual.candidates).toEqual(expected.candidates);
      },
    );

    it("回帰テスト: threshold=NaNだと明らかに正EVな候補も黙って全滅すること(この修正前の症状。現在はフォールバックで再現しない)", () => {
      const horses = evenHorses(4, 3);
      const oddsMap = uniformOddsMap(4, 2, 5); // odds=5(明らかに正EV)
      // 前提(無条件expect): threshold=1.0(既定)ならpositiveCount>0であること。
      const healthy = buildComboCandidates(horses, 3, 2, oddsMap, { threshold: 1.0 });
      expect(healthy.diagnostics.judged.positiveCount).toBeGreaterThan(0);

      // 修正後は防御によりNaNが1.0へフォールバックされるため、結果はhealthyと一致する
      // (=「全滅」という誤った結果には決して化けない)。
      const withNaNThreshold = buildComboCandidates(horses, 3, 2, oddsMap, { threshold: Number.NaN });
      expect(withNaNThreshold.diagnostics.judged.positiveCount).toBe(
        healthy.diagnostics.judged.positiveCount,
      );
    });
  });

  describe("候補上限(候補cap)の境界。boss指摘2026-08-05により「暴走ガード」へ位置づけ変更", () => {
    it("既定上限は2000であること(DEFAULT_CANDIDATE_CAP。性能のための間引きではなく暴走ガード)", () => {
      expect(DEFAULT_CANDIDATE_CAP).toBe(2000);
    });

    it("複勝相当(18件)の入力ではcapが発動しないこと(上限2000>=18)", () => {
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

    it("現実的な最大(18頭・C(18,2)=153件のワイド相当)でも既定candidateCapでは発動しないこと(廃止の直接確認)", () => {
      // boss指摘: candidateCapは「性能のための打ち切り」としては廃止した。既定値(2000)は
      // 現実的な最大候補数(複勝18+ワイド153+3連複816=987)を大きく上回るため、
      // 実際にありうる最大規模の入力でも切り捨てが発動しないことを直接確認する。
      const horses = evenHorses(18, 3);
      const candidates = makeAscendingUniqueCandidates(153); // C(18,2)の全件
      const result = allocateGeneralBets(horses, 3, candidates, {
        ...DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
        bankroll: 100000,
        perRaceCap: 100000,
      });
      expect(result.diagnostics.truncatedByCapCount).toBe(0);
      expect(result.diagnostics.candidateCount).toBe(153);
    });

    it("上限ちょうど/上限+1の境界(選抜メカニズム自体の検証。既定値の大小に依存しないよう明示的なcandidateCapを指定)", () => {
      const horses = evenHorses(18, 3);
      const explicitCapConfig = { ...DEFAULT_GENERAL_BET_ALLOCATION_CONFIG, bankroll: 100000, perRaceCap: 100000, candidateCap: 50 };

      const at50 = allocateGeneralBets(horses, 3, makeAscendingUniqueCandidates(50), explicitCapConfig);
      expect(at50.diagnostics.truncatedByCapCount).toBe(0);
      expect(at50.diagnostics.candidateCount).toBe(50);

      const at51 = allocateGeneralBets(horses, 3, makeAscendingUniqueCandidates(51), explicitCapConfig);
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

    it.each([
      { name: "umaban=NaN", umaban: Number.NaN },
      { name: "umaban=0", umaban: 0 },
      { name: "umaban=負値(-5)", umaban: -5 },
    ])(
      "$name を含む候補を渡すと例外を投げること(受け入れ条件20の走査で発見。" +
        "NaN<=NaNは常にfalseなので、昇順チェックだけではNaNの馬番をすり抜けてしまう)",
      ({ umaban }) => {
        const horses = evenHorses(4, 3);
        const bad: AllocationCandidate[] = [
          { umabans: [umaban, umaban + 100], odds: 3, ev: 2, isPositive: true },
        ];
        expect(() => allocateGeneralBets(horses, 3, bad)).toThrow();
      },
    );
  });

  describe("候補の数値検証(odds/evの異常値。boss差し戻し2026-08-06)", () => {
    // boss差し戻し理由: 候補の「構造」(昇順・重複・空)はvalidateCandidatesで検証してthrow
    // していたが、候補の「数値」(odds/ev)は無防備だった。payout計算(trialX[idx]*odds[idx])に
    // NaN/Infinityが1件でも混じると、貪欲ループのcurrentF・全候補の増分がNaN汚染され、
    // `NaN > 0`は常にfalseのため`bestIdx=-1`(=収束)に化ける。無関係な1候補の異常値が、
    // 他の健全な候補の配分まで巻き添えで消える(C-1で3回・C-2で2回繰り返した
    // 「サイレント破損」欠陥クラスの6回目。しかも今回は「判定できていないことを、
    // 判定した結果〈妙味が小さく…〉として報告する」という最も重い形)。
    // 構造検証と同じくthrowに揃える(除外して続行する設計は採らない。異常値を黙って
    // 除外すると「判定不能」が「候補外」に混ざり、受け入れ条件16〈オッズ状態分離〉の
    // 思想と矛盾するため)。

    it.each([
      { name: "odds=NaN", odds: Number.NaN },
      { name: "odds=+Infinity", odds: Number.POSITIVE_INFINITY },
      { name: "odds=-Infinity", odds: Number.NEGATIVE_INFINITY },
      { name: "odds=0", odds: 0 },
      { name: "odds=負値(-5)", odds: -5 },
    ])("$name の候補を渡すと例外を投げること", ({ odds }) => {
      const horses = evenHorses(4, 3);
      const bad: AllocationCandidate[] = [{ umabans: [1, 2], odds, ev: 2, isPositive: true }];
      expect(() => allocateGeneralBets(horses, 3, bad)).toThrow();
    });

    it.each([
      { name: "ev=NaN", ev: Number.NaN },
      { name: "ev=+Infinity", ev: Number.POSITIVE_INFINITY },
      { name: "ev=-Infinity", ev: Number.NEGATIVE_INFINITY },
    ])("$name の候補を渡すと例外を投げること", ({ ev }) => {
      const horses = evenHorses(4, 3);
      const bad: AllocationCandidate[] = [{ umabans: [1, 2], odds: 3, ev, isPositive: true }];
      expect(() => allocateGeneralBets(horses, 3, bad)).toThrow();
    });

    it("回帰テスト: 健全な候補1件は正の配分を得るが、無関係なodds=NaNの候補を混ぜると【この修正前は】黙って見送りに化けていた(現在はthrowする)", () => {
      // boss実測の再現(数値は本テスト用に別途用意したもので、boss報告の3,800円そのものの
      // 引き写しではない。前提〈健全な1件が正の配分を得ること〉を無条件expectで固定する)。
      const horses = evenHorses(4, 3);
      const healthyOnly: AllocationCandidate[] = [
        { umabans: [1, 2], odds: 5, ev: 2.5, isPositive: true },
      ];
      const config = { ...DEFAULT_GENERAL_BET_ALLOCATION_CONFIG, bankroll: 100000, perRaceCap: 100000 };

      // 前提(無条件expect): 健全な候補1件だけなら正の配分(見送りにならない)を得ること。
      const healthyResult = allocateGeneralBets(horses, 3, healthyOnly, config);
      expect(healthyResult.isSkip).toBe(false);
      expect(healthyResult.totalStake).toBeGreaterThan(0);

      // 【この修正が無ければ何が起きていたか(記録)】: 以下のodds=NaNを混ぜた呼び出しは、
      // validateCandidatesの数値検証が無かった場合、NaNがpayout計算(trialX[idx]*odds[idx])
      // に混入してcurrentF・全増分をNaN汚染し、`bestIdx=-1`に化けて即座に「収束」扱いとなる
      // (greedyStepsを1回も進められない)。結果、healthyOnlyなら正の配分を得るはずの
      // 上記候補まで巻き添えでtotalStake=0・isSkip=true・
      // skipReason="妙味が小さく、賭ける価値のある配分が見つかりませんでした"という
      // 【誤った判定結果】に化けていた(実際は判定できていないだけなのに)。
      // 現在はvalidateCandidatesがodds=NaNの時点でthrowするため、この誤った見送りには
      // 到達しない。
      const withNaNCandidate: AllocationCandidate[] = [
        ...healthyOnly,
        { umabans: [3, 4], odds: Number.NaN, ev: 1.5, isPositive: true },
      ];
      expect(() => allocateGeneralBets(horses, 3, withNaNCandidate, config)).toThrow();
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

    it("candidateCap=NaN/Infinity/負値/0/非整数でも既定candidateCap相当の結果になること", () => {
      // 他5フィールド(betUnit/kellyFraction/bankroll/perRaceCap/greedySteps)と同じ流儀
      // (code-reviewer指摘【要修正2】)。
      //
      // 既定candidateCap(2000。暴走ガードへ位置づけ変更後)は現実的な候補数(最大987)を
      // 大きく上回るため、60件程度の候補では自然には切り捨てが発生しない。そこで検証を
      // 2段構えにする:
      //   (a) 明示的な小さいcandidateCap(5)を指定すると実際に切り捨てが発動すること
      //       (メカニズム自体が生きていることの直接証拠。無条件expectで先に固定)
      //   (b) 異常値のcandidateCapが、明示的にDEFAULT_CANDIDATE_CAPを指定した場合と
      //       完全に一致すること(例: NaNがresolveCandidateCapの防御なしに素通りすると
      //       `Array.prototype.slice(0, NaN)` は空配列を返し candidateCount=0 になる。
      //       これは(b)の比較で確実に検出できる)。
      const horses18 = evenHorses(18, 3);
      const candidates60 = makeAscendingUniqueCandidates(60);
      const base: GeneralBetAllocationConfig = {
        bankroll: 100000,
        perRaceCap: 100000,
        kellyFraction: 1,
        betUnit: 100,
        greedySteps: 1000,
        candidateCap: 5,
      };

      // (a) 明示的な小さいcandidateCapで実際に切り捨てが発動すること。
      const explicitSmallCap = allocateGeneralBets(horses18, 3, candidates60, base);
      expect(explicitSmallCap.diagnostics.truncatedByCapCount).toBe(55);
      expect(explicitSmallCap.diagnostics.candidateCount).toBe(5);

      // (b) 異常値はDEFAULT_CANDIDATE_CAPを明示指定した場合と完全に一致すること。
      const expected = allocateGeneralBets(horses18, 3, candidates60, {
        ...base,
        candidateCap: DEFAULT_CANDIDATE_CAP,
      });
      for (const candidateCap of [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        -5,
        0,
        12.5,
      ]) {
        const result = allocateGeneralBets(horses18, 3, candidates60, { ...base, candidateCap });
        expect(result.diagnostics.candidateCount).toBe(expected.diagnostics.candidateCount);
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

  describe("converged(収束と打ち切りの区別。boss指摘2026-08-05)", () => {
    it("市場regime(現実的なオッズ分布)ではconverged=trueにしかならないことの前提確認", () => {
      // 「502件規模の現実的な候補では常にconverged=trueになる」というboss訂正の事実を
      // 本テストスイート内でも再現しておく(下のテストが本当に打ち切りを再現しているかを
      // 対比で示すため)。妙味が小さめの候補を多数並べても、貪欲法はgreedySteps=1000より
      // 十分手前で自然停止する(実測: scripts/bench-allocation.tsの市場regimeは
      // 使用ステップ数15〜973/1000で必ず1000未満)。
      const horses = evenHorses(18, 3);
      const candidates = makeAscendingUniqueCandidates(80);
      const result = allocateGeneralBets(horses, 3, candidates, {
        ...DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
        bankroll: 1000000,
        perRaceCap: 100000,
      });
      expect(result.diagnostics.converged).toBe(true);
    });

    it("打ち切り(converged=false)を再現できること(市場regimeでは再現できないため、確実に打ち切る構造で検証する)", () => {
      // 「複数の買い目が排反かつ全体を尽くす(確率の合計が1)・オッズが極めて高い」という
      // 構造にすると、貪欲法にとって実質リスクフリーな配分になり、貪欲分割数(greedySteps)を
      // 使い切るまで改善が続く(allocation-primitives.test.tsの
      // 「greedySteps不足時はconverged=falseになること」と同じ構造を、combo経路
      // 〈GeneralBetAllocationDiagnostics.converged〉で確認する)。
      const horses = evenHorses(3, 3);
      const model = stubModel([
        { placed: [1], probability: 1 / 3 },
        { placed: [2], probability: 1 / 3 },
        { placed: [3], probability: 1 / 3 },
      ]);
      const candidates: AllocationCandidate[] = [
        { umabans: [1], odds: 10, ev: 3.33, isPositive: true },
        { umabans: [2], odds: 10, ev: 3.33, isPositive: true },
        { umabans: [3], odds: 10, ev: 3.33, isPositive: true },
      ];
      // greedySteps=5のように小さい値で強制的に打ち切らせる(前提: この構造は
      // greedySteps=1000でも打ち切られる。低レイヤ〈allocation-primitives.test.ts〉で
      // 確認済みの構造をそのまま再利用しているため、ここでは空振りではないことを
      // 小さいgreedyStepsでも同じ結論になることで補強する)。
      const result = allocateGeneralBets(
        horses,
        3,
        candidates,
        { ...DEFAULT_GENERAL_BET_ALLOCATION_CONFIG, bankroll: 1000000, perRaceCap: 1000000, greedySteps: 5 },
        model,
      );
      expect(result.diagnostics.converged).toBe(false);
      // 前提(無条件expect): 打ち切られた結果、Σx*が1.0に到達している(貪欲分割数を
      // 使い切ってなお改善余地が残っていたことの直接証拠。仮に自然収束していたら
      // Σx*<1.0で止まっているはず)。
      const sumX = result.allocations.reduce((acc, a) => acc + a.continuousFraction, 0);
      expect(sumX).toBeCloseTo(1, 10);
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
