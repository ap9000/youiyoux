import { createContext, useContext, type ReactNode } from "react";

const NoticeContext = createContext<(message: string) => void>(() => {});

export function NoticeProvider({ children }: { children: ReactNode }) {
  return <NoticeContext.Provider value={() => {}}>{children}</NoticeContext.Provider>;
}

export function useNotice(): (message: string) => void {
  return useContext(NoticeContext);
}

export function showNotice(): void {}
