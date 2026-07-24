/**
 * analysis-export.ts(分析データのエクスポート・第一版)のテスト(GitHub Issue#10)。
 *
 * electron・IOに一切依存しない純関数(buildRaceSnapshot・buildAnalysisExportDocument・
 * serializeAnalysisExportJson・serializeAnalysisExportCsv・pickLatestAnalysis)を検証する。
 * 手本は log-export.test.ts 相当の純関数テスト流儀。
 */

import { describe, expect, it } from "vitest";
import type { RaceData, RaceResultDetail, RaceResultEntry, StoredAnalysis } from "@keiba/core";

import {
  buildAnalysisExportDocument,
  buildDefaultAnalysisExportFileName,
  buildRaceSnapshot,
  deriveCsvPathFromJsonPath,
  pickLatestAnalysis,
  serializeAnalysisExportCsv,
  serializeAnalysisExportJson,
  type BuildAnalysisExportInput,
} from "../src/main/analysis-export.js";

/** テスト用の最小 RaceData を組み立てる。 */
function makeRaceData(overrides: Partial<RaceData> = {}): RaceData {
  return {
    raceId: "202605020811" as RaceData["raceId"],
    race: {
      raceName: "テストステークス",
      courseType: "芝",
      distance: 1600,
      startTime: "15:35",
      weather: "晴",
      trackCondition: "良",
      fence: "A",
    },
    horses: [
      {
        shutuba: {
          wakuban: 1,
          umaban: 1,
          name: "アルファ",
          horseId: "2020100001" as never,
          sex: "牡",
          age: 4,
          kinryo: 57,
          jockeyName: "テスト騎手",
          jockeyId: "00001",
          stableLocation: "美浦",
          trainerName: "テスト調教師",
          trainerId: "00002",
          bodyWeight: { weight: 480, diff: 2 },
        },
        results: [],
        oikiri: { umaban: 1, horseId: "2020100001" as never, horseName: "アルファ", critic: "動き良好", rank: "A" },
      },
      {
        shutuba: {
          wakuban: 2,
          umaban: 2,
          name: "ブラボー",
          horseId: "2020100002" as never,
          sex: "牝",
          age: 3,
          kinryo: 54,
          jockeyName: "テスト騎手2",
          jockeyId: null,
          stableLocation: "栗東",
          trainerName: "テスト調教師2",
          trainerId: null,
          bodyWeight: null,
        },
        results: [],
        oikiri: null,
      },
    ],
    odds: {
      officialDatetime: "2026-07-24 09:00:00",
      oddsStatus: "result",
      win: {
        1: { odds: 2.5, ninki: 1 },
        2: { odds: 8.0, ninki: 4 },
      },
      place: {
        1: { oddsMin: 1.2, oddsMax: 1.4, ninki: 1 },
        2: { oddsMin: 2.0, oddsMax: 2.5, ninki: 4 },
      },
    },
    meta: {
      fetchedAt: "2026-07-24T09:00:00.000Z",
      oddsFetchedAt: "2026-07-24T09:00:00.000Z",
      warnings: [],
    },
    ...overrides,
  } as RaceData;
}

/** テスト用の最小 StoredAnalysis を組み立てる。 */
function makeStoredAnalysis(overrides: Partial<StoredAnalysis> = {}): StoredAnalysis {
  return {
    id: 42,
    raceId: "202605020811",
    analyzedAt: "2026-07-24T09:05:00.000Z",
    evEstimated: false,
    promptVersion: "v1",
    additionalInstruction: null,
    kaisaiDate: "20260724",
    model: "claude-sonnet-4-6",
    rawResponse: '{"horses":[]}',
    raceSnapshot: buildRaceSnapshot(makeRaceData()),
    horses: [
      {
        umaban: 1,
        prior: 0.4,
        adjustedProb: 0.45,
        placeOddsMin: 1.2,
        ev: 0.9,
        isPositive: false,
        contributions: null,
        mark: "◎",
        reason: "調教良化",
      },
      {
        umaban: 2,
        prior: 0.2,
        adjustedProb: 0.18,
        placeOddsMin: 2.0,
        ev: 1.2,
        isPositive: true,
        contributions: null,
        mark: null,
        reason: null,
      },
    ],
    ...overrides,
  };
}

