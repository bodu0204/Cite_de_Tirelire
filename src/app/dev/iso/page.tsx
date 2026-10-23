import { notFound } from "next/navigation";
import { IsoPlayground } from "./IsoPlayground";

// M0 の試作ページ（docs/rendering-requirements.md §8）。開発環境だけで開ける。
export default function Page() {
  if (process.env.NODE_ENV === "production") notFound();
  return <IsoPlayground />;
}
