#!/usr/bin/env bash
# 検証を順に流し、要約だけを出す。既定は速い層だけ、--full で CI と同じ全段(Issue #606・#620)。
#
# 使い方:
#   SMOKE_PORT=18814 scripts/verify-all.sh [--research] [--dry-run] [--smoke-port N]
#
#   --research        確率の質のコード(packages/core/src/ev/probability-quality*.ts・scripts/probability-quality-41*/)に
#                     触れたときだけ付ける。ルートの `pnpm test:research` も流す(普段の `pnpm test` から外してあるため。Issue #395)
#   --full            CI が流す段を全部流す(cloud の全件 `pnpm test` と smoke を含む。手元で 30 分を超える)。通常は付けない(Issue #620)
#   --dry-run         流すコマンドを順に出すだけで、何も実行しない(テストが段の形を調べるのに使う)
#   --smoke-port N    smoke の SMOKE_PORT(--full のときだけ使う)。引数が環境変数 SMOKE_PORT より優先する。他のセッションと分ける
#
# テストの 3 層(Issue #620):
#   ユニット          偽の D1・DO を差し込む、純粋な関数のテスト。実装担当が TDD の 1 周ごとに全件流す。
#   インテグレーション 本物の workerd(ローカルの D1・R2)を開く、または wrangler を実行するテスト(cloud の *.integration.test.ts)。
#                     実装担当は、変えたものに関係する分だけ流す。
#   全件と smoke      上の全部と cloud/smoke.ts。push 後の CI が確かめる(結果の確認はメインが行う)。
#
# 既定で流す段(依存のインストールは含めない):
#   ルート: pnpm typecheck / pnpm test        (`-r` 無し。scripts/ 配下のテスト・型検査は -r 付きでは走らない。Issue #38)
#   cloud : pnpm run typecheck / pnpm run test:unit / 関係するインテグレーション(scripts/verify-related-integration.mjs)
#           / pnpm run deploy:dry / pnpm exec wrangler d1 migrations apply DB --local
#   関係するインテグレーションの基点は環境変数 VERIFY_BASE(既定は実装担当の終了時フックと同じ ref)。merge-base から作業ツリー・未追跡までを変更とみなす。
# --full の段(ci.yml の verify・cloud-verify と、deploy-cloud.yml の check・smoke の run: に対応する):
#   ルート: pnpm typecheck / pnpm test
#   cloud : pnpm run typecheck / pnpm test / pnpm run deploy:dry / pnpm exec wrangler d1 migrations apply DB --local / pnpm run smoke
# 依存のインストールは事前に行う: ルートで `pnpm install --frozen-lockfile`、cloud/ で `pnpm install --ignore-workspace --frozen-lockfile`。
#
# 出力: 各段の終了コード・所要時間・テストの要約行(`Test Files …`・`Tests …`、smoke は最後の行)だけ。全文のログは一時ディレクトリに残し、その場所を出す。
# 1 つでも失敗したら 0 以外で終わる(失敗しても後続の段は流し、全段の結果を出す)。
#
# テスト用の差し替え(scripts/test/verify-all.test.ts が使う): VERIFY_ALL_STUB=1 で全段のコマンドを `true` に、
# VERIFY_ALL_FAIL_STAGE=<段の id> でその段だけ `false` に置き換える。
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
research=0
dry=0
full=0
smoke_port="${SMOKE_PORT:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --research) research=1 ;;
    --full) full=1 ;;
    --dry-run) dry=1 ;;
    --smoke-port)
      shift
      smoke_port="${1:-}"
      if [ -z "$smoke_port" ]; then echo "--smoke-port には番号が要ります" >&2; exit 2; fi
      ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "不明な引数: $1" >&2; exit 2 ;;
  esac
  shift
done

# 段: id|作業ディレクトリ(ROOT からの相対)|コマンド
stages=(
  "root-typecheck|.|pnpm typecheck"
  "root-test|.|pnpm test"
)
if [ "$research" -eq 1 ]; then
  stages+=("root-test-research|.|pnpm test:research")
fi
stages+=("cloud-typecheck|cloud|pnpm run typecheck")
if [ "$full" -eq 1 ]; then
  # --full: CI が流す段をそのまま全部(cloud の全件と smoke を含む)
  stages+=(
    "cloud-test|cloud|pnpm test"
    "cloud-deploy-dry|cloud|pnpm run deploy:dry"
    "cloud-d1-migrate-local|cloud|pnpm exec wrangler d1 migrations apply DB --local"
    "cloud-smoke|cloud|pnpm run smoke"
  )
else
  # 既定: ユニットの全件と、変えたものに関係するインテグレーションだけ。全件と smoke は push 後の CI が確かめる(Issue #620)
  stages+=(
    "cloud-test-unit|cloud|pnpm run test:unit"
    "cloud-test-integration-related|cloud|node ../scripts/verify-related-integration.mjs"
    "cloud-deploy-dry|cloud|pnpm run deploy:dry"
    "cloud-d1-migrate-local|cloud|pnpm exec wrangler d1 migrations apply DB --local"
  )
fi

if [ "$dry" -eq 1 ]; then
  for s in "${stages[@]}"; do
    IFS='|' read -r id dir cmd <<<"$s"
    echo "STAGE $id | $dir | $cmd"
  done
  if [ -n "$smoke_port" ]; then echo "SMOKE_PORT=$smoke_port"; fi
  exit 0
fi

if [ -n "$smoke_port" ]; then export SMOKE_PORT="$smoke_port"; fi
if [ "$full" -eq 1 ] && [ "${VERIFY_ALL_STUB:-}" != "1" ] && pgrep -f 'workerd|wrangler' >/dev/null 2>&1; then
  echo "注意: wrangler・workerd が動いています。smoke は固定のポートを使うので、SMOKE_PORT を他と分けてください(現在: ${SMOKE_PORT:-既定の 8801})" >&2
fi

LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/verify-all.XXXXXX")"
echo "全文のログ: $LOGDIR"

failed=0
results=()
for s in "${stages[@]}"; do
  IFS='|' read -r id dir cmd <<<"$s"
  run="$cmd"
  if [ "${VERIFY_ALL_STUB:-}" = "1" ]; then run="true"; fi
  if [ "${VERIFY_ALL_FAIL_STAGE:-}" = "$id" ]; then run="false"; fi
  log="$LOGDIR/$id.log"
  start=$SECONDS
  (cd "$ROOT/$dir" && bash -c "$run") >"$log" 2>&1
  code=$?
  elapsed=$((SECONDS - start))
  summary="$(grep -E '^\s*(Test Files|Tests)\s' "$log" | sed 's/^\s*//' | tr '\n' ' ')"
  if [ "$id" = "cloud-smoke" ] || [ -z "$summary" ]; then
    summary="$(grep -v '^\s*$' "$log" | tail -n 1)"
  fi
  if [ "$code" -ne 0 ]; then failed=1; fi
  printf '%-24s 終了コード=%s %4ss  %s\n' "$id" "$code" "$elapsed" "$summary"
done

if [ "$failed" -ne 0 ]; then
  echo "結果: 失敗あり(ログ: $LOGDIR)"
  exit 1
fi
echo "結果: 全段成功(ログ: $LOGDIR)"
