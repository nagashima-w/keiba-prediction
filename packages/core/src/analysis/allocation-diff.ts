/**
 * allocation-diff — 配分(買い目の一覧)の差分(Issue #338〈#335-A1〉)。分析時の提案と、締切の直前に再計算した提案を比べる。
 *
 * 買い目の同一性は (券種, 組合せキー)。**賭け金が違うものだけ**を「変化」とし、オッズ・期待値だけが動いて賭け金が同じものは「変化なし」に数える
 * (買う内容が変わらないため)。変化した買い目には、前後のオッズ・期待値を添える(表示用)。出力は券種・キーの昇順(決定的)。
 * 純関数。入力は書き換えない。
 */

/** 差分に使う買い目の最小の形(`AnalysisBetRecord` が満たす)。 */
export interface DiffBet {
  readonly betType: string;
  readonly comboKey: string;
  readonly stake: number;
  readonly odds: number | null;
  readonly ev: number | null;
}

/** 賭け金が変わった買い目。 */
export interface ChangedBet {
  readonly betType: string;
  readonly comboKey: string;
  readonly beforeStake: number;
  readonly afterStake: number;
  readonly beforeOdds: number | null;
  readonly afterOdds: number | null;
  readonly beforeEv: number | null;
  readonly afterEv: number | null;
}

export interface AllocationDiff {
  /** 後にだけある買い目。 */
  readonly added: readonly DiffBet[];
  /** 前にだけある買い目。 */
  readonly removed: readonly DiffBet[];
  /** 両方にあり、賭け金が違う買い目。 */
  readonly changed: readonly ChangedBet[];
  /** 両方にあり、賭け金が同じ買い目の数。 */
  readonly unchanged: number;
  /** 追加・削除・変化のどれかがあるか。 */
  readonly hasChange: boolean;
  readonly totalStakeBefore: number;
  readonly totalStakeAfter: number;
}

const keyOf = (b: { readonly betType: string; readonly comboKey: string }): string => `${b.betType}\u0000${b.comboKey}`;

function compareBets(a: { readonly betType: string; readonly comboKey: string }, b: { readonly betType: string; readonly comboKey: string }): number {
  return a.betType < b.betType ? -1 : a.betType > b.betType ? 1 : a.comboKey < b.comboKey ? -1 : a.comboKey > b.comboKey ? 1 : 0;
}

export function diffAllocationBets(before: readonly DiffBet[], after: readonly DiffBet[]): AllocationDiff {
  const beforeByKey = new Map(before.map((b) => [keyOf(b), b]));
  const afterByKey = new Map(after.map((b) => [keyOf(b), b]));
  const added: DiffBet[] = [];
  const removed: DiffBet[] = [];
  const changed: ChangedBet[] = [];
  let unchanged = 0;
  for (const [key, a] of afterByKey) {
    const b = beforeByKey.get(key);
    if (b === undefined) {
      added.push(a);
    } else if (b.stake !== a.stake) {
      changed.push({
        betType: a.betType,
        comboKey: a.comboKey,
        beforeStake: b.stake,
        afterStake: a.stake,
        beforeOdds: b.odds,
        afterOdds: a.odds,
        beforeEv: b.ev,
        afterEv: a.ev,
      });
    } else {
      unchanged += 1;
    }
  }
  for (const [key, b] of beforeByKey) {
    if (!afterByKey.has(key)) {
      removed.push(b);
    }
  }
  added.sort(compareBets);
  removed.sort(compareBets);
  changed.sort(compareBets);
  const total = (bets: readonly DiffBet[]): number => bets.reduce((sum, b) => sum + b.stake, 0);
  return {
    added,
    removed,
    changed,
    unchanged,
    hasChange: added.length + removed.length + changed.length > 0,
    totalStakeBefore: total(before),
    totalStakeAfter: total(after),
  };
}
