/**
 * テスト用(Issue #597): 補完の列挙・件数のテストは、分析と結果の行を生の INSERT で入れる。本番では書き込みの経路が batch の最後に状態の作り直しを流すが、
 * 生の INSERT は流さないので、列挙・件数を呼ぶ前に整合検査(全レースの状態の作り直し)を流して、入れた行を `race_backfill` に反映する。
 */
import { D1ResultStore } from "../src/result-repository";

export function withState(store: D1ResultStore): D1ResultStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value === "function" && typeof prop === "string" && /^(list|count)/.test(prop)) {
        return async (...args: unknown[]) => {
          await target.reconcileBackfillState();
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
