/**
 * mixed-allocation-cache — 混在配分の表示データをレース単位でメモ化する
 * (機能D-2c第4段・Issue #28・AC21)。
 *
 * ## 主リスクはキー漏れ(遅さではない。boss指摘)
 *
 * 1レースあたりの所要時間は無視できない大きさで、`BatchAnalysisView.tsx` は render 内 IIFE で
 * 毎レンダー全レース分を評価するため、details の開閉・Discord送信状態の変化などあらゆる
 * 再レンダーで再計算が走ると複数レースで体感の重さになる(性能上の理由)。
 *
 * **具体的なミリ秒数はこのJSDocには書かない**(code-reviewer指摘2026-08-13: 「1レースあたり
 * 約93ms・12レースで約1.1秒/レンダー」という記述に対しリポジトリ内に再現手段が無かった。
 * `performance.now()`/`Date.now()`の計測コードが0件で、実行環境が変われば数値も変わる)。
 * **再現可能な計測: `pnpm tsx scripts/bench-mixed-allocation.ts`**(ネットワークに出ない。
 * `mixed-allocation-view.ts`の「greedySteps が構成比を左右する事実」と同じスクリプトが
 * 1レースあたりの所要時間も出力する)。
 *
 * **しかし性能そのものより危険なのは、キャッシュキーに含める入力を1つでも
 * 漏らすと「設定を変えたのに前回の金額が表示され続ける」という静かな誤りが起きること**。
 * 遅さはユーザーが気づけるが、古い金額の表示はユーザーが気づけない。
 *
 * ## キャッシュキーに含める入力の全数列挙表(次にこのキャッシュへ入力を追加する人は、
 * この表に1行追加すること。`combo-bet-allocation.ts`の「数値防御カバレッジ表」と同じ流儀)
 *
 * | 入力 | 変わると再計算しなければならない理由 |
 * |---|---|
 * | `raceId` | キャッシュエントリの所在(レース単位のスロット)そのもの |
 * | `race`(`AnalysisResult`への参照) | `rows`/`wideCombo`/`trioCombo`/`comboOdds`/`oddsStatus`等、レース内容全体を代表する。再分析すると新しいオブジェクト参照になる(不変データフロー)ため、参照比較だけで内容変化を検知できる |
 * | `bankroll` | `allocateGeneralBets`の入力そのもの |
 * | `perRaceCap` | 同上 |
 * | `kellyFraction` | 同上 |
 * | `evThreshold` | `buildComboCandidates`へ渡す`evConfig`(D-4)。ワイド・三連複の候補選定に直結 |
 * | `includeComboOdds` | D-2フォールバック規則の条件①に直結(ONOFFで混在経路に入るか自体が変わる) |
 * | `includeWideInAllocation` | D-1の`betTypes`組み立てに直結 |
 * | `includeTrioInAllocation` | 同上 |
 *
 * 上記9項目のいずれか1つでも比較から漏れると、その項目だけを変えた操作でキャッシュが
 * 誤ってヒットし続ける(`mixed-allocation-cache.test.ts`のテーブル駆動テストが、
 * 1項目ずつ変えたときに必ずミスすることを固定している)。
 */

/** キャッシュキー(表の9項目をそのまま構造体にしたもの)。 */
export interface MixedAllocationCacheKey {
  readonly raceId: string;
  /** `AnalysisResult`への参照。内容比較ではなく参照(`===`)で同一性を判定する。 */
  readonly race: object;
  readonly bankroll: number;
  readonly perRaceCap: number;
  readonly kellyFraction: number;
  readonly evThreshold: number;
  readonly includeComboOdds: boolean;
  readonly includeWideInAllocation: boolean;
  readonly includeTrioInAllocation: boolean;
}

/** レース単位でメモ化するキャッシュ(値の型`T`は呼び出し側が決める。表示データを想定)。 */
export interface MixedAllocationCache<T> {
  /**
   * `key.raceId`のスロットを引き、キー全項目が前回と一致すればキャッシュ済みの値を返す
   * (`compute`は呼ばない)。1項目でも異なれば`compute()`を呼び、結果を新しいキーとともに
   * 保存してから返す。
   */
  get(key: MixedAllocationCacheKey, compute: () => T): T;
}

/** キー9項目すべてが一致するかを判定する(表の全項目を漏れなく比較する唯一の場所)。 */
function cacheKeyEquals(a: MixedAllocationCacheKey, b: MixedAllocationCacheKey): boolean {
  return (
    a.raceId === b.raceId &&
    a.race === b.race &&
    a.bankroll === b.bankroll &&
    a.perRaceCap === b.perRaceCap &&
    a.kellyFraction === b.kellyFraction &&
    a.evThreshold === b.evThreshold &&
    a.includeComboOdds === b.includeComboOdds &&
    a.includeWideInAllocation === b.includeWideInAllocation &&
    a.includeTrioInAllocation === b.includeTrioInAllocation
  );
}

/**
 * 混在配分の表示データキャッシュを新規作成する。`BatchAnalysisView.tsx`が`useRef`で
 * インスタンスをコンポーネントの生存期間中保持し、レース単位のメモ化に使う想定
 * (本モジュール自体はReactに依存しない純粋なデータ構造)。
 */
export function createMixedAllocationCache<T>(): MixedAllocationCache<T> {
  const store = new Map<string, { readonly key: MixedAllocationCacheKey; readonly value: T }>();
  return {
    get(key, compute) {
      const cached = store.get(key.raceId);
      if (cached !== undefined && cacheKeyEquals(cached.key, key)) {
        return cached.value;
      }
      const value = compute();
      store.set(key.raceId, { key, value });
      return value;
    },
  };
}
