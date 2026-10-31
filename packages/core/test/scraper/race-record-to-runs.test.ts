import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HORSE_RUN_FIELD_SLOTS,
  HORSE_RUN_SLOT_COUNT,
  decodeHorseRun,
  encodeHorseRun,
  horseRunKey,
} from "../../src/scraper/horse-run-record.js";
import { parseHorseResults } from "../../src/scraper/parse-horse-results.js";
import {
  buildRaceRecord,
  RACE_RECORD_PARSER_VERSION,
  type Kind,
  type RaceRecord,
  type RecordHorse,
} from "../../src/scraper/race-record.js";
import { RESULT_RUN_VERSION, raceRecordToRuns } from "../../src/scraper/race-record-to-runs.js";
import type { HorseRaceResult } from "../../src/scraper/types.js";

/**
 * Issue #553(#549-B2): 過去の結果ページのレコード(RaceRecord)を、戦績 API の 1 走(HorseRaceResult。26 スロット)にする変換。
 *
 * 実例(戦績 API と同じ馬・同じレースがフィクスチャにある 3 件)は、スロットごとに API の値と一致することを確かめる。
 * 実例の無い分岐(中央の 1 着・同着・降着・失格など)は合成のレコードで確かめる。テスト名に「実例なし(合成)」と書く。
 * **netkeiba への取得はしていない**(#549 のコメント参照。コンテナからの取得が HTTP 400 で止められたため)。
 */

const FIXTURE_DIR = new URL("../../../../fixtures/", import.meta.url);
const read = (name: string): string => readFileSync(fileURLToPath(new URL(name, FIXTURE_DIR)), "utf-8");

function record(file: string, raceId: string, kind: Kind): RaceRecord {
  const built = buildRaceRecord(read(file), raceId, kind);
  if (!built.ok) {
    throw new Error(`フィクスチャ ${file} を読めません: ${built.category} ${built.detail}`);
  }
  return built.record;
}

function apiRun(file: string, raceId: string): HorseRaceResult {
  const found = parseHorseResults(read(file)).find((r) => r.raceIdRaw === raceId);
  if (found === undefined) {
    throw new Error(`戦績 ${file} に ${raceId} の行がありません`);
  }
  return found;
}

function convertOk(rec: RaceRecord) {
  const out = raceRecordToRuns(rec);
  if (!out.ok) {
    throw new Error(`変換を拒否されました: ${out.reason}`);
  }
  return out;
}

function runOf(rec: RaceRecord, horseId: string): HorseRaceResult {
  const found = convertOk(rec).runs.find((r) => r.horseId === horseId);
  if (found === undefined) {
    throw new Error(`馬 ${horseId} の行が出ませんでした`);
  }
  return found.run;
}

/** 実例の 3 件。`knownDiff` は API と一致しない既知のスロット(意図した差。下のテストで値を明示する)。 */
const SLOT_JOCKEY_NAME = HORSE_RUN_FIELD_SLOTS.jockeyName;
const SLOT_PASSING = HORSE_RUN_FIELD_SLOTS.passing;
interface RealCase {
  readonly label: string;
  readonly file: string;
  readonly raceId: string;
  readonly kind: Kind;
  readonly apiFile: string;
  readonly horseId: string;
  readonly knownDiff: readonly number[];
}
const REAL_CASES: readonly RealCase[] = [
  {
    label: "中央・7 着(1 勝クラス。ダ 1700 稍重。ペースあり)",
    file: "result_202602010607.html",
    raceId: "202602010607",
    kind: "central",
    apiFile: "horse_results_2021105857.json",
    horseId: "2021105857",
    knownDiff: [SLOT_JOCKEY_NAME],
  },
  {
    label: "中央・10 着(G3。馬体重の減り・見習でない)",
    file: "result_202603020211.html",
    raceId: "202603020211",
    kind: "central",
    apiFile: "horse_results_2023103386.json",
    horseId: "2023103386",
    knownDiff: [SLOT_JOCKEY_NAME],
  },
  {
    label: "地方・1 着(着差が負・勝ち馬名が括弧つき。通過順は結果ページに無い)",
    file: "nar_result_202654071201.html",
    raceId: "202654071201",
    kind: "nar",
    apiFile: "horse_results_2021104387.json",
    horseId: "2021104387",
    knownDiff: [SLOT_JOCKEY_NAME, SLOT_PASSING],
  },
];

