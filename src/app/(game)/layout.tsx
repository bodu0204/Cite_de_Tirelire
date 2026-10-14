import { AppShell } from "@/components/AppShell";
import { GameProvider } from "@/components/GameProvider";

export default function GameLayout({ children }: { children: React.ReactNode }) {
  return (
    <GameProvider>
      <AppShell>{children}</AppShell>
    </GameProvider>
  );
}
