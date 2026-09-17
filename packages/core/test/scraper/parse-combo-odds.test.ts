/**
 * parse-combo-odds(中央ワイド・3連複オッズ、api_get_jra_odds type=5/7)のテスト
 * (機能D-2b-A・Issue #32)。
 *
 * 実装当初(#32)は既存 parse-odds.ts / parse-odds.test.ts を一切変更しなかった
 * (受け入れ条件1・12)。**その後 Issue #34 で、人気(ninki)の数値化のみ `scraper/ninki.ts`
 * の共有実装に統合された(本ファイルのテストケースは無改変)。**
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildComboOddsKey } from "../../src/scraper/combo-odds-key.js";
import {
  ComboOddsParseError,
  parseComboOdds,
  type ComboOddsParseResult,
} from "../../src/scraper/parse-combo-odds.js";

/** fixtures/ 配下のファイルをUTF-8テキストとして読み込む(既存テストと同じ解決方法)。 */
function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

/** 「available」状態であることを前提として先に固定し、oddsマップを取り出す(空振り防止)。 */
function expectAvailable(result: ComboOddsParseResult): ReadonlyMap<string, { oddsMin: number | null; oddsMax: number | null; ninki: number | null }> {
  expect(result.state).toBe("available");
  if (result.state !== "available") throw new Error("unreachable");
  return result.odds;
}

describe("parseComboOdds(桁区切りカンマ。受け入れ条件3)", () => {
  it("前提固定: 3連複フィクスチャは560件中251件がカンマを含むこと(再現: python3 -c \"import json;o=json.load(open('fixtures/odds_trio_202603020211.json'))['data']['odds']['7'];print(len(o),sum(1 for v in o.values() if ',' in v[0]))\" → 560 251)", () => {
    const json = loadFixture("odds_trio_202603020211.json");
    const parsed = JSON.parse(json) as { data: { odds: { "7": Record<string, [string, string, string]> } } };
    const rows = Object.values(parsed.data.odds["7"]);
    expect(rows.length).toBe(560);
    expect(rows.filter((v) => v[0].includes(",")).length).toBe(251);
  });

  it("前提固定: ワイドフィクスチャはカンマを1件も含まないこと(120件中0件。導出値ではなく観測値)", () => {
    const json = loadFixture("odds_wide_202603020211.json");
    const parsed = JSON.parse(json) as { data: { odds: { "5": Record<string, [string, string, string]> } } };
    const rows = Object.values(parsed.data.odds["5"]);
    expect(rows.length).toBe(120);
    expect(rows.filter((v) => v[0].includes(",")).length).toBe(0);
  });

  it("3連複の最大オッズ(041015: \"15,462.5\")がカンマを除去して数値化されること", () => {
    const odds = expectAvailable(parseComboOdds(loadFixture("odds_trio_202603020211.json"), "trio"));
    expect(odds.get(buildComboOddsKey([4, 10, 15]))?.oddsMin).toBe(15462.5);
  });

  it("ワイドの馬番04-10(\"429.3\" - \"432.0\"、カンマなし)がそのまま数値化されること", () => {
    const odds = expectAvailable(parseComboOdds(loadFixture("odds_wide_202603020211.json"), "wide"));
    const cell = odds.get(buildComboOddsKey([4, 10]));
    expect(cell?.oddsMin).toBe(429.3);
    expect(cell?.oddsMax).toBe(432.0);
  });

  // code-reviewer指摘: 実フィクスチャのワイドオッズはカンマを1件も含まない(上の前提固定テスト参照)ため、
  // oddsMax(cellAt(value,1)、ワイドのみ使用)の呼び出し箇所は実フィクスチャでは独立に検証できない。
  // 実測: oddsMax側だけを旧実装(カンマ非対応)に戻してもparse-combo-odds.test.tsは全緑のままだった
  // (レビュアー指摘を受けた変異注入で確認)。合成JSONでoddsMin/oddsMaxに異なるカンマ値を与え、
  // 構造体まるごとtoEqualで比較する。
  it("ワイドのoddsMin・oddsMaxがいずれも桁区切りカンマを含む合成データの場合、それぞれ除去して数値化されること", () => {
    const json = JSON.stringify({
      status: "result",
      data: { odds: { "5": { "0102": ["1,234.5", "2,345.6", "10"] } } },
    });
    const odds = expectAvailable(parseComboOdds(json, "wide"));
    expect(odds.get(buildComboOddsKey([1, 2]))).toEqual({
      oddsMin: 1234.5,
      oddsMax: 2345.6,
      ninki: 10,
    });
  });
});