function makeInput(overrides: Partial<BuildAnalysisExportInput> = {}): BuildAnalysisExportInput {
  return {
    analysis: makeStoredAnalysis(),
    venueName: "東京",
    results: undefined,
    resultDetail: undefined,
    toolName: "競馬期待値分析ツール",
    toolVersion: "1.0.0",
    exportedAt: "2026-07-24T10:00:00.000Z",
    ...overrides,
  };
}

describe("buildRaceSnapshot(取得したレース情報のスナップショット化)", () => {
  it("レース情報・各馬の出馬表項目・単複オッズ・調教をスナップショット化すること", () => {
    const snapshot = buildRaceSnapshot(makeRaceData());
    expect(snapshot.race).toEqual({
      raceName: "テストステークス",
      courseType: "芝",
      distance: 1600,
      weather: "晴",
      trackCondition: "良",
      startTime: "15:35",
      fence: "A",
      oddsStatus: "result",
      officialDatetime: "2026-07-24 09:00:00",
    });
    const h1 = snapshot.horses.find((h) => h.umaban === 1)!;
    expect(h1).toEqual({
      umaban: 1,
      wakuban: 1,
      name: "アルファ",
      sex: "牡",
      age: 4,
      kinryo: 57,
      jockeyName: "テスト騎手",
      trainerName: "テスト調教師",
      bodyWeight: 480,
      winOdds: 2.5,
      popularity: 1,
      placeOddsMin: 1.2,
      oikiriCritic: "動き良好",
      oikiriRank: "A",
    });
  });

  it("馬体重未発表(null)・調教評価なし(oikiri null)・天候等未取得(undefined)は欠損項目をnullで表すこと", () => {
    const snapshot = buildRaceSnapshot(
      makeRaceData({
        race: {
          raceName: "テスト2",
          courseType: "ダ",
          distance: 1200,
        },
      }),
    );
    expect(snapshot.race.weather).toBeNull();
    expect(snapshot.race.trackCondition).toBeNull();
    expect(snapshot.race.startTime).toBeNull();
    expect(snapshot.race.fence).toBeNull();
    const h2 = snapshot.horses.find((h) => h.umaban === 2)!;
    expect(h2.bodyWeight).toBeNull();
    expect(h2.oikiriCritic).toBeNull();
    expect(h2.oikiriRank).toBeNull();
  });

  it("過去戦績(results)はスナップショットに含めないこと(サイズ大のため対象外)", () => {
    const snapshot = buildRaceSnapshot(makeRaceData());
    for (const h of snapshot.horses) {
      expect((h as unknown as Record<string, unknown>).results).toBeUndefined();
    }
  });
});

