/**
 * Railway Infrastructure as Code for the hub's preview deploys (evaluated by the Railway CLI:
 * `railway config plan`, then `railway config apply`; see apps/web/README.md, "Preview deploys").
 *
 * One static service, built by Railway's default builder from the repository root. Each pull
 * request gets its own copy of it in a PR environment; the build serves only the committed demo
 * snapshot and fails if anything else reaches dist/.
 */
import { defineRailway, github, project, service } from "railway/iac";

export default defineRailway(() => {
  const hub = service("youiyoux-web", {
    source: github("ap9000/youiyoux", { branch: "main" }),
    build: "pnpm --filter @youiyoux/web build:preview",
    start: "node apps/web/scripts/serve-preview.ts",
    healthcheck: "/healthz",
    healthcheckTimeout: 60,
  });

  return project("youiyoux", { resources: [hub] });
});
