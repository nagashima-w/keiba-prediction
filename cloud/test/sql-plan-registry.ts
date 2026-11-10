/**
 * Issue #632: 実行計画の検査の一覧(sql-plan-inventory.test.ts が使う)。区分は 4 つ。
 * 鍵は `<cloud/src のファイル>::<定数名>`(オブジェクトの値は `.<キー>`、組み立て関数は `<関数名>(.<キー>)`)。
 * 文書側の一覧(docs/db-sql-rules.md の末尾)は、この 4 区分の写し。区分を変えたら文書も直す。
 */
export type PlanEntry =
  | { readonly kind: "here"; readonly tempBtree?: string }
  | { readonly kind: "existing"; readonly file: string }
  | { readonly kind: "exception"; readonly reason: string; readonly issue: string; readonly tempBtree?: string }
  | { readonly kind: "excluded"; readonly reason: string };

const here = (keys: readonly string[], tempBtree?: string): Record<string, PlanEntry> =>
  Object.fromEntries(keys.map((k) => [k, tempBtree === undefined ? { kind: "here" as const } : { kind: "here" as const, tempBtree }]));
const existing = (file: string, keys: readonly string[]): Record<string, PlanEntry> => Object.fromEntries(keys.map((k) => [k, { kind: "existing" as const, file }]));
const exception = (keys: readonly string[], reason: string, issue: string, tempBtree?: string): Record<string, PlanEntry> =>
  Object.fromEntries(keys.map((k) => [k, tempBtree === undefined ? { kind: "exception" as const, reason, issue } : { kind: "exception" as const, reason, issue, tempBtree }]));

