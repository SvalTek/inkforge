# Development

Inkforge is a pure client-side single-page app: a browser bundle, a set of static assets, and a Deno toolchain that
builds and tests it. There is no server runtime in production.

## Prerequisites

- **Deno 2.x** or newer for the application. The separate docs site needs Node.js 22+ and
  `npm ci --prefix docs`.
- **Chrome or Playwright Chromium** for the browser-driven checks. See [Build and test](build-and-test.md).

## Quick start

```sh
deno task dev        # build, serve on http://localhost:4173/, rebuild on change
deno task check      # type-check the app
deno task smoke      # full browser verification
```

## Where things live

| Path | What |
|---|---|
| `index.html` | The application shell. All DOM the app touches is declared here. |
| `src/` | Application source, bundled by esbuild |
| `styles/` | Ordered CSS partials, concatenated into one stylesheet at build time |
| `templates/` | Bundled starter projects, copied verbatim into the build |
| `tools/` | Deno build, dev, serve, packaging and check scripts |
| `docs/` | Authoring guides and these development notes |
| `deno.json` | Tasks, import map and TypeScript configuration |
| `dist/` | Generated build output (not committed) |

## Reading order

- **[Architecture](architecture.md)** — the module map, the boot and command flows, and the invariants that hold the
  design together. Read this first.
- **[Build and test](build-and-test.md)** — every task, what the build actually does, and what each check covers.
- **[Conventions](conventions.md)** — the rules to follow when changing the code, and the ones that must not be broken.

## Related

- `docs/authoring/` — the author-facing documentation for the YAML and Lua surface. Much of what is in `src/` exists to
  implement that surface, so it is worth having open alongside this tree.
