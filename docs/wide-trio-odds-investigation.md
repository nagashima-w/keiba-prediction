# ワイド・3連複オッズの実測調査記録(機能D-1、Issue #13)

実測日: 2026-08-04。実行者: tdd-implementer(boss着手前ゲート合意済み・条件付きGo→4件回答によりGo維持)。

対象は「ワイド・3連複のオッズをどう取得するか」の実測調査と、`urls.ts` / `fixture-plan.ts` の
拡張、フィクスチャ整備。パーサ本体(`OddsSnapshot`型拡張・`parse-wide-odds.ts`等)は
**次の Issue #14 のスコープ**であり、本ドキュメントは実測結果の記録に徹する。

## 1. 実リクエスト一覧(合計24件。上限24件以内)

すべて `HttpClient`(既定: 最低1.5秒間隔・UA明示)経由。`curl`直叩き・並列取得はしていない。

| # | 目的 | URL |
|---|---|---|
| 1 | 中央タブ構造の観測 | `https://race.netkeiba.com/odds/index.html?type=b1&race_id=202603020211` |
| 2 | 中央ワイドタブのAJAXフラグメント | `https://race.netkeiba.com/odds/odds_get_form.html?type=b5&race_id=202603020211&rf=shutuba_submenu` |
| 3 | 中央3連複タブのAJAXフラグメント | `https://race.netkeiba.com/odds/odds_get_form.html?type=b7&race_id=202603020211&rf=shutuba_submenu` |
| 4 | 中央ワイドJSON API(type確認) | `https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=5&action=init` |
| 5 | 中央3連複JSON API(type確認) | `https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=7&action=init` |
| 6 | 地方ワイドページ | `https://nar.netkeiba.com/odds/index.html?type=b5&race_id=202654071210` |
| 7 | 地方3連複ページ | `https://nar.netkeiba.com/odds/index.html?type=b7&race_id=202654071210` |
| 8 | 地方3連複jiku切替の誤仮説検証(index.html直叩き、失敗) | `https://nar.netkeiba.com/odds/index.html?type=b7&race_id=202654071210&jiku=2` |
| 9 | 地方3連複jiku切替の正しい経路(AJAXフラグメント) | `https://nar.netkeiba.com/odds/odds_get_form.html?type=b7&race_id=202654071210&jiku=2` |
| 10 | 中央6頭result.html(一次証拠) | `https://race.netkeiba.com/race/result.html?race_id=202602010605` |
| 11 | 中央6頭ワイド | `https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202602010605&type=5&action=init` |
| 12 | 中央6頭3連複 | `https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202602010605&type=7&action=init` |
| 13 | 地方6頭result.html(一次証拠) | `https://nar.netkeiba.com/race/result.html?race_id=202646071203` |
| 14 | 地方6頭ワイド | `https://nar.netkeiba.com/odds/index.html?type=b5&race_id=202646071203` |
| 15 | 地方6頭3連複 | `https://nar.netkeiba.com/odds/index.html?type=b7&race_id=202646071203` |
| 16 | 中央5頭result.html(一次証拠) | `https://race.netkeiba.com/race/result.html?race_id=202603020203` |
| 17 | 中央5頭ワイド | `https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020203&type=5&action=init` |
| 18 | 中央5頭3連複 | `https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020203&type=7&action=init` |
| 19 | 地方7頭result.html(一次証拠) | `https://nar.netkeiba.com/race/result.html?race_id=202630062407` |
| 20 | 地方7頭ワイド | `https://nar.netkeiba.com/odds/index.html?type=b5&race_id=202630062407` |
| 21 | 地方7頭3連複 | `https://nar.netkeiba.com/odds/index.html?type=b7&race_id=202630062407` |
| 22 | CLI(`--race-odds-types`)動作確認: 中央ワイド | `https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=5&action=init` |
| 23 | CLI動作確認: 中央3連複 | `https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202603020211&type=7&action=init` |
| 24 | 未発売状態(state③)の探索(結果は失敗。§6参照) | `https://nar.netkeiba.com/odds/index.html?type=b5&race_id=202642071301` |
| 25\* | 【boss差し戻し対応・追加承認】地方3連複jiku=2の一次データ保存(§3.2の仮説X/Y判別の証拠) | `https://nar.netkeiba.com/odds/odds_get_form.html?type=b7&race_id=202654071210&jiku=2` |

\*#25は当初の予算24件とは別枠。boss差し戻し(要修正1)を受け、ユーザー承認済みnetkeibaリクエストの
枠内で1件のみ追加実施(1.5秒間隔厳守、`fixtures/nar_odds_b7_jiku2_202654071210.html`として保存)。

すべて HTTP 200(4xxは一度も発生しなかった。§6参照)。#22・#23 は #4・#5 と同一URLの再取得(CLI経路の
実動作確認のため。予算制約上、他のレースはCLI再取得せず探索フェーズの実データをそのまま正式名称で
フィクスチャとしてコミットしている。詳細は §8)。

候補レース選定はすべて既存の `race_list_sub` フィクスチャに対する `parseRaceList`(既存パーサ)の
`entryCount` から行った。正規表現の近接ペアリングはしていない(boss指摘のバグの再発防止)。