/** ここ(sql-plan-inventory.test.ts)で検査する: 実在の表の全走査が無い。一時の並べ替えを持つものは、範囲が絞られている理由つき。 */
export const HERE: Record<string, PlanEntry> = {
  ...here([
    // 統計モデルの並走の記録(Issue #649)。json_each から主キーの表への INSERT だけ(読み取りなし)。書き込みの行数は analysis-shadow.integration.test.ts が固定している。
    "analysis-shadow-repository.ts::INSERT_SHADOW_HORSES_SQL",
    "analysis-shadow-repository.ts::INSERT_SHADOW_PROBS_SQL",
    "analysis-close.ts::UPSERT_CLOSE_SQL",
    "analysis-close.ts::DELETE_CLOSE_BETS_SQL",
    "analysis-close.ts::INSERT_CLOSE_BETS_SQL",
    "analysis-close.ts::SELECT_CLOSE_SQL",
    "analysis-close.ts::SELECT_CLOSE_BETS_SQL",
    "analysis-repository.ts::SELECT_ALLOCATION_CAPS_SQL",
    // 前の分析との差(Issue #583)。前の分析は索引 idx_analyses_race_analyzed の範囲+LIMIT 1、馬は主キーの範囲。
    "analysis-repository.ts::PREVIOUS_ANALYSIS_SQL",
    "analysis-repository.ts::DIFF_HORSES_SQL",
    "daily-report-repository.ts::NEEDING_REPORT_SQL",
    "daily-report-repository.ts::READ_RESULTS_SQL.results",
    "daily-report-repository.ts::READ_RESULTS_SQL.combos",
    "daily-report-repository.ts::READ_RESULTS_SQL.imports",
    "daily-report-repository.ts::READ_PERIOD_SQL.bets",
    "daily-report-repository.ts::READ_PERIOD_SQL.marks",
    "daily-report-repository.ts::READ_PERIOD_SQL.results",
    "daily-report-repository.ts::READ_PERIOD_SQL.combos",
    "daily-report-repository.ts::READ_PERIOD_SQL.imports",
    "kaisai-days-repository.ts::RECORD_SQL",
    "jra-entries-repository.ts::JRA_ENTRY_DONE_SQL",
    "jra-entries-repository.ts::JRA_ENTRY_CLAIM_SQL",
    "jra-entries-repository.ts::JRA_ENTRY_FINISH_SQL",
    "jra-entries-repository.ts::UPSERT_PROFILES_SQL",
    "jra-entries-repository.ts::UPSERT_OWNERS_SQL",
    "jra-entries-repository.ts::UPSERT_ENTRIES_SQL",
    // 馬の頁から取った属性の保存と、取る馬の読み出し(Issue #697)。horse_runs の主キーの範囲読み・json_each から horse_profiles の主キーの引き・json_each からの INSERT。
    "jra-horse-repository.ts::LIST_HORSE_IDS_SQL",
    "jra-horse-repository.ts::FILTER_TARGETS_SQL",
    "jra-horse-repository.ts::INSERT_HORSE_PROFILES_SQL",
    // 過去のレースのブリンカー着用の保存と、取り終えたレースの確認(Issue #698)。json_each から past_blinker_races の主キーの引き・json_each からの INSERT 2 本。
    "past-blinker-repository.ts::FILTER_DONE_SQL",
    "past-blinker-repository.ts::INSERT_BLINKER_HORSES_SQL",
    "past-blinker-repository.ts::INSERT_RACES_SQL",
    "monthly-report-repository.ts::INSERT_MONTHLY_SQL",
    "monthly-report-repository.ts::REPLACE_MONTHLY_SQL",
    "prior-export-store.ts::SELECT_R2_USAGE_SQL",
    "prior-export-store.ts::COUNT_READS_SQL",
    "prior-export-store.ts::COUNT_WRITE_SQL",
    "race-backfill-state.ts::RECOMPUTE_RACES_SQL",
    "race-backfill-state.ts::RECOMPUTE_BY_ANALYSIS_IDS_SQL",
    "race-backfill-state.ts::settleRaceBackfillSql",
    "result-repository.ts::SAVE_RACE_CLASS_SQL",
    "settings.ts::SELECT_SETTINGS_SQL",
    "settings.ts::UPSERT_SETTINGS_SQL",
    "verify-read.ts::VERIFY_DAY_ANALYSES_SQL",
    "verify-read.ts::VERIFY_NO_DATE_ANALYSES_SQL",
    "jockey-names-repository.ts::recordSql",
    "trainer-names-repository.ts::recordSql",
    // 騎手・調教師の指標(Issue #642)。未処理の列挙は部分索引、集計の読みは日付の索引の範囲、置き換えは主キー。実際の読み取り行数は market-edge-repository.integration.test.ts が固定している。
    "market-edge-repository.ts::SELECT_MARKET_PENDING_PAGE_SQL",
    "market-edge-repository.ts::MARK_MARKET_VERSION_SQL",
    "market-edge-repository.ts::SELECT_MARKET_WINDOW_PAGE_SQL",
    "market-edge-repository.ts::PRUNE_MARKET_ROWS_SQL",
    "market-edge-repository.ts::UPSERT_MARKET_EDGES_SQL",
    "market-edge-repository.ts::DELETE_STALE_MARKET_EDGES_SQL",
    "market-edge-repository.ts::UPSERT_MARKET_EDGE_META_SQL",
    "market-edge-repository.ts::SELECT_MARKET_EDGES_SQL",
    "market-edge-repository.ts::SELECT_MARKET_EDGE_META_SQL",
    "market-edge-repository.ts::saveMarketRowsSql",
    // 組み立て関数(サンプルの引数 ids=1,2 で SQL にしたもの)
    "targets-repository.ts::targetsSql.bets",
    "targets-repository.ts::targetsSql.marks",
    "targets-repository.ts::targetsCloseSql.rounds",
    "targets-repository.ts::targetsCloseSql.bets",
    "verify-read.ts::verifyDayHorsesSql",
    "verify-read.ts::verifyDayAllocationSql.allocationMeta",
    "verify-read.ts::verifyDayAllocationSql.bets",
    "verify-read.ts::verifyDayResultSql.results",
    "verify-read.ts::verifyDayResultSql.comboPayouts",
    "verify-read.ts::verifyDayResultSql.comboImports",
    "verify-close.ts::verifyDayCloseSql.meta",
    "verify-close.ts::verifyDayCloseSql.bets",
  ]),
  ...here(["daily-report-repository.ts::LIST_DAY_ANALYSES_SQL"], "1 日の分析(開催日の索引で絞る。25〜270 行)の ORDER BY"),
  ...here(["daily-report-repository.ts::READ_PERIOD_SQL.races"], "期間(28 日・1 か月)の分析(開催日の索引で絞る)の ROW_NUMBER() OVER と ORDER BY"),
  ...here(["monthly-report-repository.ts::LAST_DAY_STATUS_SQL"], "1 日の分析(開催日の索引で絞る)の ROW_NUMBER() OVER と ORDER BY"),
  ...here(["targets-repository.ts::TARGETS_ANALYSES_SQL"], "1 日の分析(開催日の索引で絞る)の ROW_NUMBER() OVER と ORDER BY"),
  ...here(["verify-race-mark.ts::MARK_VERIFY_RACES_SQL", "verify-race-mark.ts::MARK_VERIFY_BY_ANALYSIS_IDS_SQL"], "束縛した JSON の配列(書いたレース・分析の数)の ROW_NUMBER() OVER と DISTINCT"),
};
export const CHECK_HERE_TEMP_BTREE = 6;

