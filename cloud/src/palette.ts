/**
 * 配色(Issue #239。カラーユニバーサルデザイン)。**色の正はこのファイルの1箇所**で、web の CSS 変数(`page.ts`)と Discord の帯の色(`notify-embeds.ts`・`daily-report-embed.ts`)がここから作る。
 * 純粋なモジュール(依存なし)。クライアントの束には入れない。
 *
 * 考え方: P・D 型の色覚では「赤↔緑」「赤↔茶」の差が縮む。残る手がかりは「青↔黄」の軸と明度なので、状態の3色(ok・wait・fail)は、色相の差だけに頼らず明度も離した。
 * 全体の雰囲気は変えず、緑は青みの緑、赤は朱〜煉瓦色に寄せた。状態は色だけで示さない(バッジ・通知には文字がある。文字のない所には記号を足した)。
 * 採用した色の根拠とテストは docs/current-spec.md の「配色」の節。数値(コントラスト比・色覚シミュレーション後の色差)は test/palette.test.ts が固定する。
 */

/** web の色(CSS 変数名から先頭の `--` を除いたもの)。 */
export interface WebPalette {
  readonly fg: string;
  readonly bg: string;
  readonly muted: string;
  readonly line: string;
  readonly card: string;
  readonly accent: string;
  /** 完了・成功・EVプラス。 */
  readonly ok: string;
  /** 待機・注意。 */
  readonly wait: string;
  /** 失敗・エラー。 */
  readonly fail: string;
}

export const WEB_LIGHT: WebPalette = {
  fg: "#1c1c1e",
  bg: "#ffffff",
  muted: "#6b6b70",
  line: "#d8d8dc",
  card: "#f5f5f7",
  accent: "#0a58ca",
  ok: "#177c55",
  wait: "#8e6610",
  fail: "#922b2b",
};

export const WEB_DARK: WebPalette = {
  fg: "#f2f2f5",
  bg: "#151517",
  muted: "#a0a0a8",
  line: "#3a3a3f",
  card: "#212125",
  accent: "#7cacf8",
  ok: "#7cd9ac",
  wait: "#e3b548",
  fail: "#ec7971",
};

/** Discord の embed の帯の色(0xRRGGBB)。 */
export const DISCORD_COLORS = {
  /** 狙い目あり・事前分析が全て完了・回収率 100% 以上。 */
  ok: 0x009e73,
  /** 一部の失敗・未完了。 */
  warn: 0xe69f00,
  /** 失敗・回収率 100% 未満。 */
  fail: 0xd02040,
  /** 狙い目なし・手動の分析ありでスキップ・詳細なし・結果なし。 */
  none: 0x95a5a6,
} as const;

/** CSS 変数の並び(page.ts の `:root` の中の順)。 */
const WEB_KEYS = ["fg", "bg", "muted", "line", "card", "accent", "ok", "wait", "fail"] as const;

function variables(palette: WebPalette): string {
  return WEB_KEYS.map((key) => `--${key}: ${palette[key]};`).join(" ");
}

/** ページの `<style>` の先頭に置く CSS 変数(ライトと、`prefers-color-scheme: dark` のときのダーク)。 */
export function paletteCss(): string {
  return `  :root { ${variables(WEB_LIGHT)} }\n  @media (prefers-color-scheme: dark) { :root { ${variables(WEB_DARK)} } }`;
}
