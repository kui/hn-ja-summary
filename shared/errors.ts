// 同じ入力でやり直しても毎回同じ結果になる失敗。processor はこれを再試行せずにすぐ error にし、
// それ以外の例外はすべて Queue の再配信に回す。分類を誤っても再配信の上限で止まるので、
// 再試行しても通らないと確かに言えるものだけをこのクラス（かその派生クラス）で投げる
export class PermanentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PermanentError";
  }
}