describe("実例: 戦績 API と同じ馬・同じレース(結果ページ → 26 スロット)", () => {
  for (const c of REAL_CASES) {
    describe(c.label, () => {
      const rec = record(c.file, c.raceId, c.kind);
      const api = apiRun(c.apiFile, c.raceId);
      const mine = runOf(rec, c.horseId);
      const apiTuple = encodeHorseRun(api);
      const myTuple = encodeHorseRun(mine);

      it("前提: 26 スロットで、API の行は一致を確かめるスロットの大半が null でない(空振りにしない)", () => {
        expect(myTuple).toHaveLength(HORSE_RUN_SLOT_COUNT);
        const compared = (Object.values(HORSE_RUN_FIELD_SLOTS) as Array<number | null>).filter((s): s is number => s !== null && !c.knownDiff.includes(s));
        const nonNull = compared.filter((s) => apiTuple[s] !== null);
        // 地方はペースが null なので 1 つ減る。それでも 20 以上のスロットが値を持つ。
        expect(nonNull.length).toBeGreaterThanOrEqual(20);
      });

      for (const [field, slot] of Object.entries(HORSE_RUN_FIELD_SLOTS)) {
        if (slot === null || c.knownDiff.includes(slot)) {
          continue;
        }
        it(`スロット ${slot}(${field}): API と一致する`, () => {
          expect(myTuple[slot]).toEqual(apiTuple[slot]);
        });
      }

      it("騎手名(スロット 13)は null。API はフルネームを持つ(同じスロットに略称を入れて意味を混ぜない)", () => {
        expect(apiTuple[SLOT_JOCKEY_NAME]).not.toBeNull();
        expect(myTuple[SLOT_JOCKEY_NAME]).toBeNull();
        expect(mine.jockeyId).toBe(api.jockeyId); // ID は一致する(スロット 14)
      });

      it("往復: encodeHorseRun → decodeHorseRun で元の 1 走に戻る", () => {
        expect(decodeHorseRun(JSON.parse(JSON.stringify(myTuple)))).toEqual(mine);
      });
    });
  }

  it("地方の通過順(スロット 21)は結果ページに列が無いので空配列。API は 4 コーナー分を持つ(意図した差)", () => {
    const rec = record("nar_result_202654071201.html", "202654071201", "nar");
    const api = apiRun("horse_results_2021104387.json", "202654071201");
    expect(api.passing.length).toBeGreaterThan(0);
    expect(runOf(rec, "2021104387").passing).toEqual([]);
  });

  it("除外の馬(マイネルユンフェン。API 側の着順は「除」)は行を作らない。残りの馬の頭数は API の頭数と一致する", () => {
    const rec = record("result_202605040205.html", "202605040205", "central");
    const api = apiRun("horse_results_2024103584.json", "202605040205");
    expect(api.finishPosition).toEqual({ kind: "非数値", text: "除" }); // 前提: 実例の API は除外の行
    expect(rec.horses.some((h) => h.horseId === "2024103584" && h.finishStatus === "除外")).toBe(true);
    const out = convertOk(rec);
    expect(out.skippedNonStart).toBe(1);
    expect(out.runs.some((r) => r.horseId === "2024103584")).toBe(false);
    expect(out.runs).toHaveLength(rec.horses.length - 1);
    for (const r of out.runs) {
      expect(r.run.entryCount).toBe(api.entryCount); // 11。ページの宣言(12)ではない
    }
    expect(rec.fieldSizeDeclared).toBe(12);
  });
});

describe("鍵と版", () => {
  it("raceKey は horseRunKey(run) = race_id で、全行に付く", () => {
    const rec = record("result_202602010607.html", "202602010607", "central");
    const out = convertOk(rec);
    expect(out.runs).toHaveLength(10);
    for (const r of out.runs) {
      expect(r.raceKey).toBe("202602010607");
      expect(horseRunKey(r.run)).toBe(r.raceKey);
    }
  });

  it("版の組を固定する: レコードの読み取りの版(2)と変換の版(1)。どちらかを上げたら、このテストを意識して直す", () => {
    expect([RACE_RECORD_PARSER_VERSION, RESULT_RUN_VERSION]).toEqual([2, 1]);
  });
});

/** 合成用: 実ページ(中央 10 頭)のレコードに、馬を差し替えて使う。 */
const BASE = record("result_202602010607.html", "202602010607", "central");

