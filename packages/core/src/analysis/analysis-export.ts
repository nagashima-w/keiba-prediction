/**
 * レース情報スナップショット(R2 に保存する分析時点のレース情報。GitHub Issue#10)。
 *
 * `buildRaceSnapshot`(取得したレースデータ → 保存用のスナップショット)と
 * `toSafeRaceSnapshot`(保存済みの unknown 値 → 防御的に復元)を持つ純関数群。IO に一切依存しない。
 * `toSafeRaceSnapshot` は、クラウド版の `cloud/src/analysis-view.ts`・`cloud/src/race-day-core.ts` が直接使う。
 * `buildRaceSnapshot` は `runAnalysis`(`analysis-pipeline.ts`)が使う。
 *
 * ファイル名は、旧 exe の分析エクスポート(JSON・CSV の書き出し。Issue #393 で削除)の名残。import 元が多いため改名していない。
 *
 * 防御的復元(旧レコード・破損データ):
 * 保存済みのスナップショットは、列追加前の旧レコードでは null、JSON破損時も保存側で null にフォールバック済み。
 * `toSafeRaceSnapshot` は「null」「スキーマに一致しないunknown値」のいずれでも例外を投げず、
 * 欠損した項目を null にフォールバックする。
 */

import type { ComboOddsScrapeOutcome, RaceData } from "../pipeline.js";
import type { DayBaba } from "../analyzer/day-baba.js";
import { computeEarlyPosition } from "../analyzer/early-position.js";
import { computeLatePosition } from "../analyzer/late-position.js";
import type { LegStyle } from "../analyzer/leg-style.js";
import { computeReplayLegStyle } from "../analyzer/replay-leg-style.js";

/** レース情報スナップショットの「レース」部分(Issue#10)。 */
export interface RaceSnapshotRace {
  readonly raceName: string | null;
  readonly courseType: string | null;
  readonly distance: number | null;
  readonly weather: string | null;
  readonly trackCondition: string | null;
  readonly startTime: string | null;
  readonly fence: string | null;
  readonly oddsStatus: string | null;
  readonly officialDatetime: string | null;
  /**
   * グレード(Issue #250。"G1"〜"G3"・"J・G1"〜"J・G3"・地方の "Jpn1" や "重賞" など。出馬表の `grade` の写し)。
   * **値があるときだけキーを持つ任意項目**: グレードの無いレース・グレードを保存する前に作った過去のスナップショットはキー自体が無い。
   */
  readonly grade?: string;
}

/** レース情報スナップショットの「馬」部分(Issue#10)。過去戦績は含めない。 */
export interface RaceSnapshotHorse {
  readonly umaban: number;
  readonly wakuban: number | null;
  readonly name: string | null;
  readonly sex: string | null;
  readonly age: number | null;
  readonly kinryo: number | null;
  readonly jockeyName: string | null;
  readonly trainerName: string | null;
  readonly bodyWeight: number | null;
  readonly winOdds: number | null;
  readonly popularity: number | null;
  readonly placeOddsMin: number | null;
  /**
   * 複勝オッズの上限(Issue #253。`race.odds.place[umaban].oddsMax`)。分析時点の実際の複勝オッズを「下限〜上限」の幅で見せるために保存する。
   * **任意項目**: このキーを保存する前に作った過去のスナップショットは持たない(読み出し〈`toSafeRaceSnapshot`〉では null になる)。
   * 未確定・取れない馬・複勝が未発売(発売前の予想)は null。
   */
  readonly placeOddsMax?: number | null;
  /**
   * スタート直後の位置(Issue #311。想定隊列図〈#362〉の道中の並びに使う)。近走の第1コーナーの通過順位 ÷ 出走頭数の平均(0〜1。小さいほど前。`computeEarlyPosition`)。
   * 戦績が無い・通過順位や頭数が取れない馬は null。**任意項目**: このキーを保存する前に作った過去のスナップショットは持たない(読み出し〈`toSafeRaceSnapshot`〉では null になる)。
   */
  readonly earlyPos?: number | null;
  /**
   * 終盤の位置(Issue #363。想定隊列図〈#362〉の4コーナーの位置に使う)。近走の最終コーナー(`passing` の最後の要素。通過点が 2 つ以上ある走だけ)の通過順位 ÷ 出走頭数の平均(0〜1。小さいほど前。`computeLatePosition`)。
   * 戦績が無い・通過順位や頭数が取れない馬は null。**任意項目**: このキーを保存する前に作った過去のスナップショットは持たない(読み出し〈`toSafeRaceSnapshot`〉では null になる)。
   */
  readonly latePos?: number | null;
  /**
   * 脚質(Issue #314。想定隊列図〈#362〉の位置を決める材料)。プロンプトの展開想定と同じ分類・同じ参照走数(`computeReplayLegStyle`)。
   * 戦績が無い・通過順位が取れない馬は null。**任意項目**: このキーを保存する前に作った過去のスナップショットは持たない(読み出し〈`toSafeRaceSnapshot`〉では null になる)。
   */
  readonly legStyle?: LegStyle | null;
  readonly oikiriCritic: string | null;
  readonly oikiriRank: string | null;
}

