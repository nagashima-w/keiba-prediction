---
version: alpha
name: Uma Driller 競馬新聞風
description: 画面は競馬新聞のように、箱で囲まず、線と余白と文字の大きさで区切る。
colors:
  paper: "#faf6ec"
  paper-alt: "#f6f1e3"
  ink: "#1d1b16"
  ink-muted: "#6b6b70"
  rule: "#cdc5b0"
  link: "#0a58ca"
  brand: "#b34700"
  ok: "#177c55"
  wait: "#8e6610"
  fail: "#922b2b"
  paper-night: "#1c1a15"
  paper-alt-night: "#27241c"
  ink-night: "#efe9d8"
  ink-muted-night: "#a0a0a8"
  rule-night: "#4a4536"
  link-night: "#7cacf8"
  brand-night: "#ff7803"
  ok-night: "#7cd9ac"
  wait-night: "#e3b548"
  fail-night: "#ec7971"
typography:
  heading:
    fontFamily: "Hiragino Mincho ProN, Noto Serif CJK JP, Noto Serif JP, Yu Mincho, serif"
    fontSize: 1rem
    fontWeight: 700
  title:
    fontFamily: "Hiragino Mincho ProN, Noto Serif CJK JP, Noto Serif JP, Yu Mincho, serif"
    fontSize: 1.5rem
    fontWeight: 700
  body:
    fontFamily: "system-ui, sans-serif"
    fontSize: 15px
    lineHeight: 1.45
  table:
    fontFamily: "system-ui, sans-serif"
    fontSize: 0.8rem
    fontFeature: tabular-nums
rounded:
  none: 0
  full: 50%
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 22px
components:
  button:
    backgroundColor: transparent
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    height: 44px
  button-primary:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.paper}"
    rounded: "{rounded.none}"
    height: 44px
  heading-band:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.none}"
---

## Overview
競馬新聞のような、紙の上に文字と線だけがある画面にする。カード・タイル・影・丸いバッジは使わない。
区切るのは、線・余白・文字の大きさの 3 つだけにする。

## Colors
紙(paper)の上に墨(ink)で書く。紙の色は 2 段で、paper-alt は入力欄・表の強調行・プレビューにだけ使う。
有彩色は 5 つだけにする。

- **brand**: 選んでいる状態(タブ・切替)、主要なボタンの塗り、EV プラスの強調。
- **link**: リンクだけ。
- **ok・wait・fail**: 状態だけ。成功・待ち・失敗。色だけで示さず、必ず文字か記号(✓ … ⚠ ▲ ▼)を添える。

brand と状態の色を混ぜない。ダークは暖かい黒の紙面(夜の紙面)で、有彩色と muted は昼と同じ値にする。
値の正は `cloud/src/palette.ts` で、上の colors は同じ値を書き写したもの。食い違いは `cloud/test/design-md.test.ts` が赤にする。

## Typography
見出しは明朝系(端末にある書体だけ。Web フォントは CSP が許さない。端末に無ければゴシックに落ちる)。本文は system-ui の 15px。
見出しの段は 4 つだけ。h1(1.3rem)、画面の題(1.5rem・下に二重線)、h2(1rem の墨の帯・字間を少し広く)、h3(0.95rem)。
数字は tabular-nums でそろえる(表・数値の帯・金額・検証の行の値)。太字は行の見出しと、印・馬番に限る。

## Layout
余白は 4・8・12・22px の 4 段だけ。段の頭に 22px、行の間に 4〜8px。
タップできるもの(ボタン・タブ・リンク・日付欄)は、高さ 44px 以上を保つ。密にするのは表と行の中身で、タップの大きさではない。

## Elevation & Depth
影を使わない。重なりも付けない。強調は、線の太さ(2px の墨か brand)と、文字(「EVプラス」)で示す。

## Shapes
角丸は 0。例外は、想定隊列図のチップ(円形、50%)と、見出しの横のロゴ画像だけ。

## Components
- **見出しの帯(h2)**: 墨の地に紙の字。開閉の見出し(場ごと・設定の節)は、ボタン自体が帯になる。
- **ボタン・タブ・リンク**: 透明の地に 1px の墨の枠。選んでいるものは枠と文字が brand で太字。主要な操作(実行・保存)だけ brand の塗り。
- **バッジ**: 1px の枠と、同じ色の小さな文字。塗らない。色は状態(ok・wait・fail)か、未実行(muted)。
- **表**: 見出しの上下に 2px の墨の線、行の間は 1px の薄い線。EV プラスの行は paper-alt の地。
- **数値の帯**: 数値(タイル)は箱にせず、上に線を引き、列の間に縦の薄い線を入れる。回収率の 100% 以上・未満は、上の線の色(ok・fail)と値の色と、記号(▲▼)で示す。
- **開閉の行(結果の馬ごとの評価)**: 表の馬の行を押すと、その行の直後に詳しい中身が開く。普段は閉じる。ボタンは馬名の列(▸ 閉・▾ 開)で、高さ 44px 以上。
- **行・カード**: 箱にせず、上に 1px(区切り)か 2px(節の頭)の線を引く。

## Do's and Don'ts
- 囲むより、上に線を引く。
- 強調色を増やさない。状態を色だけで示さない。
- 影・グラデーション・角丸・丸いバッジを足さない。
- タップの高さを 44px より小さくしない。
