/** The page the server sends: the CLI's Tailwind build, then the plain kit, as index.html has them. */
export function shell(body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <link rel="stylesheet" href="/assets/app.css?v=1" />
    <link rel="stylesheet" href="/ui.css" />
  </head>
  <body>${body}</body>
</html>`;
}
