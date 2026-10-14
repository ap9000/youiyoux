import "./app.css";
import { RadioCard } from "./radio-card";
// Layout classes also used elsewhere in the app, so automatic scanning still finds them.
export function Layout({ children }: { children: React.ReactNode }) { return <div className="flex h-11 gap-2">{children}</div>; }
export function App() { return <RadioCard />; }
