# #665 計画(並走の「買われすぎの印」とブリンカーの傾向を、BASHIRA の長い期間で確かめる。集計を引く前に書く)

**状態: 計画。この文書をコミットしてから集計を引く。判定の基準(§4)は、結果を見る前に固定する。**

## 1. 書く前に見たもの(順序の記録)
- 本番の印の定義 `packages/core/src/ev/stat-shadow-flags.ts`(前走で逃げた: 前走の最初のコーナーの通過順 ÷ 前走の頭数 ≤ 0.125。人気薄で近走が大敗続き: q < 0.05 かつ直近 3 走の平均着順 ≥ 11.5)。
- #653(Fable 版)の報告。2 つの印はどちらも「市場が買いすぎる」側(3着内が期待より低い)。前走で逃げた馬の差は中位の人気(q 0.05〜0.3)に集中し、q < 0.05 では差が無かった。
- #663 の計画・報告・集計の道具(`scripts/bashira-blindspots-663/analyze.py`)。比べ方はこれに合わせる。
- 11/7 にメインが #638 のコメントに書いたブリンカーの結果(2016〜2026 の全期間。初ブリンカーの 4〜9 番人気は 3着内が期待の 0.89 倍〈z −3.7〉、続けて着けている 10 番人気以下は 1.15 倍〈z +4.0〉、再装着は期待とほぼ同じ)。**全期間の結果は見てしまっているので、ブリンカーは新しい確認ではなく「期間で揺れていないか」の確かめとして扱う。**
- BASHIRA の集計の結果は、この Issue の条件については何も見ていない。

## 2. データと取り方(#663 と同じ)
- BASHIRA の `get_stats`。JRA の芝・ダート、新馬を除く(`career_starts ≥ 1`)、クラスは未勝利・1勝クラス・2勝クラス・3勝クラス・オープン。
- 1 回の呼び出しで `dimensions: ["race_condition","win_odds_rank"]`、metrics に勝ち数(`official_result = 1`)・3着内数(`≤ 3`)・単勝払戻の合計・複勝払戻の合計・単勝オッズの平均。
- 期待値は、**条件に当たらない馬(基準 − 条件)**のクラス × 人気順(1〜18)ごとの勝率・3着内率に、条件の馬の頭数を掛けて足す。帯(1〜3・4〜9・10 番人気以下)ごとに足し上げ、実際/期待と z = (O − E)/√Σ n p(1−p)。回収率(単勝・複勝)と平均オッズを添える。
- 生の応答は scratchpad(`/tmp/claude-0/-home-user-keiba-prediction/6255576e-d816-5938-a938-9fa3fb2459d6/scratchpad/b665/<期間>/<id>.json`)に置き、リポジトリには計画・集計値・スクリプトだけを入れる。`get_entries` は使わない。
- 呼び出しは 1 本ずつ。この Issue で get_stats 20 回(60 回分)以内。見積もりは 14 回(§5)。

### 期間
| 記号 | 期間 | 用途 |
|---|---|---|
| p1624 | 2016-01-01〜2024-07-31 | 並走の 2 つの印の確認。#653 の発見に使った 2024-08 以降と重ならない。全馬の集計は新しく 1 回引く |
| p1620 | 2016-01-01〜2020-12-31 | ブリンカー(前半)。全馬の集計は #663 の探索の応答(`b663/explore/ALL.json`)を使い回す |
| p2126 | 2021-01-01〜2026-11-03 | ブリンカー(後半)。全馬の集計は #663 の確認の応答(`b663/confirm/ALL.json`)を使い回す |

## 3. 条件の書き方(本番の定義との対応と、近似した点)

### 3.1 前走で逃げた(FR)
本番: 前走の最初に記録のあるコーナーの通過順 ÷ 前走の出走頭数 ≤ 0.125。

