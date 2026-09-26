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
import { buildComboOddsKey, buildOrderedComboOddsKey } from "../../src/scraper/combo-odds-key.js";
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
  it("16頭(202603020211): ワイドC(16,2)=120・3連複C(16,3)=560・馬連C(16,2)=120と完全一致すること", () => {
    const wide = expectAvailable(parseComboOdds(loadFixture("odds_wide_202603020211.json"), "wide"));
    const trio = expectAvailable(parseComboOdds(loadFixture("odds_trio_202603020211.json"), "trio"));
    const quinella = expectAvailable(
      parseComboOdds(loadFixture("odds_quinella_202603020211.json"), "quinella"),
    );
    expect(wide.size).toBe(120);
    expect(trio.size).toBe(560);
    expect(quinella.size).toBe(120);
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

/**
 * 馬単(exacta、type=6)の配線(Issue #106・#24-B AC-B6・AC-B9)。
 *
 * #24-A(#103)の実測フィクスチャ(16頭、P(16,2)=240件)をthrowせず全件パースできること、
 * かつ逆順の組(1着13・2着8 と 1着8・2着13)が別キー・別値のまま保持されることを固定する。
 *
 * ★このdescribeは実装前(betType="exacta"をJSON_ODDS_KEY/decodeRawKey/buildComboOddsCellMapが
 * 順序未対応のまま)ではRedになる: `decodeRawKey`内の`validateComboUmabans`(昇順のみ許容)が
 * 240件中120件(1着>2着の組)でthrowするか、あるいは昇順チェックを回避できても
 * `buildComboOddsCellMap`が逆順2組の値不一致でthrowする(いずれもcombo-odds-key.tsの
 * 実装がbetType非対応のまま馬単に流用された場合の欠陥。着手前ゲートの実測参照)。
 */
describe("parseComboOdds(馬単。Issue #106・#24-B AC-B6・AC-B9)", () => {
  it("実フィクスチャ(16頭・P(16,2)=240件)をthrowせず全件パースできること", () => {
    const odds = expectAvailable(parseComboOdds(loadFixture("odds_exacta_202603020211.json"), "exacta"));
    expect(odds.size).toBe(240);
  });

  it("逆順の組(1着13・2着8 と 1着8・2着13)が別キー・別値のまま保持されること", () => {
    const odds = expectAvailable(parseComboOdds(loadFixture("odds_exacta_202603020211.json"), "exacta"));
    const forwardKey = buildOrderedComboOddsKey([13, 8]);
    const backwardKey = buildOrderedComboOddsKey([8, 13]);
    expect(forwardKey).toBe("1308");
    expect(backwardKey).toBe("0813");
    const forward = odds.get(forwardKey);
    const backward = odds.get(backwardKey);
    expect(forward?.oddsMin).toBe(83.6);
    expect(backward?.oddsMin).toBe(118.8);
    expect(forward?.oddsMin).not.toBe(backward?.oddsMin);
  });

  it("馬単は3連複と同じく単一値の券種であり、oddsMaxは常にnullであること", () => {
    const odds = expectAvailable(parseComboOdds(loadFixture("odds_exacta_202603020211.json"), "exacta"));
    expect(odds.size).toBeGreaterThan(0);
    for (const cell of odds.values()) {
      expect(cell.oddsMax).toBeNull();
    }
  });
});

/**
 * 馬連(quinella、type=4)の配線(Issue #113・#24-D2 AC-1・AC-2)。
 *
 * 馬連はワイド・3連複と同じ「順不同の組」であり、キーは昇順に正規化される
 * (中央 "0813" = 45.5倍・19人気。"1308" は存在しない。着手前ゲートで実測確認済み:
 * `python3 -c "import json;o=json.load(open('fixtures/odds_quinella_202603020211.json'))['data']['odds']['4'];print(len(o),o.get('0813'),o.get('1308'))"`
 * → `120 ['45.5', '0.0', '19'] None`)。確定払戻(馬連8-13=4,550円・19人気)との突合は
 * オッズ・人気の両方が一致することをリテラルで固定する(集合一致だけでは値の取り違えを
 * 検出できない。#103の教訓)。
 */
describe("parseComboOdds(馬連。Issue #113・#24-D2 AC-1・AC-2)", () => {
  it("実フィクスチャ(16頭・C(16,2)=120件)をthrowせず全件パースできること", () => {
    const odds = expectAvailable(parseComboOdds(loadFixture("odds_quinella_202603020211.json"), "quinella"));
    expect(odds.size).toBe(120);
  });

  it("キーは昇順に正規化されること(\"0813\"はあるが\"1308\"は無い。ワイド・3連複と同じ順不同の組)", () => {
    const odds = expectAvailable(parseComboOdds(loadFixture("odds_quinella_202603020211.json"), "quinella"));
    expect(odds.has("0813")).toBe(true);
    expect(odds.has("1308")).toBe(false);
  });

  it("AC-2: 確定払戻(馬連8-13=4,550円・19人気)とキー\"0813\"のオッズ・人気がリテラルで一致すること", () => {
    const odds = expectAvailable(parseComboOdds(loadFixture("odds_quinella_202603020211.json"), "quinella"));
    const cell = odds.get("0813");
    expect(cell).toBeDefined();
    expect(cell?.oddsMin).toBe(45.5);
    expect(cell?.ninki).toBe(19);
  });

  it("馬連は3連複と同じく単一値の券種であり、oddsMaxは常にnullであること", () => {
    const odds = expectAvailable(parseComboOdds(loadFixture("odds_quinella_202603020211.json"), "quinella"));
    expect(odds.size).toBeGreaterThan(0);
    for (const cell of odds.values()) {
      expect(cell.oddsMax).toBeNull();
    }
  });

  it("未発売の封筒異常(dataが空文字列。type非依存のためワイド用フィクスチャを流用)をthrowせずunavailableに分類できること", () => {
    const json = loadFixture("odds_wide_presale_202604020511_20260806.json");
    const result = parseComboOdds(json, "quinella");
    expect(result.state).toBe("unavailable");
    if (result.state !== "unavailable") throw new Error("unreachable");
    expect(result.reason).toEqual({
      rawStatus: "NG",
      rawReason: "empty free odds schedule",
      missingKey: "data",
    });
  });
});

/**
 * 三連単(trifecta、type=8)の配線(Issue #130・#25-D)。
 *
 * 三連単は馬単と同じ「着順が意味を持つ並び」であり、キーはソートしない
 * (実測: 13→8→5=52,690円のキーは"130805"。docs/trifecta-odds-investigation.md §5.2)。
 *
 * ★このdescribeは実装前(betType="trifecta"をJSON_ODDS_KEY/decodeRawKey/
 * buildComboOddsCellMapが順序未対応のまま)ではRedになる(馬単と同型の欠陥)。
 */
describe("parseComboOdds(三連単。Issue #130・#25-D)", () => {
  it("実フィクスチャ(16頭・P(16,3)=3360件)をthrowせず全件パースできること", () => {
    const odds = expectAvailable(parseComboOdds(loadFixture("odds_trifecta_202603020211.json"), "trifecta"));
    expect(odds.size).toBe(3360);
  });

  it("完全反転(1着↔3着)の組(13→8→5 と 5→8→13)が別キー・別値のまま保持されること", () => {
    const odds = expectAvailable(parseComboOdds(loadFixture("odds_trifecta_202603020211.json"), "trifecta"));
    const forwardKey = buildOrderedComboOddsKey([13, 8, 5]);
    const backwardKey = buildOrderedComboOddsKey([5, 8, 13]);
    expect(forwardKey).toBe("130805");
    expect(backwardKey).toBe("050813");
    const forward = odds.get(forwardKey);
    const backward = odds.get(backwardKey);
    expect(forward?.oddsMin).toBe(526.9);
    expect(backward?.oddsMin).toBe(442.7);
    expect(forward?.oddsMin).not.toBe(backward?.oddsMin);
  });

  it("AC-A3(b): 中央の確定払戻(13→8→5=52,690円)とキー\"130805\"のオッズが一致すること", () => {
    const odds = expectAvailable(parseComboOdds(loadFixture("odds_trifecta_202603020211.json"), "trifecta"));
    const cell = odds.get("130805");
    expect(cell).toBeDefined();
    expect(cell?.oddsMin).toBeCloseTo(526.9, 5);
  });

  it("三連単は3連複と同じく単一値の券種であり、oddsMaxは常にnullであること", () => {
    const odds = expectAvailable(parseComboOdds(loadFixture("odds_trifecta_202603020211.json"), "trifecta"));
    expect(odds.size).toBeGreaterThan(0);
    for (const cell of odds.values()) {
      expect(cell.oddsMax).toBeNull();
    }
  });
});

/**
 * 上限キャップ値"999,999.9"のnull化(Issue #130・#25-D。オーケストレーター裁定2026-09-26)。
 *
 * 中央presale(`status:"middle"`)応答では、票数がまだ少ない組合せがこの値で表示される
 * (実測3360件中2644件〈78.7%〉。docs/trifecta-odds-investigation.md §6.2)。実オッズとして
 * 読むとEVが桁外れのプラスになり配分が偏るため、欠損(null)として扱う。
 *
 * ★この変換は「組合せ券種共通のパーサ(`parseComboOdds`)の中で券種分岐させない」実装であり
 * (オーケストレーター裁定の言葉どおり)、`toOddsNumber`(単勝・複勝・過去走とも共有する
 * より広いヘルパ)には入れない。したがって(c)は三連単以外の券種の合成データでも
 * 同じくnull化されることを確認する。
 */
describe("parseComboOdds(上限キャップ値'999,999.9'のnull化。Issue #130・#25-D)", () => {
  /** テスト専用の最小限の組合せオッズJSON応答を組み立てる(封筒構造は本番と同じ)。 */
  function buildEnvelope(
    status: string,
    typeKey: string,
    odds: Record<string, [string, string, string]>,
  ): string {
    return JSON.stringify({ status, reason: "", data: { odds: { [typeKey]: odds } } });
  }

  it("(a) 三連単の発売中フィクスチャ(実物): 上限値2644件がnullになり、残り716件は数値で残ること(再現: node -e スクリプトで別途確認した実測値と一致)", () => {
    const odds = expectAvailable(
      parseComboOdds(loadFixture("odds_trifecta_presale_202606040901_20260926.json"), "trifecta"),
    );
    // 前提を無条件expectで先に固定(空振り防止): 全体が3360件(P(16,3))であること。
    expect(odds.size).toBe(3360);

    const nullCells = [...odds.values()].filter((c) => c.oddsMin === null);
    const numericCells = [...odds.values()].filter((c) => c.oddsMin !== null);
    expect(nullCells.length).toBe(2644);
    expect(numericCells.length).toBe(716);

    // 個別サンプル(実測。node -e '...odds_trifecta_presale_202606040901_20260926.json...'で確認済み)。
    expect(odds.get("100102")?.oddsMin).toBeNull(); // 上限値"999,999.9"のセル
    expect(odds.get("100107")?.oddsMin).toBeCloseTo(1992.3, 5); // 実数らしい値のセル
  });

  it("(b) 上限値のすぐ隣の値(999,999.8)はnullにならないこと(丁度999999.9だけを特別扱いすることの確認)", () => {
    const json = buildEnvelope("middle", "8", {
      "010203": ["999,999.9", "0.0", "1"],
      "040506": ["999,999.8", "0.0", "2"],
    });
    const odds = expectAvailable(parseComboOdds(json, "trifecta"));
    expect(odds.get("010203")?.oddsMin).toBeNull();
    expect(odds.get("040506")?.oddsMin).toBeCloseTo(999999.8, 5);
  });

  it("(c) 券種に依存しないこと(ワイド・馬単の合成JSONに上限値を入れてもnullになる。券種で分岐させない実装であることの直接証拠)", () => {
    const wideJson = buildEnvelope("middle", "5", {
      "0102": ["999,999.9", "999,999.9", "1"],
    });
    const wideOdds = expectAvailable(parseComboOdds(wideJson, "wide"));
    // ワイドはoddsMin・oddsMaxとも上限値を読みうる(幅を持つ券種のため)。両方nullになること。
    expect(wideOdds.get("0102")?.oddsMin).toBeNull();
    expect(wideOdds.get("0102")?.oddsMax).toBeNull();

    const exactaJson = buildEnvelope("middle", "6", {
      "0102": ["999,999.9", "0.0", "1"],
    });
    const exactaOdds = expectAvailable(parseComboOdds(exactaJson, "exacta"));
    expect(exactaOdds.get("0102")?.oddsMin).toBeNull();
  });

  it("(d) 既存フィクスチャ(ワイド・3連複)のパース結果は上限値の導入前後で変わらないこと(回帰確認。上限値を含まない実測データのため無条件expectで件数・代表値を固定)", () => {
    const wideOdds = expectAvailable(parseComboOdds(loadFixture("odds_wide_202603020211.json"), "wide"));
    expect(wideOdds.size).toBe(120); // C(16,2)。既存挙動と同じ(#13実測)。
    const trioOdds = expectAvailable(parseComboOdds(loadFixture("odds_trio_202603020211.json"), "trio"));
    expect(trioOdds.size).toBe(560); // C(16,3)。既存挙動と同じ(#13実測)。
    // 前提: 既存フィクスチャに上限値"999,999.9"は1件も含まれないこと(このテストが検出対象を
    // 持っていることの確認。含まれていれば(d)の主張〈変わらない〉が無意味になる)。
    for (const cell of [...wideOdds.values(), ...trioOdds.values()]) {
      expect(cell.oddsMin).not.toBe(999999.9);
    }
  });
});