describe("parseComboOdds(3連複の2要素目はダミー。受け入れ条件4)", () => {
  it("3連複は全件でoddsMaxがnullであること(\"0.0\"を上限として拾わない)", () => {
    const odds = expectAvailable(parseComboOdds(loadFixture("odds_trio_202603020211.json"), "trio"));
    expect(odds.size).toBeGreaterThan(0);
    for (const cell of odds.values()) {
      expect(cell.oddsMax).toBeNull();
    }
  });

  it("3連複の馬01-02-03の値(\"260.2\")がoddsMinに入り、oddsMaxとして複製されないこと", () => {
    const odds = expectAvailable(parseComboOdds(loadFixture("odds_trio_202603020211.json"), "trio"));
    expect(odds.get(buildComboOddsKey([1, 2, 3]))).toEqual({ oddsMin: 260.2, oddsMax: null, ninki: 103 });
  });
});

describe("parseComboOdds(ワイドの幅。受け入れ条件4)", () => {
  it("全組で下限<=上限であり、かつ下限<上限の組が実在すること(退化していないことの確認)", () => {
    const odds = expectAvailable(parseComboOdds(loadFixture("odds_wide_202603020211.json"), "wide"));
    expect(odds.size).toBe(120);
    let hasStrictDiff = false;
    for (const cell of odds.values()) {
      expect(cell.oddsMin).not.toBeNull();
      expect(cell.oddsMax).not.toBeNull();
      expect(cell.oddsMin!).toBeLessThanOrEqual(cell.oddsMax!);
      if (cell.oddsMax! > cell.oddsMin!) hasStrictDiff = true;
    }
    expect(hasStrictDiff).toBe(true);
  });
});

describe("parseComboOdds(非数値の値の解釈。合成データ。受け入れ条件6)", () => {
  function synthJson(cellValue: [string, string, string]): string {
    return JSON.stringify({
      status: "result",
      data: { official_datetime: "2026-06-28 15:52:30", odds: { "5": { "0102": cellValue } } },
    });
  }

  it.each([
    ["---.-", "---.-"],
    ["取消", "取消"],
    ["", ""],
  ])("オッズ列が非数値(%s)の場合はoddsMin/oddsMaxともnullであり、レース全体を落とさないこと", (a, b) => {
    const odds = expectAvailable(parseComboOdds(synthJson([a, b, "3"]), "wide"));
    expect(odds.size).toBe(1);
    const cell = odds.get("0102");
    expect(cell?.oddsMin).toBeNull();
    expect(cell?.oddsMax).toBeNull();
  });

  it.each([["0"], [""]])("人気列が欠損表現(%s)の場合はninkiがnullであること", (ninkiRaw) => {
    const odds = expectAvailable(parseComboOdds(synthJson(["5.0", "6.0", ninkiRaw]), "wide"));
    expect(odds.get("0102")?.ninki).toBeNull();
  });

  it("人気列が正常な数値の場合はそのまま数値化されること(空振り防止の対照)", () => {
    const odds = expectAvailable(parseComboOdds(synthJson(["5.0", "6.0", "7"]), "wide"));
    expect(odds.get("0102")?.ninki).toBe(7);
  });
});