BASHIRA の `past_runs` は 1 条件(where の AND)しか書けず、比(通過順 ÷ 頭数)は書けないので、頭数の帯ごとに通過順の上限を分ける。0.125 × 頭数 の床は、頭数 8〜15 で 1、16〜18 で 2、7 以下で 0(該当なし)。
- FR1C_A: `past_runs {runs:1, agg:count, where:{first_corner_position:{lte:1}, scheduled_horse_count:{gte:8, lte:15}}, value:{gte:1}}`
- FR1C_B: `past_runs {runs:1, agg:count, where:{first_corner_position:{lte:2}, scheduled_horse_count:{gte:16}}, value:{gte:1}}`
- FR1C = FR1C_A + FR1C_B(前走の頭数で排反なので、層ごとに足せる)。

近似した点:
- 頭数は `scheduled_horse_count`(出走予定頭数。取消を含む)で、本番の出走頭数とは取消の分だけ違う。
- `first_corner_position` は 1 コーナーの通過順で、**1 コーナーの無い短距離のレースでは値が無い**(BASHIRA の説明では 42.8% しか値がない)。本番は「最初に記録のあるコーナー」なので、短距離では 3 コーナーを使っている。BASHIRA では NULL を直接は扱えないので、**基準を「前走に 1 コーナーの通過順がある馬」(ALL_1C)に揃える**: `past_runs {runs:1, agg:count, where:{first_corner_position:{gte:1}}, value:{gte:1}}`。FR1C ⊂ ALL_1C なので、期待値は ALL_1C − FR1C から作る。これで「前走が長めの距離だった」という偏りは基準の側にも入る。
- 参考として、3 コーナーの通過順で同じ形を作る(FR3C_A・FR3C_B。`third_corner_position` で、ほぼ全レースに値がある。基準は ALL)。これは「前走で先頭付近を進んだ」の近い定義で、本番の短距離の分に対応する。**判定は FR1C で行い、FR3C は参考**(検定の数に入れない)。
- 前走が地方・海外の馬は JRA 限定の列が NULL なので、ALL_1C にも FR にも入らない。

### 3.2 人気薄で近走が大敗続き(SLUMP)
本番: q < 0.05(q = 1/単勝オッズをレース内で合計 1 に割り戻した値)かつ、直近 3 走の平均着順 ≥ 11.5。

- q の近似: JRA の単勝の払戻率は 80% なので、レース内の Σ(1/オッズ) ≈ 1.25。q = (1/オッズ)/1.25 < 0.05 ⇔ オッズ > 16。オッズは 0.1 刻みなので `win_odds: {gte: 16.1}`。実際の Σ(1/オッズ) は 1.2〜1.3 の幅があるので、q 0.05 の境界は オッズ 15.4〜16.7 の間で揺れる(近似)。
- 直近 3 走: `past_runs {runs:3, agg:avg, field:official_result, value:{gte:11.5}}`。本番は「前走から数えて 3 走を取ってから、着順の無い走を除く」。BASHIRA は取消・除外を 1 走に数えないので、取消がある馬で 1 走ぶん違う。地方・海外の走は両方とも数える。着順が 3 走に満たない馬は、ある走だけで判定する(本番と同じ)。
- SLUMP: filters に `win_odds: {gte: 16.1}` を足し、上の past_runs。基準は ALL(本番の印の使い方「印の有無」に対応)。
- 参考: 基準を「オッズ 16.1 以上の馬」(ODDS16。filters に `win_odds: {gte: 16.1}` だけ)に替えた比べ方も出す。これは「人気薄の中で、大敗続きの馬が他の人気薄より来ないか」を見るもの(近走の部分だけの効き)。**判定は ALL 基準で行い、ODDS16 基準は参考。**

