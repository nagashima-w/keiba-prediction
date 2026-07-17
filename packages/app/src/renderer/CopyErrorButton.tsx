import { useEffect, useRef, useState } from "react";

import {
  type CopyErrorController,
  createCopyErrorController,
} from "./copy-error-controller.js";
import { buildErrorCopyText, type ErrorCopyInput } from "./error-copy.js";

/**
 * 「このエラーのログをコピー」ボタン(Task#36 受け入れ条件3)。
 *
 * 各画面の赤エラー表示に添えて使う。押すと buildErrorCopyText(純関数、error-copy.ts)で
 * 組み立てた自己完結テキストをクリップボードへ書き込み、ユーザーがそのままAIへ貼り付けられるようにする。
 *
 * クリップボードAPIの選定(設計判断): navigator.clipboard.writeText を使う。
 * 理由:
 * - コピー対象は「画面に表示中の文字列を整形しただけ」であり、main プロセスの情報
 *   (ファイルシステム・設定等)にはアクセスしない。IPC を新設するほどの必要が無い。
 * - preload/IPC 経由の Electron clipboard モジュールに比べ、renderer 内で完結する分
 *   単体テスト(error-copy.test.ts)の対象を純関数に閉じ込めやすい。
 * - contextIsolation + sandbox 有効下でも navigator.clipboard はレンダラーの標準Web APIとして
 *   利用でき、preload の追加配線が不要(既存の openLogFolder/exportLogs のような
 *   「main側の副作用を伴う操作」とは性質が異なるため、IPCチャネルを増やさない判断とした)。
 *
 * コピー状態遷移(clipboard.writeText 呼び出し・成功時のラベル巻き戻しタイマー・失敗時の握りつぶし)は
 * copy-error-controller.ts の createCopyErrorController に切り出し、そちらで単体テストする
 * (このリポジトリは @testing-library 未導入のためレンダリングテストは行わない)。
 * ここではコントローラの生成・破棄(アンマウント時のタイマークリーンアップ)と、
 * onCopiedChange を useState へつなぐ配線のみを担う。
 */
export interface CopyErrorButtonProps extends ErrorCopyInput {
  /** ボタンの追加スタイル(呼び出し元のレイアウトに合わせる)。 */
  readonly style?: React.CSSProperties;
}

export function CopyErrorButton(props: CopyErrorButtonProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const { style, ...copyInput } = props;

  // コントローラの生成はuseEffect内で行う(code-reviewer再レビュー指摘の要修正1)。
  // 当初はuseRefの遅延初期化(render中に1回だけ生成)にしていたが、main.tsxはアプリ全体を
  // React 18 StrictModeで包んでおり、開発モードではeffectがsetup→cleanup→setupと2重実行される。
  // render中生成だとインスタンスは1つしか作られないため、1回目のcleanupでdisposeされた
  // 同一インスタンスを2回目以降のsetup後も使い続けることになり、「コピーしました」表示が
  // 二度と出なくなる(本番ビルドでは2重実行がないため問題は顕在化しない)。
  // setupのたびに新しいインスタンスを生成し、対応するcleanupでそのインスタンスだけを
  // disposeする形にすることで、StrictModeのsetup→cleanup→setupを経ても2つ目のインスタンスが
  // 正常に動作する(この不変条件は copy-error-controller.test.ts で固定している)。
  const controllerRef = useRef<CopyErrorController | null>(null);
  useEffect(() => {
    const controller = createCopyErrorController({
      writeText: (text) => navigator.clipboard.writeText(text),
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      onCopiedChange: setCopied,
    });
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      // クロージャで捕まえた自分自身のインスタンスだけをnullに戻す。
      // (StrictModeの1回目cleanupが2回目setup後のcontrollerRef.currentを誤って
      // nullにしてしまわないよう、参照ではなく「このeffect実行が生成した値」で判定する)
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
  }, []);

  // copyInput(operation/message/context)は呼び出し元のJSXで毎レンダー新規オブジェクトになりがちで
  // useCallbackの依存配列に含めてもメモ化が実質無効化されるだけなので、素直な関数として定義する
  // (ボタン単体の再生成コストは無視できるレベルであり、下流での参照比較にも使っていない)。
  const handleClick = () => {
    controllerRef.current?.copy(buildErrorCopyText(copyInput));
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      style={{
        fontSize: "0.78rem",
        marginLeft: "0.5rem",
        padding: "0.1rem 0.4rem",
        ...style,
      }}
    >
      {copied ? "コピーしました" : "このエラーのログをコピー"}
    </button>
  );
}