/** 取得したレース情報のスナップショット(analyses.race_snapshot_jsonに保存する形)。 */
export interface RaceSnapshot {
  readonly race: RaceSnapshotRace;
  readonly horses: readonly RaceSnapshotHorse[];
  /**
   * ワイドオッズ(機能D-2c・Issue #28)。`scrapeRace`の`options.includeComboOdds`が
   * trueのときのみ設定される(既定undefined。core `OddsSnapshot.wideCombo`のプレーン写し)。
   *
   * **この値自体は「JSON永続化用のスナップショット」であり、馬券配分の計算には使われない**
   * (この記述は今も正しい)。第4段(Issue #28)で券種横断の配分が実際に使うのは、
   * このスナップショットではなく**別の生きた経路**(`AnalysisResult.wideCombo` →
   * `analysis/mixed-race-allocation.ts` の `buildMixedRaceAllocation`。Issue #57で
   * `renderer/mixed-allocation-view.ts` から分離した。DB保存を経ずに分析結果からその場で
   * 計算する)である。混同を避けるための補足: この`RaceSnapshot.wideCombo`はエクスポート・
   * DB保存専用の写しにすぎず、配分計算の入力としては一切参照されない。
   * **さらなる追記予定(#56-3)**: main が実際にこの経路を配線したら、「DB保存を経ずに
   * 分析結果からその場で計算する」という記述は main 起点の呼び出しが生まれた分だけ
   * 古くなる可能性があるため、#56-3 着手時にこの段落を再確認・再更新すること。
   */
  readonly wideCombo?: Record<string, number | null>;
  /** 三連複オッズ(機能D-2c第3段)。`wideCombo`と同じ条件・同じ理由でoptional。 */
  readonly trioCombo?: Record<string, number | null>;
  /**
   * 馬連オッズ(Issue #116・#24-D3b-1)。`wideCombo`と同じ条件・同じ理由でoptional。
   * 配分・画面への配線はまだ無い(このスナップショットに保持するだけ)。
   */
  readonly quinellaCombo?: Record<string, number | null>;
  /**
   * 馬単オッズ(Issue #122・#24-E2)。`wideCombo`と同じ条件・同じ理由でoptional。
   * キーは順序付き(1着・2着の順序が意味を持つ)。配分・画面への配線はまだ無い
   * (このスナップショットに保持するだけ。#123のスコープ)。
   */
  readonly exactaCombo?: Record<string, number | null>;
  /**
   * 三連単オッズ(Issue #137・#25-E2)。`wideCombo`と同じ条件・同じ理由でoptional。
   * キーは順序付き(1着・2着・3着の順序が意味を持つ。馬単`exactaCombo`と同じ性質)。
   *
   * 地方(NAR)も取得する(Issue #283・ユーザー判断2026-10-13。旧: 地方では常に`undefined`)。
   * このスナップショット自体は保持・エクスポート専用の写しであり、
   * 配分計算の入力としては一切参照されない(このファイル冒頭JSDocの`wideCombo`と同じ設計。
   * 実際の配分接続〈Issue #139・#25-E3b〉は`AnalysisResult.trifectaCombo`
   * 〈`analysis/analysis-types.ts`〉側で完結している)。
   *
   * **サイズについての注記(2026-09-27実測。`docs/current-spec.md`参照)**: 出走頭数nに対し
   * P(n,3)通りのキーを持ち(16頭なら3360キー・18頭なら4896キー)、`wideCombo`/`trioCombo`/
   * `quinellaCombo`/`exactaCombo`より1桁多い。`analyses.race_snapshot_json`(SQLite TEXT列)
   * へそのまま保存されるため、`includeComboOdds:true`の分析を保存するたびにこのぶんだけ
   * DBサイズが増える(圧縮・保存方針の見直しは#53の範疇。本フィールド追加自体を妨げない)。
   */
  readonly trifectaCombo?: Record<string, number | null>;
  /**
   * 枠連オッズ(Issue #148・#26-E2)。`wideCombo`と同じ条件・同じ理由でoptional。
   * キーは**枠番**の組(2桁ゼロ埋め連結・昇順・同枠可。例"0407"・"0101")で、馬番ではない。
   * 三連単と異なり中央・地方とも取得する。#148の時点では配分・画面への配線は無く(このスナップショットに
   * 保持するだけだった)、設定の配管は#149で完了し、Issue #150(#26-E3b)で配分への接続・画面への
   * 表示が完了した。枠番4桁キーは最大でも36件規模なので、三連単のような
   * DBサイズの懸念はない。
   */
  readonly bracketQuinellaCombo?: Record<string, number | null>;
  /**
   * 組合せオッズの取得診断値(機能D-2c第3段。馬連はIssue #116・#24-D3b-1、馬単はIssue #122・
   * #24-E2、三連単はIssue #137・#25-E2、枠連はIssue #148・#26-E2で追加)。`wideCombo`/
   * `trioCombo`/`quinellaCombo`/`exactaCombo`/`trifectaCombo`/`bracketQuinellaCombo`が空({})に
   * なった原因(発売なし/未発売なのか、取得失敗
   * なのか)を判別する唯一の手段(`comboOdds.<betType>.state`)。core
   * `RaceDataMeta.comboOdds`のプレーン写し。
   */
  readonly comboOdds?: ComboOddsScrapeOutcome;
  /**
   * 発走前の分析の LLM に渡した当日の馬場の値(Issue #295。コース種別で絞った後の値)。**値があるときだけキーを持つ任意項目**:
   * 地方・LLM を使わない分析・値が無い日・Issue #295 より前のスナップショットはキー自体が無い。キーがある ⇔ LLM がその節を見た。
   * `buildRaceSnapshot` は付けない(取得した RaceData には無い。`runAnalysis` が LLM に渡した値を足す)。
   */
  readonly baba?: DayBaba;
}

