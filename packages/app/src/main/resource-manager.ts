/**
 * 依存(分析パイプライン資源)のライフサイクル管理(main プロセス)。
 *
 * 目的: 設定保存で依存を作り直す際、実行中の分析が使っている DB 接続を閉じて
 * 「connection is not open」で分析が落ちるのを防ぐ。
 *
 * 方針:
 * - 分析中(runExclusive 実行中)は close を遅延する。設定変更は markDirty で「保留」にし、
 *   分析中は既存資源を保持したまま dirty フラグだけ立てる。
 * - アイドル時(実行中0件)の markDirty は即座に閉じて破棄し、次回 acquire で再構築する。
 * - dirty のまま分析が続いた場合も、次回の acquire(次の分析開始時など)で idle を確認して
 *   古い資源を閉じ、新しい設定で再構築する(プロセス再起動不要)。
 *
 * create/close は注入(Electron 非依存)。ipc.ts が実資源(createPipelineDeps / close)を束ねる。
 */

/** ResourceManager の依存(資源の生成・破棄)。 */
export interface ResourceManagerDeps<R> {
  /** 資源を生成する(現在の設定を読み込んで配線する)。 */
  readonly create: () => R;
  /** 資源を破棄する(DB接続などのクローズ)。 */
  readonly close: (resource: R) => void;
}

/**
 * 資源を遅延生成・再利用し、実行中の破棄を避けるマネージャ。
 * @typeParam R 管理対象の資源型
 */
export class ResourceManager<R> {
  private current: R | null = null;
  /** 実行中(runExclusive)の件数。0 のときだけ破棄・再構築してよい。 */
  private running = 0;
  /** 設定変更が保留中(次のアイドル時に再構築すべき)か。 */
  private dirty = false;

  constructor(private readonly deps: ResourceManagerDeps<R>) {}

  /**
   * 資源を取得する(必要なら再構築)。実行を開始する前に呼ぶこと。
   * 実行中の分析が無く、かつ設定変更が保留中なら、ここで古い資源を閉じて作り直す。
   */
  acquire(): R {
    if (this.current !== null && this.dirty && this.running === 0) {
      this.deps.close(this.current);
      this.current = null;
      this.dirty = false;
    }
    if (this.current === null) {
      this.current = this.deps.create();
      this.dirty = false;
    }
    return this.current;
  }

  /**
   * 資源を取得し、in-flight カウントを +1 してから処理を実行する。完了(成否問わず)で -1 する。
   *
   * 注意(名前に反して相互排他ではない): 複数の runExclusive を同時に呼べば、それらは並行して
   * 走る(この実装は処理同士の直列化・ロックは行わない)。この関数が保証するのは「in-flight が
   * 1件でもある間は markDirty による close を遅延する」ことだけであり、実行中の資源(DB接続)が
   * 途中で閉じられないことを担保する用途に用いる。処理そのものの直列実行が必要な場合
   * (例: 一括分析のレート制御)は、呼び出し側で逐次 await して直列化すること。
   * @param fn 資源を受け取って実行する非同期処理
   */
  async runExclusive<T>(fn: (resource: R) => Promise<T>): Promise<T> {
    const resource = this.acquire();
    this.running += 1;
    try {
      return await fn(resource);
    } finally {
      this.running -= 1;
    }
  }

  /**
   * 設定変更を通知する。実行中でなければ即座に破棄し(次回 acquire で再構築)、
   * 実行中なら破棄を遅延して dirty を立てる(次のアイドル acquire で再構築)。
   */
  markDirty(): void {
    this.dirty = true;
    if (this.running === 0 && this.current !== null) {
      this.deps.close(this.current);
      this.current = null;
      this.dirty = false;
    }
  }

  /** 現在の資源を明示的に閉じる(will-quit 用)。未生成なら何もしない(冪等)。 */
  close(): void {
    if (this.current !== null) {
      this.deps.close(this.current);
      this.current = null;
    }
  }
}
