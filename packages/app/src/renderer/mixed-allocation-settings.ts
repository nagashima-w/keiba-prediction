/**
 * mixed-allocation-settings — `getSettings`の結果(`AppSettings`のマスク済み版)から、混在配分の
 * 設定(`MixedAllocationSettings`)を作る純関数(Issue #150・#26-E3b・AC-5(b))。
 *
 * ## 切り出した理由
 * `App.tsx`は配分の設定11項目を`setBetAllocationSettings({...})`へ1項目ずつ手書きで写していた。
 * この写しは、レンダリングテスト基盤が無く`App`が`window.keibaApi`を要するためテストできず、
 * `includeBracketQuinellaInAllocation`(や三連単)を`true`固定に書き換える変異が全緑のまま生存していた
 * (三連単から続く穴。#149のレビューからの申し送り)。本関数へ切り出せば、写し方をテーブル駆動テスト
 * (`mixed-allocation-settings.test.ts`)で全項目固定でき、`App.tsx`がこれを呼んでいること自体は
 * 1行のソース走査で固定できる。
 *
 * ## 契約
 * 戻り値の型が`MixedAllocationSettings`のため、項目を1つ書き忘れるとコンパイルエラーになる
 * (`MixedAllocationSettings`に項目が増えたときの写し漏れが型で検出される)。入力に配分と無関係な項目
 * (APIキー・Discordの設定等)が含まれていても、戻り値へは持ち込まない(キャッシュキーや
 * Web Workerへ渡す値に機微な値が混ざらないようにするため。項目を名指しで写す)。
 */

import type { MixedAllocationSettings } from "../shared/mixed-race-allocation.js";

/**
 * 配分の設定11項目を名指しで写す(スプレッドで全項目を持ち込まない)。
 *
 * @param s `getSettings()`の結果など、`MixedAllocationSettings`の11項目を(少なくとも)持つ値
 */
export function mixedAllocationSettingsFromAppSettings(s: MixedAllocationSettings): MixedAllocationSettings {
  return {
    bankroll: s.bankroll,
    perRaceCap: s.perRaceCap,
    kellyFraction: s.kellyFraction,
    evThreshold: s.evThreshold,
    includeComboOdds: s.includeComboOdds,
    includeWideInAllocation: s.includeWideInAllocation,
    includeTrioInAllocation: s.includeTrioInAllocation,
    includeQuinellaInAllocation: s.includeQuinellaInAllocation,
    includeExactaInAllocation: s.includeExactaInAllocation,
    includeTrifectaInAllocation: s.includeTrifectaInAllocation,
    includeBracketQuinellaInAllocation: s.includeBracketQuinellaInAllocation,
  };
}