/**
 * scrapeRace が返した RaceData から、保存用のレース情報スナップショットを組み立てる。
 * 過去戦績(horseData.results)は意図的に含めない(サイズ大。承認済みスコープ外)。
 * @param race スクレイピング直後のレースデータ
 */
export function buildRaceSnapshot(race: RaceData): RaceSnapshot {
  return {
    race: {
      raceName: race.race.raceName,
      courseType: race.race.courseType,
      distance: race.race.distance,
      weather: race.race.weather ?? null,
      trackCondition: race.race.trackCondition ?? null,
      startTime: race.race.startTime ?? null,
      fence: race.race.fence ?? null,
      oddsStatus: race.odds.oddsStatus,
      officialDatetime: race.odds.officialDatetime,
      ...(race.race.grade !== undefined ? { grade: race.race.grade } : {}),
    },
    horses: race.horses.map((h) => {
      const umaban = h.shutuba.umaban;
      return {
        umaban,
        wakuban: h.shutuba.wakuban,
        name: h.shutuba.name,
        sex: h.shutuba.sex,
        age: h.shutuba.age,
        kinryo: h.shutuba.kinryo,
        jockeyName: h.shutuba.jockeyName,
        trainerName: h.shutuba.trainerName,
        bodyWeight: h.shutuba.bodyWeight?.weight ?? null,
        winOdds: race.odds.win[umaban]?.odds ?? null,
        popularity: race.odds.win[umaban]?.ninki ?? null,
        placeOddsMin: race.odds.place[umaban]?.oddsMin ?? null,
        placeOddsMax: race.odds.place[umaban]?.oddsMax ?? null,
        earlyPos: computeEarlyPosition(h.results),
        latePos: computeLatePosition(h.results),
        legStyle: computeReplayLegStyle(h.results),
        oikiriCritic: h.oikiri?.critic ?? null,
        oikiriRank: h.oikiri?.rank ?? null,
      };
    }),
    // 組合せオッズ(ワイド・三連複・馬連・馬単・三連単・枠連、機能D-2c第3段・Issue #28。
    // 馬連はIssue #116・#24-D3b-1、馬単はIssue #122・#24-E2、三連単はIssue #137・#25-E2、
    // 枠連はIssue #148・#26-E2で追加): race.odds.wideCombo/trioCombo/quinellaCombo/exactaCombo/
    // trifectaCombo/bracketQuinellaCombo・
    // race.meta.comboOdds はいずれも scrapeRace の
    // options.includeComboOdds が true のときだけ設定される optional フィールド。
    // ここでは「写すだけ」で新たな解釈・変換は行わない(analysis-pipeline.ts の
    // AnalysisResult 組み立て〈同じ写し方〉と同じ流儀。条件付きspreadで、未設定
    // 〈undefined〉のときはキー自体を持たせない)。
    ...(race.odds.wideCombo !== undefined ? { wideCombo: race.odds.wideCombo } : {}),
    ...(race.odds.trioCombo !== undefined ? { trioCombo: race.odds.trioCombo } : {}),
    ...(race.odds.quinellaCombo !== undefined ? { quinellaCombo: race.odds.quinellaCombo } : {}),
    ...(race.odds.exactaCombo !== undefined ? { exactaCombo: race.odds.exactaCombo } : {}),
    ...(race.odds.trifectaCombo !== undefined ? { trifectaCombo: race.odds.trifectaCombo } : {}),
    ...(race.odds.bracketQuinellaCombo !== undefined
      ? { bracketQuinellaCombo: race.odds.bracketQuinellaCombo }
      : {}),
    ...(race.meta.comboOdds !== undefined ? { comboOdds: race.meta.comboOdds } : {}),
  };
}

