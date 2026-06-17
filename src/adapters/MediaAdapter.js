// ============================================================
// sirube-ams-checker / 媒体アダプタ 基底クラス
// system_code: sys_ops_ams_checker
//
// すべての媒体アダプタが実装すべきインターフェースを定義する。
// 新しい媒体を追加するときは、このクラスを継承して
// mediaName / fetchStatus / translateStatus を実装すること。
// ============================================================

export class MediaAdapter {
  // 媒体名（"freins" / "suumo" / "athome" 等）。DBの media カラムに使う内部識別子。サブクラスで実装必須。
  get mediaName() {
    throw new Error(`${this.constructor.name}: mediaName を実装してください`);
  }

  // 人間向け表示名（note 等に使う）。デフォルトは mediaName と同じ。必要に応じてオーバーライド。
  get displayName() {
    return this.mediaName;
  }

  // ログイン。デフォルトは何もしない（ログイン不要な媒体はオーバーライド不要）。
  async login(_page) {}

  // 1件取得。freins_id 等の媒体固有 ID を受け取り、以下の形式で返す。
  // {
  //   rawStatus  : string | null,  // 媒体から取得した原文（必ず保持）
  //   mediaStatus: string | null,  // 標準ステータス（open/negotiating/contracted/vanished/unknown）
  //   judgment   : string,         // error / vanished_suspected / open / negotiating / unknown 等
  //   note       : string,         // 人間向け補足（原文・エラー内容等）
  // }
  // サブクラスで実装必須。
  async fetchStatus(_page, _mediaId) {
    throw new Error(`${this.constructor.name}: fetchStatus を実装してください`);
  }

  // 媒体固有の表現 → 標準ステータス変換。サブクラスで実装必須。
  // 戻り値は open / negotiating / contracted / vanished / unknown のいずれか。
  translateStatus(_rawText) {
    throw new Error(`${this.constructor.name}: translateStatus を実装してください`);
  }
}
