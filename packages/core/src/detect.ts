/**
 * youi.detect/v1: which UI libraries a repo or website uses, as `youiyoux detect` found them. A
 * verdict per library and per element type, each with a confidence and the evidence behind it.
 * A website report covers only the pages it crawled; a repo report lists packages that are
 * declared but never imported apart from the verdicts, never counted in them.
 */
import { posix } from "node:path";
import { z } from "zod";

const IsoTime = z.string().datetime({ offset: true });
/** A screenshot beside the report: relative, without `..`. */
const ShotPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !posix.normalize(p.replace(/\\/g, "/")).split("/").includes(".."), "expected a path relative to the report, without ..");

export const DETECT_CONFIDENCE = ["high", "medium", "low"] as const;
export const DetectConfidence = z.enum(DETECT_CONFIDENCE);
export type DetectConfidence = z.infer<typeof DetectConfidence>;

export const DETECT_ELEMENT_TYPES = ["button", "input", "checkbox", "switch", "select", "tabs", "dialog", "menu", "popover", "tooltip", "accordion", "card", "avatar", "badge"] as const;
export const DetectElementType = z.enum(DETECT_ELEMENT_TYPES);
export type DetectElementType = z.infer<typeof DetectElementType>;

/** What a piece of evidence is: where in the repo or page it was read. */
export const EVIDENCE_KINDS = ["package", "lockfile", "components-json", "import", "data-slot", "class-prefix", "css-var", "id-prefix", "style-tag", "radix-colors", "tailwind"] as const;

export const DetectEvidence = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  /** strong decides a verdict; weak alone gives only low confidence; support never decides one, only adds to it. */
  strength: z.enum(["strong", "weak", "support"]),
  detail: z.string().min(1),
  count: z.number().int().min(1).default(1),
  /** `file:line` in a repo, or the page URL. */
  where: z.array(z.string()).default([]),
  /** A few matching values (class names, variables, specifiers). */
  samples: z.array(z.string()).default([]),
});
export type DetectEvidence = z.infer<typeof DetectEvidence>;

export const DetectLibrary = z.object({
  /** The fingerprint table's id: `mui`, `shadcn`, `radix`, `base-ui`, `styled-components`, … */
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1),
  confidence: DetectConfidence,
  /** 0 to 1, for ordering; the confidence is what to read. */
  score: z.number().min(0).max(1),
  evidence: z.array(DetectEvidence).min(1),
  /** Pages this library was seen on (websites only). */
  pages: z.array(z.string()).default([]),
});
export type DetectLibrary = z.infer<typeof DetectLibrary>;

export const DetectElement = z.object({
  type: DetectElementType,
  /** The most likely library for this element type; `also` lists the others that matched it. */
  library: z.string(),
  confidence: DetectConfidence,
  count: z.number().int().min(1),
  evidence: z.array(DetectEvidence).min(1),
  also: z.array(z.string()).default([]),
  /** Element screenshot, relative to the report file (websites only). */
  screenshot: ShotPath.optional(),
  /** The page the screenshot was taken on. */
  page: z.string().optional(),
});
export type DetectElement = z.infer<typeof DetectElement>;

export const DetectUnused = z.object({
  package: z.string().min(1),
  /** The declared range. */
  version: z.string(),
  /** The package.json that declares it, relative to the repo. */
  declaredIn: z.string(),
  library: z.string().optional(),
});
export type DetectUnused = z.infer<typeof DetectUnused>;

export const DetectPage = z.object({
  url: z.string().min(1),
  status: z.enum(["ok", "failed"]),
  title: z.string().optional(),
  error: z.string().optional(),
  /** Menus, dialogs and tabs opened to expose portals (`--expose`). */
  exposed: z.number().int().min(0).default(0),
});
export type DetectPage = z.infer<typeof DetectPage>;

export const DetectFont = z.object({
  family: z.string().min(1),
  /** Where it was read: element selectors on a page, or the package that supplies it in a repo. */
  usedBy: z.array(z.string()).default([]),
});
export type DetectFont = z.infer<typeof DetectFont>;

export const DetectReport = z.object({
  $schema: z.string().optional(),
  schema: z.literal("youi.detect/v1"),
  generatedAt: IsoTime,
  detector: z.string(),
  target: z.object({
    kind: z.enum(["repo", "site"]),
    /** The repo path, or every URL asked for. */
    inputs: z.array(z.string().min(1)).min(1),
    /** The site's host or the repo's directory name, as people read it. */
    name: z.string().min(1),
  }),
  /** Every page crawled (websites); empty for a repo. */
  pages: z.array(DetectPage).default([]),
  /** Plainly what the report covers and what it cannot see. */
  coverage: z.string().min(1),
  libraries: z.array(DetectLibrary),
  elements: z.array(DetectElement),
  /** Declared but never imported: reported, not counted in any verdict (repos). */
  unused: z.array(DetectUnused).default([]),
  fonts: z.array(DetectFont).default([]),
  /** Signals read but deliberately not counted, such as data-slot values that are not shadcn's. */
  notes: z.array(z.string()).default([]),
});
export type DetectReport = z.infer<typeof DetectReport>;