/** 既存の検査: workerd を開く integration テストが、実行計画を見ている(ここでは複製しない)。 */
export const EXISTING: Record<string, PlanEntry> = {
  ...existing("monthly-report-repository.integration.test.ts", ["adjustment-fit-read.ts::FIT_CANDIDATES_SQL", "adjustment-fit-read.ts::FIT_HORSES_SQL", "adjustment-fit-read.ts::FIT_RESULTS_SQL"]),
  ...existing("kaisai-days-repository.integration.test.ts", ["kaisai-days-repository.ts::LOAD_SQL"]),
  ...existing("verify-pending-index.integration.test.ts", ["verify-store.ts::PENDING_SQL"]),
  ...existing("race-archive-runs-index.integration.test.ts", ["race-archive-repository.ts::SELECT_CATALOG_PAGE_SQL", "race-archive-repository.ts::SELECT_CATALOG_PENDING_PAGE_SQL"]),
  ...existing("result-repository.integration.test.ts", ["result-repository.ts::LIST_UNIMPORTED_SQL", "result-repository.ts::LIST_UNIMPORTED_BY_DAY_SQL"]),
  ...existing("result-backfill-state.integration.test.ts", [
    "result-repository.ts::LIST_BACKFILL_SQL",
    "result-repository.ts::COUNT_BACKFILL_SQL",
    "result-repository.ts::LIST_WIN_ODDS_BACKFILL_SQL",
    "result-repository.ts::COUNT_WIN_ODDS_BACKFILL_SQL",
    "result-repository.ts::LIST_CLASS_BACKFILL_SQL",
    "result-repository.ts::COUNT_CLASS_BACKFILL_SQL",
    "result-repository.ts::LIST_PAYOUT_BACKFILL_SQL",
    "result-repository.ts::COUNT_PAYOUT_BACKFILL_SQL",
    "race-backfill-state.ts::RECONCILE_RECENT_RACE_BACKFILL_SQL",
  ]),
  ...existing("result-fill-sql-equivalence.integration.test.ts", ["result-repository.ts::FILL_WIN_ODDS_SQL", "result-repository.ts::FILL_SCRATCHED_SQL", "result-repository.ts::FILL_WIN_PAYOUT_SQL"]),
};

/** 既知の例外: 今も全走査がある。理由と Issue を付ける(新しい全走査を、ここへ載せて赤を消さない。理由を調べてから)。 */
export const EXCEPTIONS: Record<string, PlanEntry> = {
  ...exception(
    [
      "verify-read.ts::VERIFY_READ_SQL.analyses",
      "verify-read.ts::VERIFY_READ_SQL.horses",
      "verify-read.ts::VERIFY_READ_SQL.allocationMeta",
      "verify-read.ts::VERIFY_READ_SQL.bets",
      "verify-read.ts::VERIFY_READ_SQL.results",
      "verify-read.ts::VERIFY_READ_SQL.comboPayouts",
      "verify-read.ts::VERIFY_READ_SQL.comboImports",
      "verify-close.ts::VERIFY_CLOSE_READ_SQL.meta",
      "verify-close.ts::VERIFY_CLOSE_READ_SQL.bets",
    ],
    "検証の再計算(readAll)の全件読み。開催日ごとの差分の再計算へ置き換え中",
    "#616",
  ),
  ...exception(["d1-health.ts::D1_HEALTH_SQL"], "各表を LIMIT 1 で読んで止まる疎通確認(計画は SCAN と出るが、読む行数は表の大きさに依らない少数)", "#612"),
  ...exception(["prior-export-store.ts::CANDIDATES_SQL"], "統計モデルの書き出し(管理者の要求)が分析の全件を読む。書き出した日だけ走る", "#612"),
  ...exception(["prior-export-store.ts::LOOKUPS_SQL", "prior-export-store.ts::TRAINER_LOOKUPS_SQL"], "騎手名・調教師名の表の全件(統計モデルの書き出しだけ。小さい表: 本番で 189・268 行)", "#612"),
  ...exception(["race-backfill-state.ts::RECONCILE_RACE_BACKFILL_SQL"], "結果の補完の整合検査。分析と結果の全件を突き合わせる(夜に 1 回)。直近だけの RECONCILE_RECENT_RACE_BACKFILL_SQL もある", "#612"),
  ...exception(
    ["result-repository.ts::CLASS_DISTRIBUTION_SQL"],
    "補完の status を開くたび(管理者の口)に分析の全件を race_class で集計する",
    "#612",
    "GROUP BY・COUNT(DISTINCT)・ORDER BY の一時の構造(全走査と一体)",
  ),
};

/** 検査対象外: 理由つき。 */
export const EXCLUDED: Record<string, PlanEntry> = {};