describe("buildAnalysisExportDocument(schemaVersion=1 のエクスポートJSONを組み立てる)", () => {
  it("schemaVersion:1と、meta・race・horses・results・rawLlmResponseを組み立てること", () => {
    const doc = buildAnalysisExportDocument(
      makeInput({
        results: [
          { umaban: 1, finishPosition: 1, placePayout: 120 },
          { umaban: 2, finishPosition: 4, placePayout: null },
        ],
        resultDetail: {
          courseType: "芝",
          horses: [
            { umaban: 1, finishPosition: 1, passing: [2, 1, 1, 1], last3f: 34.5 },
            { umaban: 2, finishPosition: 4, passing: [5, 5, 5, 4], last3f: 35.8 },
          ],
        },
      }),
    );
    expect(doc.schemaVersion).toBe(1);
    expect(doc.meta).toEqual({
      toolName: "競馬期待値分析ツール",
      toolVersion: "1.0.0",
      exportedAt: "2026-07-24T10:00:00.000Z",
      analysisId: 42,
      analyzedAt: "2026-07-24T09:05:00.000Z",
      kaisaiDate: "20260724",
      promptVersion: "v1",
      additionalInstruction: null,
      model: "claude-sonnet-4-6",
      evEstimated: false,
    });
    expect(doc.race).toEqual({
      raceId: "202605020811",
      venueName: "東京",
      raceName: "テストステークス",
      courseType: "芝",
      distance: 1600,
      weather: "晴",
      trackCondition: "良",
      startTime: "15:35",
      fence: "A",
      oddsStatus: "result",
      officialDatetime: "2026-07-24 09:00:00",
    });
    const h1 = doc.horses.find((h) => h.umaban === 1)!;
    expect(h1).toEqual({
      umaban: 1,
      wakuban: 1,
      name: "アルファ",
      sex: "牡",
      age: 4,
      kinryo: 57,
      jockeyName: "テスト騎手",
      trainerName: "テスト調教師",
      bodyWeight: 480,
      winOdds: 2.5,
      popularity: 1,
      placeOddsMin: 1.2,
      oikiriCritic: "動き良好",
      oikiriRank: "A",
      prior: 0.4,
      adjustedProb: 0.45,
      ev: 0.9,
      isPositive: false,
      mark: "◎",
      reason: "調教良化",
    });
    expect(doc.results).toEqual([
      { umaban: 1, finishPosition: 1, placePayout: 120, passing: [2, 1, 1, 1], last3f: 34.5 },
      { umaban: 2, finishPosition: 4, placePayout: null, passing: [5, 5, 5, 4], last3f: 35.8 },
    ]);
    expect(doc.rawLlmResponse).toBe('{"horses":[]}');
  });

  it("欠損はキーを省略せず明示nullで表すこと(placeOddsMin/evなど)", () => {
    const doc = buildAnalysisExportDocument(
      makeInput({
        analysis: makeStoredAnalysis({
          horses: [
            {
              umaban: 1,
              prior: 0.3,
              adjustedProb: 0.3,
              placeOddsMin: null,
              ev: null,
              isPositive: false,
              contributions: null,
              mark: null,
              reason: null,
            },
          ],
        }),
      }),
    );
    const h1 = doc.horses[0]!;
    expect("placeOddsMin" in h1).toBe(true);
    expect(h1.placeOddsMin).toBeNull();
    expect("ev" in h1).toBe(true);
    expect(h1.ev).toBeNull();
    expect("mark" in h1).toBe(true);
    expect(h1.mark).toBeNull();
    expect("reason" in h1).toBe(true);
    expect(h1.reason).toBeNull();
  });

  it("LLMスキップ時(model/rawResponse/reasonがnull)は偽値を混入させずnullのまま出力すること", () => {
    const doc = buildAnalysisExportDocument(
      makeInput({
        analysis: makeStoredAnalysis({
          model: null,
          rawResponse: null,
          horses: [
            {
              umaban: 1,
              prior: 0.4,
              adjustedProb: 0.4,
              placeOddsMin: 1.2,
              ev: 0.9,
              isPositive: false,
              contributions: null,
              mark: null,
              reason: null,
            },
          ],
        }),
      }),
    );
    expect(doc.meta.model).toBeNull();
    expect(doc.rawLlmResponse).toBeNull();
    expect(doc.horses[0]!.reason).toBeNull();
  });

  it("旧レコード(raceSnapshot/model/rawResponseが全てnull)でも例外を投げず出力すること(スナップショット由来項目はnull)", () => {
    const doc = buildAnalysisExportDocument(
      makeInput({
        analysis: makeStoredAnalysis({
          model: null,
          rawResponse: null,
          raceSnapshot: null,
          horses: [
            {
              umaban: 1,
              prior: 0.4,
              adjustedProb: 0.4,
              placeOddsMin: 1.2,
              ev: 0.9,
              isPositive: false,
              contributions: null,
              mark: null,
              reason: null,
            },
          ],
        }),
      }),
    );
    expect(doc.race.raceName).toBeNull();
    expect(doc.race.courseType).toBeNull();
    expect(doc.race.oddsStatus).toBeNull();
    const h1 = doc.horses[0]!;
    expect(h1.name).toBeNull();
    expect(h1.jockeyName).toBeNull();
    expect(h1.oikiriCritic).toBeNull();
    // analysis_horses由来の項目(prior/adjustedProb等)は旧レコードでも保持される。
    expect(h1.prior).toBe(0.4);
    expect(h1.adjustedProb).toBe(0.4);
  });

  it("破損したraceSnapshot(スキーマ不正なJSON由来のunknown値)でも例外を投げずスナップショット由来項目をnullにすること", () => {
    const doc = buildAnalysisExportDocument(
      makeInput({
        analysis: makeStoredAnalysis({ raceSnapshot: { unexpected: "shape" } }),
      }),
    );
    expect(doc.race.raceName).toBeNull();
    expect(doc.horses[0]!.name).toBeNull();
  });

  it("結果未取込(results/resultDetailともにundefined)ならresultsは空配列になること", () => {
    const doc = buildAnalysisExportDocument(makeInput());
    expect(doc.results).toEqual([]);
  });

  it("非数値着順(finishPosition=null。中止・除外)もそのままnullで出力すること", () => {
    const doc = buildAnalysisExportDocument(
      makeInput({
        results: [{ umaban: 1, finishPosition: null, placePayout: null }],
        resultDetail: {
          courseType: null,
          horses: [{ umaban: 1, finishPosition: null, passing: [], last3f: null }],
        },
      }),
    );
    expect(doc.results).toEqual([
      { umaban: 1, finishPosition: null, placePayout: null, passing: [], last3f: null },
    ]);
  });

  it("yoso(推定EV)はevEstimated:trueかつplaceOddsMinがnullのまま出力すること", () => {
    const doc = buildAnalysisExportDocument(
      makeInput({
        analysis: makeStoredAnalysis({
          evEstimated: true,
          horses: [
            {
              umaban: 1,
              prior: 0.4,
              adjustedProb: 0.4,
              placeOddsMin: null,
              ev: 1.5,
              isPositive: true,
              contributions: null,
              mark: null,
              reason: null,
            },
          ],
        }),
      }),
    );
    expect(doc.meta.evEstimated).toBe(true);
    expect(doc.horses[0]!.placeOddsMin).toBeNull();
  });

  it("秘密安全性: 出力ドキュメントに許可されたキー以外(apiKey・webhook・プロンプト本文相当)が混入しないこと", () => {
    const doc = buildAnalysisExportDocument(makeInput());
    expect(Object.keys(doc).sort()).toEqual(
      ["schemaVersion", "meta", "race", "horses", "results", "rawLlmResponse"].sort(),
    );
    expect(Object.keys(doc.meta).sort()).toEqual(
      [
        "toolName",
        "toolVersion",
        "exportedAt",
        "analysisId",
        "analyzedAt",
        "kaisaiDate",
        "promptVersion",
        "additionalInstruction",
        "model",
        "evEstimated",
      ].sort(),
    );
    // rawLlmResponseは「LLMのモデル出力」のみで、プロンプト本文・apiKeyの文字列は
    // buildAnalysisExportDocumentの入力(BuildAnalysisExportInput)自体に存在しないため、
    // 関数のシグネチャ上構造的に混入しえない(このテストは入力に無い秘密が出力にも無いことの確認)。
    const json = serializeAnalysisExportJson(doc);
    expect(json).not.toContain("apiKey");
    expect(json).not.toContain("webhook");
    expect(json).not.toContain("Webhook");
  });
});

