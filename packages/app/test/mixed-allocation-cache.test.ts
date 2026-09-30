import { describe, expect, it, vi } from "vitest";

import {
  cacheKeyEquals,
  createMixedAllocationCache,
  toMixedAllocationCacheKey,
  type MixedAllocationCacheKey,
} from "../src/renderer/mixed-allocation-cache.js";
import type { MixedAllocationSettings } from "../src/shared/mixed-race-allocation.js";

// `race`はキャッシュキーの中で唯一「参照(===)」で比較されるフィールドのため、既定値は
// 1つの安定したオブジェクト参照を使い回す(key()を呼ぶたびに新しいリテラルを作ると、
// 「同じレースのつもり」でも参照が毎回変わり、ヒットするはずのテストが誤ってミスと
// 判定されてしまう。この不具合を自己テストで実際に検知したため、この形にした)。
const DEFAULT_RACE_REF: object = { marker: "race-A" };

/** テスト用のキャッシュキーを組み立てる補助関数(既定は混在配分の典型的な設定値)。 */
function key(overrides: Partial<MixedAllocationCacheKey> = {}): MixedAllocationCacheKey {
  return {
    raceId: "202601010101",
    race: DEFAULT_RACE_REF,
    bankroll: 300000,
    perRaceCap: 20000,
    kellyFraction: 0.5,
    evThreshold: 1.0,
    includeComboOdds: true,
    includeWideInAllocation: true,
    includeTrioInAllocation: true,
    includeQuinellaInAllocation: true,
    includeExactaInAllocation: true,
    includeTrifectaInAllocation: true,
    includeBracketQuinellaInAllocation: true,
    ...overrides,
  };
}

describe("テストヘルパー自己テスト", () => {
  it("key(): overridesで個別のフィールドを上書きでき、既定値は互いに異なる値を持つこと(取り違え検知の前提)", () => {
    const k = key();
    // 前提固定: raceIdとbankroll/perRaceCap/kellyFraction/evThresholdが混同されない値であること。
    const numericFields = [k.bankroll, k.perRaceCap, k.kellyFraction, k.evThreshold];
    expect(new Set(numericFields).size).toBe(4);
    expect(key({ raceId: "999" }).raceId).toBe("999");
    expect(key({ bankroll: 1 }).bankroll).toBe(1);
  });
});

