# 現状の実装済み仕様(v1)

本書は **実際に実装されている現状(v1.0.0)** をまとめたもの。当初の設計・計画は
[`keiba-ev-tool-spec.md`](../keiba-ev-tool-spec.md)(中央競馬前提)と
[`docs/nar-scraping-plan.md`](./nar-scraping-plan.md)(地方競馬拡張)に残してあり、本書はそれらとの
乖離を含め「今どう動くか」を実コードに基づいて記述する。数値・定数は実装の既定値であり、多くは
設定画面またはconfigでチューニング可能。

- ツール名: 競馬期待値分析ツール(keiba-ev-tool)
- 種別: 複勝の期待値プラス馬券を抽出するデスクトップアプリ(Electron + React)
- バージョン: ルート/アプリ `1.0.0`、`@keiba/core` `0.1.0`
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
  (出馬表・戦績・調教は長 TTL、オッズは短 TTL)。発走直前は `bypassOddsCache` でオッズのみキャッシュを迂回。
  `HttpClient`/`CachedFetcher` は GET 専用ではなく POST(method/body/追加ヘッダ)にも対応し、
  URL が固定でリクエスト識別子が POST ボディに入る API 向けに `cacheKey`(省略時は URL)を明示指定できる
  (同レース過去10年結果 API 向け。詳細は次項)。
- **期間一括取得**: 日付範囲を `enumerateDates` で列挙し、`validatePeriodInput` で入力検証したうえで
  複数日・複数レースをまとめて取得する(`packages/app` 側の一括分析と連動)。
- **エラー方針**: 必須データ(出馬表・オッズ)の失敗は throw。optional データ(調教)の失敗はその項目を
  null にして警告(`ScrapeWarning`、kind: 調教/戦績)を積む。戦績は馬単位で握り、1 頭の失敗で全体を落とさない。
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
- **共通ルール**: 各バイアスは「対象条件の複勝率 − 全体複勝率 × 重み」の差分ベース(`aggregate.ts`)。
  サンプル 2 走未満は補正なし(`minSampleForBias=2`)。各バイアスの寄与度は内訳(`BiasContribution`)として
  ログ可能。
- **prior 合成**(`prior.ts`): 基礎スコア + バイアス補正合計(バイアスは過剰補正防止のため
  `biasCorrectionScale=0.3` で一律減衰)を、頭数レベル正規化(目標複勝圏内数 min(3, 頭数)へ寄せる、
  逸脱許容 0.1)したうえで prior を算出。prior は [0.02, 0.95] にクランプ。
- **EV(期待値)**(`ev/expected-value.ts`): 複勝期待値 = place_prob × **複勝オッズ下限(oddsMin)**。
  EV > 閾値(既定 1.0、厳密不等号)の馬のみ `isPositive=true`。オッズ欠損馬は EV=null で対象外。
  発売前(oddsStatus=yoso で複勝オッズが無い)場合は単勝オッズから複勝下限を概算する
  `estimatePlaceOddsMinFromWin`(係数 0.2、あくまで概算で `evEstimated=true` として区別)。

## 3. LLM 分析(analyzer)

scorer の prior と多数のテキスト材料をプロンプト化し、Claude が補正後確率・予想印・根拠を返す。

- **モデル/呼び出し**(`anthropic-client.ts`): 既定 `claude-sonnet-4-6`、`maxTokens=8192`、`temperature=0`。
  18 頭級の応答が 2048 トークンで切り詰められ全馬 prior に落ちる事故を受けて 8192 に引き上げた経緯あり。
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
- **回収率サマリ**(`VerifyBetSummary`): EV プラスで購入した点数・賭け金・払戻・回収率。払戻は実配当
  (placePayout)優先、無ければ複勝下限で近似(近似計上件数を区別)。既定 stake 100 円。
- **キャリブレーション**: 推定確率帯(既定 10 分割)ごとの実複勝率(`CalibrationBin`)と、過信バイアス
  (`CalibrationBiasBin`、代表予測値 − 実複勝率)。
- **予実ブレークダウン**(`RaceBreakdown`): レース単体ごとに予測(印・EV プラス馬・AI 補正後確率)と
  結果(実着順・複勝的中・賭け金/払戻/回収)を並べる。見出しは日付・競馬場・レース番号。
