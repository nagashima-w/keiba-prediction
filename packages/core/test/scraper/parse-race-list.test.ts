import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRaceList } from "../../src/scraper/parse-race-list.js";
import type { RaceListEntry } from "../../src/scraper/types.js";

/** フィクスチャHTMLを読み込む(実ネットワークは使わない)。 */
function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

const html = loadFixture("race_list_sub_20260628.html");
const entries = parseRaceList(html);

/** race_idで1件を取り出す小ヘルパ。 */
function byRaceId(id: string): RaceListEntry {
  const e = entries.find((x) => x.raceId === id);
  if (!e) {
    throw new Error(`race_id=${id} のエントリが見つかりません`);
  }
  return e;
}

describe("parseRaceList(レース一覧サブHTMLのパース)", () => {
  it("3場36レースをすべて抽出すること", () => {
    expect(entries).toHaveLength(36);
  });

  it("ラジオNIKKEI賞(202603020211)の条件を正しく抽出すること", () => {
    const e = byRaceId("202603020211");
    // 注: race_list_sub のレース名はサーバ側で切り詰められており、full名は出馬表から取る。
    expect(e.name).toBe("ラジオNIK");
    expect(e.courseType).toBe("芝");
    expect(e.distance).toBe(1800);
    expect(e.entryCount).toBe(16);
    expect(e.venue).toBe("福島");
    expect(e.raceNumber).toBe(11);
  });

  it("障害レース(202603020201)を種別「障」として抽出すること", () => {
    // 障害レースは距離spanのclassが付かないため、テキストからの抽出が必要になる境界ケース。
    const e = byRaceId("202603020201");
    expect(e.name).toBe("3歳以上障害未勝利");
    expect(e.courseType).toBe("障");
    expect(e.distance).toBe(2750);
    expect(e.entryCount).toBe(14);
    expect(e.venue).toBe("福島");
    expect(e.raceNumber).toBe(1);
  });

  it("3場それぞれ12レースずつ、会場名が付与されていること", () => {
    const venues = new Map<string, number>();
    for (const e of entries) {
      venues.set(e.venue ?? "", (venues.get(e.venue ?? "") ?? 0) + 1);
    }
    expect(venues.get("福島")).toBe(12);
    expect(venues.get("小倉")).toBe(12);
    expect(venues.get("函館")).toBe(12);
  });

  it("全エントリのrace_idが12桁で、距離・頭数が正の数であること", () => {
    for (const e of entries) {
      expect(e.raceId).toMatch(/^\d{12}$/);
      expect(e.distance).toBeGreaterThan(0);
      expect(e.entryCount).toBeGreaterThan(0);
      expect(e.raceNumber).toBeGreaterThanOrEqual(1);
      expect(e.raceNumber).toBeLessThanOrEqual(12);
    }
  });

  it("空HTMLでは空配列を返すこと", () => {
    expect(parseRaceList("")).toEqual([]);
  });

  it("無関係なHTMLでは空配列を返すこと", () => {
    expect(parseRaceList("<html><body><p>hello</p></body></html>")).toEqual([]);
  });
});

describe("parseRaceList(地方(NAR)フィクスチャの互換性)", () => {
  const html0712 = loadFixture("nar_race_list_sub_20260712.html");
  const entries0712 = parseRaceList(html0712);
  const html0713 = loadFixture("nar_race_list_sub_20260713.html");
  const entries0713 = parseRaceList(html0713);

  it("2026-07-12(4場44レース中、ばんえい12レースを除く32レース)を抽出すること", () => {
    expect(entries0712).toHaveLength(32);
  });

  it("2026-07-13(4場48レース中、ばんえい12レースを除く36レース)を抽出すること", () => {
    expect(entries0713).toHaveLength(36);
  });

  it("帯広(ばんえい・場コード65)のレースが1件も含まれないこと", () => {
    for (const e of [...entries0712, ...entries0713]) {
      const trackCode = Number(e.raceId.slice(4, 6));
      expect(trackCode).not.toBe(65);
    }
  });

  it("地方の頭数(NARはRaceList_Itemnumberのラップが無くdiv直下のテキスト)を正しく抽出すること", () => {
    // 盛岡1R(202635071201): 「ダ1000m」直後に「8頭」がプレーンテキストで入る。
    const e = entries0712.find((x) => x.raceId === "202635071201");
    expect(e).toBeDefined();
    expect(e!.entryCount).toBe(8);
    expect(e!.courseType).toBe("ダ");
    expect(e!.distance).toBe(1000);
  });

  it("全エントリで頭数が正しく取れていること(0落ちが無いこと)", () => {
    for (const e of [...entries0712, ...entries0713]) {
      expect(e.entryCount).toBeGreaterThan(0);
    }
  });

  it("高知(202654071210)を含み、場コードが地方範囲(30〜64)であること", () => {
    const e = entries0712.find((x) => x.raceId === "202654071210");
    expect(e).toBeDefined();
    expect(Number(e!.raceId.slice(4, 6))).toBe(54);
  });

  it("2026-07-13の唯一のOP表記(帯広ばんえい)はばんえい除外により1件もgrade=\"OP\"として現れないこと", () => {
    // nar_race_list_sub_20260713.html には Icon_Grade_None_Text(OP)が1件のみ存在するが、
    // その直前のレースリンクは race_id=202665071311(場コード65=帯広ばんえい)であり、
    // ばんえい除外ロジック(parseRaceId が場コード65を拒否)により entries には含まれない。
    // grade抽出の追加によってこのばんえい除外が壊れていないことを明示的に固定する。
    expect(entries0713.some((e) => e.grade === "OP")).toBe(false);
    expect(entries0713.find((e) => e.raceId === "202665071311")).toBeUndefined();
  });
});

