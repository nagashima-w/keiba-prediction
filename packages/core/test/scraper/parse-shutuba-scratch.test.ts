import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseShutuba,
  ShutubaParseError,
} from "../../src/scraper/parse-shutuba.js";

/**
 * Issue #154: 出馬表に残った取消・除外の馬を `parseShutuba` が読み取ること。
 *
 * 実物は中央 202606040901(2026-09-27 中山1R・発走後に取得)の1本のみ。そこでは取消馬の行が
 * `<tr class="HorseList Cancel">`、印が `<td class="Cancel_Txt">取消</td>` だった。
 * 次は**実物を観測していない**ため、同じ雛形・同じ印と見込んだうえで合成HTMLで検証する:
 *  - 発走前の時点の印(観測は発走後のみ)
 *  - 地方(nar.netkeiba.com)の出馬表の印(取消の例を持つ地方フィクスチャが無い)
 *  - 「除外」の文言(実物なし)
 */

function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

/** 合成用の最小行。`rowClass` と `cancelCell` で取消・除外の印を差し替える。 */
function buildRow(opts: {
  umaban: number;
  rowClass?: string;
  cancelCell?: string;
}): string {
  const n = opts.umaban;
  const rowClass = opts.rowClass ?? "HorseList";
  return `
    <tr class="${rowClass}">
      <td class="Waku${Math.min(n, 8)} Txt_C"><span>${Math.min(n, 8)}</span></td>
      <td class="Umaban${n} Txt_C">${n}</td>
      ${opts.cancelCell ?? ""}
      <td class="HorseInfo"><span class="HorseName"><a href="https://db.netkeiba.com/horse/20231033${String(n).padStart(2, "0")}" title="テスト馬${n}">テスト馬${n}</a></span></td>
      <td class="Barei Txt_C">牡3</td>
      <td class="Txt_C">55.0</td>
      <td class="Jockey"><a href="https://db.netkeiba.com/jockey/result/recent/01043/" title="騎手">騎手</a></td>
      <td class="Trainer"><span class="Label1">美浦</span><a href="https://db.netkeiba.com/trainer/result/recent/01126/" title="調教師">調教師</a></td>
      <td class="Weight">464(-8)</td>
    </tr>`;
}

function buildPage(rows: string[]): string {
  return `
    <div class="RaceList_Item02">
      <h1 class="RaceName">テストレース</h1>
      <div class="RaceData01">15:45発走 / 芝1800m / 天候:晴 / 馬場:良</div>
    </div>
    <table><tbody>${rows.join("")}</tbody></table>`;
}