- **補正傾向**(`VerifyTrendReport`): 補正方向(上げ/下げ/据え置き)× 結果、印別的中率(`MarkStat`)。
- **中央/地方別**: `VerifyVenueFilter`(all / central / nar)で絞り込み集計。
- **版別**: `computeVerifyReportByPromptVersion` が `PROMPT_VERSION` でグループ化し版別に集計・比較。
  推定 EV(evEstimated)は集計から除外して区別。既定は latest モード(レースごと最新分析のみ)。

## 5. 馬券配分の提案(ev/place-joint-model・ev/bet-allocation)

複勝の期待値プラス馬に対し、**1レースあたりいくらをどう配分するか**を提案する(機能C)。
純ロジックは core、設定と表示は renderer にあり、**IPC は追加していない**(renderer が
`@keiba/core/ev/bet-allocation` をサブパスで直接呼ぶ)。

- **同時分布モデル**(`place-joint-model.ts`): 「どの馬の組合せが複勝圏内に入るか」の同時分布を、
  条件付きベルヌーイ分布 `P(S)=Πwᵢ/ΣΠwᵢ`(`wᵢ=pᵢ/(1−pᵢ)`)で近似する。周辺確率の合計は
  「ちょうど k 頭が複勝圏内」という条件付けにより **k(複勝の対象人数)へ正規化される**。
  `PlaceJointModel` インタフェースを差し替え点として用意しており、Phase 2 で厳密なモデル
  (Plackett-Luce 等)に置き換えられる。`approximate` フラグで近似かどうかを結果に表示する。
- **配分の決め方**(`bet-allocation.ts`): 候補選定(EV プラス馬のみ)→ 同時分布 → 貪欲逐次配分で
  期待対数資産の増分が最大の馬へ少しずつ割り当て、**λ縮小前の連続最適比率 `x*ᵢ`(スケール不変)**を得る
  → フラクショナル・ケリー縮小 → 1レース上限で比例縮小 → 購入単位への切り捨て、の順で金額を決める。
- **設定は3項目**: **馬券用の総資金**(`bankroll`・既定0=未設定)、**1レースの上限**(`perRaceCap`・
  既定0=未設定)、**ケリー係数 λ**(`kellyFraction`・既定0.5・上級設定)。配分総額は
  `min(λ · Σx*ᵢ · 総資金, 1レースの上限)`。**総資金は手動更新の固定値**で、収支に応じた自動更新はしない。
  - 総資金と1レース上限を分けているのは、**ケリー基準の資金は本来「総資金」**であり、1レースの予算を
    そのまま渡すと配分が予算の数%にしかならないため。上限は「これ以上は賭けない」という歯止めとして働く。
  - 上限に届くかは妙味の大きさに依存する(必要な総資金の倍率 `1/(λ·Σx*)` は20〜285倍程度まで変動する)。
    このため UI には固定倍率を書かず、**そのレースのケリー適正額と上限を併記してどちらが効いたかを示す**。
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
- **未実装(将来課題)**: 1日/開催単位の総上限、券種拡張(ワイド・三連複。同時分布モデルは的中確率を
  そのまま計算できるが、オッズ取得が未実装。三連単は着順情報が必要で Phase 2 待ち。
  詳細は `docs/handover-next-session.md`)、検証画面での「一律100円 vs 配分」の回収率比較。

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
  `claude/keiba-prediction-handover-ojr8t1`)への push ごとに固定タグ **`dev-latest`** のプレリリースを
  in-place 更新(ローリング公開)。**exe 名がバージョン依存のため、version を上げると旧名のアセットが
  残置される**。これを防ぐため、公開ステップの直後に現行ファイル名以外の `.exe` を削除する掃除ステップを
  置いている(最新 exe が先にアップロード済みの状態を保つ順序)。
- **正式版**: `v*` タグ(例 `v1.0.0`)push でそのタグの通常リリースを公開。
- アイコンは `scripts/gen-icon.mjs`(`pnpm gen:icon`)で生成。パッケージング構成は
  `packages/app/electron-builder.yml`。

## 主な当初仕様との差異(記録)

- **配布ビルドの前倒し**: 当初 Phase 5 の配布ビルドを、UI 実装中も Releases から exe を入手できるよう
  Phase 4 開始時点で先行整備した。
- **renderer は core を直接 import しない**(上述。ネイティブ依存を main に集約)。
- **地方競馬(NAR)対応**: 当初仕様のスコープ外だったが実装済み(取得・スコアリング・検証の中央/地方別)。
- **Phase 6(discord.js bot)は未実装**。通知は Electron 内蔵の Webhook 送信まで。