function horse(over: Partial<RecordHorse> & { umaban: number }): RecordHorse {
  const base = BASE.horses[0]!;
  return {
    ...base,
    wakuban: over.umaban,
    finish: null,
    finishStatus: null,
    finishDemoted: false,
    finishRaw: "",
    horseId: `H${over.umaban}`,
    horseName: `馬${over.umaban}`,
    timeRaw: null,
    timeSec: null,
    ...over,
  };
}

function withHorses(horses: RecordHorse[], over: Partial<RaceRecord> = {}): RaceRecord {
  return { ...BASE, fieldSizeDeclared: horses.length, horses, ...over };
}

const place = (umaban: number, finish: number, timeRaw: string, over: Partial<RecordHorse> = {}): RecordHorse =>
  horse({ umaban, finish, finishRaw: String(finish), timeRaw, ...over });

describe("実例なし(合成): 着差・勝ち馬名・頭数", () => {
  const field = [
    place(1, 1, "1:34.5"),
    place(2, 2, "1:34.7"),
    place(3, 3, "1:35.4"),
    horse({ umaban: 4, finish: null, finishStatus: "中止", finishRaw: "中止" }),
  ];

  it("非 1 着: 着差は勝ち馬との時計差(0.1 秒単位)、勝ち馬名は 1 着馬の名前(括弧なし)", () => {
    const run3 = runOf(withHorses(field), "H3");
    expect(run3.margin).toBe(0.9);
    expect(run3.winnerName).toBe("馬1");
    const run2 = runOf(withHorses(field), "H2");
    expect(run2.margin).toBe(0.2);
  });

  it("1 着: 着差は 2 着との時計差で負、勝ち馬名は 2 着馬の名前を括弧で包む(API の国内 1 着 17 行の形)", () => {
    const run1 = runOf(withHorses(field), "H1");
    expect(run1.margin).toBe(-0.2);
    expect(run1.winnerName).toBe("(馬2)");
  });

  it("1 着で 2 着と同タイム: 着差は 0(API の 1 着の行にも 0 がある)。-0 にならない", () => {
    const tie = [place(1, 1, "1:34.5"), place(2, 2, "1:34.5")];
    const m = runOf(withHorses(tie), "H1").margin;
    expect(Object.is(m, 0)).toBe(true);
  });

  it("1 着で 2 着の馬がいない(1 頭だけ): 着差と勝ち馬名は null", () => {
    const solo = [place(1, 1, "1:34.5")];
    const r = runOf(withHorses(solo), "H1");
    expect(r.margin).toBeNull();
    expect(r.winnerName).toBeNull();
  });

  it("中止の馬: 時計が無いので着差は null。勝ち馬名は 1 着馬、着順は先頭 1 文字「中」。頭数には数える", () => {
    const r = runOf(withHorses(field), "H4");
    expect(r.margin).toBeNull();
    expect(r.winnerName).toBe("馬1");
    expect(r.finishPosition).toEqual({ kind: "非数値", text: "中" });
    expect(r.entryCount).toBe(4);
  });

  it("1 着馬の時計が読めない(null): 非 1 着の着差は null。勝ち馬名は出る", () => {
    const broken = [place(1, 1, ""), place(2, 2, "1:34.7")];
    const r = runOf(withHorses(broken), "H2");
    expect(r.margin).toBeNull();
    expect(r.winnerName).toBe("馬1");
  });

  it("1 着がいない(全頭が非数値): 勝ち馬名・着差は null", () => {
    const none = [horse({ umaban: 1, finishStatus: "中止", finishRaw: "中止" }), horse({ umaban: 2, finishStatus: "中止", finishRaw: "中止" })];
    const r = runOf(withHorses(none), "H1");
    expect(r.winnerName).toBeNull();
    expect(r.margin).toBeNull();
  });

  it("同着 1 着(未確認): 非 1 着の勝ち馬は行順で先に出る 1 着馬。1 着どうしの着差は 2 着(finish=2)が無いので null", () => {
    const dead = [place(1, 1, "1:34.5"), place(2, 1, "1:34.5"), place(3, 3, "1:35.0")];
    const rec = withHorses(dead);
    expect(runOf(rec, "H3").winnerName).toBe("馬1");
    expect(runOf(rec, "H3").margin).toBe(0.5);
    expect(runOf(rec, "H1").margin).toBeNull();
    expect(runOf(rec, "H1").winnerName).toBeNull();
  });

  it("分を含む時計(1:34.5)と秒だけの時計(59.8)が混ざらない: 59.8 と 1:00.5 の差は 0.7", () => {
    const short = [place(1, 1, "59.8"), place(2, 2, "1:00.5")];
    expect(runOf(withHorses(short), "H2").margin).toBe(0.7);
  });
});

