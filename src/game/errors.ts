/** プレイヤーに表示できるゲーム上のエラー */
export class GameError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export const fail = (code: string, message: string, status = 400): never => {
  throw new GameError(code, message, status);
};