### 3.3 ブリンカー(BL)
11/7 にメインが使った定義に合わせる。
- BL_FIRST(初ブリンカー): `blinker: true` ∧ `past_runs {runs:20, agg:count, where:{blinker:true}, value:{eq:0}}`
- BL_PREVOFF(前走は未着用で今回着用): `blinker: true` ∧ `past_runs {runs:1, agg:count, where:{blinker:true}, value:{eq:0}}`
- BL_RE(再装着)= BL_PREVOFF − BL_FIRST(BL_FIRST ⊂ BL_PREVOFF)。
- BL_CONT(続けて着けている): `blinker: true` ∧ `past_runs {runs:1, agg:count, where:{blinker:true}, value:{gte:1}}`
- 基準は ALL。地方・海外の走は blinker が NULL なので「着用あり」に数えない(地方で着けていた馬は初ブリンカーに入りうる)。

## 4. 判定の基準(事前登録。結果を見る前に固定)

### 4.1 並走の印(p1624)。確かめる向きは「市場が買いすぎる」(3着内の実際 < 期待)
主検定は 5 つ。片側 p(実際 < 期待の向き)を 5 で Holm 補正し、**n ≥ 300・同じ向き・Holm p < 0.05** をすべて満たすものを「残った」とする。
| # | 条件 | 基準 | 帯 | 指標 |
|---|---|---|---|---|
| T1 | FR1C | ALL_1C | 1〜3 | 3着内 |
| T2 | FR1C | ALL_1C | 4〜9 | 3着内 |
| T3 | FR1C | ALL_1C | 10+ | 3着内 |
| T4 | SLUMP | ALL | 4〜9 | 3着内 |
| T5 | SLUMP | ALL | 10+ | 3着内 |