describe("実例なし(合成): 除外・取消・失格・降着", () => {
  it("除外・取消は行を作らず、頭数からも除く。件数を skippedNonStart で返す", () => {
    const horses = [
      place(1, 1, "1:34.5"),
      place(2, 2, "1:34.7"),
      horse({ umaban: 3, finishStatus: "除外", finishRaw: "除外" }),
      horse({ umaban: 4, finishStatus: "取消", finishRaw: "取消" }),
    ];
    const out = convertOk(withHorses(horses));
    expect(out.skippedNonStart).toBe(2);
    expect(out.runs.map((r) => r.horseId)).toEqual(["H1", "H2"]);
    expect(out.runs.every((r) => r.run.entryCount === 2)).toBe(true);
  });

  it("実ページの取消(result_202606040901。16 頭中 1 頭): 15 行で、頭数は 15", () => {
    const rec = record("result_202606040901.html", "202606040901", "central");
    expect(rec.horses.filter((h) => h.finishStatus === "取消")).toHaveLength(1); // 前提
    const out = convertOk(rec);
    expect(out.skippedNonStart).toBe(1);
    expect(out.runs).toHaveLength(15);
    expect(out.runs.every((r) => r.run.entryCount === 15)).toBe(true);
  });

  it("失格: 先頭 1 文字「失」。走っているので行を作り、頭数にも数える", () => {
    const horses = [place(1, 1, "1:34.5"), horse({ umaban: 2, finishStatus: "失格", finishRaw: "失格" })];
    const out = convertOk(withHorses(horses));
    expect(out.runs).toHaveLength(2);
    expect(runOf(withHorses(horses), "H2").finishPosition).toEqual({ kind: "非数値", text: "失" });
  });

  it("降着(結果ページでの写り方は未確認): finishDemoted の馬は [順位, 1] の形に符号化される", () => {
    const horses = [place(1, 1, "1:34.5"), place(2, 5, "1:34.9", { finishDemoted: true, finishRaw: "5(降)" })];
    const r = runOf(withHorses(horses), "H2");
    expect(r.finishPosition).toEqual({ kind: "順位", value: 5, demoted: true });
    expect(encodeHorseRun(r)[HORSE_RUN_FIELD_SLOTS.finishPosition]).toEqual([5, 1]);
  });

  it("着順の表示が空の馬(finish も finishStatus も null): 着順は null で行は残る", () => {
    const horses = [place(1, 1, "1:34.5"), horse({ umaban: 2 })];
    expect(runOf(withHorses(horses), "H2").finishPosition).toBeNull();
  });

  it("実ページの障害(東京ハイジャンプ。中止 1 頭): 中止は「中」、コースは障、馬場は結果ページの値から", () => {
    const rec = record("result_202605040709.html", "202605040709", "central");
    expect(rec.courseType).toBe("障");
    const out = convertOk(rec);
    const stopped = rec.horses.find((h) => h.finishStatus === "中止")!;
    const r = runOf(rec, stopped.horseId!);
    expect(r.finishPosition).toEqual({ kind: "非数値", text: "中" });
    expect(r.courseType).toBe("障");
    expect(r.distance).toBe(3110);
    expect(r.trackCondition).toBe("良");
    expect(out.runs).toHaveLength(rec.horses.length); // 中止は走っているので全頭
  });
});