## 2. 中央: 取得経路の確定

### 2.1 タブ→typeコード対応(中央から独立観測。地方の値を仮定していない)

`race.netkeiba.com/odds/index.html?type=b1&race_id=202603020211` のHTML内、タブナビゲーション
(`<li id="odds_navi_bN">`)から実測(#1):

| タブ内部コード | 表記 |
|---|---|
| b0 | 上位人気一覧 |
| b1 | 単勝・複勝 |
| b3 | 枠連 |
| b4 | 馬連 |
| **b5** | **ワイド** |
| b6 | 馬単 |
| **b7** | **3連複** |
| b8 | 3連単 |

**中央と地方(boss実測)のtype対応は完全一致していた**(b2欠番も含め同一)。ただしこれは「タブの
内部コード」の一致であり、後述のとおり実際の**データ取得経路(API/軸馬別取得の有無)は中央/地方で
大きく異なる**。

### 2.2 数値type(JSON API)への対応(中央のみ)

各タブのAJAXフラグメント(`odds_get_form.html?type=bN&race_id=...`)内の埋め込みJS
(`$.oddsUpdate({...})`)から、数値type値を独立観測(#2, #3):

- ワイドフラグメント(`type=b5`)の埋め込みJS: `oddsType:'5'`
- 3連複フラグメント(`type=b7`)の埋め込みJS: `oddsType:'7'`

既存の単勝・複勝JSON API(`oddsApiUrl`、`type=1`)と**同一エンドポイント**
(`race.netkeiba.com/api/api_get_jra_odds.html`)の `type` クエリを変えるだけで取得できることを
実測で確認(#4, #5)。レスポンス例(#4, 16頭):

```
{"status":"result","data":{"official_datetime":"2026-06-28 15:52:30",
"odds":{"5":{"0102":["18.3","19.1","25"],"0103":["17.5","18.3","22"], ...}}},
"update_count":"0","reason":""}
```

3連複(#5、16頭)の応答冒頭:

```
{"status":"result","data":{"official_datetime":"2026-06-28 15:52:30",
"odds":{"7":{"010203":["260.2","0.0","103"],"010204":["942.3","0.0","298"], ...}}},
"update_count":"0","reason":""}
```

### 2.3 中央の結論

- **経路**: JSON API `GET https://race.netkeiba.com/api/api_get_jra_odds.html?race_id={race_id}&type={5|7}&action=init`(既存`oddsApiUrl`と同一メカニズム)
- **1レース分の全組合せに必要なリクエスト数**: **1**(ワイド・3連複とも)。16頭のレースでC(16,2)=120件・C(16,3)=560件が1レスポンスに全件含まれることを確認済み(`packages/core/test/scraper/wide-trio-odds-fixtures.test.ts`で組合せ集合の完全一致を検証)
- **ワイドは幅(下限-上限)**。`data.odds["5"][キー] = [下限, 上限, 人気]`(既存の複勝type=2と同じ並び)。全120件で下限<=上限が成立し、かつ差が0でない組が存在(退化していない)ことをテストで確認
- **3連複は単一値**。`data.odds["7"][キー] = [オッズ, "0.0"(ダミー), 人気]`(既存の単勝type=1と同じ形)
- キー形式: ワイドは4桁(馬番2桁×2、昇順連結。例`"0102"`)、3連複は6桁(馬番2桁×3、昇順連結)

## 3. 地方: 取得経路の確定

### 3.1 ワイド(type=b5)

`GET https://nar.netkeiba.com/odds/index.html?type=b5&race_id={race_id}` の**静的HTML**
(#6、12頭)。軸馬(1〜11)ごとの `<table class="Odds_Table">` が**すべて同一ページに含まれる**
(`<div class="Axis_Horse_Container">` のような軸馬選択UIは存在しない)。

各組の値は `<td class="Odds" id="chk_..._b5_c0_{a}_{b}">41.9 - 42.8` のようにテキストで
「下限 - 上限」の順に埋め込まれている。

- **1レース分の全組合せに必要なリクエスト数**: **1**。12頭のレースでC(12,2)=66件と完全一致
- **幅形式**であることをテキストの `"数値 - 数値"` パターンで確認、全件で下限<=上限、非退化

### 3.2 3連複(type=b7)。中央と挙動が異なる重要な発見

`GET https://nar.netkeiba.com/odds/index.html?type=b7&race_id={race_id}` の静的HTMLには
`<select id="list_select_horse">`(軸馬選択プルダウン)と `<div class="Axis_Horse">` が存在し、
ページ読み込み時点で**軸馬1固定**の組合せしか表示されない(#7、12頭でC(11,2)=55件のみ。
全体C(12,3)=220件の一部)。

軸馬切替はJS関数 `view_3odds_normal()` が発火し、AJAX GET
`../odds/odds_get_form.html?type=b7&race_id=...&jiku={軸馬番}` を叩く実装だった。

**変数を1つだけ変える検証**: まず `index.html?...&jiku=2` を素朴に叩いたところ(#8)、軸馬2の
データではなく**軸馬1のデータがそのまま返った**(index.htmlは`jiku`クエリを無視し常に軸馬1固定。
コメントアウトされた旧実装 `location.href = "?...&jiku=" + umaban` の名残と考えられる)。
正しいエンドポイント(`odds_get_form.html?...&jiku=2`)を叩き直したところ(#9、
`fixtures/nar_odds_b7_jiku2_202654071210.html`として保存済み)、以下がコミット済み
フィクスチャから再計算できる形で確認できた(`wide-trio-odds-fixtures.test.ts`で固定):

- 軸馬2の応答は「**馬02を含む全トリオ**」(C(11,2)=55件)と完全一致する
  (「馬02を最小とするトリオのみ」〈C(10,2)=45件〉という別仮説は棄却された)
- 軸馬1の応答(#7)との積集合は**ちょうど10件**(馬01と馬02をともに含むトリオ=馬01,02,x)

この2点により、**`jiku=k`はkを含む全トリオを返す**(kを最小とするトリオだけではない)ことが
確定した。この区別は#14の設計判断に直結する: 「上位候補馬に絞る」場合、上位3頭のいずれかを軸に
選べばその3頭間のトリオは必ず含まれる(最小馬番の軸を選ぶ必要はない)。

**必要リクエスト数について、導出値と観測値を書き分ける**:
実物の軸馬選択プルダウン(`<select id="list_select_horse">`)は**1〜n(全頭)**を選択肢として
提示している(12頭レースで実測: `<option value="1">`〜`<option value="12">`の12件、
`fixtures/nar_odds_b7_202654071210.html`から追加リクエスト0で確認可能)。これは**サイトが
提示する選択肢の数(観測値)**である。

一方、全 C(n,3) 通りを漏れなく覆うために**必要な最小リクエスト数はn-2**(**導出値**)である。
3頭の組合せの最小馬番は必ずn-2以下になるため、軸1〜(n-2)を叩けば全組合せをカバーできる
(軸(n-1)・軸nを追加で叩いても、その軸を最小とする新規トリオは存在しないため冗長)。

- **1レース分の全組合せに必要なリクエスト数(導出値)**: **n-2 回**(n=頭数)。
  例: 12頭なら軸1〜10の**10リクエスト**、16頭なら**14リクエスト**必要
  (「18回叩くのは禁止」の指示のとおり、全軸を実際に叩いて確かめてはいない。軸1→軸2への
  差分確認1件のみで、上記の「kを含む全トリオを返す」性質を確定させた)
- **単一値形式**。td内テキストに幅を表す `"-"` 区切りが無く、単独の数値のみ(構造的にもワイドの
  `<span id="oddsmin-5-...">` 相当の要素が3連複側には存在しない)

### 3.3 地方の結論

| 券種 | 経路 | セレクタが提示する軸馬数(観測値) | 全組合せに必要な最小リクエスト数(導出値) | 形式 |
|---|---|---|---|---|
| ワイド | 静的HTML(`type=b5`、軸馬クエリ不要) | — | 1 | 幅(下限-上限) |
| 3連複 | 静的HTML(`type=b7`、`jiku`で軸馬指定) | 1〜n(全頭) | **n-2**(軸馬別取得。軸1〜n-2で全C(n,3)を網羅) | 単一値 |

## 4. 実測で埋めた5論点(boss指定)

1. **1レース全組合せの必要リクエスト数**: 中央はワイド・3連複とも**1**。地方はワイドが**1**、
   3連複が**n-2**(軸馬別取得)。**中央/地方で3連複の取得方式が根本的に異なる**ことが今回の
   最大の発見。#14の設計判断に直結する(地方の3連複を全通り取得する場合、頭数が多いレースほど
   リクエスト数が線形に増える)
2. **ワイドは幅・3連複は単一値**。中央・地方とも共通(§2.3, §3.3)
3. **組合せ件数はC(n,2)/C(n,3)と一致するか**: 中央(ワイド・3連複とも)・地方ワイドは**完全一致**
   (取消馬が今回の実測範囲に含まれなかったため「欠落時にどうなるか」は今回未検証。#14で取消馬
   ありのレースを対象にする場合は追加確認が必要)。地方3連複は前述のとおり軸馬別のため単純な
   件数比較ではなく「軸馬1固定の部分集合との完全一致」で検証(テストコード参照)
4. **中央のAPI/ページ判断**: 静的ページ(`odds/index.html?type=b1`)自体は現在の実オッズを
   表示するJSプレースホルダ(`---.-`)であり、確定オッズはページ単体では取得できない。1リクエストで
   全点取れるJSON API(`api_get_jra_odds.html`)が既存 `oddsApiUrl` と同一メカニズムであるため、
   これを正式ルートとした(判断基準(i)(ii)がどちらもAPI側を支持し、両論併記の必要はなかった)
5. **地方のtypeコードは中央と同じか**: **同じだった**(b0/b1/b3/b4/b5/b6/b7/b8のタブ内部コードが
   完全一致)。ただし取得方式(軸馬別取得の有無)は異なるため、「typeコードが同じ=挙動が同じ」では
   ないことに注意

## 5. フィクスチャ対応表

| ファイル名 | レース | 頭数 | 状態 | 頭数の情報源 |
|---|---|---|---|---|
| `odds_wide_202603020211.json` | 中央・福島11R ラジオNIKKEI賞 | 16 | ①発売されていた(確定) | `parseShutuba(readFileSync("fixtures/shutuba_202603020211.html","utf-8")).horses.length`(既存フィクスチャ、本番パーサで再現可能。単純な`class="HorseList"`カウントは読み込み用ダミー行2件を含むため18になり誤る点に注意) |
| `odds_trio_202603020211.json` | 同上 | 16 | ①同上 | 同上 |
| `nar_odds_b5_202654071210.html` | 地方・高知10R ファイナルレース | 12 | ①発売されていた(確定) | `nar_race_list_sub_20260712.html`のentryCount(既存フィクスチャ) |
| `nar_odds_b7_202654071210.html` | 同上 | 12 | ①同上(軸馬1固定) | 同上 |
| `nar_odds_b7_jiku2_202654071210.html` | 同上 | 12 | ①同上(軸馬2固定。§3.2の仮説X/Y判別の証拠。`result.html`と同様、`fixture-plan.ts`のCLI経路外〈`odds_get_form.html`はAJAXフラグメント用の別URLのため〉) | 同上 |
| `odds_wide_202602010605.json` | 中央・函館5R 2歳新馬 | 6 | ①発売されていた(確定) | `race_list_sub_20260628.html`のentryCount |
| `odds_trio_202602010605.json` | 同上 | 6 | ①同上 | 同上 |
| `result_202602010605.html` | 同上 | 6 | 払戻確定(一次証拠) | 同上 |
| `odds_wide_202603020203.json` | 中央・福島3R 2歳未勝利 | 5 | ①発売されていた(確定) | `race_list_sub_20260628.html`のentryCount |
| `odds_trio_202603020203.json` | 同上 | 5 | ①同上 | 同上 |
| `result_202603020203.html` | 同上 | 5 | 払戻確定(一次証拠) | 同上 |
| `nar_odds_b5_202646071203.html` | 地方・金沢3R 2歳新馬 | 6 | ①発売されていた(確定) | `nar_race_list_sub_20260712.html`のentryCount |
| `nar_odds_b7_202646071203.html` | 同上 | 6 | ①同上(軸馬1固定) | 同上 |
| `nar_result_202646071203.html` | 同上 | 6 | 払戻確定(一次証拠) | 同上 |
| `nar_odds_b5_202630062407.html` | 地方・門別7R アルキバ特別 | 7 | ①発売されていた(確定) | `nar_race_list_sub_20260624.html`のentryCount |
| `nar_odds_b7_202630062407.html` | 同上 | 7 | ①同上(軸馬1固定) | 同上 |
| `nar_result_202630062407.html` | 同上 | 7 | 払戻確定(一次証拠) | 同上 |

すべて `pnpm tsx scripts/fetch-fixtures.ts --race-odds-types {race_id}`(中央/地方は
race_idから自動判定)で再取得できる経路(実際に202603020211でCLI実行し確認済み。§8)。
`result_*.html` / `nar_result_*.html` は既存の `raceResultUrl` を使うが、`fixture-plan.ts` には
元々result.html用のCLIターゲットが無い(既存の `result_202602010607.html` も同様にCLI経路外で
取得された前例に倣った)。これは本Issueのスコープ外(urls.tsの`raceResultUrl`自体は既存)。

## 6. 発売条件の4状態

| 状態 | 今回の実測結果 |
|---|---|
| ①発売されていた | 中央5・6・16頭、地方6・7・12頭の**全レース**でワイド・3連複とも確認(result.htmlの`tr.Wide`/`tr.Fuku3`一次証拠+オッズ側の組合せ完全一致という二次証拠の両方で裏付け) |
| ②発売なし | **今回の実測範囲(5〜16頭)では1件も観測できなかった**。中央2026-06-28・地方2026-07-12/06-24/07-13の計4つの`race_list_sub`(約150レース)を0追加リクエストで探索したが、4頭以下のレースが1件も見つからなかった(観測範囲の実情)。よって「4頭以下でワイド・3連複が発売されないこと」は**未確認**として記録する(推測で断定しない) |
| ③未発売(発走前) | **今回は取得できなかった**。2026-08-04(火)は中央非開催。地方の既存「発売前」フィクスチャ(`nar_odds_b1_presale_202642071301.html`、race_id=202642071301)を流用してワイドを再取得したところ(#24)、このレースは2026年7月13日開催で**既に終了しており、確定オッズ(下限-上限を含む実数値)が返った**(状態①)。「presale」という古いフィクスチャ名は取得**時点**の状態であり、同じrace_idを後日再取得しても③が再現するとは限らないという教訓が得られた。#14着手前に中央の開催日を確認した上で改めて取得する必要がある |
| ④取得失敗 | **今回は1件も発生しなかった**(全24リクエストがHTTP 200)。`scripts/fetch-fixtures.ts`は4xxで`HttpError`を投げてループが止まる実装のままであり(本Issueのスコープ外、CLAUDE.md参照)、探索フェーズでは`try/catch`でステータスを記録する専用スクリプト(非コミット、scratchpad配下)を使った |

**②③④の実例を持てなかったことは本調査の限界として明記する。** #14の着手前に、(a)中央の
開催日に発走前オッズを再取得する、(b)4頭以下のレースを別日程の一覧から探す、のいずれかが
必要になる可能性がある。

## 7. resolvePlaceBetTarget(複勝7頭以下対象外)の再検討材料

`packages/app/src/renderer/bet-allocation-view.ts` の `resolvePlaceBetTarget` は変更していない
(AC9)。実測結果を再検討材料として記録する:

- **ワイド・3連複は5頭・6頭・7頭のレースでも発売されていた**(§6)。複勝が「2着まで」に
  変わる7頭以下の帯でも、ワイド・3連複自体は(複勝と独立に)発売されている
- **複勝の払戻点数(`resolvePlaceBetTarget`の"two-place-only"閾値の直接証拠。0追加リクエストで
  コミット済み`result.html`から取得)**: `tr.Fukusho`行の`td.Payout`(払戻円)・`td.Ninki`(人気)の
  件数を実測したところ、以下のとおり**「5〜7頭は2点」「10頭は3点」が実物で確認できた**
  (`resolvePlaceBetTarget`の閾値7は2026-07-30のboss判断としてハードコードされたのみで、
  実測根拠が無かった。今回が初めての実測裏付けとなる):

  | レース | 頭数 | 複勝払戻点数 | 人気列 |
  |---|---|---|---|
  | 中央・202603020203(福島3R) | 5 | **2点** | 1人気, 4人気 |
  | 中央・202602010605(函館5R) | 6 | **2点** | 1人気, 2人気 |
  | 地方・202646071203(金沢3R) | 6 | **2点** | 3人気, 5人気 |
  | 地方・202630062407(門別7R) | 7 | **2点** | 2人気, 1人気 |
  | 中央・202602010607(函館7R、既存フィクスチャ) | 10 | **3点** | 5人気, 1人気, 9人気 |

  観測できたのは5・6・7・10頭のみ。**8頭・9頭の境界(3点に切り替わる正確な頭数)は未確認**
  (導出値と観測値を混同しない: 「5〜7頭は2点」は5・6・7の3つの頭数で直接観測した事実であり、
  「8頭以上は3点」は10頭の1点のみからの外挿であって8・9頭では未確認)
- **枠連(0追加リクエストでの副産物的観測)**: 中央5・6頭、地方6・7頭のいずれの`result.html`にも
  `tr.Wakuren`(枠連の払戻行)が存在しなかった。一方、既存フィクスチャ`result_202602010607.html`
  (中央・10頭)には`tr.Wakuren`が存在する。5〜7頭では枠連が発売されず、10頭では発売される
  ことが示唆されるが、8・9頭の境界は未検証(#26のスコープ外につき追加リクエストはしていない)

## 8. 予算とCLI経路の整合(AC5)

探索フェーズ(URL構築・データ形式の特定)は非コミットのアドホックスクリプト
(`HttpClient`直呼び出し)で行った。経路確定後、本番コード(`urls.ts`/`fixture-plan.ts`/
`scripts/fetch-fixtures.ts`の新フラグ`--race-odds-types`)をTDDで実装し、**実際にCLIを実行して
動作確認した**(race_id=202603020211、中央ワイド・3連複の2ファイルをCLI経由で取得・保存。
§1の#22, #23)。

予算(24件)の制約上、他の10レース分(地方2件×5レース+中央2件×1レース=既に探索フェーズで
取得済みの12ファイル)はCLIで二重取得していない。**探索フェーズで`HttpClient`経由で取得した
実データをそのまま正式なファイル名でコミットしている**(URLは`urls.ts`の関数が生成するものと
同一であり、内容の改変は一切していない)。これらのファイルが実際にCLI経路で再取得可能である
ことは、同一URL構築ロジックを使う202603020211の動作確認と、`fixture-plan.test.ts`のURL完全一致
テストで裏付けている。

## 9. キャッシュキー(AC10)

いずれの新規URLも `race_id` と `type`(・地方3連複は`jiku`)がすべてURLクエリに含まれ、
POSTボディに識別子が入る設計ではない(`race_api/`のような事故パターンに該当しない)。
`action=init`はセッション依存ではなく、Cookie無しの直接GETで確定オッズが取得できることを
実測で確認済み。**`cacheKey`の明示指定は不要**(既存`oddsApiUrl`と同じURLキー方式で足りる)。

申し送り(#14向け): オッズは揮発性のため、既存の複勝オッズと同様`bypassOddsCache`相当の
迂回が必要になる(`scrape-race.ts`の既存パターンを踏襲する想定)。

## 10. #14への申し送り事項まとめ

1. **地方の3連複は軸馬別取得**。全通り取得する場合は頭数-2回のリクエストが必要。方式(全通り取得
   するか上位候補馬に絞るか)は#14の着手前ゲートで判断する(本Issueでは判断しない)
2. **状態③(未発売)・④(取得失敗)の実フィクスチャが無い**。#14着手前に中央の開催日を確認して
   追加取得するか、地方の直近レースで再探索する必要がある
3. **取消馬がいるレースでの組合せ欠落パターンが未検証**(今回の実測レースはいずれも取消馬なし)
4. **`resolvePlaceBetTarget`の変更判断は#14に持ち越し**(§7の再検討材料を参照)

## 11. 状態③(未発売)の実測(機能D-2b-A・Issue #32、2026-08-06)

#13時点では②③④の実例を持てなかった(§6)。本Issueで③(未発売)を実測し、`parse-combo-odds.ts`
(中央)・`parse-nar-combo-odds.ts`(地方)の `unavailable` 分岐を実物で固定した。

### 11.1 実リクエスト一覧(合計11件。当初の上限9件を2件超過。理由は末尾参照)

すべて `HttpClient`(既定: 最低1.5秒間隔・UA明示)経由、実行日時 2026-08-06T18:27〜2026-08-07T02:28 UTC
(JST 8/7 3:27〜11:28頃)。翌々日(8/8開催)のレースを選定し、#13の教訓
(「presaleという名前は取得**時点**の状態であり、同じrace_idを再取得しても再現しない」)を
踏まえフィクスチャ名に取得日(20260806)を含めている。

| # | 目的 | URL | 結果 |
|---|---|---|---|
| 1 | 地方race_list_sub(8/8開催の一覧、探索用) | `https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260808` | 200(10件のレースを取得) |
| 2 | 地方ワイド(佐賀・202655080803・12頭、探索用) | `https://nar.netkeiba.com/odds/index.html?type=b5&race_id=202655080803` | 200(unavailable) |
| 3 | 地方3連複(同上、探索用) | `https://nar.netkeiba.com/odds/index.html?type=b7&race_id=202655080803` | 200(unavailable) |
| 4 | 中央race_list_sub(8/8開催の一覧、探索用) | `https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260808` | 200(36件のレースを取得) |
| 5 | 中央ワイド(18頭最大・202604020511、探索用) | `https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202604020511&type=5&action=init` | 200(unavailable) |
| 6 | 中央3連複(同上、探索用) | `https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202604020511&type=7&action=init` | 200(unavailable) |
| 7 | 地方ワイド再取得(フィクスチャ本文保存用) | `https://nar.netkeiba.com/odds/index.html?type=b5&race_id=202655080803` | 200 → `fixtures/nar_odds_b5_presale_202655080803_20260806.html` |
| 8 | 地方3連複再取得(フィクスチャ本文保存用) | `https://nar.netkeiba.com/odds/index.html?type=b7&race_id=202655080803` | 200 → `fixtures/nar_odds_b7_presale_202655080803_20260806.html` |
| 9 | 中央ワイド再取得(正確なバイト列でフィクスチャ保存) | `https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=202604020511&type=5&action=init` | 200 → `fixtures/odds_wide_presale_202604020511_20260806.json` |
| 10\* | 【code-reviewer要修正3対応・追加】中央race_list_subの再取得(発走予定時刻の記録漏れの補完) | `https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260808` | 200(#4と同一URL。11R「17:50」を確認。**当初はscratchpadに残っていたのみでフィクスチャ未保存だったため、後日#11として改めて保存した(下記参照)**) |
| 11\*\* | 【code-reviewer再指摘・全数走査で発見した欠落の補完】地方race_list_subの再取得(#1が repo にもscratchpadにも残っていなかったため) | `https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=20260808` | 200(#1と同一URL) → `fixtures/nar_race_list_sub_20260808.html` |

\*#10は当初の予算9件とは別枠。code-reviewer要修正3(AC10「発走予定時刻」の記録漏れ)への
対応として、CLAUDE.mdのnetkeiba一般承認(継続適用)の範囲内で1件のみ追加実施した
(1.5秒間隔厳守)。#4の時点で `parseRaceList` が抽出しない発走時刻(`span.RaceList_Itemtime`。
`RaceListEntry`型に無いフィールド)を見落としており、0追加コストで取得できたはずの証拠を
取りこぼしていた(#13で boss が指摘したのと同型の失敗)。**#10自体もこの時点ではフィクスチャに
保存せず、コンソール出力とscratchpad(`central_race_list_20260808.html`)に残しただけだった
(同型の欠陥の再発。§11.1末尾「再発防止」参照)。** code-reviewer再指摘を受け、scratchpadに
残っていたその生バイト列をそのまま `fixtures/race_list_sub_20260808.html` として保存した
(**追加の実リクエストなし**。同一内容であることは、保存したファイルに`race_id=202604020511`の
`<span class="RaceList_Itemtime">17:50 </span>`が含まれることで裏付けられる)。

\*\*#11は全数走査(下記)で新たに発見した欠落(#1も同様にフィクスチャ未保存かつscratchpadにも
残っていなかった)を埋めるための追加実施(**この1件のみ実リクエストが必要だった**。1.5秒間隔は
単発のため実質無関係)。

#5・#6は探索段階で状態(`unavailable`)を確認済みだったため、#9では#5と同一URLを再取得して
正確なバイト列(トリミングなし)をフィクスチャとして保存した。3連複(#6)は探索段階の応答が
ワイド(#5)とバイト単位で同一内容("empty free odds schedule")だったため(封筒がtype非依存の
内容であることを示す。既存 `odds_yoso_*.json` と同様、中央APIはtype横断で共通の封筒仕様)、
再取得はせず同一バイト列を `fixtures/odds_trio_presale_202604020511_20260806.json` として
コミットしている(内容が完全一致することは#5・#6両方の探索リクエストで独立に確認済み)。

#### 全数走査: 11件それぞれが repo のどのファイルから再計算できるか(code-reviewer再指摘対応)

| # | 再計算可能か | 根拠ファイル |
|---|---|---|
| 1 | **可**(#11で事後的に保存) | `fixtures/nar_race_list_sub_20260808.html`(`race_id=202655080803`・`3R`・`17:10`・`12頭`を含む) |
| 2 | 可(#7と同一URL。#7で上書き取得・保存済み) | `fixtures/nar_odds_b5_presale_202655080803_20260806.html` |
| 3 | 可(#8と同一URL) | `fixtures/nar_odds_b7_presale_202655080803_20260806.html` |
| 4 | **可**(#10と同一URL。#10のバイト列を#11発覚時に事後保存) | `fixtures/race_list_sub_20260808.html` |
| 5 | 可(#9と同一URL。#9で正確なバイト列を保存済み) | `fixtures/odds_wide_presale_202604020511_20260806.json` |
| 6 | 部分的(独立採取のバイト列そのものはrepoに無い。#5とバイト単位で同一であることを探索段階の2回の観測で確認済みという**記録**〈本ドキュメント〉と、#5のバイト列を複製したファイルはrepoにある) | `fixtures/odds_trio_presale_202604020511_20260806.json`(#5と同一内容を意図的に複製したもの。#6自体の独立キャプチャではない点に注意) |
| 7 | 可(直接保存) | `fixtures/nar_odds_b5_presale_202655080803_20260806.html` |
| 8 | 可(直接保存) | `fixtures/nar_odds_b7_presale_202655080803_20260806.html` |
| 9 | 可(直接保存) | `fixtures/odds_wide_presale_202604020511_20260806.json` |
| 10 | 可(直接保存) | `fixtures/race_list_sub_20260808.html` |
| 11 | 可(直接保存) | `fixtures/nar_race_list_sub_20260808.html` |

**#6のみ「部分的」**: 独立に採取したバイト列そのものは保存されていない(2回の探索リクエストで
コンソール上バイト単位で同一と確認したが、その時点でファイル保存していなかった)。ただし
実害は小さいと判断する: (a) 同じ封筒フォーマットを使う中央APIの他の応答(`odds_yoso_*.json`)が
type非依存の封筒仕様であることを裏付けており、(b) 3連複固有の内容(type別に異なる可能性のある
情報)がそもそも存在しない応答("empty free odds schedule"という定型文言のみ)なので、
仮に#6を独立再取得しても#5と異なる内容になる可能性は構造的に低い。とはいえ「探索段階の
コンソール出力を根拠にする」こと自体が#13・今回の#10と同じ弱いパターンであるため、
**次回この結論を利用する際は#6を独立再取得してバイト単位で確認することを推奨する**
(本タスクでは追加の実リクエストは行わない。#33着手前ゲートで判断材料として提示する)。

### 再発防止(code-reviewer再指摘への対応として明記)

今回、#10(要修正3対応)を取得した際に**フィクスチャとして保存せず、ドキュメント本文に転記した
数値だけを残す**という、まさに是正しようとしていた欠陥(#4の保存漏れ)と同型の失敗を繰り返した。
さらに全数走査で#1にも同じ欠落が見つかった。原因は「実リクエストを発行した直後にその場で
ファイル保存する」ことを手順化しておらず、コンソール出力を見て満足してしまったこと。
今後この種の探索を行う際は、**`HttpClient.fetchText`の戻り値を得た直後に`writeFileSync`で
保存してから解析する**(解析が先、保存が後、という順序を取らない)ことを徹底する。

候補レース選定は既存の `parseRaceList`(本番パーサ)の `entryCount` で頭数最大のレースを機械的に
選び(組合せ市場が観測しやすいため)、`venueKindOfRaceId` で中央/地方を判定した。**この選定
スクリプトは帯広(場コード65)を明示的に除外していない**(`venueKindOfRaceId` はトラックコード
`<=10`か否かのみを見る簡易判定で、帯広を特別扱いする`parseRaceId`の`InvalidIdError`を経由
していないため。指示された「帯広は避ける」という既存の慣行をコードで保証できていなかった
点は本調査の実装上の抜けとして記録する)。結果として実際に選ばれたのは佐賀(場コード55、
race_id=202655080803)であり帯広ではなかったが、これは選定ロジックが保証したのではなく
たまたま佐賀の方が頭数が多かったことによる。もし帯広の方が頭数最大だった場合は誤って選定
されていた可能性があり、次回同種の探索を行う場合は `parseRaceId` を通す(帯広は例外で弾かれる)
か、`raceId`の場コードを明示チェックするフィルタに直すこと。

### 11.2 中央の観測結果(封筒異常の実物。改訂後AC7の裏付け)

中央・8/8開催18頭最大レース(race_id=202604020511、**11R「3歳以上1勝クラス」・芝1000m・
17:50発走予定**〈#10で`race_list_sub`の生HTMLから`<span class="RaceList_Itemtime">17:50
</span>`を確認。`parseRaceList`〈本番パーサ〉の`RaceListEntry`型は発走時刻を持たないため、
生HTMLを直接参照した〉)のワイド・3連複とも、応答は次の80バイトで完全に一致した
(トリミングなし):

```json
{"status":"NG","data":"","update_count":"0","reason":"empty free odds schedule"}
```

これは boss が着手前ゲートで示した仮説「未発売時の封筒が `{"status":"NG","data":"",...}` の
ように `data` がオブジェクトですらない形で返る可能性がある」と**完全に一致する実物**であり、
`data` が非オブジェクト(空文字列)であっても throw せず `unavailable` に分類する改訂後AC7の
必要性を実物で裏付けた。`parseComboOdds` はこの応答を
`{state:"unavailable", reason:{rawStatus:"NG", rawReason:"empty free odds schedule",
missingKey:"data"}}` として分類する(`parse-combo-odds.test.ts`「状態③=未発売の実測」describe)。

### 11.3 地方の観測結果(OR判定の実物確認)

地方・佐賀(race_id=202655080803、3R「C2ー26組」、ダ1300m、**17:10発走予定**、頭数12、8/8開催)の
b5(ワイド)・b7(3連複)とも、次のコンテナ構成だった:

| ページ | `#odds_select` | `#odds_view_form` | `td.Odds` | 中身 |
|---|---|---|---|---|
| b5(ワイド、8/8開催17:10発走予定、未発売) | **なし** | あり | 12 | 「予想オッズ（単勝）」プレビュー(単勝のみ、人気順) |
| b7(3連複、8/8開催17:10発走予定、未発売) | **なし** | あり | 12 | 同上 |

`td.Odds` の数え方(boss要修正2対応。#13「HorseList行数16件」誤カウントの再発防止として明記する):
**`grep -c '<td class="Odds"'`**(開始タグの完全一致。`class="Odds"`という文字列一致ではなく、
`<td class="Odds"` という開始タグ全体で数える)で12件。当初「13件」と記録していたのは
`<th class="Odds">予想<br>オッズ</th>`(見出し行の`th`要素。`grep -c 'class="Odds"'`のような
緩い一致だと見出し行のthを1件誤って混入する)を数えてしまっていたための誤り。実際に本番実装
(`selectors.ts`の`NAR_COMBO_ODDS_SELECTORS.oddsCell = 'td.Odds[id^="chk_"]'`)がtd要素のみを
対象にしていることと整合させ、再検証(`grep -c '<td class="Odds"' fixtures/nar_odds_b5_presale_202655080803_20260806.html`
→12、`fixtures/nar_odds_b7_presale_202655080803_20260806.html`→12、いずれも`<th class="Odds"`は1件)
した。

**発見: b5・b7いずれの未発売ページも、券種固有のプレビューではなく、単勝の「予想オッズ」プレビュー
(`block=odds_yoso`)に一律フォールバックする。** 実際に2ファイルを`diff`したところ、本文の差分は
`meta`/`canonical`のURLと`<!-- block=... -->`のブロックキャッシュタグ(`cg`/`cp`)の5箇所のみで、
オッズテーブル本体は完全に同一だった(既存 `nar_odds_b1_presale_202642071301.html` と同型の
`block=odds_yoso`構造であることも確認済み)。

この実物により、`selectors.ts` の `NAR_COMBO_ODDS_SELECTORS` JSDoc・受け入れ条件8で要求された
「OR判定(`#odds_select` OR `#odds_view_form`)が b1 からの外挿ではなく実物のb5/b7でも正しく
分岐すること」を確認した: `#odds_select` が無くても `#odds_view_form` があるため文書としては
正当と判定され(throwしない)、かつ `td.Odds` 12件のいずれもワイド・3連複のセルid規約
(`chk_..._b5|b7_c0_...`)を持たない(単勝プレビューのtd.Oddsにはこのid自体が付かない)ため
組合せは0件となり、`unavailable` に分類される(`parse-nar-combo-odds.test.ts`
「状態③=未発売の実測」describe)。返り値は
`{state:"unavailable", reason:{cartCountFound:false, viewFormWrapperFound:true,
oddsCellCount:12}}`(boss裁定2026-08-07により地方側もreasonを保持するよう改訂。
詳細は`parse-nar-combo-odds.ts`の`NarComboOddsUnavailableReason`JSDoc参照)。

**追加の発見(要修正1の裁定過程で判明)**: 型の取り違え(発売済みの単複ページ`nar_odds_b1_202654071210.html`
をワイドパーサに通す)も同じ`{state:"unavailable"}`になるが、`reason`は
`{cartCountFound:true, viewFormWrapperFound:true, oddsCellCount:24}`と異なる値になり、
本当の未発売(`cartCountFound:false`・`oddsCellCount:12`)と区別できる。ただし
`oddsCellCount`はどちらのケースも0より大きい(単勝プレビューへのフォールバック自体が
`td.Odds`を持つドキュメントであるため)ため、`oddsCellCount>0`だけで型の取り違えと断定は
できない(誤検知を許容する早期警戒シグナルとして#33で扱うこと)。
