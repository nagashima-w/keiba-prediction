# #663 計画(BASHIRA で市場〈単勝オッズ〉が見落としやすい条件を探す。データを見る前に書く)

**状態: 計画。この文書をコミットしてから、探索の期間(2016〜2020)の集計を引く。確認の期間(2021〜2026-11-03)は、探索を終えて候補を `candidates.json` に固定し、コミットしてから 1 回だけ引く。**

## 1. 書く前に見たもの(順序の記録)
- BASHIRA の MCP ツールの入力スキーマ(`get_stats` の fields・dimensions・past_runs の書き方)。集計の結果は何も見ていない。
- #653 の Fable 版の計画と報告(`docs/investigations/market-blindspots-653-fable/`)。事前登録の進め方(候補を固定してから確認の期間を 1 回だけ開く、Holm 補正、残らなかった候補も表に残す)はこれに倣う。
- #638 の結果(BASHIRA の性質): 本番からの自動取得と網羅的な収集・保存はできない。このチャットでの分析には使える。外回り・内回りの区別が無い。地方のレースは無い。

## 2. データと取り方
- BASHIRA の `get_stats`(1 行 = 1 出走の集計)。JRA の芝・ダート、新馬を除く(`career_starts ≥ 1`)。障害は除く。
- 1 回の呼び出しで `dimensions: ["race_condition","win_odds_rank"]` を取り、metrics に 勝ち数(`official_result = 1`)・3着内数(`official_result ≤ 3`)・単勝払戻の合計(`sum win_payout`)・複勝払戻の合計(`sum place_payout`)・単勝オッズの平均(`avg win_odds`)を並べる。`starts` は常に付く。
- 条件に当たる馬の集計は、上の呼び出しに条件の filters(または past_runs)を足したもの。**全馬の集計は期間ごとに 1 回だけ引いて使い回す**(芝のみの仮説のために、芝だけの全馬の集計も期間ごとに 1 回引く)。
- `get_entries` で出走の個票を引いて貯めることはしない(規約の「網羅的な収集・保存」に当たらないようにする)。生の応答は scratchpad(`/tmp/claude-0/-home-user-keiba-prediction/6255576e-d816-5938-a938-9fa3fb2459d6/scratchpad/b663/`)に置き、リポジトリには計画・候補・集計値・集計のスクリプトだけを入れる。
- 上限: 呼び出しは 1 本ずつ(並列にしない)。この探索全体で get_stats を 100 回(300 回分)以内に収める。見積もり: 探索 = 全馬 2 + 仮説 41、確認 = 全馬 2 + 候補(最大 20)。合計 65 回前後。

### 期間
| 区分 | 期間 | 用途 |
|---|---|---|
| 探索 | 2016-01-01〜2020-12-31 | 条件を見つける |
| 確認 | 2021-01-01〜2026-11-03 | 固定した候補が残るかを確かめる。**候補をコミットしてから 1 回だけ引く** |

### クラスと人気の帯
- クラス: 未勝利・1勝クラス・2勝クラス・3勝クラス・オープン(BASHIRA は 500万円以下などの旧名称を 1勝クラス 等に正規化している)。それ以外のクラス(新馬・未出走・旧名称の残り)は filters で外す。
- 人気の帯: 1〜3 番人気、4〜9 番人気、10 番人気以下。
- 期待値の層は **クラス × 人気順(1〜18)** の細かい層で作り、報告は帯ごとに足し上げる。

## 3. 期待値と指標
条件 C、層 s(クラス × 人気順)について、
- 条件に当たらない馬(全馬 − C)の勝率 p_s^win・3着内率 p_s^top3 を層ごとに出す(全馬の集計から条件の集計を引く。条件が全馬の大半を占める場合でも「当たる馬 vs 当たらない馬」の比べ方になる)。
- 期待値 E = Σ_s n_s(C) × p_s、実際 O = Σ_s(条件の勝ち数または 3着内数)。帯ごとに s を帯に属する層だけで足す。
- 実際/期待 = O / E。z = (O − E) / sqrt(Σ_s n_s(C) p_s (1 − p_s))。
- 同じレースの馬どうしの相関(勝ちは 1 頭だけ、3着内は 3 頭だけ)は無視した近似。
- 回収率: 単勝 = Σ win_payout / (starts × 100)、複勝 = Σ place_payout / (starts × 100)。帯ごとに出す。判断には使わない(雑音が大きい)。
- 単勝オッズの平均も帯ごとに出す(同じ人気順でもオッズに幅があるので、条件の馬のオッズが帯の中で高い側・低い側に偏っていないかを見る)。

