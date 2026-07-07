import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseHorseId } from "../../src/scraper/ids.js";
import {
  HorseProfileParseError,
  parseHorseProfile,
} from "../../src/scraper/parse-horse-profile.js";
import type { HorseProfile } from "../../src/scraper/types.js";

/** フィクスチャHTMLを読み込む(実ネットワークは使わない)。 */
function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

/** 合成ページの検証で使うダミー馬ID(所在地・欠損の分岐確認用)。 */
const DUMMY_ID = parseHorseId("2023103386");

const rouge: HorseProfile = parseHorseProfile(
  loadFixture("horse_2023103386.html"),
  parseHorseId("2023103386"),
);
const winter: HorseProfile = parseHorseProfile(
  loadFixture("horse_2021105857.html"),
  parseHorseId("2021105857"),
);

describe("parseHorseProfile(実データの全項目抽出)", () => {
  it("ルージュボヤージュ(2023103386)の全項目が一致すること", () => {
    expect(rouge.horseId).toBe("2023103386");
    expect(rouge.name).toBe("ルージュボヤージュ");
    expect(rouge.birthDate).toBe("2023年2月17日");
    expect(rouge.trainerName).toBe("木村哲也");
    expect(rouge.trainerId).toBe("01126");
    expect(rouge.stableLocation).toBe("美浦");
    expect(rouge.totalResults).toBe("4戦2勝 [2-0-0-2]");
  });

  it("ウィンターガーデン(2021105857)は栗東所属として抽出すること", () => {
    expect(winter.horseId).toBe("2021105857");
    expect(winter.name).toBe("ウィンターガーデン");
    expect(winter.birthDate).toBe("2021年4月15日");
    expect(winter.trainerName).toBe("井上智史");
    expect(winter.trainerId).toBe("01214");
    expect(winter.stableLocation).toBe("栗東");
  });
});

describe("parseHorseProfile(厩舎所在地の扱い)", () => {
  it("美浦/栗東以外の未知表記(地方・海外)は既知値に丸めずそのまま保持すること", () => {
    const html = buildProfilePage({
      trainerCell:
        '<a href="/trainer/99999/" title="外国人調教師">外国人調教師</a> (仏)',
    });
    const p = parseHorseProfile(html, DUMMY_ID);
    expect(p.stableLocation).toBe("仏");
    expect(p.trainerName).toBe("外国人調教師");
    expect(p.trainerId).toBe("99999");
  });

  it("所在地(括弧)が無い調教師表記では stableLocation が null になること", () => {
    const html = buildProfilePage({
      trainerCell: '<a href="/trainer/12345/" title="調教師">調教師</a>',
    });
    const p = parseHorseProfile(html, DUMMY_ID);
    expect(p.stableLocation).toBeNull();
    expect(p.trainerId).toBe("12345");
  });
});

describe("parseHorseProfile(欠損項目のnull許容)", () => {
  it("通算成績の行が無い(未出走)場合は totalResults が null になること", () => {
    const html = buildProfilePage({ includeTotal: false });
    const p = parseHorseProfile(html, DUMMY_ID);
    expect(p.totalResults).toBeNull();
  });

  it("調教師リンクが無い行では trainerId が null になること", () => {
    const html = buildProfilePage({ trainerCell: "未定 (美浦)" });
    const p = parseHorseProfile(html, DUMMY_ID);
    expect(p.trainerId).toBeNull();
    expect(p.stableLocation).toBe("美浦");
  });
});

describe("parseHorseProfile(構造異常は失敗)", () => {
  it("db_prof_table も馬名見出しも無いHTMLは HorseProfileParseError になること", () => {
    expect(() =>
      parseHorseProfile("<html><body>無関係</body></html>", DUMMY_ID),
    ).toThrow(HorseProfileParseError);
  });
});

/**
 * プロフィールページを合成する。境界値(未知所在地・欠損)を検証するための最小構造。
 */
function buildProfilePage(
  opts: {
    trainerCell?: string;
    includeTotal?: boolean;
  } = {},
): string {
  const trainerCell =
    opts.trainerCell ??
    '<a href="/trainer/01126/" title="木村哲也">木村哲也</a> (美浦)';
  const includeTotal = opts.includeTotal ?? true;
  const totalRow = includeTotal
    ? `<tr><th>通算成績</th><td>4戦2勝 [<a href="/horse/result/2023103386/">2-0-0-2</a>]</td></tr>`
    : "";
  return `
    <div class="horse_title"><h1>テスト馬</h1></div>
    <table class="db_prof_table">
      <tr><th>生年月日</th><td>2023年2月17日</td></tr>
      <tr><th>調教師</th><td>${trainerCell}</td></tr>
      ${totalRow}
    </table>`;
}
