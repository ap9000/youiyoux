import type { ComponentProps } from "react";

export function LegacyButton(props: ComponentProps<"button">) {
  return <button className="lg-button" {...props} />;
}

export function LegacyIconButton(props: ComponentProps<"button">) {
  return <button className="lg-button lg-button--small" {...props} />;
}
