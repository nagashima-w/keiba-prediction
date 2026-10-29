import { describe, expect, it } from "vitest";
import { DEFAULT_PRE_RACE_OFFSET_MINUTES } from "../../cloud/src/pre-race-time.js";
import { CLOUD_SETTINGS_RULES, DEFAULT_CLOUD_SETTINGS, SCORING_WEIGHT_FIELDS } from "../../cloud/src/settings.js";
import { BASE_SCORE_WEIGHT_KEYS, BIAS_WEIGHT_KEYS } from "../../packages/core/src/analysis/app-settings.js";
import { DEFAULT_SCORER_CONFIG } from "../../packages/core/src/scorer/config.js";

/**
 * Issue #178(#164-c): クラウド版の設定の既定値を固定する。
 *
 * Issue #287(#285 の段階B)で、比べる相手を変えた。以前は exe の現在の既定値(`packages/app/src/main/settings-store.ts` の
 * `DEFAULT_APP_SETTINGS`。「既定値は exe に揃える」というメインの判断 2026-10-06)と一致することを検査していた。exe を削除したため、
 * **web の既定値を正として、固定値(リテラル)と比べる**(ユーザー決定 2026-10-13)。リテラルは、exe を削除する直前に両者が一致していた値
 * (このファイルが緑だった 3c1664e の `DEFAULT_CLOUD_SETTINGS`)をそのまま写した。既定値を変えるときは、ここも意図して書き換える。
 * 「exe に同名の項目がある」「exe の coerceSettings と採用・不採用が同じ」という、exe との比較そのものは無くなった(下の各テストに、置き換えた形を書く)。
 */

/** 配分・EV・クリップ幅など、以前は exe と同名で共有していた13項目の既定値(固定値)。 */
const EXPECTED_SHARED_DEFAULTS = {
  evThreshold: 1,
  additionalInstruction: "",
  clipVariant: "default",
  bankroll: 0,
  perRaceCap: 0,
  kellyFraction: 0.5,
  includeComboOdds: false,
  includeWideInAllocation: true,
  includeTrioInAllocation: true,
  includeQuinellaInAllocation: true,
  includeExactaInAllocation: true,
  includeTrifectaInAllocation: true,
  includeBracketQuinellaInAllocation: true,
} as const;

/** スコアリングの重み15項目の既定値(固定値。14 番目のタイム指数は Issue #353、15 番目の調教師成績は Issue #354 で足した)。 */
const EXPECTED_WEIGHT_DEFAULTS = {
  biasWeightTrackCondition: 1,
  biasWeightVenue: 1,
  biasWeightSeason: 1,
  biasWeightFrame: 1,
  biasWeightSummerFatigue: 1,
  biasWeightTransport: 1,
  biasWeightRotation: 1,
  baseScoreWeightRecentForm: 0.7,
  baseScoreWeightLast3f: 0.15,
  baseScoreWeightCourseDistance: 0.3,
  baseScoreWeightJockey: 0.15,
  baseScoreWeightWeightChange: 1,
  baseScoreWeightCourseFrameBias: 1,
  baseScoreWeightTimeIndex: 0.12,
  baseScoreWeightTrainer: 0.77,
} as const;

/**
 * cloud 専用の項目(Issue #189 ほか)。exe の設定は PC 上で手動の分析を行うので、「発走何分前に自動評価するか」などを持たなかった。
 * 新しい cloud 専用の項目を足すときは、ここに明示する(足し忘れると、下の「項目集合」の検査が落ちる)。
 */
const CLOUD_ONLY_KEYS = ["analysisModel", "preRaceOffsetMinutes", "minHitProb", "maxWinBetsPerRace", "maxPlaceBetsPerRace"] as const;

/** cloud 専用の項目のうち、既定値を固定値で押さえるもの(Issue #470: 的中確率の下限。ユーザー決定 2026-10-23。Issue #533: 単勝・複勝の点数の上限。ユーザー決定 2026-10-29)。 */
const EXPECTED_CLOUD_ONLY_DEFAULTS = { minHitProb: 0.05, maxWinBetsPerRace: 2, maxPlaceBetsPerRace: 2 } as const;

/** スコアリングの重み15項目(Issue #218。タイム指数は Issue #353、調教師成績は Issue #354)。cloud では平坦な接頭辞つきのキー。対応表は cloud/src/settings.ts の SCORING_WEIGHT_FIELDS。 */
const WEIGHT_FIELDS: readonly string[] = SCORING_WEIGHT_FIELDS.map((f) => f.field);