## 4. 仮説の一覧(事前登録。結果を見る前に固定)
1 行が get_stats 1 回。filters は §2 の基本(期間・JRA 芝ダ・career_starts ≥ 1・5 クラス)に足す。

| # | 条件 | BASHIRA の書き方 | 芝のみ |
|---|---|---|---|
| H01 | 乗り替わり(前走比) | `is_jockey_change: true` | |
| H02 | 直前の乗り替わり(発表時から) | `is_jockey_change_from_announced: true` | |
| H03 | 外国人騎手への乗り替わり | `is_jockey_change: true` ∧ `jockey_foreigner in [日本在住の外国人, 海外在住の外国人]` | |
| H04 | 短期免許の外国人騎手 | `jockey_foreigner: 海外在住の外国人` | |
| H05 | 馬体重 +10kg 以上 | `horse_weight_difference_with_previous_race ≥ 10` | |
| H06 | 馬体重 −10kg 以下 | `horse_weight_difference_with_previous_race ≤ −10` | |
| H07 | 馬体重 420kg 未満 | `horse_weight ≤ 418`(2kg 刻みなので 420 未満 = 418 以下) | |
| H08 | 馬体重 520kg 以上 | `horse_weight ≥ 520` | |
| H09 | 連闘(7 日以内) | `days_since_last_race ≤ 7` | |
| H10 | 中 1 週(8〜14 日) | `days_since_last_race 8〜14` | |
| H11 | 休み明け(180 日以上) | `days_since_last_race ≥ 180` | |
| H12 | 距離延長 400m 以上 | `distance_change ≥ 400` | |
| H13 | 距離短縮 400m 以上 | `distance_change ≤ −400` | |
| H14 | 前走で上がり最速なのに 4 着以下 | `past_runs {runs:1, count where is_fastest_last_3f=true ∧ official_result ≥ 4, value ≥ 1}` | |
| H15 | 前走で 4 角から 5 頭以上押し上げ | `past_runs {runs:1, count where gain_from_corner4 ≥ 5, value ≥ 1}` | |
| H16 | 前走 1 番人気で 4 着以下(期待を裏切った直後) | `past_runs {runs:1, count where win_odds_rank=1 ∧ official_result ≥ 4, value ≥ 1}` | |
| H17 | 前走 1 着(勝ち上がり直後) | `prev_official_result: 1` | |
| H18 | 柵 B〜D × 1〜2 枠(芝) | `rail_type in [B,C,D]` ∧ `bracket_number ≤ 2` ∧ `surface: 芝` | ○ |
| H19 | 柵 B〜D × 7〜8 枠(芝) | `rail_type in [B,C,D]` ∧ `bracket_number ≥ 7` ∧ `surface: 芝` | ○ |
| H20 | 柵 A × 1〜2 枠(芝。H18 の対照) | `rail_type: A` ∧ `bracket_number ≤ 2` ∧ `surface: 芝` | ○ |
| H21 | 生産者 ノーザンファーム | `breeder_name: ノーザンファーム` | |
| H22 | 生産者 社台ファーム | `breeder_name: 社台ファーム` | |
| H23 | 馬主 サンデーレーシング | `owner_name: サンデーレーシング` | |
| H24 | 馬主 キャロットファーム | `owner_name: キャロットファーム` | |
| H25 | 見習騎手の減量 | `jockey_apprentice in [☆ 1kg減, △ 2kg減, ▲ 3kg減, ★ 4kg減, ◇ 2kg減]` | |
| H26 | 女性騎手 | `jockey_sex: 女性` | |
| H27 | 外国産 (外) | `horse_symbol` に (外)・[外] を含む全値 | |
| H28 | 地方所属 (地) | `horse_symbol` に (地)・[地] を含む全値 | |
| H29 | 市場取引 (市) | `horse_symbol` に (市) を含む全値 | |
| H30 | 関西馬の関東遠征 | `trainer_east_west: 西` ∧ `race_track in [東京, 中山, 新潟, 福島]` | |
| H31 | 関東馬の関西遠征 | `trainer_east_west: 東` ∧ `race_track in [京都, 阪神, 中京, 小倉]` | |
| H32 | 芝→ダート替わり | `surface: ダート` ∧ `prev_surface: 芝` | |
| H33 | ダート→芝替わり | `surface: 芝` ∧ `prev_surface: ダート` | |
| H34 | 牝馬 | `horse_sex: 牝馬`(牝馬限定戦を含む) | |
| H35 | セン馬 | `horse_sex: セン馬` | |
| H36 | 7 歳以上 | `horse_age ≥ 7` | |
| H37 | 1 枠(芝ダ問わず) | `bracket_number: 1` | |
| H38 | 8 枠(芝ダ問わず) | `bracket_number: 8` | |
| C01 | 対照: 芦毛(効くはずのない条件) | `coat_color: 芦毛` | |
| C02 | 対照: 栗毛 | `coat_color: 栗毛` | |
| C03 | 対照: 土曜日 | `day_of_the_week: 土曜日` | |