describe("parseComboOdds(構造の検証。throw側。受け入れ条件7)", () => {
  function synthJsonKey(key: string, betType: "5" | "7"): string {
    return JSON.stringify({
      status: "result",
      data: { odds: { [betType]: { [key]: ["5.0", "0.0", "1"] } } },
    });
  }

  it("JSON.parseに失敗する文字列はComboOddsParseErrorを投げること", () => {
    expect(() => parseComboOdds("{ not json", "wide")).toThrow(ComboOddsParseError);
  });

  it("馬番キーが範囲外(00・19)の場合は投げること", () => {
    expect(() => parseComboOdds(synthJsonKey("0002", "5"), "wide")).toThrow(ComboOddsParseError);
    expect(() => parseComboOdds(synthJsonKey("0219", "5"), "wide")).toThrow(ComboOddsParseError);
  });

  it("キー長が券種と不一致(ワイドに6桁3連複キー)の場合は投げること", () => {
    expect(() => parseComboOdds(synthJsonKey("010203", "5"), "wide")).toThrow(ComboOddsParseError);
  });

  it("キーが昇順違反(\"0201\")の場合は投げること(buildComboOddsKeyが黙ってソートしてしまう問題の再発防止)", () => {
    expect(() => parseComboOdds(synthJsonKey("0201", "5"), "wide")).toThrow(ComboOddsParseError);
  });

  it("キーが数字ではない場合は投げること", () => {
    expect(() => parseComboOdds(synthJsonKey("0Xa2", "5"), "wide")).toThrow(ComboOddsParseError);
  });
});

describe("parseComboOdds(未発売・封筒異常はunavailableに分類しthrowしない。受け入れ条件7・7b・改訂後AC7)", () => {
  it("dataが非オブジェクト(空文字列)の場合はunavailableになり、rawStatus/rawReason/missingKeyを保持すること(boss指摘の{status:NG,data:\"\"}想定)", () => {
    const json = JSON.stringify({ status: "NG", data: "", reason: "no market" });
    const result = parseComboOdds(json, "wide");
    expect(result.state).toBe("unavailable");
    if (result.state !== "unavailable") throw new Error("unreachable");
    expect(result.reason).toEqual({ rawStatus: "NG", rawReason: "no market", missingKey: "data" });
  });

  it("dataは存在するがoddsキーが無い場合はunavailableになり、missingKey=\"odds\"であること", () => {
    const json = JSON.stringify({ status: "yoso", data: { official_datetime: null }, reason: "" });
    const result = parseComboOdds(json, "wide");
    expect(result.state).toBe("unavailable");
    if (result.state !== "unavailable") throw new Error("unreachable");
    expect(result.reason.missingKey).toBe("odds");
    expect(result.reason.rawStatus).toBe("yoso");
  });

  it("odds[\"5\"]キーが無い場合(既存yosoフィクスチャの複勝欠落と同型)はunavailableになり、missingKey=\"5\"であること", () => {
    const json = JSON.stringify({ status: "yoso", data: { odds: { "1": {} } } });
    const result = parseComboOdds(json, "wide");
    expect(result.state).toBe("unavailable");
    if (result.state !== "unavailable") throw new Error("unreachable");
    expect(result.reason.missingKey).toBe("5");
  });

  it("組合せが0件の場合はunavailableになること", () => {
    const json = JSON.stringify({ status: "result", data: { odds: { "5": {} } } });
    const result = parseComboOdds(json, "wide");
    expect(result.state).toBe("unavailable");
  });

  it("statusが未知の値でもthrowせずunavailableにできること(改訂後AC7: JSON.parse失敗以外はthrowしない)", () => {
    const json = JSON.stringify({ status: "totally-unknown-status", data: "unexpected" });
    const result = parseComboOdds(json, "wide");
    expect(result.state).toBe("unavailable");
  });

  it("ルート自体が配列(dataを持たない)場合もunavailableになること", () => {
    const json = JSON.stringify([1, 2, 3]);
    const result = parseComboOdds(json, "wide");
    expect(result.state).toBe("unavailable");
  });
});

