# Repository Guidelines

## Project Structure & Module Organization

`src/` contains the browser application: `app/` boots it, `engine/` runs scenarios, `yaml/` loads and validates authored
data, `lua/` connects scripts, and `ui/`, `editor/`, `canvas/`, and `audio/` own their respective surfaces. `tools/`
holds Deno build, packaging, and check scripts. `styles/` contains numbered CSS partials concatenated in filename order.
`templates/` holds starter projects and their `.inkforge` packs. `docs/` is a separate VitePress site; `dist/` is
generated output.

## Build, Test, and Development Commands

Use Deno 2.x from the repository root. The docs site also needs Node.js 22+ and `npm ci --prefix docs`.

- `deno task dev`: build, serve at `http://localhost:4173/`, and rebuild on source changes.
- `deno task build`: create the static site in `dist/`.
- `deno task check` and `deno task check:tools`: type-check the app and tool scripts separately.
- `deno task fmt` and `deno task lint`: format and lint Deno sources.
- `deno task docs:dev` / `deno task docs:build`: develop or build the documentation site.
- `deno task pack -- templates/lantern-below`: regenerate a project pack after changing its folder; update its package
  version when content changes.

## Coding Style & Naming Conventions

Follow `deno fmt` for TypeScript (two-space indentation, 120-character line width) and keep imports explicit with `.ts`
extensions. Use camelCase for functions and variables, PascalCase for types and classes. Keep CSS partials readable and
numerically ordered; `deno fmt` intentionally excludes `styles/`, `templates/`, and `docs/`. Add authored YAML keys to
load-time validation alongside their runtime handling. See `docs/development/conventions.md` for rendering, Lua, and
boot invariants.

## Testing Guidelines

Checks are task scripts under `tools/`, not a `Deno.test` suite. Run `deno task smoke` for browser behavior,
`deno task check:authoring` for authored UI, `deno task check:renderer` for canvas math, and `deno task check:pack` for
pack precedence and template drift. Add behavior-focused assertions near the affected check; browser checks should wait
for `document.body.dataset.projectReady` instead of fixed delays. No coverage threshold is configured.

## Documentation Maintenance

Every agent making a code, UI, configuration, or workflow change must review `README.md`, `Architecture.md`, and the
relevant pages under `docs/` against the changed behavior. Update affected documentation in the same change, including
`docs/authoring/` for author-facing behavior and `docs/development/` for implementation, build, and test changes. Do not
defer documentation repairs to a later pull request. If a file needs no edit, state why in the pull request.

Keep `README.md` a concise public introduction with a path to the deeper guides. Keep `Architecture.md` an accurate
description of the current system, based on source rather than historical plans or check-count snapshots. Put detailed
developer procedures in `docs/development/`, and verify commands, paths, and links before publishing them. Do not add
local-only tooling or private workspace details to the public introduction.

## Commit & Pull Request Guidelines

Recent commits commonly use `feat(scope): ...`, `fix(scope): ...`, or `chore(scope): ...`; use a short imperative
subject and a relevant scope such as `ui`, `build`, or `docs`. In pull requests, describe the behavior changed, list the
checks run, link the related issue when one exists, and include screenshots for visible UI changes. Update
documentation as required above and list those updates in the pull request.