- 芝のみの仮説(H18〜H20)の期待値は、芝だけの全馬の集計から作る。
- 対照(C01〜C03)は、方法そのものが偽の差を出していないかを見るためのもの。対照が候補に残ったら、方法の欠陥(層の粗さ・相関の無視)を疑い、報告に書く。
- **事前登録の外**: ブリンカー(初・再・継続)は、メインが 11/7 に全期間の集計を見てしまったので、仮説の一覧に入れない。参考として `blinker: true` を探索・確認の両期間で引くが、「事前登録の外」と明記して別枠に置き、結論にはしない。

## 5. 判断の目安(事前登録)
### 候補(探索の期間)
条件 × 人気の帯 × 指標(3着内・勝ち)ごとに次を満たすものを候補にする。
1. 条件の件数 n ≥ 300(その帯)。
2. |z| ≥ 3。
3. 両側 p 値を、走査した全検定(仮説 41 × 帯 3 × 指標 2)で BH 補正した q < 0.05。

### 確認の期間(候補を固定してから 1 回だけ引く)
「残った」とするのは次をすべて満たすもの。
1. 確認の期間の件数 n ≥ 300。
2. 探索と同じ向き(O − E の符号が同じ)。
3. 同じ向きの片側 p 値が、候補の数 K で Holm 補正しても 0.05 未満。

### 確認の期間を見たあと
- 確認の期間で条件を作り直さない。作り直したら「新しい探索」として別の節に書く。
- 残らなかった候補も表に残す。
- 残った条件には、探索・確認それぞれの 実際/期待・z・単勝と複勝の回収率・単勝オッズの平均を添える。

## 6. 実装
- `scripts/bashira-blindspots-663/analyze.py`: scratchpad に保存した get_stats の応答(JSON)を読み、§3 の指標を条件 × 帯ごとに計算する。`explore` サブコマンドで候補(`candidates.json`)を書き出し、`confirm` サブコマンドで固定した候補に Holm 補正を当てる。標準ライブラリだけで書く(scipy は使わない。正規分布の裾は `math.erfc`)。
- 生の応答は `scratchpad/b663/<period>/<id>.json` に 1 呼び出し 1 ファイルで保存する(リポジトリに入れない)。
- 集計値(条件 × 帯の表)は `explore-results.json`・`confirm-results.json` としてリポジトリに入れる。