describe("parseComboOdds(状態③=未発売の実測。受け入れ条件9。実リクエスト実施日2026-08-06)", () => {
  /**
   * 実測記録: 2026-08-06T18:29 UTC、中央・8/8開催の18頭最大レース(race_id=202604020511)の
   * ワイドAPI応答を取得(翌々日開催のため未発売が高確率で再現した)。
   *
   * 実際の応答(80バイト、全文。トリミングなし):
   * `{"status":"NG","data":"","update_count":"0","reason":"empty free odds schedule"}`
   *
   * これは boss が着手前ゲートで示した仮説「未発売時の封筒が `{"status":"NG","data":"",...}`
   * のように `data` がオブジェクトですらない形で返る可能性がある」と**完全に一致する実物**であり、
   * 改訂後AC7(封筒異常はthrowせずunavailableに分類する)の必要性を実物で裏付けた。
   *
   * type=7(3連複)も同一調査で取得し、バイト単位で同一内容("empty free odds schedule")で
   * あることを確認した(この封筒はtype非依存の内容のため、`odds_trio_presale_*.json`は
   * `odds_wide_presale_*.json`と同一バイト列をコミットしている。中央APIは既存
   * `odds_yoso_*.json`と同様type横断の共通封筒仕様であるため、内容が同一になること自体は
   * 構造として自然)。
   */
  it("中央・8/8開催18頭レース(202604020511、2026-08-06取得): dataが空文字列の実物応答をthrowせずunavailableに分類できること", () => {
    const json = loadFixture("odds_wide_presale_202604020511_20260806.json");
    // 前提固定(空振り防止): 実物がboss仮説どおりの形(dataが空文字列)であること。
    const parsed = JSON.parse(json) as { status: string; data: unknown; reason: string };
    expect(parsed.status).toBe("NG");
    expect(parsed.data).toBe("");
    expect(parsed.reason).toBe("empty free odds schedule");

    const result = parseComboOdds(json, "wide");
    expect(result.state).toBe("unavailable");
    if (result.state !== "unavailable") throw new Error("unreachable");
    expect(result.reason).toEqual({
      rawStatus: "NG",
      rawReason: "empty free odds schedule",
      missingKey: "data",
    });
  });

  it("同一応答を3連複としてパースしてもunavailableになること(封筒がtype非依存であることの確認)", () => {
    const json = loadFixture("odds_trio_presale_202604020511_20260806.json");
    const result = parseComboOdds(json, "trio");
    expect(result.state).toBe("unavailable");
  });
});

describe("parseComboOdds(件数の完全性。TDDリスト項目14)", () => {
  it("16頭(202603020211): ワイドC(16,2)=120・3連複C(16,3)=560と完全一致すること", () => {
    const wide = expectAvailable(parseComboOdds(loadFixture("odds_wide_202603020211.json"), "wide"));
    const trio = expectAvailable(parseComboOdds(loadFixture("odds_trio_202603020211.json"), "trio"));
    expect(wide.size).toBe(120);
    expect(trio.size).toBe(560);
  });

  it("6頭(202602010605): ワイドC(6,2)=15・3連複C(6,3)=20と完全一致すること", () => {
    const wide = expectAvailable(parseComboOdds(loadFixture("odds_wide_202602010605.json"), "wide"));
    const trio = expectAvailable(parseComboOdds(loadFixture("odds_trio_202602010605.json"), "trio"));
    expect(wide.size).toBe(15);
    expect(trio.size).toBe(20);
  });

  it("5頭(202603020203): ワイドC(5,2)=10・3連複C(5,3)=10と完全一致すること", () => {
    const wide = expectAvailable(parseComboOdds(loadFixture("odds_wide_202603020203.json"), "wide"));
    const trio = expectAvailable(parseComboOdds(loadFixture("odds_trio_202603020203.json"), "trio"));
    expect(wide.size).toBe(10);
    expect(trio.size).toBe(10);
  });
});

describe("parseComboOdds(キー正規化の一致。受け入れ条件5)", () => {
  it("パーサ由来のキー全件が buildComboOddsKey(umabans) の再計算結果と一致すること", () => {
    const odds = expectAvailable(parseComboOdds(loadFixture("odds_trio_202603020211.json"), "trio"));
    expect(odds.size).toBeGreaterThan(0);
    for (const key of odds.keys()) {
      // キー(6桁)を2桁ずつに分解して馬番配列を復元し、buildComboOddsKeyで再生成して一致を見る。
      const umabans = [Number(key.slice(0, 2)), Number(key.slice(2, 4)), Number(key.slice(4, 6))];
      expect(buildComboOddsKey(umabans)).toBe(key);
    }
  });
});
