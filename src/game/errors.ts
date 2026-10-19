/** プレイヤーに表示できるゲーム上のエラー */
export class GameError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    /** 画面で使う補足（例：自由予算を超える月の一覧） */
    public details?: unknown,
  ) {
    super(message);
  }
}

export const fail = (code: string, message: string, status = 400, details?: unknown): never => {
  throw new GameError(code, message, status, details);
};