describe("serializeAnalysisExportJson(JSON文字列化)", () => {
  it("schemaVersion=1を含むJSON文字列を返し、パースするとドキュメントと一致すること", () => {
    const doc = buildAnalysisExportDocument(makeInput());
    const json = serializeAnalysisExportJson(doc);
    expect(JSON.parse(json)).toEqual(doc);
    expect(json).toContain('"schemaVersion": 1');
  });
});

describe("serializeAnalysisExportCsv(馬別CSV文字列化・RFC4180準拠)", () => {
  it("ヘッダ行付き・1行1頭で出力し、結果があればfinishPosition/placePayout/last3f/passing列を結合すること(code-reviewer提案対応: passing/last3f追加)", () => {
    const doc = buildAnalysisExportDocument(
      makeInput({
        results: [{ umaban: 1, finishPosition: 1, placePayout: 120 }],
        resultDetail: {
          courseType: "芝",
          horses: [{ umaban: 1, finishPosition: 1, passing: [2, 3, 4, 3], last3f: 34.5 }],
        },
      }),
    );
    const csv = serializeAnalysisExportCsv(doc);
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    // ヘッダ行 + 2頭分。
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("umaban");
    expect(lines[0]).toContain("finishPosition");
    expect(lines[0]).toContain("placePayout");
    expect(lines[0]).toContain("last3f");
    expect(lines[0]).toContain("passing");
    const header = lines[0]!.split(",");
    const row1 = parseCsvLine(lines[1]!);
    expect(row1[0]).toBe("1"); // umaban
    expect(lines[1]).toContain("120"); // placePayout
    expect(row1[header.indexOf("last3f")]).toBe("34.5");
    // passingは配列を "2-3-4-3" のようにハイフン連結した文字列にすること。
    expect(row1[header.indexOf("passing")]).toBe("2-3-4-3");
  });

  it("欠損値は空セルとして出力すること(last3f/passingを含む)", () => {
    const doc = buildAnalysisExportDocument(makeInput());
    const csv = serializeAnalysisExportCsv(doc);
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    // 2頭目(reason=null・placeOddsMin=2.0はあるがfinishPositionは結果未取込でnull)。
    const header = lines[0]!.split(",");
    const finishPositionIdx = header.indexOf("finishPosition");
    const row2 = parseCsvLine(lines[2]!);
    expect(row2[finishPositionIdx]).toBe("");
    expect(row2[header.indexOf("last3f")]).toBe("");
    // passingが空配列(結果未取込)のときも空セルにすること(要素0件のハイフン連結="" の意味を明示)。
    expect(row2[header.indexOf("passing")]).toBe("");
  });

  it("RFC4180エスケープ: 馬名にカンマ・ダブルクオート・改行を含む場合は正しくクオートされること", () => {
    const doc = buildAnalysisExportDocument(
      makeInput({
        analysis: makeStoredAnalysis({
          raceSnapshot: buildRaceSnapshot(
            makeRaceData({
              horses: [
                {
                  shutuba: {
                    wakuban: 1,
                    umaban: 1,
                    name: '馬名,"引用",改行\n入り',
                    horseId: "2020100001" as never,
                    sex: "牡",
                    age: 4,
                    kinryo: 57,
                    jockeyName: "騎手",
                    jockeyId: "1",
                    stableLocation: "美浦",
                    trainerName: "調教師",
                    trainerId: "1",
                    bodyWeight: null,
                  },
                  results: [],
                  oikiri: null,
                },
              ],
            }),
          ),
          horses: [
            {
              umaban: 1,
              prior: 0.3,
              adjustedProb: 0.3,
              placeOddsMin: null,
              ev: null,
              isPositive: false,
              contributions: null,
              mark: null,
              reason: 'reasonにも,"引用"を含む',
            },
          ],
        }),
      }),
    );
    const csv = serializeAnalysisExportCsv(doc);
    const header = csv.split("\r\n")[0]!.split(",");
    const nameIdx = header.indexOf("name");
    const reasonIdx = header.indexOf("reason");
    const rows = parseCsvRecords(csv);
    const dataRow = rows[1]!;
    expect(dataRow[nameIdx]).toBe('馬名,"引用",改行\n入り');
    expect(dataRow[reasonIdx]).toBe('reasonにも,"引用"を含む');
  });
});