describe("parseRaceList(グレードラベルの抽出)", () => {
  it("実物のJpn1表記(さきたま杯・浦和、2026-06-24)をアラビア数字の\"Jpn1\"としてexact抽出すること", () => {
    // 実測: Icon_Grade_None_Text の内テキストはアラビア数字「Jpn1」(ローマ数字ではない)。
    const html = loadFixture("nar_race_list_sub_20260624.html");
    const entries = parseRaceList(html);
    const e = entries.find((x) => x.raceId === "202642062411");
    expect(e).toBeDefined();
    expect(e!.grade).toBe("Jpn1");
  });

  it("実物の地方重賞表記(20260712、非ばんえい2件)を\"重賞\"として抽出すること", () => {
    const html = loadFixture("nar_race_list_sub_20260712.html");
    const entries = parseRaceList(html);
    const yamabiko = entries.find((x) => x.raceId === "202635071211"); // 盛岡・やまびこ賞
    const kanazawa = entries.find((x) => x.raceId === "202646071210"); // 金沢
    expect(yamabiko).toBeDefined();
    expect(yamabiko!.grade).toBe("重賞");
    expect(kanazawa).toBeDefined();
    expect(kanazawa!.grade).toBe("重賞");
  });

  it("OP表記(実物マークアップを忠実に再現した合成HTML)を\"OP\"として抽出すること", () => {
    // 実物(nar_race_list_sub_20260713.html)で観測した唯一のOP表記は帯広ばんえいのレースで
    // entriesから除外されてしまうため実データでは検証できない(上のdescribeブロックで別途固定)。
    // ここでは実測した class 表記
    //   class="Icon_Grade_None_Text Icon_GradeType Icon_GradeType5 Icon_GradePos01"
    // をそのまま用い、簡略化せず忠実に再現した合成HTMLで抽出を検証する。
    const html = `
<dl class="RaceList_DataList">
<dt class="RaceList_DataHeader" >
<p class="RaceList_DataTitle ">
<small>1回</small>
盛岡
<small>1日目</small>
</p>
</dt>
<dd class="RaceList_Data ">
<ul style="position: relative">
<li class="RaceList_DataItem ">
<a href="../race/shutuba.html?race_id=202635071311&rf=race_list" class="">
<div class="Race_Num">
<span>
<span class="MyRace_List_Item" id="myrace_202635071311" style="display: none;"></span>
11R
</span>
</div>
<div class="RaceList_ItemContent">
<div class="RaceList_ItemTitle">
<span class="ItemTitle">瑞鳳賞(OP)</span>
<span class="Icon_Grade_None_Text Icon_GradeType Icon_GradeType5 Icon_GradePos01">OP</span>
</div>
<div class="RaceData">
<span>20:00</span>
<span class="Dart">ダ1600m</span>
10頭
</div>
</div>
</a>
</li>
</ul>
</dd>
</dl>`;
    const entries = parseRaceList(html);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.grade).toBe("OP");
  });

  it("中央(20260628)のグレードアイコンは内テキストが空のため、grade=undefinedのままであること(空文字を拾わない)", () => {
    // 中央は Icon_Grade_None_Text クラスを持たず、画像アイコン方式(内テキスト空)の
    // Icon_GradeType のみが付く。空文字を grade="" として拾わず undefined にする契約を固定する。
    const html = loadFixture("race_list_sub_20260628.html");
    const entries = parseRaceList(html);
    const e = entries.find((x) => x.raceId === "202603020209"); // 松島特別(Icon_GradeType17)
    expect(e).toBeDefined();
    expect(e!.grade).toBeUndefined();
  });

  it("グレード表記の無いNARレースはgrade=undefinedであること", () => {
    const html = loadFixture("nar_race_list_sub_20260712.html");
    const entries = parseRaceList(html);
    const e = entries.find((x) => x.raceId === "202635071201"); // ファーストステップ(無印)
    expect(e).toBeDefined();
    expect(e!.grade).toBeUndefined();
  });

  it("境界値: グレード span が存在しない行ではgrade=undefinedであること", () => {
    const html = `
<dl class="RaceList_DataList">
<dd class="RaceList_Data ">
<ul>
<li class="RaceList_DataItem ">
<a href="../race/shutuba.html?race_id=202601010101&rf=race_list" class="">
<div class="Race_Num"><span>1R</span></div>
<div class="RaceList_ItemContent">
<div class="RaceList_ItemTitle">
<span class="ItemTitle">3歳未勝利</span>
</div>
<div class="RaceData"><span>10:00</span><span class="Dart">ダ1200m</span>10頭</div>
</div>
</a>
</li>
</ul>
</dd>
</dl>`;
    const entries = parseRaceList(html);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.grade).toBeUndefined();
  });

  it("境界値: グレード span が複数存在する行では先頭のspanを採用すること", () => {
    const html = `
<dl class="RaceList_DataList">
<dd class="RaceList_Data ">
<ul>
<li class="RaceList_DataItem ">
<a href="../race/shutuba.html?race_id=202601010101&rf=race_list" class="">
<div class="Race_Num"><span>1R</span></div>
<div class="RaceList_ItemContent">
<div class="RaceList_ItemTitle">
<span class="ItemTitle">架空重賞</span>
<span class="Icon_Grade_None_Text Icon_GradeType Icon_GradeType19 Icon_GradePos01">Jpn1</span>
<span class="Icon_Grade_None_Text Icon_GradeType Icon_GradeType4 Icon_GradePos01">重賞</span>
</div>
<div class="RaceData"><span>10:00</span><span class="Dart">ダ1200m</span>10頭</div>
</div>
</a>
</li>
</ul>
</dd>
</dl>`;
    const entries = parseRaceList(html);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.grade).toBe("Jpn1");
  });
});
