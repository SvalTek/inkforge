# Audio

Sound is a project asset played through a small manager. Add the file with the **+** button in the Author view, then
refer to it by path.

Supported formats are `.mp3`, `.ogg` and `.wav`. Anything else is refused on upload.

## From Lua

```lua
function OnInit()
  GameAudio.play("assets/theme.mp3", { id = "theme", loop = true, volume = 0.5 })
end
```

| Method | Arguments | Notes |
|---|---|---|
| `play` | `path`, `options` | Returns the handle id |
| `stop` | `id` | Pauses, rewinds and releases the file |
| `pause` | `id` | Pauses, keeping position |
| `resume` | `id` | Resumes a paused sound |
| `setVolume` | `id`, `0..1` | Values outside the range are clamped |
| `setLoop` | `id`, `boolean` | |
| `stopAll` | — | Stops every sound |

`options` is a table with any of:

| Key | Meaning |
|---|---|
| `id` | The handle to address this sound by later |
| `loop` | Play forever until stopped |
| `volume` | `0` to `1`, default `1` |

If you omit `id`, one is generated (`sound-1`, `sound-2`, …) and returned from `play`, so keep the result if you intend
to control the sound later:

```lua
local ambience = GameAudio.play("assets/wind.ogg", { loop = true })
-- later
GameAudio.stop(ambience)
```

Playing a path again **under the same id** stops the previous sound first, so `play("assets/step.wav", { id = "step" })`
on every step replaces the last footstep rather than stacking twelve of them. That is what makes a fixed id the right
choice for repeated one-shots.

## From YAML

A UI element activation can start a sound directly, with no Lua involved:

```yaml
- id: themeButton
  type: button
  location: sidebar
  fields:
    - { id: label, type: text, value: "Play theme" }
  events:
    activate:
      type: audio.play
      asset: assets/theme.mp3
      id: theme
      loop: true
      volume: 0.5
```

The keys are the same ones `GameAudio.play` takes, spelled `asset` instead of `path`.

## Autoplay

Browsers block audio that starts without a user gesture. Inkforge reports this rather than failing silently:

```
Audio playback was blocked: assets/theme.mp3
```

The reliable pattern is to start audio from something the player clicked — a UI activation, a `call:` from an action's
`then`, or an `emit:` that Lua handles in response to a pointer event. Starting a sound in `OnInit` may be blocked
until the player interacts with the page.

Two other failures are reported the same way:

- `Audio asset not found or unsupported: <path>` — the path is not in the project, or the extension is not one of the
  supported three.
- `Audio could not be loaded: <path>` — the file is present but could not be decoded.

## Lifetime

Sounds live for the run. Restarting the scenario tears the audio manager down and stops everything, so a track started
in `OnInit` is restarted by the next `OnInit` rather than continuing underneath it.
