import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Cité de Tirelire",
    short_name: "Tirelire",
    description: "節約と貯金で街が育つ、放置型の街づくり貯金ゲーム",
    start_url: "/",
    display: "standalone",
    background_color: "#f6f0e1",
    theme_color: "#2f6f4e",
    lang: "ja",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
