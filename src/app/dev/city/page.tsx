import { notFound } from "next/navigation";
import { CityPlayground } from "./CityPlayground";

// 街の盤面の確認ページ（docs/map-layout-redesign.md）。データベースなしで街を放置計算して描く。開発環境だけで開ける。
export default function Page() {
  if (process.env.NODE_ENV === "production") notFound();
  return <CityPlayground />;
}
