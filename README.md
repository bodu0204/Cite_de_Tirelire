# Cité de Tirelire（街づくり貯金ゲーム）

読み方:シテ・ド・ティルリール

節約と貯金で街が育つ、放置型の街づくり貯金ゲーム（PWA対応Webアプリ）。
要件は [docs/requirements.md](docs/requirements.md)（v1.0 と v1.1 追加仕様の統合整理版）にまとめています。

## 起動

```bash
npm install
cp .env.example .env          # DATABASE_URL
npm run db:up                 # PostgreSQL（docker compose、ポート5433）
npx prisma migrate deploy
npm run dev                   # http://localhost:3000
```

デモデータ（12日前に始まったシーズン）：`npx tsx scripts/seed-demo.ts` → `demo@example.com` / `password123`

## スクリプト


| コマンド                                               | 内容                                         |
| -------------------------------------------------- | ------------------------------------------ |
| `npm test`                                         | ゲームエンジンの単体テスト（受入テスト AT-001〜014 を含む）        |
| `npm run typecheck`                                | 型チェック                                      |
| `npm run build`                                    | 本番ビルド                                      |
| `npx tsx scripts/balance.ts`                       | 貯金スケジュールに沿って50日放置したときの街の推移を表示（バランス調整用）     |
| `BASE=http://localhost:3000 bash scripts/smoke.sh` | APIの通しテスト（登録→シーズン→記録→交換→建設→目標達成→タイムラプス→削除） |
| `node scripts/make-icons.mjs`                      | PWAアイコンの再生成                                |




## 構成

```
src/game/        ゲームエンジン（純粋なTypeScript。DB・UIに依存しない）
  config.ts        バランス値の正本
  catalog.ts       建物の系統×段階（技術Lv・発展Lvの解放条件、生産・消費・建設費）
  mine.ts          金貨の配当（10^-6G単位の固定小数点、月境界・サブスク区切り）と購入の精算
  exchange.ts      資源交換の効率
  levels.ts        銀行Lv・配当Lv・記録Lv・技術Lv・発展Lv
  city/economy.ts  内部経済（人口・労働・電力・物流・幸福度・都市資金）
  city/sim.ts      10分ティックの放置シミュレーションと自律型開発システム
  city/actions.ts  手動操作、公園（サブスク）・像（ほしい物）の同期
  replay.ts        タイムラプスの再構築
src/server/      サーバー（正本）
  game.ts          ユーザー単位ロック付きトランザクションで「同期→操作→保存」
  ops.ts           各操作（記録・報酬・精算・交換・建設・シーズン）
  view.ts          画面に返す状態（ゲージ・放置中の変化）
src/app/         Next.js App Router（画面 SCR-01〜10 と API）
src/components/  UI・ドット絵の描画（Canvas 2D）
prisma/          データモデル
```



### 設計上のポイント

- **サーバーが正本**：時間計算はサーバー時刻。操作のたびに最終計算時刻から現在まで配当と街を計算してから操作を適用する。
- **決定的な放置計算**：ティックを絶対時刻（10分刻み）に揃えるので、いつアクセスしても同じ経過時間なら同じ結果になり、二重計上しない。
- **重複防止**：同一ユーザーの操作は `pg_advisory_xact_lock` で直列化。変更系APIは `Idempotency-Key` で再送を検出。記録報酬は記録IDごとに1回。
- **街の状態は1行のJSON**（`CityState`、楽観ロック付き）。家計履歴・通貨台帳・イベントは別テーブル。



## 未実装・今後

- 第2スコープ：購入写真、AIドット絵（像・公園）、タイムラプス動画出力、オフライン編集（FR-027〜031）、高度な外観演出・物流（FR-048, 049）。
- 認証は自前のメール＋パスワード（scrypt・セッションCookie）。ログイン試行のレート制限、パスワード再設定は未実装。
- バランス値は `src/game/config.ts` で調整する前提の初期値。