describe("parseShutuba: 取消・除外の読み取り(Issue #154)", () => {
  describe("実フィクスチャ shutuba_202606040901.html(中央・取消馬1頭)", () => {
    const shutuba = parseShutuba(loadFixture("shutuba_202606040901.html"));

    it("実データ行16行をすべて返し、取消馬を落とさないこと(除外は呼び出し側の責務)", () => {
      expect(shutuba.horses).toHaveLength(16);
    });

    it("馬番6(ニシノドリーマー)だけが取消印を持ち、区分は「取消」・原文は「取消」であること", () => {
      const scratched = shutuba.horses.filter((h) => h.scratch !== undefined);
      // 前提を無条件に固定する(0頭や2頭以上なら以降が空振りになる)。
      expect(scratched.map((h) => h.umaban)).toEqual([6]);
      expect(scratched[0]!.name).toBe("ニシノドリーマー");
      expect(scratched[0]!.scratch).toBe("取消");
      expect(scratched[0]!.scratchText).toBe("取消");
    });

    it("取消でない15頭は scratch / scratchText を持たないこと(キー自体が無い)", () => {
      const runners = shutuba.horses.filter((h) => h.umaban !== 6);
      expect(runners).toHaveLength(15);
      for (const h of runners) {
        expect("scratch" in h, `馬番${h.umaban}`).toBe(false);
        expect("scratchText" in h, `馬番${h.umaban}`).toBe(false);
      }
    });
  });

  describe("既存の6フィクスチャ(取消の例が無い)は回帰しないこと", () => {
    const FIXTURES = [
      "shutuba_202602010601.html",
      "shutuba_202602010607.html",
      "shutuba_202603020211.html",
      "nar_shutuba_202642071301.html",
      "nar_shutuba_202654071210.html",
      "nar_shutuba_grade_202644070111.html",
    ];
    it.each(FIXTURES)("%s: 全馬が出走(scratch なし)で頭数が行数と一致すること", (name) => {
      const html = loadFixture(name);
      const shutuba = parseShutuba(html);
      // 実データ行 = td.HorseInfo を持つ行(HorseList の行にはダミー行が2行混じるため行数では数えない)。
      const runnerRowCount = (html.match(/<td class="HorseInfo"/g) ?? []).length;
      expect(runnerRowCount).toBeGreaterThan(0); // 前提固定。
      expect(shutuba.horses.length).toBe(runnerRowCount);
      expect(shutuba.horses.filter((h) => "scratch" in h)).toEqual([]);
    });
  });

  describe("合成HTML(区分・未知文言・防御)", () => {
    it("「除外」の文言は区分「除外」になること(合成。実物の文言は未観測で、取消と同じ雛形と見込む)", () => {
      const html = buildPage([
        buildRow({ umaban: 1 }),
        buildRow({
          umaban: 2,
          rowClass: "HorseList Cancel",
          cancelCell: `<td class="Cancel_Txt">除外</td>`,
        }),
      ]);
      const h2 = parseShutuba(html).horses.find((h) => h.umaban === 2)!;
      expect(h2.scratch).toBe("除外");
      expect(h2.scratchText).toBe("除外");
    });

    it("未知の文言は「不明」になり原文を保持すること(出走しない側に倒す。例外にしない)", () => {
      const html = buildPage([
        buildRow({ umaban: 1 }),
        buildRow({
          umaban: 2,
          rowClass: "HorseList Cancel",
          cancelCell: `<td class="Cancel_Txt">出走回避?</td>`,
        }),
      ]);
      const h2 = parseShutuba(html).horses.find((h) => h.umaban === 2)!;
      expect(h2.scratch).toBe("不明");
      expect(h2.scratchText).toBe("出走回避?");
    });

    it("Cancel クラスだけで文言が無い行も「不明」(原文は空)として出走しない側に倒すこと", () => {
      const html = buildPage([
        buildRow({ umaban: 1 }),
        buildRow({ umaban: 2, rowClass: "HorseList Cancel" }),
      ]);
      const h2 = parseShutuba(html).horses.find((h) => h.umaban === 2)!;
      expect(h2.scratch).toBe("不明");
      expect(h2.scratchText).toBe("");
    });

    it("Cancel クラスが無くても Cancel_Txt に文言があれば取消として読むこと(印の片方だけが変わった場合に備える)", () => {
      const html = buildPage([
        buildRow({ umaban: 1 }),
        buildRow({
          umaban: 2,
          cancelCell: `<td class="Cancel_Txt">取消</td>`,
        }),
      ]);
      const h2 = parseShutuba(html).horses.find((h) => h.umaban === 2)!;
      expect(h2.scratch).toBe("取消");
    });

    it("空の Cancel_Txt セルだけでは取消にしないこと(雛形に空セルがあっても誤検出しない)", () => {
      const html = buildPage([
        buildRow({ umaban: 1, cancelCell: `<td class="Cancel_Txt"></td>` }),
        buildRow({ umaban: 2 }),
      ]);
      const horses = parseShutuba(html).horses;
      expect(horses).toHaveLength(2);
      expect(horses.filter((h) => "scratch" in h)).toEqual([]);
    });

    it("メモ欄のボタン(Cancel_Btn01 / Cancel_Btn)は取消の印と取り違えないこと", () => {
      const html = buildPage([
        buildRow({
          umaban: 1,
          cancelCell: `<td><button class="NoteBtn01 Cancel_Btn01">削除</button><span class="Cancel_Btn">x</span></td>`,
        }),
        buildRow({ umaban: 2 }),
      ]);
      expect(parseShutuba(html).horses.filter((h) => "scratch" in h)).toEqual([]);
    });

    it("全馬が取消扱いなら ShutubaParseError で失敗すること(雛形変更で全行に印が付いた場合に空レースを静かに通さない)", () => {
      const html = buildPage([
        buildRow({
          umaban: 1,
          rowClass: "HorseList Cancel",
          cancelCell: `<td class="Cancel_Txt">取消</td>`,
        }),
        buildRow({
          umaban: 2,
          rowClass: "HorseList Cancel",
          cancelCell: `<td class="Cancel_Txt">取消</td>`,
        }),
      ]);
      expect(() => parseShutuba(html)).toThrow(ShutubaParseError);
      expect(() => parseShutuba(html)).toThrow(/取消|除外|出走/);
    });
  });

  describe("地方(NAR)の合成ケース(実物なし。中央と同じ雛形・同じ印と見込む前提)", () => {
    it("地方フィクスチャの1行に取消の印を足した合成HTMLで、その馬だけが取消になること", () => {
      const original = loadFixture("nar_shutuba_202654071210.html");
      // 馬番1の行を取消行に書き換える(合成。地方の取消の実物は未観測)。
      const rowOpen = `<tr class="HorseList" id="tr_1">`;
      const umabanCell = `<td class="Umaban1">1</td>`;
      expect(original.split(rowOpen)).toHaveLength(2); // 前提: 書き換え対象が一意。
      expect(original.split(umabanCell).length).toBeGreaterThanOrEqual(2);
      const synthetic = original
        .replace(rowOpen, `<tr class="HorseList Cancel" id="tr_">`)
        .replace(umabanCell, `${umabanCell}\n<td class="Cancel_Txt">取消</td>`);

      const base = parseShutuba(original);
      const shutuba = parseShutuba(synthetic);
      expect(shutuba.horses).toHaveLength(base.horses.length);
      const scratched = shutuba.horses.filter((h) => h.scratch !== undefined);
      expect(scratched.map((h) => h.umaban)).toEqual([1]);
      expect(scratched[0]!.scratch).toBe("取消");
      // 他の馬は元のパース結果と完全一致(印の追加が他の列の読み取りを乱さない)。
      expect(shutuba.horses.filter((h) => h.umaban !== 1)).toEqual(
        base.horses.filter((h) => h.umaban !== 1),
      );
    });
  });
});