describe("実例なし(合成): 項目ごとの変換", () => {
  const goingTable: ReadonlyArray<readonly [RaceRecord["going"], string | null]> = [
    ["良", "良"],
    ["稍重", "稍"],
    ["重", "重"],
    ["不良", "不"],
    [null, null],
  ];
  it.each(goingTable)("馬場 %s → %s(API の略記にそろえる)", (going, expected) => {
    expect(runOf(withHorses(BASE.horses, { going }), BASE.horses[0]!.horseId!).trackCondition).toBe(expected);
  });

  const gradeTable: ReadonlyArray<readonly [string | null, string]> = [
    ["G1", "ラジオNIKKEI賞(GI)"],
    ["G2", "ラジオNIKKEI賞(GII)"],
    ["G3", "ラジオNIKKEI賞(GIII)"],
    ["Jpn1", "ラジオNIKKEI賞(JpnI)"],
    ["Jpn2", "ラジオNIKKEI賞(JpnII)"],
    ["Jpn3", "ラジオNIKKEI賞(JpnIII)"],
    ["JG1", "ラジオNIKKEI賞"],
    ["JG2", "ラジオNIKKEI賞"],
    ["JG3", "ラジオNIKKEI賞"],
    ["L", "ラジオNIKKEI賞"],
    [null, "ラジオNIKKEI賞"],
  ];
  it.each(gradeTable)("格 %s → レース名 %s(G1〜G3 と Jpn1〜3 だけローマ数字の括弧を付ける。JG・L・OP は付けない)", (grade, expected) => {
    const rec = withHorses(BASE.horses, { name: "ラジオNIKKEI賞", grade });
    expect(runOf(rec, BASE.horses[0]!.horseId!).raceName).toBe(expected);
  });

  it("レース名が null なら、格があっても null(括弧だけの名前を作らない)", () => {
    const rec = withHorses(BASE.horses, { name: null, grade: "G1" });
    expect(runOf(rec, BASE.horses[0]!.horseId!).raceName).toBeNull();
  });

  it("名前は 10 文字に切らない(API は 10 文字に切るが、中央で未確認。違いとして残す)", () => {
    const long = "ジャパンダートクラシック";
    const rec = withHorses(BASE.horses, { name: long, grade: "Jpn1" });
    expect(runOf(rec, BASE.horses[0]!.horseId!).raceName).toBe(`${long}(JpnI)`);
  });

  it("開催(スロット 1): 中央は [回次, 会場, 日目, 生テキスト]、地方は [null, 会場, null, 会場]、会場が読めなければ null", () => {
    const id = BASE.horses[0]!.horseId!;
    const central = encodeHorseRun(runOf(withHorses(BASE.horses, { kai: 1, venueName: "函館", nichime: 6 }), id));
    expect(central[HORSE_RUN_FIELD_SLOTS.venue]).toEqual([1, "函館", 6, "1函館6"]);
    const nar = encodeHorseRun(runOf(withHorses(BASE.horses, { kind: "nar", kai: 5, venueName: "高知", nichime: 6 }), id));
    expect(nar[HORSE_RUN_FIELD_SLOTS.venue]).toEqual([null, "高知", null, "高知"]);
    expect(runOf(withHorses(BASE.horses, { venueName: null }), id).venue).toBeNull();
    // 中央で回次が読めないときは、会場名だけ(API の「分解できない表記」と同じ形)
    const noKai = runOf(withHorses(BASE.horses, { kai: null, venueName: "函館" }), id);
    expect(noKai.venue).toEqual({ round: null, name: "函館", day: null, raw: "函館" });
  });

  it("開催区分と race_id: 中央は 中央+raceId、地方は 地方+raceId が null(API の classifyRace と同じ)", () => {
    const id = BASE.horses[0]!.horseId!;
    const c = runOf(withHorses(BASE.horses), id);
    expect([c.venueKind, c.raceIdRaw, c.raceId]).toEqual(["中央", "202602010607", "202602010607"]);
    const n = runOf(withHorses(BASE.horses, { kind: "nar", raceId: "202654071201" }), id);
    expect([n.venueKind, n.raceIdRaw, n.raceId]).toEqual(["地方", "202654071201", null]);
  });

  it("日付は YYYY/MM/DD", () => {
    expect(runOf(BASE, BASE.horses[0]!.horseId!).date).toBe("2026/06/28");
  });

  it("馬体重: 体重と増減がそろったときだけ [体重, 増減]。増減が読めない(初出走など)・体重が無いときは null", () => {
    const h = BASE.horses[0]!;
    const mk = (bodyWeight: number | null, bodyWeightDiff: number | null) => runOf(withHorses([{ ...h, bodyWeight, bodyWeightDiff }]), h.horseId!).bodyWeight;
    expect(mk(496, 2)).toEqual({ weight: 496, diff: 2 });
    expect(mk(474, 0)).toEqual({ weight: 474, diff: 0 }); // 増減 0 を欠損にしない
    expect(mk(496, null)).toBeNull();
    expect(mk(null, null)).toBeNull();
  });

  it("時計: 空文字・null は null、あれば生の文字", () => {
    const h = BASE.horses[0]!;
    const mk = (timeRaw: string | null) => runOf(withHorses([{ ...h, timeRaw, finish: 1, finishRaw: "1" }]), h.horseId!).time;
    expect(mk("1:46.0")).toBe("1:46.0");
    expect(mk("")).toBeNull();
    expect(mk(null)).toBeNull();
  });

  it("馬 ID が無い馬は行を作れない(鍵が (馬 ID, レース))。件数を skippedNoHorseId で返し、頭数には数える", () => {
    const horses = [place(1, 1, "1:34.5"), place(2, 2, "1:34.7", { horseId: null })];
    const out = convertOk(withHorses(horses));
    expect(out.skippedNoHorseId).toBe(1);
    expect(out.runs.map((r) => r.horseId)).toEqual(["H1"]);
    expect(out.runs[0]!.run.entryCount).toBe(2);
  });
});