describe("pickLatestAnalysis(同一レースの複数分析から最新〈id最大〉を決定的に選ぶ)", () => {
  it("id最大の分析を返すこと(保存順に関わらない)", () => {
    const a1 = makeStoredAnalysis({ id: 5 });
    const a2 = makeStoredAnalysis({ id: 12 });
    const a3 = makeStoredAnalysis({ id: 7 });
    expect(pickLatestAnalysis([a1, a2, a3])).toBe(a2);
  });

  it("1件のみなら、その1件を返すこと", () => {
    const a1 = makeStoredAnalysis({ id: 1 });
    expect(pickLatestAnalysis([a1])).toBe(a1);
  });

  it("空配列ならnullを返すこと", () => {
    expect(pickLatestAnalysis([])).toBeNull();
  });
});

describe("buildDefaultAnalysisExportFileName(既定ファイル名。log-export.tsのbuildDefaultLogExportFileNameと同流儀)", () => {
  it("レースIDと当日日付(YYYYMMDD)を含むJSON既定ファイル名を返すこと", () => {
    const name = buildDefaultAnalysisExportFileName(
      "202605020811",
      new Date(2026, 6, 16),
    );
    expect(name).toBe("keiba-ev-tool-analysis-202605020811-20260716.json");
  });
});

describe("deriveCsvPathFromJsonPath(JSON保存先パスからCSVパスを導出。code-reviewer指摘対応: csvPathがjsonPathと衝突しないことを保証する)", () => {
  it("拡張子.json(小文字)は.csvへ置き換えること", () => {
    expect(deriveCsvPathFromJsonPath("/tmp/out/analysis.json")).toBe(
      "/tmp/out/analysis.csv",
    );
  });

  it("拡張子.JSON(大文字)も.csvへ置き換えること(大文字小文字を区別しない)", () => {
    expect(deriveCsvPathFromJsonPath("/tmp/out/analysis.JSON")).toBe(
      "/tmp/out/analysis.csv",
    );
  });

  it("ユーザーが保存先に.csv拡張子を指定した場合は置き換えず末尾に.csvを付加すること(元のjsonPathと衝突させない。JSON消失防止)", () => {
    const result = deriveCsvPathFromJsonPath("/tmp/out/analysis.csv");
    expect(result).toBe("/tmp/out/analysis.csv.csv");
    expect(result).not.toBe("/tmp/out/analysis.csv");
  });

  it("拡張子が無いファイル名は末尾に.csvを付与すること", () => {
    expect(deriveCsvPathFromJsonPath("/tmp/out/analysis")).toBe(
      "/tmp/out/analysis.csv",
    );
  });

  it(".json以外の拡張子(.txt等)は置き換えず末尾に.csvを付加すること(置き換えると衝突を生みうるため常に付加のみ)", () => {
    expect(deriveCsvPathFromJsonPath("/tmp/out/analysis.txt")).toBe(
      "/tmp/out/analysis.txt.csv",
    );
  });

  it("境界プロパティ: どの入力でも戻り値が入力jsonPathと一致しないこと(衝突不可能性の保証)", () => {
    for (const p of [
      "/a/b.json",
      "/a/b.JSON",
      "/a/b.csv",
      "/a/b.CSV",
      "/a/b",
      "/a/b.txt",
    ]) {
      expect(deriveCsvPathFromJsonPath(p)).not.toBe(p);
    }
  });
});

/** 簡易CSV1行パーサ(RFC4180の最小サブセット。テスト専用)。 */
function parseCsvLine(line: string): string[] {
  return parseCsvRecords(line)[0]!;
}

/** 簡易CSV全体パーサ(RFC4180の最小サブセット。テスト専用。crlf区切り・""エスケープ対応)。 */
function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      record.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r" && text[i + 1] === "\n") {
      record.push(field);
      field = "";
      records.push(record);
      record = [];
      i += 2;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records.filter((r) => !(r.length === 1 && r[0] === ""));
}
