-- クラウド版(D1)の migration 0049: JRA の「過去の含水率・クッション値」(年ごとの頁と、開催ごとの PDF)から貯めた、過去の馬場の公表値(Issue #769)。exe の SQLite には無い、D1 専用の表。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため。表が無い間は新しい Worker の保存が止まるだけ)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_TABLES)も同時に直す。
-- 読み書きは cloud/src/baba-past-repository.ts だけ(書くのは本番の Worker の DO〈JraBabaPastBackfillDO〉だけ)。
--
-- ★★ 測定の時刻は載っていない(PDF には日付と曜日の列しかない)ので、この表は measured_at を持たない。当日の取得で貯めている baba_conditions(0017)とは別の表にした。
--    JRA の注記(年の頁の注記): 「含水率測定は、原則として金曜日は午前中、土日の開催日は早朝に実施します。」「クッション値測定時刻は、各競馬場の調教時間や天候等によって異なります。」
--    したがって、クッション値は「その日のいつ測ったか」が公表されない(分析で「レースより前に測った」と言い切れない)。含水率は、金曜は午前、土日は早朝(これも原則であって、時刻の記録ではない)。
--    「原則、競馬開催終了後の翌木曜日に更新します」とあるので、最新の開催は PDF に載るのが遅れる。含水率は 2018-07-27 から、クッション値は 2020-09-11 から公表されている(それより前の PDF は cushion が NULL)。
-- 馬場状態(良・稍重など)・使用コース・芝丈・降水量は PDF に無いので持たない(当日の取得の baba_conditions にだけある)。ダートのクッション値も公表されていない。
-- 金曜(開催日ではない日)の行も入る(weekday = 金)。開催日かどうかは読み手が決める。
-- 両方の表とも WITHOUT ROWID で、副索引は作らない(使うのは主キーの引きと範囲読みだけ)。1 行の書き込み = 1 書き込み。
--
-- baba_past: 日付 × 競馬場(JRA の場コード 01〜10)で 1 行。
--   kaisai_date              日付(YYYYMMDD。JST の暦の日)。金曜など開催日でない日も入る
--   venue_code               JRA の場コード(01〜10)
--   weekday                  曜日の 1 字(金・土・日・月など。PDF の列の見出し)
--   cushion                  芝のクッション値。クッション値の節が無い PDF(2020-09-11 より前)は NULL
--   turf_goal_moisture       芝の含水率(ゴール前。%)
--   turf_corner4_moisture    芝の含水率(4 コーナー。%)
--   dirt_goal_moisture       ダートの含水率(ゴール前。%)
--   dirt_corner4_moisture    ダートの含水率(4 コーナー。%)
--   source_pdf               出どころの PDF(archive/ からの相対。例 2021pdf/tokyo01.pdf。年はこの先頭の 4 桁)
--   fetched_at               取って保存した時刻(エポックミリ秒)
CREATE TABLE baba_past (
  kaisai_date TEXT NOT NULL,
  venue_code TEXT NOT NULL,
  weekday TEXT NOT NULL,
  cushion REAL,
  turf_goal_moisture REAL NOT NULL,
  turf_corner4_moisture REAL NOT NULL,
  dirt_goal_moisture REAL NOT NULL,
  dirt_corner4_moisture REAL NOT NULL,
  source_pdf TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (kaisai_date, venue_code)
) WITHOUT ROWID;

-- baba_past_pdfs: PDF 1 本につき 1 行の、取得の記録。**この行があれば取り終えている**(再取得しない)。読めなかった PDF も、分類を result に残して止めない。
--   source_pdf   PDF の相対パス(主キー)
--   year         年(年の頁の年)
--   venue_code   JRA の場コード(PDF の名前から)
--   kai          開催回(PDF の名前から)
--   result       結果の分類(固定の語): ok・not-pdf・inflate-failed・too-large・no-text・shape-mismatch(PDF が読めなかったとき)、
--                http-<status>・redirect(取得で決まった失敗。一時的な失敗〈timeout・network・5xx・408・429〉は記録せず、あとで取り直す)
--   rows_saved   baba_past に書いた行数(ok 以外は 0)
--   r2_key       R2 に置いた PDF のキー(baba-past/ + source_pdf)。置かなかった(柵・失敗・取得できていない)ときは NULL。パーサを直したときに JRA へ取り直さないための控え
--   fetched_at   記録した時刻(エポックミリ秒)
CREATE TABLE baba_past_pdfs (
  source_pdf TEXT NOT NULL PRIMARY KEY,
  year INTEGER NOT NULL,
  venue_code TEXT NOT NULL,
  kai INTEGER NOT NULL,
  result TEXT NOT NULL,
  rows_saved INTEGER NOT NULL,
  r2_key TEXT,
  fetched_at INTEGER NOT NULL
) WITHOUT ROWID;
