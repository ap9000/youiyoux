// @generated from design-language components/_shared/utils.ts by apps/web/scripts/snapshot.ts. Do not edit.
/** shadcn/ui's class helper: conditional classes, later Tailwind classes win. */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]): string { return twMerge(clsx(inputs)); }
