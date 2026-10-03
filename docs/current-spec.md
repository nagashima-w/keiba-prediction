# 現状の実装済み仕様(v1)

本書は **実際に実装されている現状(v1.19.0)** をまとめたもの。当初の設計・計画は
[`keiba-ev-tool-spec.md`](../keiba-ev-tool-spec.md)(中央競馬前提)と
[`docs/nar-scraping-plan.md`](./nar-scraping-plan.md)(地方競馬拡張)に残してあり、本書はそれらとの
乖離を含め「今どう動くか」を実コードに基づいて記述する。数値・定数は実装の既定値であり、多くは
設定画面またはconfigでチューニング可能。

- ツール名: 競馬期待値分析ツール(keiba-ev-tool)
- 種別: 複勝の期待値プラス馬券を抽出するデスクトップアプリ(Electron + React)
- **対応券種は用途によって異なる(3点。混同しないこと)**:
  - **配分提案**: 複勝+単勝+ワイド+馬連+馬単+三連複(単勝はIssue #90・#23-B2で、馬連は
    Issue #117・#24-D3b-2で、馬単はIssue #125・#24-E3bで追加)。複勝・単勝は常時対象、
    ワイド・馬連・馬単・三連複はオプトイン設定
    `includeWideInAllocation`/`includeQuinellaInAllocation`/`includeExactaInAllocation`/
    `includeTrioInAllocation`(既定ON。取得自体は`includeComboOdds`が別途必要。5節参照)。
    **単勝には専用のON/OFF設定を作っていない**(単勝は複勝・ワイド・馬連・馬単・三連複と
    同じ1つの予算枠に常に含める設計。D-10裁定)。そのため`includeComboOdds`がOFF・
    ワイド/馬連/馬単/三連複がすべて配分対象OFF・ワイド/馬連/馬単/三連複の候補合計が0件、
    のいずれかに該当して複勝専用の従来経路へフォールバックする状況では、**単勝もワイド・
    馬連・馬単・三連複と同様に提案されなくなる**(現状の制限として維持。5節参照)
  - **記録・回収率検証**: 新方式(proposedBet系、`ev/verify.ts`の`computeProposedBetReport`。
    Issue #71・#54-B)は複勝・単勝・ワイド・三連複・馬連・馬単・三連単・枠連の8券種に対応(単勝はIssue #100・#23-Cで、
    馬連はIssue #114・#24-F1で、馬単はIssue #121・#24-F2で、三連単はIssue #131・#25-Fで、枠連はIssue #145・#26-Fで追加。それ以前はそれぞれが「未対応の券種コード」扱いだった)。
    `analysis_bets`テーブルへ`bet_type`列付きで保存された買い目のうち、この8券種以外の
    `bet_type`は引き続き「未対応の券種コード」として別集計(`unknownBetType`)へ計上し、
    回収率集計(overall)からは除外する(検証画面には除外している旨の注記が出る)。旧方式
    (`VerifyReport.bet`。複勝一律100円ずつ買ったと仮定した累積回収率)は複勝のみを対象と
    する設計(賭け金の仮定がproposedBet系と異なるため合算しない。AC-B5)で、こちらは
    変更していない。`ev/analysis-store.ts`は複勝の確定払戻(`race_results.place_payout`)・
    単勝の確定払戻(`race_results.win_payout`、Issue #100)をレース結果テーブルへ、
    ワイド・三連複・馬連・馬単・三連単・枠連の確定払戻(ワイド・三連複はIssue #52、馬連はIssue
    #114・#24-F1、馬単はIssue #121・#24-F2、三連単はIssue #131・#25-F、枠連はIssue #145・#26-F)を
    `race_combo_payouts`/`race_combo_payout_imports`テーブルへ、それぞれ永続化する。
    **枠連の払戻は`tr.Wakuren`から読み、キーは馬番ではなく枠番の組(例: 4枠と7枠は"0407"、同枠は"0202")。
    8頭以下のレースには`tr.Wakuren`行が無く、「取込済み・0件」(発売なし)として保存される。
    枠連はIssue #150(#26-E3b)で配分提案・画面表示に接続されたため、`bracketQuinella`は検証画面の
    内訳・判定不能の行にも表示する(表示順は馬連→枠連→馬単)**。
    **馬連はIssue #117(#24-D3b-2)、馬単はIssue #125(#24-E3b)でそれぞれ配分提案への
    組み込みが完了し、買い目が実際に発生するようになったため、検証画面(`VerifyView.tsx`)の
    内訳・判定不能の行にも表示するようになった(表示順は馬連→馬単で、ワイドと3連複の
    間)**(それまでは買い目が構造的に0件だったため、#112「馬連 ¥0 0点」の事故と同型を
    避けるためあえて表示しない設計だった)。
    取得(オッズ・配分提案)と検証(回収率集計)は別軸であることに注意(5節の配分提案は
    既に単勝・ワイド・馬連・馬単・三連複対応済みだが、これは組合せ**オッズ**の話で本項の
    組合せ**払戻**とは別物。組合せオッズの永続化自体も別Issue #53)
  - **単勝オッズ**: Issue #90以降は2つの用途を持つ。(a) 発売前レースで複勝下限を概算する用途
    (`estimatePlaceOddsMinFromWin`。従来どおり)、(b) 5節の配分提案における単勝の候補自体の
    値付け(`ev/combo-bet-allocation.ts`の`buildWinCandidates`が同時分布モデルの順序付き
    outcome空間から導出した1着確率×単勝オッズでEVを算出する。複勝〈3着内〉確率では値付けしない)
  - **馬連・馬単・三連単ともに配分提案・画面表示まで含めて対応済み**(#24-D3シリーズ・
    #24-Eシリーズ・#25-E3bシリーズ)。**枠連も配分提案・画面表示まで含めて対応済み**(#26-E2〈取得〉・
    #26-E3a〈設定の配管。`includeBracketQuinellaInAllocation`・既定ON〉・#26-E3b〈配分・画面。Issue #150〉。
    配分記録のメタ行への`include_bracket_quinella`列追加と過去分析再表示の「枠連: ON/OFF/記録なし」は
    #26-E3c〈Issue #151〉で対応済み。詳細は下記「配分記録の永続化」節参照)、枠単は引き続き未対応
    (拡張のロードマップと技術的な依存関係はGitHub Issue #22)。馬連対応の経緯:
    core の確率・候補ビルダー・配分(Issue #112・v1.9.5。`buildQuinellaCandidates` が順序付き
    outcome 空間から1着・2着の集合を周辺化して的中確率を求める。上位3着の集合から求めると
    ワイドと同じ値になるため)→ 馬連オッズのパーサ・取得関数(Issue #113・v1.9.6。中央
    `api_get_jra_odds` の`type=4`・地方 `odds/index.html?type=b4`。キーは昇順正規化・値は
    単一値)→ 馬連の確定払戻の取込・回収率検証(Issue #114・#24-F1。上記「記録・回収率検証」
    参照)→ 配分に含めるかの設定`includeQuinellaInAllocation`の配管(Issue #115・#24-D3a。
    既定ON)→ `scrape-race.ts`(オッズ取得)への配線・分析結果/保存スナップショットへの搭載・
    `shared/mixed-candidates.ts`の候補ビルダー(`buildMixedCandidates`)対応(Issue #116・
    #24-D3b-1。`includeComboOdds: true`のとき、既存のワイド・3連複の**後**に馬連オッズを
    1リクエスト追加で取得する〈中央 `type=4`・地方 `type=b4`、いずれも単発リクエストで
    完結。地方3連複の軸馬別取得とは異なる〉)→ **配分の券種選択
    (`shared/mixed-race-allocation.ts`の`resolveMixedBetTypes`・D-2フォールバック規則)への
    接続と画面表示(Issue #117・#24-D3b-2)**。これにより`includeQuinellaInAllocation`がONで
    馬連オッズが取得できていれば、一括分析画面の配分内訳・検証画面の回収率内訳に馬連が
    ワイドと3連複の間に表示されるようになった(利用者から見える変化はここで初めて生じた)。
    **馬単対応の経緯**(馬連〈#112〜#118〉と同じ切り方。`#24-E`は`#120`/`#121`/`#122`/`#123`に
    分割し、`#123`はさらに`#124`〈E3a〉/`#125`〈E3b〉/`#126`〈E3c〉に分割): core の的中確率・
    候補ビルダー・配分の門番(Issue #120・#24-E1。馬単は着順が意味を持つ券種のため、
    順序付きキー〈`buildOrderedComboOddsKey`〉でオッズを引き、`buildExactaCandidates`が
    P(n,2)通りの順序付きペアを列挙してP(1着=a,2着=b)で的中確率を求める)→ 馬単の確定払戻の
    取込・回収率検証(Issue #121・#24-F2)→ `scrape-race.ts`(オッズ取得)への配線・
    分析結果/保存スナップショットへの搭載・`shared/mixed-candidates.ts`の候補ビルダー
    (`buildExactaCandidatesForBetType`)対応(Issue #122・#24-E2。`includeComboOdds: true`
    のとき、既存のワイド・3連複・馬連の**後**に馬単オッズを1リクエスト追加で取得する
    〈中央`type=6`・地方`type=b6`、いずれも単発リクエストで完結〉)→ 配分に含めるかの設定
    `includeExactaInAllocation`の配管(Issue #124・#24-E3a。既定ON)→ **配分の券種選択
    (`shared/mixed-race-allocation.ts`の`resolveMixedBetTypes`・D-2フォールバック規則)への
    接続と画面表示(Issue #125・#24-E3b)**。これにより`includeExactaInAllocation`がONで
    馬単オッズが取得できていれば、一括分析画面の配分内訳・検証画面の回収率内訳に馬単が
    馬連と3連複の間に表示されるようになった(利用者から見える変化はここで初めて生じた)。
    配分記録のメタ行への`include_exacta`列追加・過去分析再表示の「馬単: ON/OFF/記録なし」は
    #24-E3c(Issue #126)で対応済み(馬連の`include_quinella`と同じ切り方。詳細は下記
    「配分記録の永続化」節参照)。
    **三連単対応の経緯**(馬連・馬単と同じ切り方。`#25`は`#127`〈A: 実測調査〉/`#128`
    〈B: core〉/`#129`〈C: 性能〉/`#130`〈D: データ〉/`#131`〈F: 払戻と検証〉/`#132`〈E: app〉に
    分割し、`#132`はさらに`#136`〈E0〉/`#137`〈E2〉/`#138`〈E3a〉/`#139`〈E3b〉/`#140`〈E3c〉に
    分割): core の的中確率・候補ビルダー・配分の門番(Issue #128・#25-B。三連単は馬単と同じく
    着順が意味を持つ券種のため、順序付きキー〈`buildOrderedComboOddsKey`〉でオッズを引き、
    `buildTrifectaCandidates`がP(n,3)通りの順序付きトリプルを列挙してP(1着=a,2着=b,3着=c)で
    的中確率を求める)→ 三連単の確定払戻の取込・回収率検証(Issue #131・#25-F)→
    配分計算の性能実測とcandidateCap引き上げ(Issue #129・#25-C、Issue #136・#25-E0。
    既定2000→8000)→ `scrape-race.ts`(オッズ取得)への配線・分析結果/保存スナップショットへの
    搭載・`shared/mixed-candidates.ts`の候補ビルダー(`buildTrifectaCandidatesForBetType`)対応
    (Issue #137・#25-E2。`includeComboOdds: true`のとき、既存のワイド・3連複・馬連・馬単の
    **後**に三連単オッズを1リクエスト追加で取得する〈中央`type=8`のみ、単発リクエストで
    完結〉)。**三連単は地方(NAR)では取得しない**(ユーザー判断2026-09-27。地方三連単は
    軸馬別取得〈1着固定・頭数分のリクエストが必要〉のコストが大きく、当面実装しない。
    `scrapeRace`は地方では調教〈oikiri〉と同じ`if (!isNar)`の明示ガードで三連単の取得自体を
    試みない)→ 配分に含めるかの設定`includeTrifectaInAllocation`の配管(Issue #138・#25-E3a。
    既定ON)→ **配分の券種選択(`resolveMixedBetTypes`・D-2フォールバック規則)への接続と
    画面表示(Issue #139・#25-E3b)**。これにより`includeTrifectaInAllocation`がONで
    三連単オッズが取得できていれば(中央競馬のみ)、一括分析画面の配分内訳・検証画面の
    回収率内訳に三連単が3連複の直後(表示順の末尾)に表示されるようになった。
    **地方(NAR)のレースで三連単が未取得のとき**、他券種の「設定変更後に再分析すると
    反映されます」という文言(再分析すれば実際に取得される場合の案内)は誤りになるため、
    「地方競馬では三連単を取得していません」という専用の注記に差し替える(地方は当面
    三連単を取得しないため、再分析しても反映されないという事実に合わせる)。
    **配分0点の説明は追加しない**(16頭の一部レースで三連単にEVプラスの候補がありながら
    配分額が厳密に0になる現象〈Kelly/貪欲最適化による他券種との資金配分の奪い合い〉が
    実測で確認されているが、これは三連単固有ではなくポートフォリオ最適化一般の性質であり、
    既存4券種にも同じ理由の「¥0 0点」が注記なしで起こりうるため、三連単だけに特別な注記を
    付けると非対称なUIになる。Issue #139着手前ゲートの判断)。
    配分記録のメタ行への`include_trifecta`列追加・過去分析再表示の「三連単: ON/OFF/記録なし」
    は#25-E3c(Issue #140)で対応済み(馬連の`include_quinella`・馬単の`include_exacta`と
    同じ切り方。詳細は下記「配分記録の永続化」節参照)。
    **DBサイズへの影響(2026-09-27実測)**: `trifectaCombo`は出走頭数nに対しP(n,3)通りの
    キーを持つ(他券種〈ワイド・3連複・馬連・馬単〉より1桁多い)。実測(中央16頭・
    race_id=202603020211・`fixtures/odds_trifecta_202603020211.json`。再現:
    `pnpm tsx scripts/bench-mixed-allocation.ts`の「trifectaComboのJSONサイズ実測」節)では
    3360キー・`JSON.stringify`後53,785バイト(約52.5KB)。この値は`analyses.race_snapshot_json`
    (SQLite TEXT列。`RaceSnapshot.trifectaCombo`のプレーン写しがそのまま保存される)へ
    `includeComboOdds:true`の分析を保存するたびに追加されるため、18頭立て(P(18,3)=4896キー)
    では比例的に約76KB程度に増える見込み(**この18頭側の数値は上記実測からの比例外挿であり、
    実測ではない**)。圧縮・保存方針の見直しは既存Issue #53の範疇として扱う(本Issueでは
    `trifectaCombo`追加自体を妨げない)
- バージョン: ルート/アプリ `1.19.0`、`@keiba/core` `0.2.0`(`@keiba/core` は版数運用の対象外・据え置き。
  private かつ npm 未公開で、app からは `workspace:*` 参照のみのため版数が意味を持たない。詳細は
  [`docs/versioning.md`](./versioning.md))
- 思想: 的中率ではなく回収率(期待値)最大化。「市場(オッズ)が過小評価している馬」を、市場から
  独立した確率推定 × 市場オッズで見つける。個人利用専用。

## 全体構成(pnpm ワークスペース)

```
packages/core  … @keiba/core: scraper / scorer / analyzer / ev / notify を UI 非依存のライブラリとして実装
packages/app   … @keiba/app: Electron(main/preload)+ React(renderer)デスクトップアプリ
scripts        … CLI・アイコン生成・フィクスチャ取得などの補助スクリプト
fixtures       … テスト用の保存済み HTML/JSON(テストは実サイトへアクセスしない)
```

- **renderer は core のバレル(`@keiba/core`)を import しない**。バレル経由だと `better-sqlite3`・
  `node:zlib` 等のネイティブ/Node 専用依存が renderer のブラウザ向けバンドルに巻き込まれ、Vite ビルドが
  落ちる(実際に `node:zlib` の混入で CI が失敗した実績がある)。取得・DB・LLM 呼び出しなどネイティブ依存
  を伴う処理は main プロセスに集約し、renderer は IPC 経由で結果を受け取る(当初仕様「UI はコアを直接
  import」からの意図的な差異。README「仕様との差異」参照)。
- ただし**純粋な計算ロジックに限り、renderer から core の `exports` サブパスを直接 import してよい**
  (例: `@keiba/core/ev/race-opportunity`、`@keiba/core/ev/bet-allocation`、
  `@keiba/core/scraper/validate-period-input`)。サブパス公開により Node 専用モジュールを引き込まない
  ことがビルドで保証される。**新しく renderer から core を使うときは必ずサブパスを追加すること。**
- 主要モジュール(core、`packages/core/src/index.ts` が公開 API): `scraper/`(取得)、`scorer/`(数値
  スコアリング)、`analyzer/`(LLM 分析と材料生成)、`ev/`(期待値・検証・分析履歴ストア)、`notify/`(Discord)。

## 1. 取得(scraper)

netkeiba から 1 レース分の完全データ(`RaceData`)を組み立てる。ファサードは `scraper/scrape-race.ts`。

- **取得対象**: 出馬表(`parseShutuba`)、各馬の全戦績(`parseHorseResults`、Ajax JSON API)、
  調教/追い切り(`parseOikiri`、optional)、単勝・複勝オッズ、レース一覧、レース結果(`parseRaceResult`)。
  馬個別プロフィールページ(db.netkeiba.com/horse)は**取得しない**(厩舎所在地は出馬表に、全戦績は
  Ajax API に含まれるため。1 レースの GET 数を「出馬表1 + 戦績N + 調教1 + オッズ1」に抑える設計)。
- **中央/地方(NAR)両対応**: `venueKindOfRaceId`(場コード 01〜10 が中央、30〜64 が NAR)で分岐。
  中央のオッズは JSON API(`api_get_jra_odds`)、地方はオッズ用 JSON API が無いため静的 HTML
  (`odds/index.html`)を `parseNarOdds` で解釈する。詳細は `docs/nar-scraping-plan.md`。
- **レート制限とキャッシュ**: リクエストは最低 1.5 秒間隔・User-Agent 明示(`http-client.ts`)。取得結果は
  SQLite にキャッシュ(`cache.ts`)し同一レースの再取得を避ける。TTL はデータの揮発性で使い分け
  (戦績は24時間・調教とレース一覧は6時間、出馬表は10分〈#155。取消・馬体重・乗り替わりの更新を拾う〉、オッズは60秒)。発走直前は `bypassOddsCache` でオッズのみキャッシュを迂回。
  `HttpClient`/`CachedFetcher` は GET 専用ではなく POST(method/body/追加ヘッダ)にも対応し、
  URL が固定でリクエスト識別子が POST ボディに入る API 向けに `cacheKey`(省略時は URL)を明示指定できる
  (同レース過去10年結果 API 向け。詳細は次項)。
- **期間一括取得**: 日付範囲を `enumerateDates` で列挙し、`validatePeriodInput` で入力検証したうえで
  複数日・複数レースをまとめて取得する(`packages/app` 側の一括分析と連動)。
- **エラー方針**: 必須データ(出馬表・オッズ)の失敗は throw。optional データ(調教)の失敗はその項目を
  null にして警告(`ScrapeWarning`、kind: 調教/戦績)を積む。戦績は馬単位で握り、1 頭の失敗で全体を落とさない。
- **取消・除外の馬は出走馬から除く(Issue #154)**: 発走前に取消になった馬は出馬表に残ることがある
  (中央 202606040901 で観測。一覧16頭・出走15頭)。印は行の `<tr class="HorseList Cancel">` と
  `<td class="Cancel_Txt">取消</td>`(`SHUTUBA_SELECTORS.cancelledRow`・`cancelText`)。
  `parseShutuba` は取消馬も `horses` に残して `ShutubaHorse.scratch`(取消/除外/不明)と原文
  `scratchText` を付け(出走馬にはキー自体が無い)、`scrapeRace` が**戦績取得の前に**出走馬から除く。
  これで頭数・prior の Σ 目標 `min(3,頭数)`・LLM プロンプト・EV・同時分布・配分の候補・複勝の発売条件
  (`resolvePlaceBetTarget`)・戦績取得・組合せオッズの期待組合せ数と地方3連複の軸馬・枠連の枠構成が、
  実際に走る馬だけから作られる(`runAnalysis` 側に除去は無い。production の経路は `scrapeRace` だけ)。
  除いた馬は `RaceData.meta.scratched`(いなければキー自体が無い)と警告(kind=出走取消、1頭1件。
  `AnalysisResult.warnings` に載り画面の警告欄に出る)に残る。`odds.win`/`odds.place` の取消馬の欄
  (オッズ null・人気 9999)は触らない。全馬が取消扱いなら `ShutubaParseError`(構造変更の兆候)。
  未知の文言(「取消」「除外」以外・文言が空で `Cancel` クラスだけ)は「不明」とし**出走しない側に倒す**。
  **未観測の前提**: 実物の観測は中央 202606040901 の「取消」(発走後の取得)の1本だけ。**発走前の
  時点の印・地方(nar.netkeiba.com)の出馬表の印・「除外」の文言は未観測**で、同じ雛形・同じ印と見込んでいる
  (地方・除外のテストは既存フィクスチャを改変した「合成」)。出馬表のキャッシュ TTL は
  当初6時間で、その間に発表された取消はキャッシュ上の出馬表に印が無く除けなかったため、**#155 で10分に短縮した**
  (`DEFAULT_SHUTUBA_TTL_MS`。戦績・調教・レース一覧の TTL は変えていない)。10分以内に発表された取消は、
  次に10分を超えて取り直すまで反映されない。
- **開発補助 CLI**: `scripts/dump-race.ts`(`--race` / `--date` / `--fresh-odds` / `--out` / `--db`)で
  1 レース分または開催日一覧を JSON ダンプできる(通常利用はアプリで行う。README「CLI」参照)。

## 2. スコアリング(scorer)

数値データから各馬の**複勝圏内(3着以内)確率の事前推定値 prior** を決定論的に算出する。設定は
`scorer/config.ts` の `DEFAULT_SCORER_CONFIG`(重み等はすべて設定画面/verify を見てチューニング可能)。

- **基礎スコア6項目**(`base-score.ts`、既定重み): 近走着順(重み減衰 0.8・直近6走)0.2 / 上がり3F水準
  0.1 / コース・距離適性 0.15 / 騎手の当該コース複勝率 0.15 / 斤量・馬体重増減 1.0 / コースレベル枠順
  バイアス(定数テーブル `frame-bias-table.ts`)1.0。相関の強い能力推定は多重計上を避けて控えめ。
- **環境・状態バイアス7項目**(既定重み各1.0): 馬場状態適性(道悪、`bias-track-condition.ts`)/
  競馬場適性(`bias-venue.ts`、出走歴が無い場は `course-traits.ts` の類似度で代替評価)/ 季節適性
  (`bias-season.ts`)/ 枠順適性(馬個別、`bias-frame.ts`)/ 夏負けフラグ / 輸送・滞在バイアス
  (`bias-transport.ts`)/ ローテーション適性(鉄砲・叩き良化・使い込み下降、`bias-rotation.ts`)。
- **戦績の扱い(先読みリークの遮断。Issue #39)**: netkeiba の馬ページの戦績は日付で絞られていないため、
  過去のレースを分析すると、そのレース自身の走と施行日以降の走が含まれる(実測: 中央16頭で全114走のうち
  自レース16走・施行日より後5走)。`runAnalysis`(`analysis-pipeline.ts`)は **scrape 直後の1点**で
  戦績を絞り、以降の消費箇所(prior・LLMプロンプト入力〈runs・条件替わり・馬体重推移・人気着順乖離・
  乗り替わり・着差傾向・休養間隔〉・結果行の `careerRunCount`・条件替わりタグ)はすべて絞った戦績を使う。
  scraper では絞らない(生の戦績が必要な用途があるため)。絞り方は次の2つ(`scorer/snapshot-filter.ts`)。
  - `excludeOwnRaceResults`: **当該 raceId の走を日付に依らず除外**する。比較は `HorseRaceResult.raceIdRaw`
    (中央・地方とも12桁の生値)で行う。`raceId` フィールドは地方では常に null のため使わない。
  - `filterRaceDataBefore`: 基準日(`analysisDate`)**と同日以降**の走と、**日付欠損・不正形式の走**を
    除外する(未来の走を混ぜない保守側。手元フィクスチャ〔中央16頭・18頭・地方12頭〕の全走で日付欠損は0件で、
    通常運用の結果は変わらない)。
  当日の未施行レースでは自レースの走も施行日以降の走も存在せず、何も変わらない。`kaisaiDate` が渡らず
  実行日で近似(`dateApproximate=true`)した場合、自レースの走は raceId で除かれるが、施行日より後・
  実行日より前の走は残る(既知の限界。近似日は UI から到達しない)。`results=null`(戦績取得失敗)は
  null のまま、0走(新馬)は `[]` で、区別を保つ。絞りに使った基準日は保存レコードの
  `historyCutoffDate`(DB の `analyses.history_cutoff_date`。4節・後述の「先読みリーク遮断の記録」参照)
  に書く。LLM プロンプト側の先読みリーク(同日傾向への後続レース混入・地方の同レース過去10年結果への
  当該回/後の回の混入)の遮断は次項(Issue #153)。
- **LLM プロンプト側の先読みリークの遮断(Issue #153)**:
  - **当日傾向**(`collectSameDayTrend`): 集計対象は**自レースより前のレース番号**(01〜自番号-1。
    `scraper/ids.ts` の `precedingRaceIdsSameDay`)だけ。以前は自番号以外の01〜12
    (`siblingRaceIdsSameDay`)を見ており、過去レースを後から分析すると取込済みの後続レースの結果
    (自レースの発走時点では存在しない)が当日傾向に混ざった。`siblingRaceIdsSameDay` は変更せず、
    `precedingRaceIdsSameDay` がその結果から自番号より小さいものだけを残す(`collectSameDayTrend` は
    後者だけを呼ぶ)。当日運用では後続レースは未取込のため結果は変わらない。
  - **同レース過去10年結果傾向**(`collectGradeWinnerTrend`): 集計の前に `excludeLookaheadEntries`
    (`grade-winner-trend.ts`)で、①`raceId` が対象レースと一致する回、②`raceDate` が基準日(`analysisDate`、
    戦績の絞り込みと同じ値)と同日以降の回、③`raceDate` が null・不正の回を除く(日付は数字だけにそろえて
    比較)。`対象回数`(プロンプトの「対象N回中」)は**除いた後の件数**。実測
    (`docs/grade-winner-lookahead-investigation.md`)で、地方は、実測した2本(同じ大井の同一重賞
    シリーズ)では race_id に依らず同じ応答(最新10年。当該年を含む)を返し(別シリーズは未確認)、中央は要求した回の年より前の10年を返す(中央では何も除かれない)。
    `kaisaiDate` が渡らず近似日(実行日)になった過去分析では、当該回は raceId で除かれるが当該回より後で
    実行日より前の回は残る(既知の限界。近似日は UI から到達しない)。
  - `PROMPT_VERSION` は据え置き(遮断済みかどうかは版ではなく `analyses.prompt_lookahead_guarded` で区別する。
    4節「先読みリーク遮断の記録」参照)。
- **共通ルール**: 各バイアスは「対象条件の複勝率 − 全体複勝率 × 重み」の差分ベース(`aggregate.ts`)。
  サンプル 2 走未満は補正なし(`minSampleForBias=2`)。各バイアスの寄与度は内訳(`BiasContribution`)として
  ログ可能。
- **prior 合成**(`prior.ts`): 基礎スコア + バイアス補正合計(バイアスは過剰補正防止のため
  `biasCorrectionScale=0.3` で一律減衰)を、頭数レベル正規化(目標複勝圏内数 min(3, 頭数)へ寄せる、
  逸脱許容 0.1)したうえで prior を算出。prior は [0.02, 0.95] にクランプ。
- **EV(期待値)**(`ev/expected-value.ts`): 複勝期待値 = place_prob × **複勝オッズ下限(oddsMin)**。
  EV > 閾値(既定 1.0、厳密不等号)の馬のみ `isPositive=true`。オッズ欠損馬(馬番が無い/下限が
  null)、および複勝オッズ下限が**値域外**(オッズの値域は1.0以上であり、0を含む1.0未満・非有限は
  値域外。判定は `ev/allocation-primitives.ts` の `isUsableOdds` に集約。Issue #74)の馬は EV=null
  で対象外。値域外の場合も `placeOddsMin` は生の値を保持し null に潰さない(判定不能〈値域外〉と
  判定結果〈EV=0等〉を混ぜない。Issue #31 の原則)。
  発売前(oddsStatus=yoso で複勝オッズが無い)場合は単勝オッズから複勝下限を概算する
  `estimatePlaceOddsMinFromWin`(係数 0.2、あくまで概算で `evEstimated=true` として区別)。

## 3. LLM 分析(analyzer)

scorer の prior と多数のテキスト材料をプロンプト化し、Claude が補正後確率・予想印・根拠を返す。

- **モデル/呼び出し**(`anthropic-client.ts`・`model-selection.ts`。Issue #157 で `claude-sonnet-4-6` から移行):
  - **固定モデル**は `claude-sonnet-5-5`(`DEFAULT_ANALYZER_CONFIG.model`)。**最新の Sonnet を自動選択**する:
    Models API(`client.models.list()`)の ID を `^claude-sonnet-(\d{1,2})(-\d{1,2})?$` で絞り(日付付き
    スナップショット・preview 等は除外。minor を1〜2桁に限るのは `claude-sonnet-4-20250514` が minor=20250514
    の最新版として選ばれるのを防ぐため)、(major, minor) の降順、同順位は `created_at` の新しい順で選ぶ。
    一覧は**分析の初回に遅延取得**し、`createPipelineDeps` 単位でメモ化する(失敗もメモ化・TTL なし)。
    取得失敗・Sonnet 0件のときは固定モデル。自動選択モデルが **HTTP 400/403/404** を返したら固定モデルで
    1回やり直し(以降その deps の間は固定モデル。切り替えは `onWarn` に記録)、401・429・5xx・
    ネットワーク・refusal・max_tokens では切り替えない。`analyzeRace` のリトライ構造は変えない。
  - **リクエスト**: `max_tokens=16000`(thinking を含む。非ストリーミングのまま。SDK 0.70.1 は 21333 超で
    例外)、`output_config: { effort: "low" }`(SDK 0.70.1 の型に無いため型の外で送る。設定可能な値として
    `AnalyzerConfig.effort` を持つ)。**`temperature` は送らない**(Sonnet 5.5 は既定値以外を拒否する)。
    thinking は指定しない(既定の adaptive)。応答は `type==="text"` のブロックだけを連結する。
  - **停止理由**: `max_tokens` は `AnalyzerTruncationError`、`refusal` は `AnalyzerRefusalError`
    (固定文言 `FALLBACK_REASON_REFUSED`、`stopReason="refusal"`)として扱い、どちらも1回リトライしたうえで
    全馬 prior にフォールバックする。
  - **使ったモデルの記録**: `LlmClient.completeDetailed`(任意実装)が `{text, model}` を返し、
    `AnalyzeRaceResult.modelUsed`(応答の `model` を優先、無ければリクエストした ID)→
    `analyses.model` 列と `AnalysisResult.model` に記録する(拒否・切り詰めで終わった場合も、例外が運ぶ応答モデルで
    記録する。HTTP エラー・ネットワーク断などで応答自体を得られなかったときだけ、静的な固定モデル名で代用)。分析結果の画面に「分析モデル: …」を1行出す。`PROMPT_VERSION` は上げない
    (文面が同一のため。検証画面の版別集計にはモデルが混ざる)。
  - 経緯: 旧設定は `maxTokens=8192`・`temperature=0`。18 頭級の応答が 2048 トークンで切り詰められ
    全馬 prior に落ちる事故を受けて 8192 にしていたが、thinking の出力も数える Sonnet 5.5 では 16000 にした。
- **プロンプト材料**(`build-prompt.ts` が組み立て、各材料は決定論的な純関数):
  展開想定(脚質分布・主導権候補・想定ペース・恵まれる/損する脚質、`leg-style.ts`。地方の前残り・馬場不良に
  対応)/ 芝の傷み目安(`turf-wear.ts`)/ 当日傾向(同一場・同一面の当日結果集計、`same-day-trend.ts`)/
  馬体重推移(`body-weight-trend.ts`)/ 過去走の人気・着順乖離(`market-gap.ts`)/ 乗り替わり(騎手継続・変更、
  `jockey-change.ts`)/ 過去走の着差(`margin-trend.ts`)/ 条件替わり(サーフェス・距離延長短縮・中央⇄地方、
  `condition-change.ts`)/ 調教(oikiri)/ 同レース(重賞)の過去10年結果傾向(`grade-winner-trend.ts`。下記)。
- **同レース(重賞)の過去10年結果傾向**(`grade-winner-trend.ts`・`fetch-grade-winner.ts`・
  `parse-grade-winner.ts`): 分析対象が重賞のとき、同一レースの過去10年結果(netkeiba内部API
  `AplGradeWinner`。中央・地方〈NAR〉いずれもホスト自動選択で取得)を集計し、【レース情報】末尾に
  最大3行(①対象回数・条件一致/除外・頭数レンジ・馬場内訳・柵内訳、②複勝圏内馬の人気レンジ・
  二桁人気頭数・複勝配当レンジ/中央値、③複勝圏内馬の平均通過順相対・平均上がり・平均馬番相対。
  いずれもサンプル数併記でラベル〈内有利/外有利等〉は付けない)を追加する。②の見出し
  「複勝圏内(延べN頭)」のNは3着以内の延べ頭数であり、人気・複勝配当それぞれの標本数(n=)とは
  別物(fuku_pay3欠損・複勝非発売・3着同着・payback丸ごとnull等で食い違うことがある)。誤読を
  避けるため人気・複勝配当それぞれに自身のサンプル数を併記する(2026-07-28小改善)。条件フィルタは
  場コード(raceId由来)+コース種別+距離の完全一致のみ、一致3回未満はブロック非表示。
  **呼び出しの事前判定**: 出馬表のレース名見出しに重賞グレードバッジ(`Icon_GradeType`)がある
  ときだけ呼び出す(`parseShutuba` の `hasGradeBadge`。判定不能〈旧データ等〉なら fail-open で
  呼ぶ)。これにより非重賞レースへの無駄なリクエストを避ける(重賞判定はバッジの有無のみで、
  グレード番号は解釈しない)。地方(NAR)にも対応(`nar.netkeiba.com` の同一API)。
- **プロンプト版の記録**: `PROMPT_VERSION`(現行 `"2026-07-28.2"`)を分析ごとに保存し、版別に検証比較する。
  設定画面の追加指示(`additionalInstruction`)も版とは別軸で記録する。
- **クリップ幅の A/B(`clip-variants.ts`、単一の真実源 `CLIP_VARIANTS`)**: prior からの補正上限を
  版として切替。`default`=±10%(絶対値0.10、対照)、`wide15`=±15%(絶対値0.15)。版文字列に幅を内包
  (例 `2026-07-28.2-clip015`)し、プロンプト文面・クリップ幅・版文字列をレジストリから機械導出して
  食い違いを防ぐ。実際のクリップは `parseAnalyzerResponse` の `maxAdjust` で行う。
- **予想印**: ◎〇▲△☆注(`PREDICTION_MARKS`)。◎はちょうど1頭必須、本線印は飛ばさない優先順位制約。
- **フェイルセーフ**(`analyze-race.ts` / `parse-response.ts`): JSON 破損・切り詰め(`AnalyzerTruncationError`、
  stop_reason=max_tokens)・呼び出し失敗は 1 回リトライ後に**全馬 prior 採用**(`fallback:true`、理由を
  3 分類 `FALLBACK_REASON_TRUNCATED` / `_PARSE_ERROR` / `_INVOCATION_ERROR` で可視化)。印制約違反
  (`AnalyzerMarkViolationError`)は確率補正は残して**印だけ落とす**救済(`marksDropped:true`)。
- **キャリブレーション**: verify 側で推定確率帯ごとの実際の複勝率・過信バイアスを算出(下記4)。

## 4. 検証(ev/verify)

分析結果と実結果を突き合わせて予実を可視化する(`ev/verify.ts`、履歴ストアは `ev/analysis-store.ts`)。

- **結果取込**: レース結果を取り込み(`parse-race-result.ts`)。未確定レース(結果表はあるが着順行が
  0 件)は構造異常と区別して `RaceResultNotConfirmedError` で穏やかに扱う。未取込レースの一括取込に対応。
- **組合せ払戻(ワイド・三連複)の取得・永続化(Issue #52)**: `parseRaceResult` は着順・複勝・単勝に
  加えて `widePayouts`/`trioPayouts`(判別共用体 `RaceComboPayoutResult`)を返す。組(複数馬番)を
  表現できない既存 `RacePayoutEntry` は流用せず、`{umabans, payout}` の新型で表す。
  - **`state:"parsed"`**(組を取得できた。`payouts:[]`は「払戻テーブルはあるがこの券種の行が無かった
    〈未発売等〉」の意味に限定)と、**`state:"undetermined"`**(構造異常・払戻未公開で判定不能。
    理由は`kind`で分類: `payoutTableAbsent`/`groupCountMismatch`/`comboSizeMismatch`/
    `invalidUmaban`/`duplicateCombo`)を明確に区別する(空配列を「判定結果」、undeterminedを
    「判定不能」として扱う二層原則。`ev/combo-bet-allocation.ts`の`ComboOddsResolution`と同型)。
    ワイド・三連複の的中組数はレースごとに一定ではない(3着同着でワイドが3組を超える等)ため、
    組数を固定値で検証しない。ワイド・三連複行の構造異常は複勝・単勝・着順の取込を巻き添えにしない。
  - 永続化は新テーブル `race_combo_payouts`(値。`race_id`/`bet_type`/`combo_key`/`payout`)と
    `race_combo_payout_imports`(取込済みマーカー。`race_id`/`bet_type`)の2本。
    `AnalysisStore.saveResult` の第4引数(`comboPayouts`)として`race_results`・
    `race_result_meta`と単一トランザクションで書く。`state:"undetermined"`の券種はDBに一切触れない
    (一過性の構造異常での再取込が正しい過去データを破壊しないため)。再取込で組数が減った場合は
    delete-then-insertで古い行を残さない。
  - 読み出しは`AnalysisStore.getComboPayouts(raceId, betType)`。「未取込」(一度も取り込んでいない・
    Issue #52より前の旧DB・直近の取込が構造異常)と「取り込んだが該当券種の払戻が0件」を、
    `race_combo_payout_imports`のマーカー行の有無(`race_results`の行の有無ではない)で区別する。
  - **verify(`ev/verify.ts`)は本Issueでは一切変更していない**(読み手はIssue #54)。
    取得・永続化はできるが回収率集計には未反映。
- **回収率サマリ**(`VerifyBetSummary`): EV プラスで購入した点数・賭け金・払戻・回収率。既定 stake 100 円。
  - **複勝の的中判定は「規則H」**(Issue #70): レースに `placePayout` 非 null の行が**1件以上あれば**
    「複勝払戻が取込済み」とみなし、的中はその馬の `placePayout` が非 null かどうかで決める
    (**着順を見ない**)。払戻は実配当。1件も無ければ従来どおり着順(`finish <= placeMaxRank`)で
    判定し複勝下限で近似する(近似計上件数を区別)。
    **これにより5〜7頭立て(複勝は2着まで)の3着馬を的中扱いする過大計上が消える**(#51)。
    出走頭数は DB から復元できない(中止・除外・取消の着順がすべて null に潰される)が、
    必要なのは「複勝の払戻対象馬の集合」であり、それは公式払戻表そのものとして厳密に取れる。
    **残余**: 「払戻未取込かつ5〜7頭立て」だけは過大計上が残る(到達は稀。塞がないと決めた)
  - **オッズが使えない買い目は「規則U」で判定不能として除外**(Issue #50): `isUsableOdds` を
    通らない `placeOddsMin` の馬は、点数・賭け金・払戻の**いずれにも計上せず** `unjudgedOddsCount`
    に別に数える。現行の本番経路では到達しない防御的堅牢化
- **キャリブレーション**: 推定確率帯(既定 10 分割)ごとの実複勝率(`CalibrationBin`)と、過信バイアス
  (`CalibrationBiasBin`、代表予測値 − 実複勝率)。
  - **「3着以内(`isInTopThree`)」と「複勝の払戻対象(`isPlaceHit`)」は別概念**(Issue #70)。
    キャリブレーション・補正傾向・印別的中率・`RaceBreakdownHorse.isPlaced` は**前者だけ**を使い、
    払戻計上は**後者だけ**を使う。6頭立ての3着馬は前者では的中・後者では不的中である
- **予実ブレークダウン**(`RaceBreakdown`): レース単体ごとに予測(印・EV プラス馬・AI 補正後確率)と
  結果(実着順・複勝的中・賭け金/払戻/回収)を並べる。見出しは日付・競馬場・レース番号。
- **補正傾向**(`VerifyTrendReport`): 補正方向(上げ/下げ/据え置き)× 結果、印別的中率(`MarkStat`)。
- **中央/地方別**: `VerifyVenueFilter`(all / central / nar)で絞り込み集計。
- **版別**: `computeVerifyReportByPromptVersion` が `PROMPT_VERSION` でグループ化し版別に集計・比較。
  推定 EV(evEstimated)は集計から除外して区別。既定は latest モード(レースごと最新分析のみ)。
- **先読みリーク遮断の記録(Issue #39)**: `analyses.history_cutoff_date`(TEXT・NULL 許容、
  `YYYYMMDD`)に、戦績の絞り込みに**実際に使った基準日**を書く(`AnalysisRecord.historyCutoffDate`)。
  `dateApproximate=true`(開催日が渡らず実行日で近似)の分析でも、使った基準日(=実行日)を書く
  (`kaisai_date` は近似のとき NULL のままで、別の値)。**NULL は「遮断の記録なし=#39 より前に作られた
  分析(是正前)」を意味する**(0や空文字で「是正済み」と読ませない。#31の原則・`include_*` 列と同じ流儀)。
  既存 DB は開くときに `PRAGMA table_info` → `ALTER TABLE ADD COLUMN` で後付けする(冪等)。
  この値は `StoredAnalysis.historyCutoffDate`(NULL は null)として読み出せる(Issue #152 A)。
  verify での扱い(「リーク疑い」の除外と画面表示)は下の「先読みリーク疑いの除外(Issue #152)」参照。
- **LLM プロンプト側の遮断を通った印(Issue #153)**: `analyses.prompt_lookahead_guarded`(INTEGER・NULL 許容。
  `AnalysisRecord.promptLookaheadGuarded`: true→1、false→0、省略/null→NULL)。`runAnalysis` は**新規の分析で
  常に true を書く**(LLM 未使用の分析でも true)。`history_cutoff_date` は戦績を絞った印にすぎず、
  v1.14.x で保存された LLM 使用の分析はプロンプト側のリーク(当日傾向・同レース過去傾向)を含みうるため、
  この列で区別する。**NULL は「v1.14.x 以前に保存された分析(プロンプト側が未遮断)」**。
  既存 DB は `history_cutoff_date` と同じ作法(`PRAGMA table_info` → `ALTER TABLE ADD COLUMN`、冪等)で後付けし、
  既存行は NULL のまま。`StoredAnalysis.promptLookaheadGuarded`(1→true・0→false・NULL→null)として読み出せる
  (Issue #152 A)。verify での扱いは下の「先読みリーク疑いの除外(Issue #152)」参照。
- **先読みリーク疑いの除外(Issue #152。core は A、app への配線と画面は B)**: 過去レースを後から分析すると、
  結果が出たあとの情報が戦績・プロンプトに混ざり、検証の回収率・キャリブレーションが過大になる。
  遮断の印(上の2項目)が無い行を、検証画面の集計から**既定で除外**し、件数を表示する
  (画面に「含める」トグルは設けない。ユーザー判断)。分類は `classifyLookaheadSuspicion`
  (`ev/lookahead-suspicion.ts`)が次の順で行う(clean / suspect / unknown):
  1. **遮断の印**: `historyCutoffDate` が非 NULL かつ(`promptVersion` が NULL〈LLM 未使用〉または
     `promptLookaheadGuarded === true`)なら、発走の前後にかかわらず **clean**。`false`〈明示的に未遮断〉と
     NULL〈記録なし〉はどちらも遮断済みとは扱わない。
  2. **発走時刻**(印で clean にならなかった行): 開催日 = `kaisaiDate`、無ければ地方の raceId の月日
     (`kaisaiDateFromNarRaceId`)。発走時刻 = 保存したスナップショットの `race.startTime`(`HH:MM`・JST)。
     `analyzedAt` が発走より前なら clean、発走ちょうど以降なら **suspect**(発走ちょうども suspect)。
     比較は JST を UTC に直した ms の数値で行う(地方ナイターで日付がずれても取り違えない)。
  3. **開催日**(発走時刻が無い行): 開催日の 00:00 JST より前に分析 → clean、翌日 00:00 JST 以降 → suspect、
     開催日当日 → **unknown**。開催日が決まらない・`analyzedAt` が読めない行も unknown。
  - **画面の表示**: 集計の除外内訳に「リーク疑い(発走後に分析・先読み未遮断)のため除外N件」と
    「発走前後を判定できず除外N件」を別のラベル・別の件数で出す(`verify-format.ts` の
    `formatExclusionSummary`。配分ベースの「判定不能」と混同しないよう「判定不能」の語は使わない)。
    どちらかが1件でもあれば「一括分析(日付を選んで分析)で該当レースを分析し直すと集計に戻ります」を添える(`formatExclusionNote`)。
    判定の順は 結果未取込 → リーク疑い/発走前後判定不可 → 旧分析 → 推定EV で、各分析はちょうど
    1つの件数に入る(6件数の和が分析総数。`unknownPromptVersionAnalysisCount` もこの6件数の和)。
    分類は最新選択より前に行うので、同一レースの「発走前の clean」と「発走後の suspect」では clean が残る。
  - **除外が効く集計**: `getVerifyReport`(全体・中央のみ・地方のみ)と `getVerifyReportByPromptVersion`
    (版別)。いずれも `pipeline-deps.ts` が `excludeLookaheadSuspects: true` で呼ぶ
    (`VerifyReport` の回収率・キャリブレーション・補正傾向・配分ベースの回収率が同じ母集団に追随する)。
  - **除外が効かない集計**: レース一覧(`computeRaceLedger`。過去分析の再表示のため全件を残す)と、
    分析データのエクスポート。保存された分析行は削除されず、版不明の削除確認の件数にも除外分を含める。
  - **既知の限界**: 遅延発走は反映されない(スナップショットの予定時刻を使う)。LLM が失敗して prior を
    採用した行は `promptVersion` が非 NULL のまま保存されうるため、遮断マーカーが無ければ suspect 側に倒れる。
    旧行は `kaisaiDate`・発走時刻を持たないものがあり、その場合は unknown になりうる。
    除外された行を集計へ戻す手段は、一括分析(日付を選んで分析)での分析し直し。期間指定一括分析は
    同じプロンプト版で分析済みのレースを再分析しない(`listAnalyzedRaceIdsByPromptVersion` による重複除外)ため、
    LLM を使った行は期間指定一括分析では戻らない。
    `PROMPT_VERSION` は上げていない(ユーザー判断)。
- **配分提案の永続化(Issue #59)**: `saveAnalysis` は分析本体(`analyses`/`analysis_horses`)と
  同一トランザクションで、5節の配分提案を新テーブル2本へ書く(`AnalysisRecord.allocation`が
  渡されたときのみ。呼び出し側〈main〉が渡さない旧来の呼び出しでは書かない=「未到達」)。
  - `analysis_allocation_meta`(`analysis_id`主キー・`analyses`へのFK): レース単位のメタ行で、
    **全経路(未設定/オッズ未発売/頭数不可/複勝のみ/券種混在/計算例外)で必ず1行書く**
    (#31の3状態〈記録なし・見送り・配分あり〉をこの1行の有無と内容だけで区別できるようにするための
    不変条件)。到達状態のコード5列(`route`・`unavailable_reason`・`fallback_reason`・
    `skip_reason_code`・`combo_odds_wide`/`combo_odds_trio`。null は「未到達」であって「不明」では
    ない)、実行時の実効設定11列(`bankroll`/`per_race_cap`/`kelly_fraction`/`ev_threshold`/
    `include_combo_odds`/`include_wide`/`include_trio`/`include_quinella`/`include_exacta`/
    `include_trifecta`/`include_bracket_quinella`。`include_quinella`はIssue #118〈#24-D3b-3〉で
    追加し7→8列、`include_exacta`はIssue #126〈#24-E3c〉で追加し8→9列、`include_trifecta`は
    Issue #140〈#25-E3c〉で追加し9→10列、`include_bracket_quinella`はIssue #151〈#26-E3c〉で追加し
    10→11列。この4列は他の設定エコー列と異なりNULLを許す〈NOT NULL・DEFAULTいずれも付けない〉列で、
    列追加前(それぞれIssue #118・#126・#140・#151より前)に保存された行はNULL=
    「馬連/馬単/三連単/枠連の設定を記録していない」であり、0(OFF)に丸めない〈#31〉。
    **v1.15.1〈#150〉で保存された記録は枠連の買い目行を持ちうるが、`include_bracket_quinella`は
    NULLのままで、過去分析の再表示では「枠連: 記録なし」と出る。買い目行からONと推定する
    バックフィルはしない〈#31〉**)、経路ごとに実際に使われた既定値4列
    (`bet_unit`/`greedy_steps`/`candidate_cap`/`model_id`+`model_approximate`。複勝のみ経路には
    `candidate_cap`が存在しないため常にnull、coreの配分計算に未到達の経路は4列とも null)、
    `odds_status` を持つ。
  - `analysis_bets`(`analysis_id`/`bet_type`/`combo_key`複合主キー・`analyses`へのFK):
    実際に配分された(`stake>0`の)買い目の明細のみを保存する(点数・総額は
    `COUNT`/`SUM`で導出でき、集計列を別途持たない)。複勝・単勝・ワイド・三連複を
    `bet_type`/`combo_key`/`stake`/`odds`/`ev`の共通5列に統合する(`combo_key`は
    `buildComboOddsKey`による正規化キーで、`race_combo_payouts`と同じ形式。単勝は
    1頭のみのキー〈例"05"〉になる)。
  - 版不明分析の一括削除(`deleteAnalysesWithUnknownPromptVersion`)は、この2テーブルの子行も
    `analysis_horses`と同じ順序原則(子→親)で先に削除してから`analyses`を削除する。
  - **読み出しAPI・verify集計・UI表示への反映は本Issueのスコープ外**(#54は#71名義で回収率検証
    〈`getAllocationForVerify`。下記「配分ベースの回収率」参照〉として、#55は過去分析の再表示
    〈`getStoredAllocation`。下記「過去分析の再表示」参照〉として、それぞれ実装済み)。
- **配分ベースの回収率(proposedBet系、Issue #71・#54-B)**: `VerifyReport.proposedBet`
  (`ProposedBetReport`)が、既存の累積回収率(`bet`。複勝一律 stakePerBet 円という仮定、Q-B)とは
  別に、**分析時点の設定で実際に提案した配分額をそのまま賭け金とする**回収率を出す(Q-C)。
  賭け金の仮定が異なる2系統のため、`bet` と `proposedBet` を合算した値はどこにも作らない。
  `proposedBet` 内部の複勝・単勝・ワイド・三連複・馬連・馬単・三連単・枠連の8券種(単勝はIssue #100・#23-Cで、
  馬連はIssue #114・#24-F1で、馬単はIssue #121・#24-F2で、三連単はIssue #131・#25-Fで、枠連はIssue #145・#26-Fで追加)は同一の賭け金仮定(実際の配分額)を共有するポートフォリオの
  ため、`overall`(8券種の合算)は持つ。**馬連はIssue #117(#24-D3b-2)、馬単はIssue #125
  (#24-E3b)、三連単はIssue #139(#25-E3b)でそれぞれ配分提案への組み込みが完了し買い目が
  実際に発生するようになったため、`quinella`・`exacta`・`trifecta`は検証画面
  (`VerifyView.tsx`)の内訳・判定不能の行にも表示する(表示順は馬連→枠連→馬単→3連複→三連単。枠連はIssue #150・#26-E3bで追加)**
  (それまでは買い目が構造的に0件だったため値のみ保持し画面には表示しない設計だった)。
  - **読み出しAPI**: `AnalysisStore.getAllocationForVerify(analysisId)` が
    `analysis_allocation_meta`/`analysis_bets` のうち `route`・`skip_reason_code`・
    `bet_type`/`combo_key`/`stake` の5列だけを読む(残り22列・`odds`/`ev` は#71のスコープ外。
    メタ行が無ければ undefined)。`odds`/`ev` を読まないのは、分析時点のオッズで払戻を近似すると
    「回収率」ではなく「提案時点の期待値の再計算」になり Q-C に反するため——系として
    `proposedBet` 系は近似払戻を一切持たず、実配当のみで按分する(複勝は
    `race_results.place_payout`、単勝は `race_results.win_payout`(Issue #100)、
    ワイド/三連複は `race_combo_payouts.payout` を、それぞれ `stake/100` で按分)。
  - **母集団の4分類**(MECEで合計は`includedAnalysisCount`と一致): 「配分あり」(メタ行あり ∧
    `route∈{place-only,mixed}` ∧ `skip_reason_code IS NULL`。賭け金>0)、「見送り」(同条件だが
    `skip_reason_code`が非null。計算した上での判定結果)、「未到達」(`route∈{unset,yoso,
    unavailable,invalid}`。coreの配分計算そのものに未到達な判定不能)、「記録なし」(メタ行が無い。
    #59より前の旧分析)。**分類は必ず`route`を先に見る**——`route==="unset"`(既定
    `bankroll<=0 || perRaceCap<=0`で層1にとどまる経路)は`skip_reason_code`が常にnullになるため、
    `skip_reason_code`を先に見ると「未到達」が「配分あり」に混入する。
  - **規則U(判定不能の扱い)の適用**: 複勝はそのレースの複勝払戻が、単勝(Issue #100)はそのレースの
    単勝払戻(`race_results.win_payout`)が、それぞれ1件も取込済みでなければ、ワイド・三連複は
    `getComboPayouts`が`not_imported`または`imported`かつ`payouts`が空配列であれば、いずれも
    判定不能として件数・賭け金・払戻のいずれにも計上せず券種別の`unjudgedCount`(買い目行単位)に
    計上する。`imported`かつ`payouts`が非空だが該当`combo_key`が無い場合は「不的中」
    (betCount+1・totalReturn+0)であり判定不能とは区別する。
  - UI(`VerifyView`)は既存の累積回収率の下に、上記overall・券種別内訳・母集団4分類件数を表示する。
- **過去分析の再表示(Issue #55)**: 検証タブ「レース一覧」の各レースの折りたたみ内に
  「配分提案(分析時点)」ブロックを表示する。導線は新設せず、既存の「レース一覧」
  (`RaceLedgerView`)に配分を引き当てるだけ(新規IPCチャネルは追加していない)。的中・払戻・
  回収率は出さない(#16/#71の領分)。配分の再計算はしない(保存済みを読むだけ)。
  - **読み出しAPI**: `AnalysisStore.getStoredAllocation(analysisId)` が
    `analysis_allocation_meta` のうちメタ**17列**(Issue #118〈#24-D3b-3〉で`include_quinella`を
    読む列に追加し13→14列、Issue #126〈#24-E3c〉で`include_exacta`を追加し14→15列、
    Issue #140〈#25-E3c〉で`include_trifecta`を追加し15→16列、Issue #151〈#26-E3c〉で
    `include_bracket_quinella`を追加し16→17列)
    (`route`/`unavailable_reason`/`fallback_reason`/`skip_reason_code`/`bankroll`/
    `per_race_cap`/`kelly_fraction`/`ev_threshold`/`include_combo_odds`/`include_wide`/
    `include_trio`/`include_quinella`/`include_exacta`/`include_trifecta`/`include_bracket_quinella`/`bet_unit`/`odds_status`)+ `analysis_bets` の5列
    (`bet_type`/`combo_key`/`stake`/`odds`/`ev`)を読む。`combo_odds_wide`/`combo_odds_trio`/
    `greedy_steps`/`candidate_cap`/`model_id`/`model_approximate`の6列は`getAllocationForVerify`
    と同じ理由(誰も読まない列にコストを払わない)で読まない。メタ行が無ければ undefined
    (#59より前の旧分析=「記録なし」)。`include_quinella`/`include_exacta`/`include_trifecta`/`include_bracket_quinella`は他13列と
    異なりNULLを許す列のため、DB値がNULLのときはそれぞれ`includeQuinella: null`/`includeExacta: null`/
    `includeTrifecta: null`/`includeBracketQuinella: null`(記録なし)としてそのまま返す(0/1のときのみbooleanへ変換する。#31: 記録なしをOFFに丸めない)。
    `getAllocationForVerify`(#71。route/skip_reason_code/bet_type/combo_key/stakeの5列のみ)とは
    読む列の範囲が異なる別クエリであり、互いに影響しない。
  - **表示状態(`renderer/allocation-proposal-view.ts`)**: 記録なし/unset/yoso/unavailable/
    invalid/見送り(skip)/配分ありの7状態に加え、値の矛盾(未知の`route`文字列、または
    `route∈{place-only,mixed}` ∧ `skip_reason_code=null` ∧ `bets=[]`)を「判定不能」として
    別枠で扱う(#31: 判定済みを未判定に潰さない)。状態の下位理由・パラメータだけが欠けている
    場合(`unavailable_reason=null`、`skip_reason_code="cap-too-small"` ∧ `bet_unit=null`)は
    状態自体は保持し、欠けた部分だけを代替文言で明示する(判定不能へは倒さない)。
  - 買い目行は券種(複勝「4番」/ワイド「4-7」/3連複「4-7-9」/**枠連「枠4-7」(同枠は「枠2-2」。`umabans`が
    馬番ではなく枠番のため。Issue #150)**/**馬単「13→8」**。馬単だけは
    1着→2着の並びが意味を持つため、ワイド・馬連・3連複のハイフン区切りとは異なり並びを
    保った「N→M」表記にする〈Issue #125・#24-E3b・AC-6。`formatComboBetLabel`〉)・
    金額・分析時点のオッズ/EVを表示し、
    実効設定12項目(総資金/1レース上限/ケリー係数/EV閾値/ワイド・馬連・枠連・馬単・三連単・三連複・
    組合せオッズ取得のON・OFF/オッズ状態。「馬連」はIssue #118〈#24-D3b-3〉でワイドと三連複の間に
    追加し8→9項目、「馬単」はIssue #126〈#24-E3c〉で馬連と三連複の間に追加し9→10項目、
    「三連単」はIssue #140〈#25-E3c〉で馬単と三連複の間に追加し10→11項目、
    「枠連」はIssue #151〈#26-E3c〉で馬連と馬単の間に追加し11→12項目)を
    注記として添える。馬連・枠連・馬単・三連単はいずれも他と異なりON/OFFに加え「記録なし」(それぞれ
    Issue #118・#151・#126・#140より前の記録で`includeQuinella=null`/`includeBracketQuinella=null`/
    `includeExacta=null`/`includeTrifecta=null`)を表示する(#31: OFFと断定しない。
    v1.15.1で保存された枠連の買い目を持つ記録も「枠連: 記録なし」と出す〈ONと推定しない〉)。
    `VerifyView.tsx`には本機能の`route`/`skip_reason_code`分岐と文言リテラルを置かず、
    `allocation-proposal-view.ts`が返す配列を`.map`するだけにしている。

## 5. 馬券配分の提案(ev/place-joint-model・ev/bet-allocation)

複勝の期待値プラス馬に対し、**1レースあたりいくらをどう配分するか**を提案する(機能C)。
純ロジックは core、設定と表示は renderer にあり、**IPC は追加していない**(renderer が
`@keiba/core/ev/bet-allocation` をサブパスで直接呼ぶ)。

- **同時分布モデル**(`place-joint-model.ts`): 「どの馬の組合せが複勝圏内に入るか」の同時分布を、
  `PlaceJointModel` インタフェースの差し替え点越しに構築する。条件付きベルヌーイ分布
  `P(S)=Πwᵢ/ΣΠwᵢ`(`wᵢ=pᵢ/(1−pᵢ)`。`CONDITIONAL_BERNOULLI_MODEL`)と、潜在強度 θ を
  推定し Plackett-Luce の上位k集合分布を厳密に構築するモデル(`PLACKETT_LUCE_MODEL`。
  Issue #77〈#20-A〉で追加)の2種類があり、**既定は Issue #81(#78-B)で `PLACKETT_LUCE_MODEL`
  へ切り替えた**(`bet-allocation.ts`・`combo-bet-allocation.ts` の既定引数3行のみが
  production 上の変更点)。いずれのモデルも周辺確率の合計は「ちょうど k 頭が複勝圏内」という
  条件付け(または射影)により **k(複勝の対象人数)へ正規化される**。
  `approximate` フラグは「同時分布が入力の周辺確率〈placeProb〉を再現しないか」だけを表す
  (`CONDITIONAL_BERNOULLI_MODEL`は`true`・`PLACKETT_LUCE_MODEL`は`false`)。**このフラグは
  「1着確率や3着内率の予測が当たる」ことを一切意味しない**(数学的な性質のフラグであり、
  予測精度の指標ではない)。**さらに、`false`は`Σp=kちょうど`のときに限って周辺確率を厳密に
  再現する、という限定付きの意味しか持たない。** production の入力は大半が `Σp≠k` であり
  (p=0を含むレースが197/200=98.5%。下記(a)参照)、この場合 `PLACKETT_LUCE_MODEL` が実際に
  再現するのは入力の `placeProb` そのものではなく、水詰め射影による再スケール後の目標 `q`
  である。**`false` は `CONDITIONAL_BERNOULLI_MODEL`(`true`)より周辺確率の再現精度が
  高いことを意味しない**(下記(a)の実測ではむしろ中央値で悪化する)。UI で近似かどうかを
  出し分ける画面は無い(値は結果に載り DB にも保存されるが、表示を出し分ける消費者はまだ
  存在しない)。

  **(a) 既定切替(#81)の論拠は精度改善ではない。** 論拠は「同一の θ から1着確率・上位k集合
  確率・順列確率を導出できる」という #23-B・#25 の技術的前提(1レース内で2つのモデルが混在
  するのを避けるための依存関係上の要請)のみであり、**確率の質が上がることは論拠にできない**。
  実測(`pnpm tsx scripts/bench-joint-model.ts` で再現可能。18頭・k=3・
  `clipVariant=default`・`N=200`)では、実際に構築した同時分布の周辺確率と入力`placeProb`との
  最大絶対差(`marginalDeviationMax`)の中央値は `PLACKETT_LUCE_MODEL=0.061835` /
  `CONDITIONAL_BERNOULLI_MODEL=0.046275` であり、**PLの方が悪化する**(中央値で約33.6%
  〈0.061835/0.046275−1。この「約33.6%」自体は`scripts/bench-joint-model.ts`の出力する
  中央値2つからの手計算であり、スクリプトの出力そのものにこの値は現れない〉)。
  PLがCBより悪化するレースの割合は117/199=58.8%
  (`clipVariant=wide15`・`N=200`では143/200=71.5%)に達する。**この数値は
  `scripts/bench-joint-model.ts` が合成する入力(`N=200`)による標本比率であり、
  production の実分布そのものを測ったものではない**(スクリプトのJSDoc「使い方」参照)。
  - **(b) 保存済みデータへの影響**: DB(`analysis_allocation_meta`)の `model_id`/
    `model_approximate` 列は #80 時点で既に存在しており、#81 でスキーマは変更していない。
    切替は**新規分析以降にのみ**適用されるため、切替前に保存された分析行は
    `model_id="conditional-bernoulli"` のまま DB に残り続ける。`verify.ts` の回収率
    (`getAllocationForVerify`)も過去分析の再表示(`getStoredAllocation`。`VerifyView.tsx`
    は保存値を読むだけで再計算しない)も、いずれも保存済みの値をそのまま読むため、
    **切替の前後で数値が書き換わることはない**。その結果、DB内には CB 期の分析行と PL 期の
    分析行が混在するが、**`model_id` 列は上記2つの読み出しAPIのどちらも「意図的に読まない列」
    であるため、回収率集計はこの2つの期間を層別できない**。切替前後で回収率を比較したい
    場合は、分析の実施日時(切替コミットの日時)で手動に区切る必要がある
    (層別集計の実装自体は別タスク#85のスコープ)。
  - **(c) 2モデル併存の実態**: production 内で2つのモデルが同時に使われることはない
    (`bet-allocation.ts`・`combo-bet-allocation.ts` の呼び出し元はすべて model 引数を
    省略し、既定〈PL〉に依存する)。併存しているのは**production の配分計算(PL)**と、
    **production の呼び出し元を持たないオフライン計測スクリプト
    (`scripts/bench-joint-model.ts` 等。CB・PL両方を明示的に呼んで比較する)**の2つである。
  - **(d) θフィットの非収束**: `PLACKETT_LUCE_MODEL` は再スケール後の目標(`q`。水詰め射影の
    出力)の最大値が1のすぐ下に着地すると、θ→∞ に近づける必要があるため反復回数が増え、
    反復上限(`MAX_FIT_ITERATIONS`)に達すると非収束(`not-converged`)として失敗する
    (1以上なら即座に「上位k枠に固定」の閉形式に落ちるため破綻しない、**片側だけの崖**。
    機構の決定的な再現手順は `plackett-luce-strength.ts` の `fitPlackettLuceStrengths` の
    JSDoc、および同ファイルのテスト「収束の崖」参照。RNG・種を使わない固定入力で毎回
    同じ結果が出る)。非収束が起きたレースは、#80 で追加した受け皿により既存の
    `route:"invalid"`(`verify.ts` では `unreached`=判定不能)に分類され、**画面はクラッシュ
    しないが配分が表示されない**。**この事象の発生頻度(何%のレースで起きるか)は本書には
    書かない**——production の実分布に対する再現可能な計測手段が現時点でリポジトリに
    無いため(#81 のゲートで一度、合成 prior 生成器による標本比率をここに書こうとしたが、
    再現手段の無い数値だったため撤回した。詳細は `docs/issue-order.md`「#80で確定した契約」
    節参照)。「稀に起きる」とだけ理解すること。
- **配分の決め方**(`bet-allocation.ts`): 候補選定(EV プラス馬のみ)→ 同時分布 → 貪欲逐次配分で
  期待対数資産の増分が最大の馬へ少しずつ割り当て、**λ縮小前の連続最適比率 `x*ᵢ`(スケール不変)**を得る
  → フラクショナル・ケリー縮小 → 1レース上限で比例縮小 → 購入単位への切り捨て、の順で金額を決める。
- **設定は3項目**: **馬券用の総資金**(`bankroll`・既定0=未設定)、**1レースの上限**(`perRaceCap`・
  既定0=未設定)、**ケリー係数 λ**(`kellyFraction`・既定0.5・上級設定)。配分総額は
  `min(λ · Σx*ᵢ · 総資金, 1レースの上限)`。**総資金は手動更新の固定値**で、収支に応じた自動更新はしない。
  - 総資金と1レース上限を分けているのは、**ケリー基準の資金は本来「総資金」**であり、1レースの予算を
    そのまま渡すと配分が予算の数%にしかならないため。上限は「これ以上は賭けない」という歯止めとして働く。
  - 上限に届くかは妙味の大きさに依存する。上限を使い切るのに必要な総資金は上限の `1/(λ·Σx*)` 倍で、
    `Σx*` がレースごとに大きく変わるためこの倍率も大きく変動する(16頭立て・EV1.14 の候補2頭という
    実測例では `Σx*=8.1%` すなわち約25倍だったが、候補が少なく退化するケースでは `Σx*` が 1 に近づき
    倍率は `1/λ` = 2倍まで下がる)。**注記: この 8.1% は特定の合成入力による実測値であり、自動テストで
    守られていない**(入力を再現するテストの追加は別タスク。この数値をそのまま引用しないこと)。
    **普遍的な倍率は存在しないため UI に固定倍率を書いてはならない。**
    代わりに**そのレースのケリー適正額と上限を併記してどちらが効いたかを示す**。
- **入力の防御**: `bankroll` / `perRaceCap` の非有限・0以下は**計算に入る前に0へクランプ**する
  (`resolveBankroll` / `resolveEffectivePerRaceCap`)。λ は非有限・`[0,1]` 範囲外を既定0.5へ、
  購入単位・貪欲分割数は非有限・非正・非整数を既定へフォールバックする。**防御はクランプ1箇所に集約**し、
  下流の判定に二重のガードを置かない(片方が退行してもテストで検出できなくなるため)。
- **最低額の扱い**: 丸めで配分総額が0円になる場合、`x*ᵢ` が最大の1頭(同値は馬番昇順)にのみ購入単位を
  1つ配分する。均等配分はしない(購入単位が最小粒度なので過大ベットが頭数倍に膨らむため)。
  この配分が**ケリー適正額を上回った場合のみ**警告文言(`advisory`)を返す。λ=0 は「賭けない」の
  明示指定として救済しない。
- **見送り理由は6分類**(優先順位順): 総資金未設定 → 1レース上限未設定 → 実効上限が購入単位未満 →
  λ=0 → EV プラスの馬が0頭 → 妙味が小さく賭ける価値がない。設定起因を妙味判定より先に置く。
  文言の定義元は core にあり、UI は複製を持たない。
- **提案しないレース**: 8頭未満(複勝が2着まで、または非発売で3着内率推定と整合しない)、
  オッズ未発売(`oddsStatus="yoso"` の推定 EV は誤差±20〜30%で賭け金に直接効く)。
  出走頭数が判定できない場合は「発売されない」ではなく専用の理由を返す。
- **表示**(`renderer/bet-allocation-view.ts` + `BatchAnalysisView`): 配分表(馬番・馬名・補正後確率・
  複勝下限・EV・配分額)と、ケリー適正額・1レース上限のどちらが効いたかを示す合計行。注記として
  (1)賭け額の考え方、(2)**レース横断のオーバーベット警告**(配分はレースごとに独立計算のため、複数
  レースを同時購入すると合計はケリー最適を超える)、(3)EV 閾値の脚注を常時表示する。複勝圏内確率の
  合計が目標から大きく外れているときは信頼性低下の警告を出す(非有限値は表示しない)。
- **券種横断の配分(機能D-2c・Issue #28。馬連はIssue #117・#24-D3b-2、馬単はIssue #125・
  #24-E3b、三連単はIssue #139・#25-E3b、枠連はIssue #150・#26-E3bで追加)**: 複勝・ワイド・馬連・枠連・馬単・三連複・三連単を
  **同じ1つの予算枠**の中で`allocateGeneralBets`(`@keiba/core/ev/combo-bet-allocation`)に
  より同時最適化する(`shared/mixed-race-allocation.ts` の `buildMixedRaceAllocation`。
  Issue #57で`renderer/mixed-allocation-view.ts` から分離した。表示データの導出
  〈`buildMixedAllocationDisplay`〉は引き続き `renderer/mixed-allocation-view.ts` にある)。
  ワイド・馬連・馬単・三連複・三連単・枠連のオッズ取得(`includeComboOdds`・既定OFF。1つのフラグで
  6券種をまとめて取得する。馬単はIssue #122・#24-E2、三連単はIssue #137・#25-E2、枠連は
  Issue #148・#26-E2で追加。既存のワイド・3連複・馬連・馬単の**後**に1レース1リクエスト
  追加で取得する。**三連単のみ中央競馬限定**〈地方競馬では取得しない。ユーザー判断2026-09-27〉。
  **枠連は中央・地方とも取得し、頭数が少なく発売のないレース〈8頭以下〉でも取得を省かない**
  〈発売の頭数条件は各頭数1レースの観測でしかないため、閾値をコードに持たせない。応答は
  `unavailable`になり警告は出ない。URL列の最後に発行する〉。取得結果は分析結果・保存スナップショット
  〈`bracketQuinellaCombo`。枠番4桁キー〉に搭載され、候補ビルダー〈`buildBracketQuinellaCandidatesForBetType`〉が
  配分の候補にする。**枠連は配分に使う**(Issue #150・#26-E3b。設定`includeBracketQuinellaInAllocation`
  〈既定ON〉が`resolveMixedBetTypes`・D-2フォールバック規則の条件②③に接続され、設定画面にチェックボックスがある)。
  配分に渡す馬には行の`wakuban`を載せている。枠連の買い目の`umabans`は**枠番**であり、画面・過去分析では
  「枠4-7」(同枠は「枠2-2」)と表記して馬番の馬連・ワイドと区別する〈`formatComboBetLabel`〉。実オッズでの実測は`pnpm tsx scripts/bench-mixed-allocation.ts`の5.節:
  中央16頭〈`202603020211`〉で他6券種をON・資金100万/1レース上限10万のとき、枠連ONは総額86,600円・274点・
  枠連9,400円〈10.9%〉14点〈EVプラスの枠連候補20件〉、同じレースの枠連OFFは総額83,800円・273点。
  発売のない8頭〈**出走馬を合成**した例。枠連オッズは実フィクスチャの未発売応答〉は枠連0点・判定不能0件で、
  注記は「このレースでは発売されていません」。所要時間は実行ごとにばらつく)と、取得したオッズを
  実際に配分へ使うか(`includeWideInAllocation`/`includeQuinellaInAllocation`/
  `includeExactaInAllocation`/`includeTrioInAllocation`/`includeTrifectaInAllocation`/
  `includeBracketQuinellaInAllocation`・それぞれ既定ON)は別設定に分けている(取得と採用の分離)。
  `includeQuinellaInAllocation`はIssue #115・#24-D3aで、`includeExactaInAllocation`は
  Issue #124・#24-E3aで、`includeTrifectaInAllocation`はIssue #138・#25-E3aでそれぞれ設定として
  先行配管し、Issue #117・Issue #125・Issue #139で券種の選択(`resolveMixedBetTypes`)・
  D-2フォールバック規則・設定画面のチェックボックスへ実際に接続した(先行配管してから
  接続する、という同じ2段の経緯を3券種とも辿り、枠連も設定を#149で先行配管して#150で接続した)。次のいずれかに該当すると、複勝専用の
  従来経路(`buildRaceAllocation`)の結果を**そのまま**使う(単一定義の原則による
  フォールバック): オッズ取得OFF / ワイド・馬連・枠連・馬単・三連複・三連単がすべて配分対象OFF /
  ワイド・馬連・枠連・馬単・三連複・三連単の候補合計が0件。
  **頭数不可(4以下・5〜7頭)は複勝候補だけを除外し、レース全体はゲートしない**
  (ワイド・馬連・馬単・三連複・三連単は複勝と異なり頭数による発売制約を受けない。枠連は8頭以下では
  発売がなく取得結果が`unavailable`になり候補は0件になる)。
  EV判定閾値は複勝・ワイド・馬連・枠連・馬単・三連複・三連単で統一する。表示は券種別内訳
  (金額・点数。複勝→単勝→ワイド→馬連→枠連→馬単→3連複→三連単の順)・複勝のみで計算した場合の提案額との
  併記(混在時に複勝の提案額が変わる理由を数値で示す。寄り先の券種は資金規模・1レース上限・
  貪欲配分の刻み幅で変わるため断定しない)・個々の買い目(stake降順・同額は馬番配列の辞書順で
  ソートした上で、上位20件〈`MIXED_ALLOCATION_VISIBLE_LIMIT`。ユーザー判断によるUXの目安であり
  計測由来ではない〉を常時表示し、残りは件数・配分額合計付きの折りたたみに収める。Issue #15再スコープ。
  この上限は混在経路の買い目一覧にのみ適用され、複勝専用経路〈`renderBetAllocationBlock`〉は
  そもそも上限を適用しないため常に全件のまま)・判定不能(未取得/欠損/不正値)件数・券種ごとの
  取得状態注記(`{}` を「発売なし」と断定せず取得結果の
  状態で判別する。枠連も他の組合せ券種と同じ文言で、頭数では出し分けない)を含む。
  **枠連の取得結果が`unavailable`(発売なし)のときは、判定不能の件数に数えない**(coreの枠連ビルダーは
  オッズMapが空だと全組を「未取得」に数えるため、そのまま合算すると発売のないレースで
  「判定できなかった買い目があります(未取得N件)」と誤って表示してしまう。取得失敗〈`failed`〉・
  未取得〈`unknown`〉は従来どおり数える。既存の他の組合せ券種は今回は変えていない)。**複勝圏内確率の合計が目標から大きく外れているときの信頼性低下の警告は、
  混在経路でも同じ閾値・同じ文言で出す**(複勝専用経路と同じ`probabilitySumWarning`を、
  混在経路が持つ`race.rows[].adjustedProb`合計から同じ形の入力を組み立てて再利用する。既存経路に
  あった注記が新経路で欠落しないことを個別に確認済み)。**組合せ券種のEVは推定誤差が組み合わせ人数ぶん増幅されて過大評価になりやすく、
  較正は未実施**(Issue #35。計測基盤は#40で整備済み、較正方式の要否検討は#42。画面にも注記を
  表示する)。異常な数値(オッズ・馬番)を含むレースは例外を投げずに判別可能な状態で表示する。
- **配分計算のタイミング(Issue #110・v1.9.4)**: 一括分析画面の券種横断の配分は、**描画の中で同期的に
  計算しない**。画面の他の部分を先に表示し、配分は**1レースずつ**計算して、レースとレースの間に画面を
  更新する(`renderer/mixed-allocation-queue.ts` の `createAllocationQueueRunner` /
  `createAllocationScheduler`)。未計算のレースの配分欄には「配分を計算中…」、「レース別ハイライト」
  見出しの直下には全体の進捗(「配分を計算中… n / N レース」)を表示し、全部終わると進捗は消える。
  計算に失敗したレースには一言の注記を出して次のレースへ進み、**失敗も結果として記録する**
  (同じ条件で再計算を繰り返さない)。配分のキャッシュは App 側が持つので、**検証・設定タブから
  分析タブへ戻っても、設定が変わっていなければ再計算しない**。表示は常に「今の設定」をキーに照会するので、
  計算途中で設定が変わっても古い設定の金額は表示しない。分析タブを離れると計算は止まり、戻ると続きから
  再開する。**配分の答え(金額・点数・構成比)はこの変更の前後で同じ**(同じ関数を同じ引数で呼ぶ)。
- **配分計算のWorkerプール化(Issue #119・#24-C3)**: 上記(#110)の1レースずつの計算を、
  さらに**Web Workerのプールへ移し、レース単位で並列化**した。実際の計算
  (`buildMixedAllocationDisplay`)は`renderer/mixed-allocation-worker-handler.ts`
  (Workerエントリ`renderer/mixed-allocation.worker.ts`から呼ばれる。画面側の逐次フォールバックと
  **全く同じ関数**を呼ぶ。別実装は無い)がWorkerスレッド上で行うため、1レースの計算中も画面は
  固まらない。プール本体・逐次フォールバックへの切り替えは`renderer/mixed-allocation-worker-pool.ts`
  (`createAllocationRunner`)。
  - **プール数**: `max(1, min(navigator.hardwareConcurrency − 1, 4))`で固定し、生存期間中
    変えない。未計算のレースがある間、この上限まで**遅延生成**し、以降は使い回す。
  - **完了順の入れ替わり・古い結果の破棄**: レース間は独立(1レース内の並列化はしない)。
    Worker完了時、送信した時点のキーと**その時点で最新のキーを取り直したもの**を比較し、
    不一致(設定変更・再分析後)なら結果を破棄する(古い結果が新しい設定の値を上書きしない)。
  - **故障の切り分け(推測ではなく経路で判定)**: Worker内での計算例外は`{status:"error"}`という
    メッセージとして返り、そのレースだけ失敗として記録し、Workerは使い続ける。一方、Worker自体の
    起動失敗・`error`/`messageerror`イベント(クラッシュ等)は「Worker自体の故障」を意味し、
    その時点で計算中だったレースは失敗として記録せず未計算のまま残し、プール全体を終了して
    **以降は#110の逐次経路(1ステップ=1レース)へ自動的にフォールバック**する(ログを1回だけ
    `logRendererError`経由でmain側のログファイルへ記録する)。
  - **実測(2026-09-25・クラウド環境・Electron 34・4コア・中央16頭フィクスチャを12件複製)**:
    1 Worker直列で約1.9〜2.1秒、プール(3 Worker)で約0.85〜0.9秒
    (`scripts/verify-worker-pool-electron.mjs`で再現可能。実行手順はJSDoc参照)。
  - **実機確認**: `xvfb-run`上の実Electron(sandbox:true・contextIsolation:true・file://・
    CSP)で、ビルド成果物のWorkerチャンクを実際に`new Worker(url, {type:"module"})`起動し、
    直接計算した結果とビット一致することを確認済み(asar化した状態でも同様)。
    CSPには`worker-src 'self'`を明示追加した(未指定でも`script-src`へのフォールバックで
    動くことも実機で確認済みだが、ブラウザ実装差に依存しないよう明示する)。
- **未実装(将来課題)**: 1日/開催単位の総上限、確率の較正(Issue #35→#39/#40/#41/#42に分割。
  #40で計測基盤を整備済み〈9節参照〉、較正方式そのものの要否検討は#42。複勝単独でも市場に対し
  系統的な過大評価がある実測がある)。三連単の配分への組み込み(#25系列)は完了した
  (Issue #139・#25-E3b。配分記録メタ行への`include_trifecta`列追加はIssue #140・#25-E3cで
  対応済み。地方の三連単は当面取得しない〈ユーザー判断 2026-09-27〉)。検証画面での
  「一律100円 vs 配分」の回収率比較。券種構成比を大きく左右する貪欲配分の刻み幅(`greedySteps`)の
  挙動確認・調整は別Issue(#36)。詳細は `docs/handover-next-session.md`。

## 6. エクスポート(app: analysis-export)

- **JSON(schemaVersion=1)+ CSV**(`packages/app/src/main/analysis-export.ts`)。
- meta に版メタ: `promptVersion` / `additionalInstruction` / `model` / `evEstimated` / `kaisaiDate` /
  ツール名・版・エクスポート時刻。horses に prior・adjustedProb・ev・isPositive・mark・reason・
  出馬表項目・オッズ・調教評価、results に着順・複勝配当・通過順・上がり3F、`rawLlmResponse`
  (モデル出力テキストのみ)。
- **秘密安全性**: 入力に apiKey・Webhook URL・プロンプト本文を受け取る経路が無く、出力へ混入しない構造。
  CSV は RFC4180 準拠(BOM なし)。

## 7. Discord 通知(notify/discord)

- レース名・日付・会場と **EV プラスの馬**(予想印・馬番・馬名・AI 補正後確率・複勝下限・EV、推定 EV は
  接尾表示)を embed で送信。EV プラスが無ければ「該当なし」。
- 設定画面の Webhook URL に送信、手動「Discordに送信」ボタン + 自動送信 ON/OFF。レート制限(429)は
  Retry-After を尊重して 1 回だけ待機リトライ。送信失敗は分析結果表示に影響しない。

## 8. 配布(GitHub Actions / electron-builder)

ワークフロー: `.github/workflows/build-windows.yml`(`windows-latest` でビルド、ビルド前にテスト全通過を関門)。

- **Windows portable exe**(`keiba-ev-tool-<version>-portable.exe`、インストール不要)。
- **開発版**: 開発ブランチ(`claude/keiba-ev-tool-dev-cvagiu`・`claude/handover-next-session-x5ki6o`・
  `claude/keiba-prediction-handover-ojr8t1`・`claude/issue-order-processing-wjgpdd`)への push のうち、
  下記の dev-latest 公開ゲート(Issue #43)を満たすものだけが固定タグ **`dev-latest`** の
  プレリリースを in-place 更新する(ローリング公開。
  **push すれば常に更新されるわけではない**)。**exe 名がバージョン依存のため、version を上げると
  旧名のアセットが残置される**。これを防ぐため、公開ステップの直後に現行ファイル名以外の `.exe` を
  削除する掃除ステップを置いている(最新 exe が先にアップロード済みの状態を保つ順序)。
- **正式版**: `v*` タグ(例 `v1.0.0`)push でそのタグの通常リリースを公開。
- **dev-latest 公開ゲート(Issue #43。既定で非公開)**: `dev-latest` への公開は、
  (i) ブランチ ref への push でコミットメッセージ(件名末尾)に承認印 `[PUBLISH-APPROVED]` を含み、
  かつ「レビュー継続中」を含まない場合、または (ii) ブランチ ref への `workflow_dispatch`(手動実行)
  の場合に限り行う。それ以外(承認印が無い push・「レビュー継続中」を含む push・タグ push 等)は
  すべて公開・孤児掃除の両ステップをスキップする(`CLAUDE.md`「レビュー継続中の中間コミット」節 (f))。
  未承認の自動コミットが1つ割り込むだけで未レビューのコードが公開される事故(Issue #43)を受けて、
  「印が無ければ公開しない」既定安全側に反転した。スキップ時は run のログに `::notice::` を残す。
- **版数運用の機械検査(Issue #45。`scripts/release-gate.ts`)**: #44-D-1(`docs/versioning.md`)
  の「公開1回につき必ず1回、版数を上げる」運用を機械で強制する2ステップ。判定核は純関数
  + 依存注入として `scripts/release-gate.ts` に切り出し、`scripts/test/release-gate.test.ts`
  で実ふるまいを検証する(yml へのインライン bash では判定ロジック自体がテストされない
  形骸化を避けるため)。
  - **版数据え置き検査**(`version-bump-check`。exe 生成の直後・dev-latest 公開の直前):
    今回ビルドした exe と同名のアセットが dev-latest に既に存在する場合に block する。
    dev-latest 公開ゲートを満たす push のときだけ実行し(`if:` に
    `github.event_name == 'push'` を明示)、**`workflow_dispatch`(手動実行)では実行しない**
    (`docs/versioning.md` が同一コミットの再送を「公開」に含めないと定めているのに合わせた
    意図的な残存ギャップ。手動実行で新しい内容を配布した場合は版上げが機械で守られない)。
    アセット一覧取得(GitHub REST API)の失敗(404・403/5xx・タイムアウト・設定不備等)は
    fail-open(公開を止めず警告のみ)。
  - **タグ検証**(`tag-version`。依存インストール直後・型検査より前): `v* タグ push` /
    タグ ref への `workflow_dispatch` で、タグ名と `packages/app/package.json` の
    version が一致しない場合に block する。こちらは fail-closed(package.json が
    読めない・不正な場合も block)。据え置き検査と非対称な理由は、タグ検証の入力が
    ローカルで決定論的に定まる値であり、リモート API のような一過性障害が原理的に
    起こり得ないため。
- アイコンは `scripts/gen-icon.mjs`(`pnpm gen:icon`)で生成。パッケージング構成は
  `packages/app/electron-builder.yml`。
- **ネイティブバインディングの解決(Issue #61)**: 配布(packaged)時は better-sqlite3 の
  `.node` を `<process.resourcesPath>/app.asar.unpacked/node_modules/better-sqlite3/build/Release/
  better_sqlite3.node` の絶対パスで**明示指定**し(`packages/app/src/main/native-binding.ts` の
  `resolveVerifiedNativeBindingPath` → `pipeline-deps.ts` の `new Database` 第2引数。
  Issue #62 でこの2関数は `ipc.ts` から electron 非依存の `native-binding.ts` へ抽出した。
  挙動不変・`ipc.ts` は re-export のみ)、`bindings` パッケージの**スタックトレースからの
  推測解決を使わない**。見つからない場合は、期待した絶対パス・`fs.existsSync` の結果・
  `process.resourcesPath`・`app.isPackaged` の4要素を含む診断メッセージ付きで**即時失敗**する。
  非 packaged(開発・テスト)では従来どおり `bindings` に委ねる。
- **配布 exe の可動性検査(Issue #62。`scripts/artifact-gate.ts`)**: #60(better-sqlite3 が
  packaged 実行でロードできなかった実機事故)を #61 で是正したが、それまでの検証は
  「exe が更新されたこと」しか見ておらず「exe が動くこと」を一度も確認していなかった
  (vitest は Node 環境で走るため、Electron ランタイム・asar・ネイティブモジュールの破綻を
  原理的に検出できない)。`electron-builder で exe を生成` の直後・`版数据え置きを検査` の
  前に、判定核を純関数として切り出した2ステップの機械検査を常時関門(`if:` なし)として置く。
  判定核・依存注入・yml 配線は #43/#45(上記)と同じ方針(yml へインライン bash の判定を書かず、
  `scripts/test/artifact-gate.test.ts` で実ふるまいを検証する)。
  - **asar 配置検査**(`asar-layout`。縮小版): A1(`unpacked !== true` な `.node` エントリが
    asar 内に0件であること。`.node` エントリ自体が1件も無い場合も fail-closed で block)・
    A2(`dist/main/main.cjs`・`dist/preload/preload.cjs`・`dist/renderer/index.html` が
    asar 内に存在すること)の2項目のみ。app.asar の読み込み自体が失敗した場合(存在しない等)も
    fail-closed で block する。asar ヘッダのバイト列パーサ(`parseAsarHeader`)は
    `@electron/asar` の実出力を実測して確定した実フォーマットに従う(新規依存は追加していない。
    pnpm 環境で `@electron/asar` を `require.resolve` できないため)。
  - **ヘッドレススモーク**(`smoke`。本命): 配置検査は asar のヘッダ(ファイルの存在・展開状態)
    しか見ず `.node` の中身(ABI)を一切読まないため、ABI 不一致を原理的に検出できない
    (Node 向け `.node` を注入した対照実験で確認済み。配置検査4項目〈当初案〉はすべて PASS した
    一方、ヘッドレススモークは `NODE_MODULE_VERSION` 不一致で実際に FAIL した)ため、こちらが本命
    (**v1.3.1 の実物 exe 自体は当初案・スモークともに allow を返す**。誤りだった旧記述の訂正と
    実測方法は下記「この検査が実際に何を検出できるのか」を参照)。
    `win-unpacked/*.exe` を一意に解決し(0個/複数個は block)、本番と同一の
    `resolveVerifiedNativeBindingPath` を呼んでネイティブバインディングの絶対パスを得たうえで、
    `spawnSync(exe, [子スクリプト, nativeBindingPath, resourcesPath, tmpDbPath], { env:
    { ELECTRON_RUN_AS_NODE: "1" }, timeout })` で子プロセス(`scripts/artifact-gate-smoke-child.cjs`。
    plain CJS)を起動する。子プロセスは `process.resourcesPath` の一致確認 →
    `require.resolve("better-sqlite3", { paths: [...] })` → `new Database(tmp, { nativeBinding })` →
    CREATE TABLE/INSERT/SELECT(値一致検証)→ close() → センチネル付きJSON1行を stdout に出す。
    判定(`judgeSmokeOutcome`)は exit code とセンチネルの両方を見る: exit 0 でもセンチネルが
    無ければ block(静かに何もせず0で返ることを許さない)、exit≠0 でも stdout のセンチネルから
    `reason` を取り出して message に含める(exit≠0 は何があっても block のまま。fail-closed は
    弱めない。理由の可視化のみ)。一時ディレクトリは `finally` で必ず削除する。
  - **射程外**(「#60型の症状を検出できない」とは書かない。#61以降それは事実として誤り):
    (1) 検査対象は `win-unpacked` であり portable exe 自身の自己展開は通らない、
    (2) `ELECTRON_RUN_AS_NODE=1` は Node 部分のみで GUI 起動時にしか出ない破綻は検出しない、
    (3) 本番の呼び出し元(`main.cjs` の `ResourceManager` 経由)そのものは実行しないが、
    `nativeBinding` を明示指定するため呼び出し元の違いは `.node` のロード可否に影響しない、
    (4) DB操作は CREATE/INSERT/SELECT のみでスキーマ移行経路は通らない、
    (5) ビルドマシン上の x64 成果物のみでユーザー実機の環境差は対象外、
    (6) 実 exe 経路は Linux では原理的に実行できず(`.exe` 拡張子を要求する)、
    Windows CI が唯一の検証場所である、
    (7) 本番コードが実際に `nativeBinding` を渡し続けることは対象外(検査は成果物を正しい
    メカニズムで叩けることを見るだけで、本番コードがそのメカニズムを使っているかは見ない。
    この配線は `packages/app/test/ipc-native-binding.test.ts` が守る)。
  - **この検査が実際に何を検出できるのか**: 本検査は v1.3.1 の実物 exe(`.node` が
    1,918,976 バイトで実在・asar ヘッダ上 `unpacked: true`・`dist` 3点も実在・
    `nm_version=132`〈Electron 34 向けに正しくビルド済み〉)に対し
    A1/A2・スモークとも実際に allow を返す(実測確認済み。#60当時の壊れ方はこの検査には
    映らない。`nm_version` はネイティブアドオンが埋め込む `node_module` 構造体〈`nm_modname`
    〈+40〉から40バイト遡った位置が `nm_version`〈+0〉〉をバイナリから直接読み取って確認した。
    詳細は `scripts/artifact-gate.ts` 冒頭「設計の核心」参照)。#60 の真因は `bindings`
    パッケージの呼び出し元スタック走査であり、そのメカニズムは
    #61 で除去済みのため、本検査は成果物を*現行(#61後)のメカニズムで*叩くだけで、v1.3.1 当時の
    壊れ方(呼び出し元スタックに依存した解決失敗)そのものは原理的に再現しない。本検査が守るのは、
    #61 が新たに単一障害点にした「ハードコードされた絶対パスが実物の配置と一致すること」と、
    ABI・asar・配置の破綻という(#60より)より広いクラスである。

## 9. 確率の質の計測基盤(scorer/snapshot-filter・ev/probability-quality。#40「#35-1a」)

#35(確率の質の疑い。「組合せ券種のEVがオッズの順序をなぞるだけではないか」)を判断するための
**計測専用**の基盤。**測るだけ**で、prior・同時分布モデル・EV計算(`prior.ts`・
`place-joint-model.ts`・`combo-bet-allocation.ts`・`expected-value.ts`)の挙動は一切変更しない。

- **Issue #35 の分割**: #40(本節。計測基盤の健全化と指標の実装)/ #39(本番側
  `analysis-pipeline.ts` の先読みリーク是正。完了)/ #41(30レース規模のサンプル拡大。LLM は使わない。測定基盤・スクリプト・実取得は完了。結果は
  `docs/investigations/probability-quality-41/report.md`)/ #42(較正 calibration 方式の要否検討・未着手)。同時分布モデルの厳密化(#20)は #41/#42 の
  技術的前提であり、#77(#20-A。θ推定器と`PLACKETT_LUCE_MODEL`の追加・既定は不変。完了)→
  #78(#20-B。既定モデルの切替。着手前ゲートで【No-Go】と判定され #80〈#78-A〉/ #81〈#78-B〉に
  分割。分割の親として open のまま残る)→ #80(#78-A。モデル例外の受け皿を invalid 経路へ一本化し
  検出力の土台を作る。完了)→ #81(#78-B。既定モデルを `PLACKETT_LUCE_MODEL` へ切替。完了)→
  #79(#20-C。`probability-quality-metrics.ts` の2関数を PL へ切り替えるか裁定。未着手、
  #81 が前提。切り替えない結論もあり得る)の順で進めている。
- **着手前ゲートで判明した2つの計測条件欠陥**(#40がまず健全化した理由):
  1. **実行日ドリフト**: `runAnalysis` に `kaisaiDate` を渡さないと `resolveAnalysisDate` が
     実行日(`now()`)へフォールバックし、季節分類・休み明け走目の基準日が壁時計時刻とともに
     動く(`dateApproximate=true`)。計測・回帰テストでは必ず実レース日の `kaisaiDate` を明示する
     こと。`scripts/bench-mixed-allocation.ts` もこの理由で `kaisaiDate` を明示するよう是正済み
     (#40。それ以前は明示していなかった)。
  2. **先読みリーク**: (#40 時点)`analysis-pipeline.ts` が戦績を日付でフィルタせず `buildPriorInput`
     に渡していたため、当該レース自身の着順が prior の材料に混入していた(実測: 中央16頭フィクスチャで
     出走16頭全頭・21走が該当。うち16走が当該レース自身、5走は基準日より後の日付)。
     **#39 で本番側(`runAnalysis`)が scrape 直後に遮断するようになった**(2節「戦績の扱い」参照)。
     LLM プロンプト側(当日傾向・同レース過去傾向)の遮断は #153(同節)。
     #40 の時点の計測値(中央 ρ=0.2104 等)はリークありの値で、#39 以降の `runAnalysis` の出力は
     遮断後の値(中央 ρ=-0.0059 等)になる。
- **`scorer/snapshot-filter.ts`**: `filterRaceDataBefore(raceData, cutoffDate)` — 各馬の
  `results` を `date < cutoffDate` で絞る純関数(`cutoffDate`/`HorseRaceResult.date` はいずれも
  `YYYY/MM/DD`。非ゼロ埋め表記も含め `daysBetweenDates` で比較し、辞書順比較はしない)。
  基準日と同日(=当該レース自身の可能性)は除外。日付欠損・不正形式は安全側(除外)に倒す。
  除去件数を診断値(`SnapshotFilterDiagnostics`)として返す。全走が除外され戦績0走になる馬が
  いても例外を投げない(新馬・デビュー戦の馬は #41 のサンプル拡大で日常的に現れる形であり、
  `scripts/test/probability-quality-regression.test.ts` で `runAnalysis` が完走し
  `Σprior` が目標付近に収まることを実測固定している)。
- **`ev/probability-quality.ts`**(公開)+ **`ev/probability-quality-metrics.ts`**(内部。
  `package.json` の `exports` に載せない): 確率の質を測る4指標。唯一の公開エントリポイント
  `buildProbabilityQualityReport` が計測条件(`priorSource`・`oddsStatus`・リーク遮断の有無・
  使用オッズの種別)を必ず結果に同梱する(条件抜きの数値を返さない設計。低レベル指標関数は
  パッケージ境界の外からは意図的に到達不能)。
  1. **全点等額購入時の平均EV÷払戻率**(三連複専用。ワイドには適用不可。1レース3組同時的中の
     ため `Σ(1/odds)=1/払戻率` の恒等式が成立しない)。
  2. **Spearman順位相関**(prior vs 市場含意複勝確率〈`1/placeOddsMin` をΣ=3正規化〉。
     平均順位法でタイ補正)。
  3. **分散比**(sd比・max/min比)。
  4. **三連複同時分布の正規化KL**(`KL(model‖uniform)/log(組数)`。モデル側・市場側を同一関数で
     算出して並記し、頭数が異なるレース間でも比較可能にする)。
  - NaN・Infinity・負値は演算前に明示検証して弾く(`reason` 付きの `null` を返し、
    もっともらしい誤った数値を返さない)。`placeOddsMin` は下限であり単一の真値ではない
    (複勝は下限〜上限の幅を持つ券種)ことを `conditions.placeOddsKind` で明示する。
- **回帰テスト**: `packages/core/test/` に低レベル指標の単体テスト(合成データ・境界値、
  `packages/app` に非依存)。`scripts/test/probability-quality-regression.test.ts` に
  実フィクスチャ(中央16頭・地方12頭)を `runAnalysis` で駆動する回帰テストと、リーク遮断の
  前後比較(#40で実測: 中央16頭で ρ 0.2104→-0.0059、正規化KL 0.0156→0.0236)。#39 以降は
  `runAnalysis` 自身が遮断するため、「リークあり」の値は core の公開関数(`buildPriorInput`+
  `computeFieldPriors`)を生の戦績で直接呼ぶ参照実装から得る(生入力と遮断済み入力の `runAnalysis`
  出力は同値であることを固定している)。

- **確率の質の測定(#41「#35-1b」。着順が必要な指標)**: `ev/probability-quality.ts` の
  `buildBrierQualityReport`(二値事象〈3着以内〉の Brier・Murphy 分解〈REL/RES/UNC と、帯内分散−2×帯内共分散の
  残差〉・気候値/市場に対する skill・レース単位ブートストラップ・レース内ラベル並べ替えによる resolution の参照値)。
  帯は検証画面と共有する `ev/calibration-bins.ts`(`binIndexFor`)。市場比較は出走8頭以上・確定オッズ・
  市場含意確率が1以下のレースの同じ集合の対に限る。低レベル関数は `probability-quality-metrics.ts`(内部)。
- **#41 の測定スクリプト**: `scripts/probability-quality-41/`(`fetch.ts`=ネットワーク・観測 JSON を保存、
  `aggregate.ts`=オフライン集計)。選定ルール・指標・読み方は
  `docs/investigations/probability-quality-41/measurement-plan.md` に取得前に固定した。
- **LLM 補正込みの確率の質(#156「#41-B」)**: 実 Claude API を使わず、production のプロンプト(`runAnalysis` を駆動して
  `buildPrompt` の文字列を捕まえる)をサブエージェントに答えさせ、応答を production の `analyzeRace` に通して、#41 と同じ
  36 レースで prior と LLM 補正後を同じレース集合の対で比べた。比較用に core へ `buildPairedBrierComparison`
  (`ev/probability-quality.ts`。同じ馬集合の2つの確率列の Brier 差・分解・レース単位ブートストラップ)を追加。
  production の LLM と同一でない近似(モデル・温度・文脈・確定オッズ等)で、区間は LLM のサンプリングのばらつきを含まない。
  スクリプト `scripts/probability-quality-41-llm/`、計画 `docs/investigations/probability-quality-41-llm/measurement-plan.md`、
  結果 `docs/investigations/probability-quality-41-llm/report.md`(Go/No-Go は書かない)。

## 主な当初仕様との差異(記録)

- **配布ビルドの前倒し**: 当初 Phase 5 の配布ビルドを、UI 実装中も Releases から exe を入手できるよう
  Phase 4 開始時点で先行整備した。
- **renderer は core を直接 import しない**(上述。ネイティブ依存を main に集約)。
- **地方競馬(NAR)対応**: 当初仕様のスコープ外だったが実装済み(取得・スコアリング・検証の中央/地方別)。
- **Phase 6(discord.js bot)は未実装**。通知は Electron 内蔵の Webhook 送信まで。
