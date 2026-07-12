# 地方競馬(NAR)スクレイピング調査結果と対応方針

調査日: 2026-07-12(ユーザー許可のもと実サイトへ最小限のリクエストで実測)。
中央競馬(JRA)版の調査は `docs/phase1-scraping-plan.md` を参照。本書はNAR固有の差分に絞って記録する。

## 結論サマリ

| 項目 | 中央(race.netkeiba.com) | 地方(nar.netkeiba.com) |
|---|---|---|
| レース一覧 | `top/race_list_sub.html?kaisai_date=` 静的UTF-8 | **同一パス・同一構造**(`RaceList_DataList`系)。静的UTF-8 |
| 出馬表 | `race/shutuba.html` 静的UTF-8 | **同一パス・同一構造**(`Shutuba_Table`/`tr.HorseList`)。静的UTF-8 |
| オッズ | `api/api_get_jra_odds.html`(JSON) | **JSON APIなし(404)**。`odds/index.html?type=b1&race_id=` の**静的HTML**に単勝・複勝(下限-上限)が埋め込まれる |
| レース結果 | `race/result.html`(`#All_Result_Table`+払戻) | **同一パス・同一構造** |
| 馬プロフィール | `db.netkeiba.com/horse/{id}/`(EUC-JP) | **共通**(NAR馬も同じdbドメイン・10桁ID) |
| 馬の全戦績 | `db.netkeiba.com/horse/ajax_horse_results.html`(JSON) | **共通**(NAR馬でstatus:OK・地方場コード行を確認) |
| 調教(oikiri) | `race/oikiri.html` 無料は評価のみ | **ページ自体が存在しない(404)** → NARでは調教なしで分析 |

## race_id の体系(中央と異なる・最重要差分)

- 中央: `YYYY`(4) + 場コード(2, **01〜10**) + 回次(2) + 日次(2) + R(2)
- 地方: `YYYY`(4) + 場コード(2, **30以上**) + **月(2) + 日(2)** + R(2)
  - 例: `202654071210` = 2026年・高知(54)・7月12日・10R
  - 地方IDは**開催日がIDに直接埋め込まれる**(中央のような回次・日次ではない)
- 実測した場コード: 35=盛岡, 42=浦和, 46=金沢, 48=名古屋, 54=高知, 65=帯広(ばんえい)。
  戦績APIからは 43=船橋, 44=大井, 45=川崎 も確認(既存の `classifyRace` の地方判定と整合)
- **帯広(65)=ばんえい競馬は平地競走ではないため対象外とする**(そり曳き。距離200m直線でスコアモデルが成立しない)

## オッズの取得方式(中央とまったく異なる)

`https://nar.netkeiba.com/odds/index.html?type=b1&race_id={race_id}` の静的HTMLをパースする。

- `div#odds_tan_block` 内の `table.RaceOdds_HorseList_Table`: 単勝(馬番・馬名・`span.Odds` に倍率)
- `div#odds_fuku_block` 内の同型テーブル: 複勝(`span.Odds` に「下限 - 上限」形式。例 `6.8 - 8.5`)
- **発売前**: 両ブロックとも存在せず、netkeibaのAI「予想オッズ」(単勝のみ)が表示される。
  文言「※予想オッズは戦績などを元に…馬券発売開始後は実際のオッズに切り替わります」で判別可能
  → 中央の `oddsStatus: "yoso"`(複勝なし)と同じ扱いに正規化する
- 発売中〜確定は実オッズが静的に入る(中央の `middle`/`result` 相当。確定判定が必要な場合は
  result.html の払戻の有無で行う)

## レース一覧の差分

- 構造は中央と同一(`dl.RaceList_DataList` グループ+`li.RaceList_DataItem`)。既存セレクタがそのまま使える見込み
- 見出しの回次・日次表記あり(「4回 盛岡 1日目」)。発走前レースは `shutuba.html` へ、終了レースは `result.html` へのリンクに切り替わる(中央と同じ)
- NARはほぼ毎日開催(実測: 7/12は盛岡・金沢・高知・帯広の44レース、7/13は盛岡・浦和・名古屋・帯広の48レース)

## 出馬表の差分

- `Shutuba_Table` 構造・馬リンク(`db.netkeiba.com/horse/{10桁}`)・騎手/調教師リンクは中央と同一
- 発走前でも馬体重列あり(地方は前走体重等が入る場合がある。実測フィクスチャで要確認)
- 芝コースはNARではほぼ無い(盛岡のみ芝あり)。`RaceData01` の表記は中央同様「ダ1400m (右)」形式

## スコアラーへの影響(Task #21 で対応)

- `COURSE_TRAITS` / `COURSE_FRAME_BIAS_TABLE` は中央10場前提 → NARレースでは**コース類似度・枠バイアス補正を適用しない**(補正なし=0)
- 輸送バイアス: 中央の美浦/栗東前提が崩れる(地方馬は所属場=開催場が多い)→ NARでは適用しない
- 戦績集計・脚質・ローテ・季節・馬場状態は流用可能(戦績の`classifyRace`はすでに地方行を保持している)
- 調教スコアは入力なし(oikiri非存在)として扱う

## フィクスチャ(取得済み)

| ファイル | 内容 |
|---|---|
| `fixtures/nar_race_list_sub_20260712.html` | 終了日ベースの一覧(result.htmlリンク) |
| `fixtures/nar_race_list_sub_20260713.html` | 発走前の一覧(shutuba.htmlリンク) |
| `fixtures/nar_shutuba_202654071210.html` | 高知10R(終了後)の出馬表 |
| `fixtures/nar_shutuba_202642071301.html` | 浦和1R(発走前)の出馬表 |
| `fixtures/nar_odds_b1_202654071210.html` | 発売後オッズ(単勝+複勝下限-上限が静的) |
| `fixtures/nar_odds_b1_presale_202642071301.html` | 発売前(予想オッズのみ・複勝なし) |
| `fixtures/nar_result_202654071201.html` | 高知1R結果(`All_Result_Table`+払戻) |
| `fixtures/horse_results_2021104387.json` | 地方所属馬の全戦績(南関東→高知の転厩例) |

## 実装方針(Task #20)

1. `ids.ts`: `parseRaceId` を場コード01〜10限定から拡張する。中央/地方を判別する `raceVenueKind(raceId)`(01〜10=中央、30以上=地方)を追加し、**ばんえい(65)は明示的に拒否**する
2. `urls.ts`: 各URL関数を「race_idの場コードからドメイン(race/nar)を自動選択」する形に変更。オッズのみNARは別パス(`odds/index.html?type=b1`)
3. `parse-nar-odds.ts`(新規): 静的オッズHTMLから `OddsSnapshot` 互換(単勝・複勝下限/上限・oddsStatus)を生成。発売前は `yoso` に正規化
4. 既存パーサー(race_list/shutuba/result)はNARフィクスチャに対するテストを追加し、差分があればセレクタを条件分岐ではなく共通化で吸収する
5. `scrape-race.ts`: NARでは oikiri をスキップ(警告ではなく「対象外」として扱う)