## 7. あらかじめ分かっている限界
- 人気順(1〜18 番人気)だけで層を作る。同じ人気順でもオッズに幅があるので、条件の馬が帯の中で高いオッズに偏っていれば、それだけで「実際/期待」が下がる(オッズの平均を添えて見る)。
- 芝・ダートを層に入れない(dimensions が 2 つまで)。条件が芝ダの一方に偏り、かつ芝ダで人気順ごとの勝率が違えば、その分が差に乗る。芝のみの仮説は芝の全馬で期待値を作ることで避ける。
- 外回り・内回りの区別が無い。地方のレースは無い。
- 同じレースの馬どうしの相関を無視した z。
- 2016〜2020 の確定オッズ(人気)と、本番の分析の時点(発走の約 30 分前)のオッズは違う。
- 多重比較: 探索の BH と確認の Holm で抑えるが、仮説の一覧そのものが「よく言われる条件」に寄っているので、残った条件も市場にすでに織り込まれている可能性がある(残っても回収率が 1 を超えるとは限らない)。

## 8. 追記(探索の集計を引いたあと、確認の期間を引く前。2026-11-07)
- 探索の期間の get_stats は 44 回(全馬 2・仮説 38・対照 3・事前登録の外 1)。牝馬の 1 回は値の綴りの誤りで入力検査に落ちたので引き直した(集計は走っていない)。
- 生の応答は scratchpad の `b663/explore/<id>.json` に保存した(`avg_odds` だけ小数 3 桁に丸めて書き写した。他の列はそのまま)。
- 芝→ダート替わり(H32)はダートの走だけなので、期待値は**ダートだけの全馬**から作る。これは全馬(ALL)から芝の全馬(ALL_TURF)を層ごとに引いて作れる(件数・払戻は加法的)ので、呼び出しは増やしていない。ダート→芝替わり(H33)は芝の走だけなので、同じ理由で芝だけの全馬(ALL_TURF)を基準にする。
- 市場取引 (市)(H29)は 2016〜2020 の走に 1 件も無かった(row_count 0)。検定の数には入れたまま(p=1)で、候補にはならない。
- 走査した検定は 228(仮説 38 × 帯 3 × 指標 2)。候補は 31(仮説 21 件)。対照 3 件(芦毛・栗毛・土曜日)はどの帯・指標でも |z| < 1.5 で、方法が偽の差を出している様子は無い。
- 確認の期間は、全馬 2 回 + 候補になった仮説 21 回 = 23 回を引く予定。

## 9. 付録: 実際に送った get_stats の filters・past_runs(確認の期間を引いたあとの記録。2026-11-07)
生の応答のファイルには条件が残っていないので、送った値をここに書き写す。全呼び出しに共通: `dimensions: ["race_condition","win_odds_rank"]`、`metrics: [count where official_result=1 → wins, count where official_result≤3 → top3, sum win_payout → win_return, sum place_payout → place_return, avg win_odds → avg_odds]`、`limit: 1000`、filters の基本 `race_meeting_date: {gte, lte}`(探索 2016-01-01〜2020-12-31、確認 2021-01-01〜2026-11-03)・`surface: ["芝","ダート"]`(芝のみの仮説は `"芝"`、H32 は `"ダート"`)・`career_starts: {gte: 1}`・`race_condition: ["未勝利","1勝クラス","2勝クラス","3勝クラス","オープン"]`。以下は仮説ごとに足した条件(JSON の値をそのまま)。