/** buildRaceSnapshot が組み立てた RaceSnapshotRace の既定値(スナップショット欠損・不正時)。 */
const EMPTY_SNAPSHOT_RACE: RaceSnapshotRace = {
  raceName: null,
  courseType: null,
  distance: null,
  weather: null,
  trackCondition: null,
  startTime: null,
  fence: null,
  oddsStatus: null,
  officialDatetime: null,
};

/**
 * StoredAnalysis.raceSnapshot(unknown。JSON復元済みだが型未検証)を安全に RaceSnapshot として
 * 解釈する。null・オブジェクトでない・想定した形と異なる場合は例外を投げず、
 * 「レース情報スナップショット全体が無い」ものとして扱う(防御的復元)。
 * horses は配列であれば要素ごとに umaban→馬情報のMapとして使えるようにする(不正な要素はスキップ)。
 *
 * Issue #183(#165-a)で export した(クラウド版の `GET /api/analyses/{id}` が、馬名・レース名を読むのに使う。関数の中身は無変更)。
 * **値の型までは検証しない**(`name` が文字列とは限らない)ので、呼び出し側が必要な型へ絞ること。
 */
export function toSafeRaceSnapshot(raw: unknown): {
  readonly race: RaceSnapshotRace;
  readonly horsesByUmaban: ReadonlyMap<number, RaceSnapshotHorse>;
} {
  if (typeof raw !== "object" || raw === null) {
    return { race: EMPTY_SNAPSHOT_RACE, horsesByUmaban: new Map() };
  }
  const obj = raw as Record<string, unknown>;
  const raceRaw = obj.race;
  const race: RaceSnapshotRace =
    typeof raceRaw === "object" && raceRaw !== null
      ? { ...EMPTY_SNAPSHOT_RACE, ...(raceRaw as Partial<RaceSnapshotRace>) }
      : EMPTY_SNAPSHOT_RACE;

  const horsesByUmaban = new Map<number, RaceSnapshotHorse>();
  const horsesRaw = obj.horses;
  if (Array.isArray(horsesRaw)) {
    for (const h of horsesRaw as unknown[]) {
      if (typeof h !== "object" || h === null) {
        continue;
      }
      const horse = h as Partial<RaceSnapshotHorse>;
      if (typeof horse.umaban !== "number") {
        continue;
      }
      horsesByUmaban.set(horse.umaban, {
        umaban: horse.umaban,
        wakuban: horse.wakuban ?? null,
        name: horse.name ?? null,
        sex: horse.sex ?? null,
        age: horse.age ?? null,
        kinryo: horse.kinryo ?? null,
        jockeyName: horse.jockeyName ?? null,
        trainerName: horse.trainerName ?? null,
        bodyWeight: horse.bodyWeight ?? null,
        winOdds: horse.winOdds ?? null,
        popularity: horse.popularity ?? null,
        placeOddsMin: horse.placeOddsMin ?? null,
        placeOddsMax: horse.placeOddsMax ?? null,
        earlyPos: horse.earlyPos ?? null,
        latePos: horse.latePos ?? null,
        legStyle: horse.legStyle ?? null,
        oikiriCritic: horse.oikiriCritic ?? null,
        oikiriRank: horse.oikiriRank ?? null,
      });
    }
  }
  return { race, horsesByUmaban };
}

