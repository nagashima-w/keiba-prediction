/**
 * JRA の馬ごとの頁(`accessU.html`。Issue #697)から、馬名・父・母・母の父・生産者を読む(純関数)。
 *
 * - 判定は `<title>` で行う。誤りの頁は状態コード 200 のまま `パラメータエラー　JRA` が返る(`docs/investigations/past-blinker-695.md` §9.2)。
 * - 欄は `div.profile > div.data > ul > li > dl` の `dt` のラベルで引く。外国産馬は「生産牧場」でなく「生産者」。母の欄の `span.sanku`(産駒へのリンク)は除く。
 * - 馬名は `h1 span.txt` の直接の文字(`span.opt`〈「競走馬情報」〉・`span.name_en`〈英名〉・`span.rest`〈放牧など〉・マルガイの画像は除く)。
 * - 馬主・母の母・生年月日などは読まない(保存先の列が無い。ユーザーの決定)。
 */
import * as cheerio from "cheerio";

export interface HorseProfile {
  readonly name: string;
  readonly sire: string | null;
  readonly dam: string | null;
  readonly damSire: string | null;
  readonly breeder: string | null;
}

export type HorseProfileFailure = "param-error" | "not-profile" | "unparsable";

export type HorseProfileParse = { readonly ok: true; readonly profile: HorseProfile } | { readonly ok: false; readonly reason: HorseProfileFailure };

/** 値の長さの上限(文字)。想定外に長い頁で表を膨らませない。 */
const MAX_VALUE_CHARS = 100;

function clean(text: string): string | null {
  const t = text.replace(/\s+/g, " ").trim();
  return t === "" ? null : t.slice(0, MAX_VALUE_CHARS);
}

export function parseHorseProfilePage(html: string): HorseProfileParse {
  const $ = cheerio.load(html);
  const title = $("title").first().text().trim();
  if (title.startsWith("パラメータエラー")) return { ok: false, reason: "param-error" };
  if (!title.startsWith("競走馬情報")) return { ok: false, reason: "not-profile" };

  const name = clean(
    $("h1 span.txt")
      .first()
      .contents()
      .filter((_, n) => n.type === "text")
      .text(),
  );
  if (name === null) return { ok: false, reason: "unparsable" };

  const fields = new Map<string, string | null>();
  $("div.profile > div.data > ul > li > dl").each((_, dl) => {
    const label = $(dl).children("dt").first().text().trim();
    if (label === "" || fields.has(label)) return;
    const dd = $(dl).children("dd").first().clone();
    dd.find("span.sanku").remove();
    fields.set(label, clean(dd.text()));
  });

  return {
    ok: true,
    profile: {
      name,
      sire: fields.get("父") ?? null,
      dam: fields.get("母") ?? null,
      damSire: fields.get("母の父") ?? null,
      breeder: fields.get("生産牧場") ?? fields.get("生産者") ?? null,
    },
  };
}