describe("クラウド版の設定の既定値(固定値との比較)", () => {
  it("cloud の項目 = 共有の13項目 + スコアリングの重み15項目 + cloud 専用の項目(CLOUD_ONLY_KEYS)。共有の13項目は、固定値と既定値が同じ(項目の取りこぼし・意図しない追加もない)", () => {
    const keys = Object.keys(DEFAULT_CLOUD_SETTINGS);
    const sharedKeys = Object.keys(EXPECTED_SHARED_DEFAULTS);
    const sameNamed = keys.filter((k) => !(CLOUD_ONLY_KEYS as readonly string[]).includes(k) && !WEIGHT_FIELDS.includes(k));
    expect(sameNamed.length).toBe(13);
    expect(sharedKeys.length).toBe(13);
    expect(WEIGHT_FIELDS.length).toBe(15);
    expect(keys.length).toBe(sameNamed.length + WEIGHT_FIELDS.length + CLOUD_ONLY_KEYS.length);
    expect([...keys].sort()).toEqual([...sameNamed, ...WEIGHT_FIELDS, ...CLOUD_ONLY_KEYS].sort());
    expect([...sameNamed].sort()).toEqual([...sharedKeys].sort());
    for (const key of sharedKeys) {
      expect((DEFAULT_CLOUD_SETTINGS as unknown as Record<string, unknown>)[key], key).toEqual((EXPECTED_SHARED_DEFAULTS as Record<string, unknown>)[key]);
    }
  });

  it("Issue #470・#533: cloud 専用の minHitProb(的中確率の下限)は 0.05、maxWinBetsPerRace・maxPlaceBetsPerRace(単勝・複勝の点数の上限)は 2 の固定値", () => {
    for (const [key, expected] of Object.entries(EXPECTED_CLOUD_ONLY_DEFAULTS)) {
      expect((DEFAULT_CLOUD_SETTINGS as unknown as Record<string, unknown>)[key], key).toBe(expected);
    }
  });

  it("Issue #218・#353・#354: スコアリングの重み15項目 — 対応表は core のキー(BIAS_WEIGHT_KEYS 7・BASE_SCORE_WEIGHT_KEYS 8)と過不足なく対応し、cloud の既定値は固定値・core の DEFAULT_SCORER_CONFIG のどちらとも、15項目すべて同じ", () => {
    expect(SCORING_WEIGHT_FIELDS.filter((f) => f.group === "bias").map((f) => f.exeKey)).toEqual([...BIAS_WEIGHT_KEYS]);
    expect(SCORING_WEIGHT_FIELDS.filter((f) => f.group === "base").map((f) => f.exeKey)).toEqual([...BASE_SCORE_WEIGHT_KEYS]);
    expect(SCORING_WEIGHT_FIELDS.length).toBe(BIAS_WEIGHT_KEYS.length + BASE_SCORE_WEIGHT_KEYS.length);
    expect(Object.keys(EXPECTED_WEIGHT_DEFAULTS).sort()).toEqual([...WEIGHT_FIELDS].sort());
    for (const f of SCORING_WEIGHT_FIELDS) {
      const core = f.group === "bias" ? (DEFAULT_SCORER_CONFIG.weights as unknown as Record<string, number>) : (DEFAULT_SCORER_CONFIG.baseScore.weights as unknown as Record<string, number>);
      expect(typeof core[f.exeKey], `core に ${f.exeKey} がある`).toBe("number");
      expect(DEFAULT_CLOUD_SETTINGS[f.field], `${f.field} = 固定値`).toBe(EXPECTED_WEIGHT_DEFAULTS[f.field as keyof typeof EXPECTED_WEIGHT_DEFAULTS]);
      expect(DEFAULT_CLOUD_SETTINGS[f.field], `${f.field} = core の ${f.group}.${f.exeKey}`).toBe(core[f.exeKey]);
    }
  });

  it("Issue #218: スコアリングの重みの検証 — 有限で 0 以上の数だけを採用する(以前は exe の coerceSettings との一致で検査していた規則を明示した述語)。cloud の読む側・書く側の述語が、13項目すべてで同じ判定をする", () => {
    const values: readonly unknown[] = [0, 0.05, 1, 3, 100, 1e300, -0.0001, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "1", "", null, undefined, true, [1], {}];
    const adopted = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= 0;
    // 前提: 採用される値と不採用の値の両方がある(空振りでない)
    expect(values.filter(adopted).length).toBeGreaterThan(3);
    expect(values.filter((v) => !adopted(v)).length).toBeGreaterThan(3);
    for (const f of SCORING_WEIGHT_FIELDS) {
      const rule = CLOUD_SETTINGS_RULES[f.field];
      for (const v of values) {
        expect(rule.isReadable(v), `${f.field} 読む側 ${String(v)}`).toBe(adopted(v));
        expect(rule.isWritable(v), `${f.field} 書く側 ${String(v)}`).toBe(adopted(v));
      }
    }
  });

  it("cloud 専用の項目の既定値: analysisModel は 'auto'、preRaceOffsetMinutes は pre-race-time.ts の定数(45)", () => {
    expect(DEFAULT_CLOUD_SETTINGS.analysisModel).toBe("auto");
    expect(DEFAULT_CLOUD_SETTINGS.preRaceOffsetMinutes).toBe(DEFAULT_PRE_RACE_OFFSET_MINUTES);
    expect(DEFAULT_PRE_RACE_OFFSET_MINUTES).toBe(45);
  });

  it("配分・取得に関わる項目(bankroll・perRaceCap・kellyFraction・includeComboOdds・各 include・evThreshold・clipVariant・additionalInstruction)の13項目は、すべて cloud にある", () => {
    const relevant = [
      "bankroll",
      "perRaceCap",
      "kellyFraction",
      "includeComboOdds",
      "includeWideInAllocation",
      "includeTrioInAllocation",
      "includeQuinellaInAllocation",
      "includeExactaInAllocation",
      "includeTrifectaInAllocation",
      "includeBracketQuinellaInAllocation",
      "evThreshold",
      "clipVariant",
      "additionalInstruction",
    ];
    expect(relevant.length).toBe(13);
    for (const key of relevant) {
      expect(key in DEFAULT_CLOUD_SETTINGS, `cloud に ${key} がある`).toBe(true);
    }
  });
});
