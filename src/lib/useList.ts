"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

/** 一覧 API（{ items: T[] }）の取得と再読み込み */
export function useList<T>(path: string) {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const r = await api<{ items: T[] }>(path);
      setItems(r.items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "読み込みに失敗しました");
    }
  }, [path]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { items, error, reload };
}