describe("createMixedAllocationCache(混在配分の表示データキャッシュ。AC21)", () => {
  it("同一キーで2回getすると、computeは1回しか呼ばれずキャッシュ済みの値を返すこと(ヒット)", () => {
    const cache = createMixedAllocationCache<string>();
    const compute = vi.fn(() => "computed-value");
    const first = cache.get(key(), compute);
    const second = cache.get(key(), compute);
    expect(first).toBe("computed-value");
    expect(second).toBe("computed-value");
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("異なるraceId(別レース)は独立したスロットとして扱われ、互いに干渉しないこと", () => {
    const cache = createMixedAllocationCache<string>();
    const computeA = vi.fn(() => "value-A");
    const computeB = vi.fn(() => "value-B");
    expect(cache.get(key({ raceId: "race-A" }), computeA)).toBe("value-A");
    expect(cache.get(key({ raceId: "race-B" }), computeB)).toBe("value-B");
    // race-Aを再度引いても、race-Bの計算に巻き込まれずcompute-Aの結果のままであること。
    expect(cache.get(key({ raceId: "race-A" }), computeA)).toBe("value-A");
    expect(computeA).toHaveBeenCalledTimes(1);
    expect(computeB).toHaveBeenCalledTimes(1);
  });

  // AC21強化(#24-D3a・Issue #115でincludeQuinellaInAllocationを追加し10項目化、
  // #24-E3a・Issue #124でincludeExactaInAllocationを追加し11項目化、
  // #25-E3a・Issue #138でincludeTrifectaInAllocationを追加し12項目化、
  // #26-E3a・Issue #149でincludeBracketQuinellaInAllocationを追加し13項目化): キャッシュキーの
  // 13項目を1つずつ変えたとき、必ずキャッシュがミスする(compute()が再度呼ばれる)ことを
  // テーブル駆動で固定する。1項目でも比較から漏れると、
  // 「設定を変えたのに前回の金額が表示され続ける」静かな誤りになる。
  const baseKey = key();
  const mutationCases: { name: string; mutate: (k: MixedAllocationCacheKey) => MixedAllocationCacheKey }[] = [
    { name: "raceId", mutate: (k) => ({ ...k, raceId: "202601010102" }) },
    { name: "race(参照)", mutate: (k) => ({ ...k, race: { marker: "race-B" } }) },
    { name: "bankroll", mutate: (k) => ({ ...k, bankroll: k.bankroll + 1 }) },
    { name: "perRaceCap", mutate: (k) => ({ ...k, perRaceCap: k.perRaceCap + 1 }) },
    { name: "kellyFraction", mutate: (k) => ({ ...k, kellyFraction: k.kellyFraction + 0.01 }) },
    { name: "evThreshold", mutate: (k) => ({ ...k, evThreshold: k.evThreshold + 0.1 }) },
    { name: "includeComboOdds", mutate: (k) => ({ ...k, includeComboOdds: !k.includeComboOdds }) },
    { name: "includeWideInAllocation", mutate: (k) => ({ ...k, includeWideInAllocation: !k.includeWideInAllocation }) },
    { name: "includeTrioInAllocation", mutate: (k) => ({ ...k, includeTrioInAllocation: !k.includeTrioInAllocation }) },
    { name: "includeQuinellaInAllocation", mutate: (k) => ({ ...k, includeQuinellaInAllocation: !k.includeQuinellaInAllocation }) },
    { name: "includeExactaInAllocation", mutate: (k) => ({ ...k, includeExactaInAllocation: !k.includeExactaInAllocation }) },
    { name: "includeTrifectaInAllocation", mutate: (k) => ({ ...k, includeTrifectaInAllocation: !k.includeTrifectaInAllocation }) },
    { name: "includeBracketQuinellaInAllocation", mutate: (k) => ({ ...k, includeBracketQuinellaInAllocation: !k.includeBracketQuinellaInAllocation }) },
  ];

  it.each(mutationCases)(
    "$name だけを変えるとキャッシュがミスし、computeが再度呼ばれること(渡し忘れ検知)",
    ({ mutate }) => {
      const cache = createMixedAllocationCache<number>();
      const compute = vi.fn();
      let callCount = 0;
      compute.mockImplementation(() => {
        callCount += 1;
        return callCount;
      });
      const first = cache.get(baseKey, compute);
      const mutatedKey = mutate(baseKey);
      // 前提固定: 実際に値が変わっていること(mutateが正しく差分を作れていることの検算)。
      expect(mutatedKey).not.toEqual(baseKey);
      const second = cache.get(mutatedKey, compute);
      expect(compute).toHaveBeenCalledTimes(2);
      expect(second).not.toBe(first);
    },
  );

  it("13項目すべてが一致すれば(新しいオブジェクトのkeyでも)ヒットすること(項目過剰検知にならないことの確認)", () => {
    const cache = createMixedAllocationCache<string>();
    const compute = vi.fn(() => "value");
    cache.get(key(), compute);
    // 全く同じ内容だが新規に組み立てたkeyオブジェクト(参照は異なる)。
    cache.get(key(), compute);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("同一raceIdのまま設定を変え、その後また元の設定に戻すと再度ミスする(古い方の結果を誤って使い回さない。1エントリしか保持しない設計の確認)", () => {
    const cache = createMixedAllocationCache<number>();
    const compute = vi.fn();
    let callCount = 0;
    compute.mockImplementation(() => {
      callCount += 1;
      return callCount;
    });
    const keyA = key({ bankroll: 100000 });
    const keyB = key({ bankroll: 200000 });
    expect(cache.get(keyA, compute)).toBe(1);
    expect(cache.get(keyB, compute)).toBe(2);
    // keyAへ戻すと、直前のキャッシュはkeyBのものになっているため再度ミスする。
    expect(cache.get(keyA, compute)).toBe(3);
    expect(compute).toHaveBeenCalledTimes(3);
  });
});

// Issue #110(#24-C2): 配分計算を1レースずつ進める仕組み(mixed-allocation-queue.ts)は、
// 「計算せずに今の値だけを覗く」経路が必要なため`peek`を追加する。
// `peek`は表示の読み出し経路そのもの(AC-3'(a)の要)なので、`get`と同じ13項目
// (#24-D3a・Issue #115でincludeQuinellaInAllocationを追加、#24-E3a・Issue #124で
// includeExactaInAllocationを追加、#25-E3a・Issue #138でincludeTrifectaInAllocationを追加、
// #26-E3a・Issue #149でincludeBracketQuinellaInAllocationを追加)
// の厳しさで独立にテーブル駆動
// テストを固定する(既存の`get`用テーブル・アサーションは1件も変更しない。
// 上のdescribeブロックとは別の新規テーブルとして持つ)。
describe("createMixedAllocationCache().peek(値を計算せずに照会する。Issue #110)", () => {
  it("computeを呼んだことが無いキーはundefinedを返すこと(副作用なし=computeを一切呼ばない)", () => {
    const cache = createMixedAllocationCache<string>();
    expect(cache.peek(key())).toBeUndefined();
  });

  it("getで一度値を計算した後、同じキーでpeekするとcomputeを呼ばずにその値を返すこと", () => {
    const cache = createMixedAllocationCache<string>();
    const compute = vi.fn(() => "computed-value");
    cache.get(key(), compute);
    const peeked = cache.peek(key());
    expect(peeked).toBe("computed-value");
    // 前提固定: peek自体はcomputeを再度呼ばない(呼び出し回数がgetの1回のままであること)。
    expect(compute).toHaveBeenCalledTimes(1);
  });

  // AC-3'(a)相当: キー13項目を1つずつ変えたとき、peekは必ずミス(undefined)すること。
  // 「設定を変えたのに古い金額がpeekでヒットし続ける」ことをこのテーブルで塞ぐ。
  const peekBaseKey = key();
  const peekMutationCases: { name: string; mutate: (k: MixedAllocationCacheKey) => MixedAllocationCacheKey }[] = [
    { name: "raceId", mutate: (k) => ({ ...k, raceId: "202601010102" }) },
    { name: "race(参照)", mutate: (k) => ({ ...k, race: { marker: "race-B" } }) },
    { name: "bankroll", mutate: (k) => ({ ...k, bankroll: k.bankroll + 1 }) },
    { name: "perRaceCap", mutate: (k) => ({ ...k, perRaceCap: k.perRaceCap + 1 }) },
    { name: "kellyFraction", mutate: (k) => ({ ...k, kellyFraction: k.kellyFraction + 0.01 }) },
    { name: "evThreshold", mutate: (k) => ({ ...k, evThreshold: k.evThreshold + 0.1 }) },
    { name: "includeComboOdds", mutate: (k) => ({ ...k, includeComboOdds: !k.includeComboOdds }) },
    { name: "includeWideInAllocation", mutate: (k) => ({ ...k, includeWideInAllocation: !k.includeWideInAllocation }) },
    { name: "includeTrioInAllocation", mutate: (k) => ({ ...k, includeTrioInAllocation: !k.includeTrioInAllocation }) },
    { name: "includeQuinellaInAllocation", mutate: (k) => ({ ...k, includeQuinellaInAllocation: !k.includeQuinellaInAllocation }) },
    { name: "includeExactaInAllocation", mutate: (k) => ({ ...k, includeExactaInAllocation: !k.includeExactaInAllocation }) },
    { name: "includeTrifectaInAllocation", mutate: (k) => ({ ...k, includeTrifectaInAllocation: !k.includeTrifectaInAllocation }) },
    { name: "includeBracketQuinellaInAllocation", mutate: (k) => ({ ...k, includeBracketQuinellaInAllocation: !k.includeBracketQuinellaInAllocation }) },
  ];

  it.each(peekMutationCases)(
    "$name だけを変えたキーでpeekすると undefined になること(古い値を返さない)",
    ({ mutate }) => {
      const cache = createMixedAllocationCache<string>();
      cache.get(peekBaseKey, () => "base-value");
      const mutatedKey = mutate(peekBaseKey);
      // 前提固定: 実際に値が変わっていること。
      expect(mutatedKey).not.toEqual(peekBaseKey);
      expect(cache.peek(mutatedKey)).toBeUndefined();
      // 前提固定: 変更前のキーではまだヒットすること(peek自体が壊れて常にmissするのではないことの確認)。
      expect(cache.peek(peekBaseKey)).toBe("base-value");
    },
  );

  it("AC-3'(a): 計算済みの値がある状態で設定を変えると、そのキーでのpeekは古い金額を返さずundefinedになること", () => {
    const cache = createMixedAllocationCache<string>();
    const oldKey = key({ bankroll: 100000 });
    cache.get(oldKey, () => "computed-with-bankroll-100000");
    // 前提固定: 変更前は計算済みの値がpeekできること。
    expect(cache.peek(oldKey)).toBe("computed-with-bankroll-100000");
    const newKey = key({ bankroll: 200000 });
    expect(cache.peek(newKey)).toBeUndefined();
  });
});

// Issue #119(#24-C3): 配分計算のWorkerプール化で「送信時のキー」と「完了時点の最新キー」を
// 比較し、不一致なら結果を破棄する(古い結果が新しい設定の値を上書きしない)ために、
// `get`/`peek`が使っているのと同じ等価判定を再利用する。**新しい経路が独自のキー定義・
// 独自の比較関数を持たない**(このファイル冒頭JSDoc「この表はキー材料の唯一の定義」)ため、
// 再実装せずexportして使う。
describe("cacheKeyEquals(get/peekと同じキー等価判定をexportして再利用可能にする。Issue #119)", () => {
  it("13項目すべてが一致すれば true を返すこと(新しく組み立てたオブジェクトでも)", () => {
    expect(cacheKeyEquals(key(), key())).toBe(true);
  });

  // get/peek用のテーブル(mutationCases・peekMutationCases)とは意図的に独立させる
  // (このファイルの既存の流儀: 「既存のテーブル・アサーションは1件も変更しない」
  // 「別のdescribeブロックとは別の新規テーブルとして持つ」に倣う)。
  const cacheKeyEqualsMutationCases: { name: string; mutate: (k: MixedAllocationCacheKey) => MixedAllocationCacheKey }[] = [
    { name: "raceId", mutate: (k) => ({ ...k, raceId: "202601010102" }) },
    { name: "race(参照)", mutate: (k) => ({ ...k, race: { marker: "race-B" } }) },
    { name: "bankroll", mutate: (k) => ({ ...k, bankroll: k.bankroll + 1 }) },
    { name: "perRaceCap", mutate: (k) => ({ ...k, perRaceCap: k.perRaceCap + 1 }) },
    { name: "kellyFraction", mutate: (k) => ({ ...k, kellyFraction: k.kellyFraction + 0.01 }) },
    { name: "evThreshold", mutate: (k) => ({ ...k, evThreshold: k.evThreshold + 0.1 }) },
    { name: "includeComboOdds", mutate: (k) => ({ ...k, includeComboOdds: !k.includeComboOdds }) },
    { name: "includeWideInAllocation", mutate: (k) => ({ ...k, includeWideInAllocation: !k.includeWideInAllocation }) },
    { name: "includeTrioInAllocation", mutate: (k) => ({ ...k, includeTrioInAllocation: !k.includeTrioInAllocation }) },
    { name: "includeQuinellaInAllocation", mutate: (k) => ({ ...k, includeQuinellaInAllocation: !k.includeQuinellaInAllocation }) },
    { name: "includeExactaInAllocation", mutate: (k) => ({ ...k, includeExactaInAllocation: !k.includeExactaInAllocation }) },
    { name: "includeTrifectaInAllocation", mutate: (k) => ({ ...k, includeTrifectaInAllocation: !k.includeTrifectaInAllocation }) },
    { name: "includeBracketQuinellaInAllocation", mutate: (k) => ({ ...k, includeBracketQuinellaInAllocation: !k.includeBracketQuinellaInAllocation }) },
  ];

  it.each(cacheKeyEqualsMutationCases)(
    "$name だけが異なれば false を返すこと(get/peekのミス判定と同じ基準であることの確認)",
    ({ mutate }) => {
      const base = key();
      const mutated = mutate(base);
      // 前提固定: 実際に値が変わっていること。
      expect(mutated).not.toEqual(base);
      expect(cacheKeyEquals(base, mutated)).toBe(false);
    },
  );
});

// ============================================================================
// toMixedAllocationCacheKey(Issue #150・AC-5(b)): 設定→キャッシュキーの組み立て
// ============================================================================
// 旧`BatchAnalysisView.tsx`は設定11項目を1つずつ手書きでキーへ写していたため、1項目を`true`固定に
// 書き換えても(設定を切り替えても古い配分がキャッシュから出続けるだけで)テストが全緑のまま通る
// 変異が生存していた(三連単から続く穴)。設定を丸ごと展開する本関数へ切り出し、項目ごとの値の
// 取り違え・固定を、ここで全項目について検知する(11項目のうち1つでも固定・脱落すれば赤)。

/** 11項目すべてが互いに区別できる値を持つ設定(数値4項目は相異なる値、boolean7項目は全てtrue)。 */
function allSettings(overrides: Partial<MixedAllocationSettings> = {}): MixedAllocationSettings {
  return {
    bankroll: 300000,
    perRaceCap: 20000,
    kellyFraction: 0.5,
    evThreshold: 1.0,
    includeComboOdds: true,
    includeWideInAllocation: true,
    includeTrioInAllocation: true,
    includeQuinellaInAllocation: true,
    includeExactaInAllocation: true,
    includeTrifectaInAllocation: true,
    includeBracketQuinellaInAllocation: true,
    ...overrides,
  };
}

/** 各項目を「元と異なる値」に変えた設定(項目名→変更後)。boolean=反転、number=別の値。 */
function changedSettings(field: keyof MixedAllocationSettings): MixedAllocationSettings {
  const base = allSettings();
  const value = base[field];
  return { ...base, [field]: typeof value === "boolean" ? !value : value + 12345 };
}

describe("toMixedAllocationCacheKey(設定→キャッシュキー。Issue #150・AC-5(b))", () => {
  const race = { marker: "race-B" };

  it("raceIdとraceの参照(===)をそのまま持ち、設定の全項目を値どおりキーへ写すこと", () => {
    const settings = allSettings({
      bankroll: 111111,
      perRaceCap: 22222,
      kellyFraction: 0.33,
      evThreshold: 1.25,
      includeComboOdds: false,
      includeWideInAllocation: false,
      includeTrioInAllocation: true,
      includeQuinellaInAllocation: false,
      includeExactaInAllocation: true,
      includeTrifectaInAllocation: false,
      includeBracketQuinellaInAllocation: false,
    });
    const k = toMixedAllocationCacheKey("202601010202", race, settings);
    expect(k.raceId).toBe("202601010202");
    expect(k.race).toBe(race);
    // 期待値はリテラルで固定する(実装と同じ写し方の再実装にしない)。
    expect({ ...k, race: undefined }).toEqual({
      raceId: "202601010202",
      race: undefined,
      bankroll: 111111,
      perRaceCap: 22222,
      kellyFraction: 0.33,
      evThreshold: 1.25,
      includeComboOdds: false,
      includeWideInAllocation: false,
      includeTrioInAllocation: true,
      includeQuinellaInAllocation: false,
      includeExactaInAllocation: true,
      includeTrifectaInAllocation: false,
      includeBracketQuinellaInAllocation: false,
    });
  });

  it("前提固定(空振り防止): 設定の項目数が11で、cacheKeyEqualsが比較する項目(raceId・raceを除く)と同じ集合であること", () => {
    const settingsKeys = Object.keys(allSettings()).sort();
    expect(settingsKeys).toHaveLength(11);
    const cacheKeyOnly = Object.keys(key())
      .filter((k) => k !== "raceId" && k !== "race")
      .sort();
    expect(cacheKeyOnly).toEqual(settingsKeys);
  });

  it.each(Object.keys(allSettings()) as (keyof MixedAllocationSettings)[])(
    "設定項目%sを変えると別のキーになり、キャッシュが再計算されること(同じ設定なら再利用される。値の固定・脱落を検知する)",
    (field) => {
      const cache = createMixedAllocationCache<string>();
      const compute = vi.fn(() => "v");
      const base = toMixedAllocationCacheKey("R1", race, allSettings());
      const same = toMixedAllocationCacheKey("R1", race, allSettings());
      const changed = toMixedAllocationCacheKey("R1", race, changedSettings(field));
      // 前提固定: 変更後の設定は本当にこの項目だけが異なる。
      expect(changedSettings(field)[field]).not.toBe(allSettings()[field]);

      cache.get(base, compute);
      cache.get(same, compute);
      expect(compute).toHaveBeenCalledTimes(1); // 同じ設定なら再利用(ヒット)
      expect(cacheKeyEquals(base, same)).toBe(true);
      expect(cacheKeyEquals(base, changed)).toBe(false);
      cache.get(changed, compute);
      expect(compute).toHaveBeenCalledTimes(2); // 設定を切り替えたら再計算(ミス)
    },
  );
});
