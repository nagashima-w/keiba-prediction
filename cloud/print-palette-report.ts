/**
 * 配色(Issue #239。palette.ts)の実測値を標準出力に出す(docs/current-spec.md の「配色」の節に書いた数値の再現用)。
 *
 *  - web のライト・ダーク: 文字色(fg・muted・accent・ok・wait・fail)の `--bg`・`--card` に対するコントラスト比と、
 *    状態の3組(ok–wait・ok–fail・wait–fail)+ 強調色と状態の3組(accent–ok・accent–wait・accent–fail)の ΔE2000(通常・P・D・T 型)と、その最小値。
 *  - Discord の帯の4色: 全6組の ΔE2000 と最小値。
 *
 * 使い方(cloud/ で): `pnpm exec tsx print-palette-report.ts`。ネットワーク・API には出ない。判定(閾値)は test/palette.test.ts。
 */
import { DISCORD_COLORS, WEB_DARK, WEB_LIGHT, type WebPalette } from "./src/palette";
import { CVD_TYPES, contrastRatio, deltaE2000Hex, intToHex } from "./test/color-science";

function minOver(a: string, b: string): { values: string; min: number } {
  const per = CVD_TYPES.map((t) => deltaE2000Hex(a, b, t));
  return { values: CVD_TYPES.map((t, i) => `${t[0]!.toUpperCase()}:${per[i]!.toFixed(1)}`).join(" "), min: Math.min(...per) };
}

function web(name: string, p: WebPalette): void {
  console.log(`== web ${name}`);
  for (const key of ["fg", "muted", "accent", "ok", "wait", "fail"] as const) {
    console.log(`  ${key.padEnd(6)} ${p[key]}  bg ${contrastRatio(p[key], p.bg).toFixed(2)}  card ${contrastRatio(p[key], p.card).toFixed(2)}`);
  }
  const pairs: readonly (readonly ["ok" | "wait" | "fail" | "accent", "ok" | "wait" | "fail"])[] = [
    ["ok", "wait"], ["ok", "fail"], ["wait", "fail"], ["accent", "ok"], ["accent", "wait"], ["accent", "fail"],
  ];
  let worst = Number.POSITIVE_INFINITY;
  for (const [a, b] of pairs) {
    const r = minOver(p[a], p[b]);
    worst = Math.min(worst, r.min);
    console.log(`  ${`${a}-${b}`.padEnd(12)} ${r.values}`);
  }
  console.log(`  最小の ΔE2000: ${worst.toFixed(1)}`);
}

web("ライト", WEB_LIGHT);
web("ダーク", WEB_DARK);

console.log("== Discord の帯");
const names = ["ok", "warn", "fail", "none"] as const;
let worst = Number.POSITIVE_INFINITY;
for (let i = 0; i < names.length; i += 1) {
  for (let j = i + 1; j < names.length; j += 1) {
    const r = minOver(intToHex(DISCORD_COLORS[names[i]!]), intToHex(DISCORD_COLORS[names[j]!]));
    worst = Math.min(worst, r.min);
    console.log(`  ${`${names[i]}-${names[j]}`.padEnd(10)} ${r.values}`);
  }
}
console.log(`  最小の ΔE2000: ${worst.toFixed(1)}`);

// 参考: 旧配色(Issue #239 より前)。閾値を満たさなかったことの確認用(test/palette.test.ts の OLD_* と同じ値)。
console.log("== 旧配色(参考)");
const OLD: Readonly<Record<string, readonly [string, string, string]>> = {
  "web ライト ok/wait/fail": ["#146c2e", "#8a5a00", "#b3261e"],
  "web ダーク ok/wait/fail": ["#6fcf8a", "#e0b24a", "#ff8a80"],
  "Discord ok/warn/fail": [intToHex(0x2ecc71), intToHex(0xe67e22), intToHex(0xe74c3c)],
};
for (const [name, [a, b, c]] of Object.entries(OLD)) {
  const rows = [minOver(a, b), minOver(a, c), minOver(b, c)];
  console.log(`  ${name}: 最小の ΔE2000 ${Math.min(...rows.map((r) => r.min)).toFixed(1)}(${rows.map((r) => r.values).join(" | ")})`);
}