| # | 足した filters / past_runs | 基準 |
|---|---|---|
| ALL | (基本のみ) | — |
| ALL_TURF | `surface: "芝"` | — |
| H01 | `is_jockey_change: true` | ALL |
| H02 | `is_jockey_change_from_announced: true` | ALL |
| H03 | `is_jockey_change: true`, `jockey_foreigner: ["日本在住の外国人","海外在住の外国人"]` | ALL |
| H04 | `jockey_foreigner: "海外在住の外国人"` | ALL |
| H05 | `horse_weight_difference_with_previous_race: {gte: 10}` | ALL |
| H06 | `horse_weight_difference_with_previous_race: {lte: -10}` | ALL |
| H07 | `horse_weight: {lte: 418}` | ALL |
| H08 | `horse_weight: {gte: 520}` | ALL |
| H09 | `days_since_last_race: {lte: 7}` | ALL |
| H10 | `days_since_last_race: {gte: 8, lte: 14}` | ALL |
| H11 | `days_since_last_race: {gte: 180}` | ALL |
| H12 | `distance_change: {gte: 400}` | ALL |
| H13 | `distance_change: {lte: -400}` | ALL |
| H14 | `past_runs: {runs: 1, agg: "count", where: {is_fastest_last_3f: true, official_result: {gte: 4}}, value: {gte: 1}}` | ALL |
| H15 | `past_runs: {runs: 1, agg: "count", where: {gain_from_corner4: {gte: 5}}, value: {gte: 1}}` | ALL |
| H16 | `past_runs: {runs: 1, agg: "count", where: {win_odds_rank: 1, official_result: {gte: 4}}, value: {gte: 1}}` | ALL |
| H17 | `prev_official_result: 1` | ALL |
| H18 | `surface: "芝"`, `rail_type: ["B","C","D"]`, `bracket_number: {lte: 2}` | ALL_TURF |
| H19 | `surface: "芝"`, `rail_type: ["B","C","D"]`, `bracket_number: {gte: 7}` | ALL_TURF |
| H20 | `surface: "芝"`, `rail_type: "A"`, `bracket_number: {lte: 2}` | ALL_TURF |
| H21 | `breeder_name: "ノーザンファーム"`(name_resolution: ノーザンファーム に解決) | ALL |
| H22 | `breeder_name: "社台ファーム"`(社台ファーム に解決) | ALL |
| H23 | `owner_name: "サンデーレーシング"`(有限会社 サンデーレーシング に解決) | ALL |
| H24 | `owner_name: "キャロットファーム"`(有限会社 キャロットファーム に解決) | ALL |
| H25 | `jockey_apprentice: ["☆ 1kg減","△ 2kg減","▲ 3kg減","★ 4kg減","◇ 2kg減"]` | ALL |
| H26 | `jockey_sex: "女性"` | ALL |
| H27 | `horse_symbol: ["(外)","(父)(外)","(外)(地)","(外)[地]","(父)(外)(地)","(父)(外)[地]","[外]","(父)[外]","(招)(外)"]` | ALL |
| H28 | `horse_symbol: ["(地)","(父)(地)","(市)(地)","(外)(地)","(父)(市)(地)","[地]","(外)[地]","(父)[地]","(市)[地]","(父)(市)[地]","(父)(外)(地)","(父)(外)[地]"]` | ALL |
| H29 | `horse_symbol: ["(市)","(父)(市)","(市)(地)","(父)(市)(地)","(招)(市)","(招)(父)(市)","(市)[地]","(父)(市)[地]"]`(row_count 0) | ALL |
| H30 | `trainer_east_west: "西"`, `race_track: ["東京","中山","新潟","福島"]` | ALL |
| H31 | `trainer_east_west: "東"`, `race_track: ["京都","阪神","中京","小倉"]` | ALL |
| H32 | `surface: "ダート"`, `prev_surface: "芝"` | ALL_DIRT(= ALL − ALL_TURF) |
| H33 | `surface: "芝"`, `prev_surface: "ダート"` | ALL_TURF |
| H34 | `horse_sex: "牝馬"` | ALL |
| H35 | `horse_sex: "セン馬"` | ALL |
| H36 | `horse_age: {gte: 7}` | ALL |
| H37 | `bracket_number: 1` | ALL |
| H38 | `bracket_number: 8` | ALL |
| C01 | `coat_color: "芦毛"` | ALL |
| C02 | `coat_color: "栗毛"` | ALL |
| C03 | `day_of_the_week: "土曜日"` | ALL |
| X01 | `blinker: true`(事前登録の外) | ALL |

確認の期間で引いたのは ALL・ALL_TURF と、候補になった H01・H03・H07・H08・H10・H11・H12・H15・H19・H20・H21・H25・H26・H28・H30・H31・H32・H33・H34・H35・H36(条件は上と同じで、期間だけ変えた)。H27 と H28 の値は (外)(地) など 4 つが重なる(どちらにも入れた)。
