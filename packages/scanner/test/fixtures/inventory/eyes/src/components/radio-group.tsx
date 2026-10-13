import { createContext, useContext, type ReactNode } from "react";
const Group = createContext(false);
export function RadioGroup({ children }: { children: ReactNode }) { return <Group.Provider value={true}><div>{children}</div></Group.Provider>; }
export function useRadioGroup() { if (!useContext(Group)) throw new Error("RadioCard needs RadioGroup"); }