- SLUMP の 1〜3 番人気は、オッズ 16.1 以上では実質的に空なので検定に入れない(n を報告するだけ)。
- #653 では前走で逃げた馬の差は中位の人気に集中していたので、T2 が残って T1・T3 が残らなくても、#653 と矛盾しない(そう書く)。
- 勝ち(1着)・単勝と複勝の回収率・平均オッズ・FR3C・ODDS16 基準は、どれも参考として表に出す。判定には使わない。
- 回収率の差(条件 − 全馬の同じ帯)も添える。同じ人気順でもオッズに幅があるので、実際/期待が低くてもオッズの偏りで説明できる場合がある(#663 §6)。

### 4.2 ブリンカー(p1620 と p2126)。「揺れていないか」の確かめ
11/7 に見た 2 つの向きを、期間ごとに別々に確かめる。
| # | 条件 | 帯 | 指標 | 向き |
|---|---|---|---|---|
| B1 | BL_FIRST | 4〜9 | 3着内 | 実際 < 期待 |
| B2 | BL_CONT | 10+ | 3着内 | 実際 > 期待 |

- 「揺れていない」= 両方の期間で、n ≥ 300・同じ向き・片側 p を 2 で Holm 補正して < 0.05。
- 「向きは同じだが片方の期間で基準に届かない」「片方の期間で向きが逆」は、それぞれそう書く。
- 3 条件 × 3 帯 × 2 指標 × 2 期間の表を全部出し、一方の期間で |z| ≥ 3 なのに他方で向きが逆の欄があれば「揺れ」として列挙する(これは走査なので結論にはしない)。
- 再装着(BL_RE)は 11/7 に「期待とほぼ同じ」だったので、確かめる向きは無い。表に出すだけ。

## 5. 呼び出しの一覧(見積もり 14 回 = 42 回分)
全呼び出しに共通: `dimensions: ["race_condition","win_odds_rank"]`、metrics(§2)、`limit: 1000`、filters の基本 `race_meeting_date: {gte, lte}`・`surface: ["芝","ダート"]`・`career_starts: {gte: 1}`・`race_condition: ["未勝利","1勝クラス","2勝クラス","3勝クラス","オープン"]`。

| 期間 | id | 足した filters / past_runs | 基準 |
|---|---|---|---|
| p1624 | ALL | (基本のみ) | — |
| p1624 | ALL_1C | `past_runs {runs:1, count where first_corner_position ≥ 1, value ≥ 1}` | — |
| p1624 | FR1C_A | `past_runs {runs:1, count where first_corner_position ≤ 1 ∧ scheduled_horse_count 8〜15, value ≥ 1}` | ALL_1C |
| p1624 | FR1C_B | `past_runs {runs:1, count where first_corner_position ≤ 2 ∧ scheduled_horse_count ≥ 16, value ≥ 1}` | ALL_1C |
| p1624 | FR3C_A | `past_runs {runs:1, count where third_corner_position ≤ 1 ∧ scheduled_horse_count 8〜15, value ≥ 1}` | ALL(参考) |
| p1624 | FR3C_B | `past_runs {runs:1, count where third_corner_position ≤ 2 ∧ scheduled_horse_count ≥ 16, value ≥ 1}` | ALL(参考) |
| p1624 | ODDS16 | `win_odds: {gte: 16.1}` | —(参考の基準) |
| p1624 | SLUMP | `win_odds: {gte: 16.1}`, `past_runs {runs:3, avg official_result, value ≥ 11.5}` | ALL(参考: ODDS16) |
| p1620 | BL_FIRST | `blinker: true`, `past_runs {runs:20, count where blinker=true, value = 0}` | ALL(b663 を使い回す) |
| p1620 | BL_PREVOFF | `blinker: true`, `past_runs {runs:1, count where blinker=true, value = 0}` | ALL |
| p1620 | BL_CONT | `blinker: true`, `past_runs {runs:1, count where blinker=true, value ≥ 1}` | ALL |
| p2126 | BL_FIRST / BL_PREVOFF / BL_CONT | 上と同じ(期間だけ変える) | ALL(b663 を使い回す) |

入力検査に落ちた呼び出し(集計が走らないもの)は回数に入れるが、計画の数には含めない。name_resolution は使わない(名前で絞る条件が無い)。

## 6. 実装
- `scripts/bashira-confirm-665/analyze.py`: #663 の `analyze.py` の関数(層の作成・引き算・評価・Holm)を読み込んで使う。足し算(FR1C = A + B)と引き算(BL_RE = PREVOFF − FIRST)で派生の条件を作り、§4 の判定を当てて `results.json` に書く。標準ライブラリだけ。
- 生の応答は `b665/<期間>/<id>.json` に 1 呼び出し 1 ファイル(#663 と同じ形: id・label・period・columns・rows。`avg_odds` だけ小数 3 桁に丸める)。

## 7. あらかじめ分かっている限界
- #663 §6 と同じ(人気順だけの層、芝ダを層に入れない、同じレースの馬どうしの相関を無視、基準の率の標準誤差を無視、外回りと内回りの区別が無い、確定オッズと分析の時点のオッズの違い)。
- 前走で逃げた馬は、1 コーナーのあるレースを前走にした馬だけで判定する(本番の印の短距離の分は FR3C の参考でしか見られない)。
- q はオッズ 16.1 以上で近似する。
- ブリンカーは全期間の結果を見たあとの確かめなので、「残った」ではなく「揺れていない」としか言えない。

## 8. 追記(集計を引いたあと。2026-11-07)
- get_stats は計画どおり 14 回(42 回分)。入力検査に落ちた呼び出しは無い。送った filters・past_runs は §5 の表のとおりで、変えていない。
- 生の応答は `b665/p1624/{ALL,ALL_1C,FR1C_A,FR1C_B,FR3C_A,FR3C_B,ODDS16,SLUMP}.json`、`b665/p1620/{BL_FIRST,BL_PREVOFF,BL_CONT}.json`、`b665/p2126/{同}.json`(列はそのまま書き写した。`avg_odds` も丸めていない)。`p1620/ALL.json`・`p2126/ALL.json` は #663 の応答のコピー。
- 判定の基準(§4)は変えていない。結果は `report.md`。
