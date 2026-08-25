# 現状の実装済み仕様(v1)

本書は **実際に実装されている現状(v1.3.2)** をまとめたもの。当初の設計・計画は
[`keiba-ev-tool-spec.md`](../keiba-ev-tool-spec.md)(中央競馬前提)と
[`docs/nar-scraping-plan.md`](./nar-scraping-plan.md)(地方競馬拡張)に残してあり、本書はそれらとの
乖離を含め「今どう動くか」を実コードに基づいて記述する。数値・定数は実装の既定値であり、多くは
設定画面またはconfigでチューニング可能。

- ツール名: 競馬期待値分析ツール(keiba-ev-tool)
- 種別: 複勝の期待値プラス馬券を抽出するデスクトップアプリ(Electron + React)
- **対応券種は用途によって異なる(3点。混同しないこと)**:
  - **配分提案**: 複勝+ワイド+三連複(ワイド・三連複はオプトイン設定`includeWideInAllocation`/
    `includeTrioInAllocation`。既定ON。取得自体は`includeComboOdds`が別途必要。5節参照)
  - **記録・回収率検証**: 複勝のみ(`ev/verify.ts`は複勝の的中判定・払戻のみを扱う。**回収率検証は
    Issue #52 完了時点でもまだ複勝のみが正**)。`ev/analysis-store.ts`は Issue #52 で
    ワイド・三連複の**確定払戻の取得・永続化**(`race_combo_payouts`/`race_combo_payout_imports`、
    `parse-race-result.ts`)まで対応したが、**保存はするが検証(`ev/verify.ts`)への反映は未着手**
    (読み手は Issue #54)。取得(オッズ・配分提案)と検証(回収率集計)は別軸であることに注意
    (5節の配分提案は既にワイド・三連複対応済みだが、これは組合せ**オッズ**の話で本項の組合せ**払戻**
    とは別物。組合せオッズの永続化自体も別Issue #53)
  - **単勝オッズ**: 賭け対象ではなく、発売前レースで複勝下限を概算する用途にのみ使う
    (`estimatePlaceOddsMinFromWin`)
  - 馬連・馬単・三連単・枠連・枠単は未対応(拡張のロードマップと技術的な依存関係は GitHub Issue #22)
- バージョン: ルート/アプリ `1.3.2`、`@keiba/core` `0.2.0`(`@keiba/core` は版数運用の対象外・据え置き。
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
- **券種横断の配分(機能D-2c・Issue #28)**: 複勝・ワイド・三連複を**同じ1つの予算枠**の中で
  `allocateGeneralBets`(`@keiba/core/ev/combo-bet-allocation`)により同時最適化する
  (`renderer/mixed-allocation-view.ts`)。ワイド・三連複のオッズ取得(`includeComboOdds`・
  既定OFF)と、取得したオッズを実際に配分へ使うか(`includeWideInAllocation`/
  `includeTrioInAllocation`・それぞれ既定ON)は別設定に分けている(取得と採用の分離)。
  次のいずれかに該当すると、複勝専用の従来経路(`buildRaceAllocation`)の結果を**そのまま**使う
  (単一定義の原則によるフォールバック): オッズ取得OFF / ワイド・三連複とも配分対象OFF /
  ワイド・三連複の候補合計が0件。**頭数不可(4以下・5〜7頭)は複勝候補だけを除外し、レース全体は
  ゲートしない**(ワイド・三連複は複勝と異なり頭数による発売制約を受けないため)。EV判定閾値は
  複勝・ワイド・三連複で統一する。表示は券種別内訳(金額・点数)・複勝のみで計算した場合の提案額との
  併記(混在時に複勝の提案額が変わる理由を数値で示す。寄り先の券種は資金規模・1レース上限・
  貪欲配分の刻み幅で変わるため断定しない)・個々の買い目(stake降順・同額は馬番配列の辞書順で
  ソートした上で、上位20件〈`MIXED_ALLOCATION_VISIBLE_LIMIT`。ユーザー判断によるUXの目安であり
  計測由来ではない〉を常時表示し、残りは件数・配分額合計付きの折りたたみに収める。Issue #15再スコープ。
  この上限は混在経路の買い目一覧にのみ適用され、複勝専用経路〈`renderBetAllocationBlock`〉は
  そもそも上限を適用しないため常に全件のまま)・判定不能(未取得/欠損/不正値)件数・券種ごとの
  取得状態注記(`{}` を「発売なし」と断定せず取得結果の
  状態で判別する)を含む。**複勝圏内確率の合計が目標から大きく外れているときの信頼性低下の警告は、
  混在経路でも同じ閾値・同じ文言で出す**(複勝専用経路と同じ`probabilitySumWarning`を、
  混在経路が持つ`race.rows[].adjustedProb`合計から同じ形の入力を組み立てて再利用する。既存経路に
  あった注記が新経路で欠落しないことを個別に確認済み)。**組合せ券種のEVは推定誤差が組み合わせ人数ぶん増幅されて過大評価になりやすく、
  較正は未実施**(Issue #35。計測基盤は#40で整備済み、較正方式の要否検討は#42。画面にも注記を
  表示する)。異常な数値(オッズ・馬番)を含むレースは例外を投げずに判別可能な状態で表示する。
- **未実装(将来課題)**: 1日/開催単位の総上限、確率の較正(Issue #35→#39/#40/#41/#42に分割。
  #40で計測基盤を整備済み〈9節参照〉、較正方式そのものの要否検討は#42。複勝単独でも市場に対し
  系統的な過大評価がある実測がある)、三連単(着順情報が必要で Phase 2 待ち)、検証画面での
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
  - **ヘッドレススモーク**(`smoke`。本命): 壊れていた v1.3.1 の実物 exe を検査すると asar
    配置検査4項目(当初案)すべてが PASS した一方、ABI 不一致(`NODE_MODULE_VERSION` 不一致)は
    配置検査では1件も検出できないことが実測で判明したため、こちらが本命。
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
    Windows CI が唯一の検証場所である。

## 9. 確率の質の計測基盤(scorer/snapshot-filter・ev/probability-quality。#40「#35-1a」)

#35(確率の質の疑い。「組合せ券種のEVがオッズの順序をなぞるだけではないか」)を判断するための
**計測専用**の基盤。**測るだけ**で、prior・同時分布モデル・EV計算(`prior.ts`・
`place-joint-model.ts`・`combo-bet-allocation.ts`・`expected-value.ts`)の挙動は一切変更しない。

- **Issue #35 の分割**: #40(本節。計測基盤の健全化と指標の実装)/ #39(本番側
  `analysis-pipeline.ts` の先読みリーク是正)/ #41(30レース規模のサンプル拡大・LLM実行)/
  #42(較正 calibration 方式の要否検討)。#20(同時分布モデルの厳密化)は #41/#42 の技術的前提。
- **着手前ゲートで判明した2つの計測条件欠陥**(#40がまず健全化した理由):
  1. **実行日ドリフト**: `runAnalysis` に `kaisaiDate` を渡さないと `resolveAnalysisDate` が
     実行日(`now()`)へフォールバックし、季節分類・休み明け走目の基準日が壁時計時刻とともに
     動く(`dateApproximate=true`)。計測・回帰テストでは必ず実レース日の `kaisaiDate` を明示する
     こと。`scripts/bench-mixed-allocation.ts` もこの理由で `kaisaiDate` を明示するよう是正済み
     (#40。それ以前は明示していなかった)。
  2. **先読みリーク**: `analysis-pipeline.ts:344` 付近が戦績を日付でフィルタせず `buildPriorInput`
     に渡すため、当該レース自身の着順が prior の材料に混入しうる(実測: 中央16頭フィクスチャで
     出走16頭全頭・21走が該当。うち16走が当該レース自身、5走は基準日より後の日付)。
     **本番側(`analysis-pipeline.ts`)の是正は #39 の担当**(#40はそこに一切手を入れない)。
     計測用には `filterRaceDataBefore`(後述)で遮断してから測る。
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
  前後比較(#40で実測: 中央16頭で ρ 0.2104→-0.0059、正規化KL 0.0156→0.0236)。

## 主な当初仕様との差異(記録)

- **配布ビルドの前倒し**: 当初 Phase 5 の配布ビルドを、UI 実装中も Releases から exe を入手できるよう
  Phase 4 開始時点で先行整備した。
- **renderer は core を直接 import しない**(上述。ネイティブ依存を main に集約)。
- **地方競馬(NAR)対応**: 当初仕様のスコープ外だったが実装済み(取得・スコアリング・検証の中央/地方別)。
- **Phase 6(discord.js bot)は未実装**。通知は Electron 内蔵の Webhook 送信まで。
