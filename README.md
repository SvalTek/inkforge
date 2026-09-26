# Inkforge Adventure Studio

Inkforge is a browser studio for writing and playing text adventures. Describe the world in YAML, add behaviour with Lua, and run the scenario in the same tab. Projects can include images, audio, interactive canvas scenes, HUD elements, and tools.

[Open Inkforge](https://svaltek.github.io/inkforge/) · [Authoring guide](docs/authoring/README.md)

## Get started

1. Open Inkforge and switch to **Author**. The bundled **Lantern Below** scenario is ready to explore and edit.
2. Change a YAML or Lua file, then select **Run** to play the current project.
3. Use **Scenarios** to create another project or import and export `.inkforge` packs.

Projects are saved in this browser as you edit. A playthrough has its own **Save** and **Manage Saves** controls; it does not overwrite the authored project. Export a scenario pack or save file when you want a copy outside the browser.

## Run locally

Install [Deno 2.x](https://deno.com/) and run:

```sh
deno task dev
```

Open `http://localhost:4173/`. The development task builds the app, serves it, and rebuilds when source files change. `deno task build` creates a static site in `dist/` for hosting.

## Read more

- [Authoring](docs/authoring/README.md) — projects, YAML, Lua, assets, UI, and saves.
- [Architecture](Architecture.md) — how the current application fits together.
- [Development](docs/development/README.md) — build tasks, checks, and contribution conventions.

Inkforge runs as a client-side application; hosting the built site does not require an application server.
