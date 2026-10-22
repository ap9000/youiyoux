/**
 * The design repo's demos, by component name, loaded on first use. The dev server and `vite build`
 * read them through the @snapshot alias; the npm package's hub builds them per snapshot and puts
 * that module in this one's place (scripts/frame.ts), with each demo it could not build and why.
 */
import type { ComponentType } from "react";

export type DemoModule = { default: ComponentType };

export const DEMOS: Readonly<Record<string, () => Promise<DemoModule>>> = Object.fromEntries(
  Object.entries(import.meta.glob<DemoModule>("@snapshot/preview/components/*.demo.tsx")).map(([path, load]) => [path.split("/").at(-1)!.replace(/\.demo\.tsx$/, ""), load]),
);

/** Demos that are in the design repo but could not be built for the frame, with the reason. */
export const DEMO_ERRORS: Readonly<Record<string, string>> = {};