describe("レース単位の拒否", () => {
  it("行数が宣言の頭数と合わない(一部の行しか載っていないページ)は変換を拒否する。実ページ nar_result_partial_202644100810(3 行・宣言 15)", () => {
    const rec = record("nar_result_partial_202644100810.html", "202644100810", "nar");
    expect(rec.horses.length).toBe(3); // 前提
    expect(rec.fieldSizeDeclared).toBe(15);
    const out = raceRecordToRuns(rec);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toContain("3");
      expect(out.reason).toContain("15");
    }
  });

  it("宣言の頭数が読めない(null)ときも拒否する", () => {
    const out = raceRecordToRuns({ ...BASE, fieldSizeDeclared: null });
    expect(out.ok).toBe(false);
  });

  it("行が 0 のレースは拒否ではなく空: 宣言も 0 のとき runs は空(通常は起きない)", () => {
    const out = raceRecordToRuns({ ...BASE, fieldSizeDeclared: 0, horses: [] });
    expect(out).toEqual({ ok: true, runs: [], skippedNonStart: 0, skippedNoHorseId: 0 });
  });
});

describe("フィクスチャ全体の往復", () => {
  const files: ReadonlyArray<readonly [string, Kind]> = [
    ["history_central_result_202105040811.html", "central"],
    ["history_nar_result_202146110310.html", "nar"],
    ["nar_result_202630062407.html", "nar"],
    ["nar_result_202644100810.html", "nar"],
    ["nar_result_202646071203.html", "nar"],
    ["nar_result_202650062411.html", "nar"],
    ["nar_result_202654071201.html", "nar"],
    ["nar_result_202654071210.html", "nar"],
    ["nar_result_202654092706.html", "nar"],
    ["nar_result_202654092711.html", "nar"],
    ["result_202602010605.html", "central"],
    ["result_202602010607.html", "central"],
    ["result_202603020203.html", "central"],
    ["result_202603020210.html", "central"],
    ["result_202603020211.html", "central"],
    ["result_202604040112.html", "central"],
    ["result_202605040205.html", "central"],
    ["result_202605040709.html", "central"],
    ["result_202605040807.html", "central"],
    ["result_202606040810.html", "central"],
    ["result_202606040901.html", "central"],
    ["result_202607020501.html", "central"],
    ["result_202607020502.html", "central"],
    ["result_202607020505.html", "central"],
    ["result_202608040204.html", "central"],
  ];

  it.each(files)("%s: 全行が encode → JSON → decode で元の 1 走に戻り、26 スロットで、騎手名は null", (file, kind) => {
    const raceId = /(\d{12})/.exec(file)![1]!;
    const rec = record(file, raceId, kind);
    const out = convertOk(rec);
    expect(out.runs.length).toBeGreaterThan(0); // 前提: 空振りにしない
    expect(out.runs.length + out.skippedNonStart + out.skippedNoHorseId).toBe(rec.horses.length);
    for (const r of out.runs) {
      const tuple = encodeHorseRun(r.run);
      expect(tuple).toHaveLength(26);
      expect(tuple[HORSE_RUN_FIELD_SLOTS.jockeyName]).toBeNull();
      expect(decodeHorseRun(JSON.parse(JSON.stringify(tuple)))).toEqual(r.run);
      expect(r.raceKey).toBe(raceId);
    }
  });
});
