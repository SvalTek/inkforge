# Canvas

Scenes are drawn with the browser's 2D canvas. They are the layer for anything the text cannot carry: a map, a room
illustration, a HUD dial, an interactive prop.

```lua
local scene = GameCanvas.create({
  id = "entry_scene",
  accessibleLabel = "Stone entry",
  viewport = { width = 960, height = 720, fit = "contain" },
  background = "#17120f",
  nodes = {
    {
      id = "lantern",
      type = "rect",
      x = 598, y = 430,
      width = 68, height = 104,
      radius = 8,
      fill = "#b87336",
      stroke = "#efbd72",
      lineWidth = 4,
      cursor = "pointer",
      hit = { type = "rect", padding = 18 },
      events = { activate = { callback = "inspect_lantern" } }
    }
  }
})
```

Creating a scene puts a canvas on screen automatically, in the **canvas** region of the play view. Removing it takes the
canvas away again. Nothing else is needed to make it visible.

## Coordinates

A scene draws into a **virtual viewport** of its own — `viewport.width` × `viewport.height`, default `960 × 720`. Node
coordinates are in that space, not in pixels of the element, so a scene draws identically whatever its on-screen size.

`viewport.fit` decides how the virtual space is mapped onto the element:

| `fit` | Behaviour |
|---|---|
| `contain` | Default. Scales to fit inside, letterboxing the remainder |
| `cover` | Scales to fill, cropping the overflow |
| `stretch` | Scales each axis independently, distorting |

The remainder is centred, and content outside the virtual viewport is clipped. Pointer input outside it is ignored — a
scene's canvas does not respond to a click in the letterbox area.

## Projection

By default a scene is **flat**: node coordinates are screen coordinates. Setting a projection switches the scene to a
pseudo-3D interpretation.

```lua
viewport = {
  width = 900, height = 600, fit = "contain",
  projection = {
    type = "isometric",
    originX = 450, originY = 82,
    tileWidth = 58, tileHeight = 30,
    elevation = 30
  }
}
```

| `type` | Projects a world point `(x, y, z)` to screen |
|---|---|
| `flat` | `(originX + x, originY + y)` |
| `isometric` | `(originX + (x−y)·tileWidth/2, originY + (x+y)·tileHeight/2 − z·elevation)` |
| `oblique` | `(originX + x + y·skew, originY + y − z·elevation)` |

| Parameter | Default | Meaning |
|---|---|---|
| `originX`, `originY` | `0`, `0` | Where world `(0,0)` lands in the virtual viewport |
| `tileWidth`, `tileHeight` | `64`, `32` | Isometric tile footprint |
| `elevation` | `32` | Vertical offset per unit of height |
| `skew` | `0.5` | Oblique horizontal shift per unit of depth |

`origin` is accepted as a `{x, y}` pair in place of `originX`/`originY`. An unknown `type` is a load-time error rather
than a silent fallback.

## Spaces

Every node is drawn in either **world** space (projected, so it lies on the ground plane or stands on it) or **screen**
space (drawn straight to the viewport, never projected).

The default depends on the scene: a flat scene is `screen`, a projected scene is `world`. A layer or a node can override
it:

```lua
layers = {
  { id = "world", order = 10, space = "world", sort = "depth" },
  { id = "labels", order = 20, space = "screen" }
}
```

Resolution is per node, in this order: `node.space`, then its layer's `space`, then the scene default. This is what lets
a projected scene keep captions, dialogue boxes and portraits upright while the world behind them is projected.

## Layers

A layer groups nodes and gives them a draw order.

| Key | Purpose |
|---|---|
| `id` | Referenced by `node.layer` |
| `order` | Draw order; higher draws later, so higher is in front. Defaults to position in the list |
| `space` | Default space for nodes in this layer |
| `sort` | `"depth"` sorts the layer's nodes back-to-front before drawing |

A node with no `layer` draws in whatever inherited context it was added in. Nodes are otherwise drawn in declaration
order.

With `sort = "depth"`, a node with a **larger** depth value is drawn first — that is, underneath. Depth defaults to the
projection's own depth for the node's position, and can be overridden per node:

```lua
{ id = "tile_b", type = "rect", x = 7, y = 2, width = 2, height = 2, layer = "world", z = 1, depth = 8 }
```

If a projected scene's overlap looks wrong, an explicit `depth` on the nodes involved is the fix.

## Nodes

```lua
{
  id = "lantern",           -- required, unique within the scene
  type = "rect",            -- required
  x = 598, y = 430,         -- default 0, 0.
  visible = true,           -- default true
  opacity = 1,              -- default 1, multiplied down through children
  rotation = 0,             -- degrees, default 0
  scale = 1,                -- default 1; scaleX/scaleY override per axis
  interactive = true,       -- default true; false makes it transparent to input
  layer = "world",          -- layer id
  space = "world",          -- "world" | "screen"
  elevation = 2,            -- height above the ground plane; `z` takes precedence over it
  depth = 8,                -- explicit sort key (see Layers)
  ...
}
```

### Shared appearance

| Field | Notes |
|---|---|
| `fill` | Fill colour. **A shape with no `fill` is not filled** |
| `stroke` | Outline colour. A shape with no `stroke` is not stroked |
| `lineWidth` | Outline width. `strokeWidth` is accepted as an alias. Default `1` |
| `lineCap`, `lineJoin` | Default `"round"` both |
| `blend` | Canvas composite operation, e.g. `"lighter"`, `"multiply"` |
| `shadowColor`, `shadowBlur`, `shadowOffsetX`, `shadowOffsetY` | Canvas shadow. `shadowBlur` defaults to `0` |
| `originX`, `originY` | A fraction of the node's own width/height, moving the local origin. Default `0`, `0` (top-left for a rect) |
| `cursor` | CSS cursor while hovered, e.g. `"pointer"` |
| `hit` | Custom hit-testing area (see [Input](#input)) |

### Types

| `type` | Draws | Uses |
|---|---|---|
| `rect` | A rounded rectangle | `width`, `height`, `radius` |
| `circle` | A circle centred on the node's position | `radius` |
| `marker` | Identical to `circle` | `radius` |
| `line` | A polyline through `points` | `points`, `closed`, `lineWidth` |
| `path` | A polygon through `points`, **always closed** | `points` |
| `text` | Text | `text`, `fontSize`, `fontFamily`, `fontWeight`, `align`, `baseline`, `maxWidth`, `fill` |
| `image` | An image | `asset`, `width`, `height` |
| `sprite` | A frame from a sprite sheet | `asset`, `frame = {x, y, width, height}`, `width`, `height` |

Things worth knowing:

- **`circle` centres on `(x, y)`** — it is not anchored top-left like a `rect`. Its `radius` is in the node's own units.
- **`path` always closes**; `line` closes only when `closed = true`. A closed path with a `fill` is a filled polygon.
- **A `text` node draws nothing without a `fill`.** It is not defaulted to black; `fill` is the text colour.
- `fontSize` defaults to `24`, `fontFamily` to `"Georgia, serif"`, `fontWeight` to `400`, `align` to `"left"` and
  `baseline` to `"top"`. Set `fontFamily` to `"ui-monospace, monospace"` for the monospace look the templates use.
- An unrecognised `type` draws nothing, but its `children` still render — so an unknown container type is quietly empty
  rather than fatal.

### Points

`points` accepts any of these per point, so a script can pass either shape:

```lua
points = { { x = 218, y = 610 }, { x = 742, y = 610 } }   -- records
points = { { 218, 610 }, { 742, 610 } }                   -- pairs
```

### Children

A node may carry `children`. They are drawn relative to their parent's transform, inherit its opacity multiplicatively,
and inherit its layer unless they name their own. This is how a grouped prop moves as one.

## Input

A node receives pointer events when it has at least one event bound, is not `interactive = false`, and its effective
opacity is above zero. Only the **topmost** node under the pointer gets the event.

| Event | When |
|---|---|
| `pointer_enter` | The pointer moves onto the node |
| `pointer_leave` | The pointer moves off it |
| `pointer_down` | Pointer pressed on the node |
| `pointer_up` | Pointer released over the node |
| `drag_start` | Pressed on the node (same moment as `pointer_down`) |
| `drag` | Pointer moved while still pressed on that node |
| `drag_end` | Pointer released (same moment as `pointer_up`) |
| `activate` | Released over the node — the click/tap event |

Bind in the scene spec, or later with `handle:on`:

```lua
events = { activate = { callback = "inspect_lantern" } }
events = { activate = "inspect_lantern" }   -- string form, also valid
```

The callback is a **function name**, resolved when the event fires, so the function may be defined later in the file — or
it may be a closure passed directly to `handle:on`.

### The payload

Every callback receives one table:

| Key | |
|---|---|
| `sceneId`, `nodeId`, `type` | What fired |
| `x`, `y` | Virtual viewport coordinates |
| `worldX`, `worldY`, `worldZ` | Ground-plane coordinates from inverse projection. `worldZ` is always `0` |
| `localX`, `localY` | Coordinates inside the node's own transformed space |
| `button`, `pointerType`, `altKey`, `ctrlKey`, `shiftKey` | Straight from the pointer event |

`localX`/`localY` are what you want for "which part of this node was hit"; `worldX`/`worldY` are what you want for "where
on the map".

### Hit areas

By default a node's hit area is its own geometry. `hit` overrides it:

```lua
hit = { type = "circle", padding = 12 }
hit = { type = "rect", width = 80, height = 80, padding = 6 }
hit = { type = "line", tolerance = 8 }
```

`type` defaults to the node's own type. `padding` grows the area outward, which is how you make a small visual easier to
click. `width`, `height`, `x`, `y`, `radius`, `points` and `tolerance` override the corresponding geometry.

A `rect` node's hit area defaults to a plain rectangle, so a heavily rounded rect is still hit in its corners unless you
give it a `circle` hit or a smaller `width`/`height`.

## Handles

`GameCanvas.create` returns a scene handle; `scene:add(node)` returns a node handle. A handle is a live reference to
something already on the host — it is not a copy you can edit locally.

```lua
local scene = GameCanvas.create({ ... })
local lantern = scene:add({ id = "lantern", type = "rect", ... })
local glow = scene:node("lantern_glow")           -- handle to an existing node
local other = GameCanvas.node("entry_scene", "flame")
```

| Scene handle | |
|---|---|
| `add(node)` | Add a node; returns its handle |
| `node(id)` | Handle to an existing node |
| `clear()` | Remove every node |
| `remove()` | Remove the scene, and its canvas from the screen |

| Node handle | |
|---|---|
| `set(values)` | Merge a table of fields onto the node |
| `translate(dx, dy)` | Move by an offset |
| `move_to(x, y)` | Move to an absolute position |
| `rotate_to(deg)`, `rotate_by(deg)` | Absolute / relative rotation |
| `scale_to(s)`, `set_opacity(o)` | |
| `show()`, `hide()` | Sets `visible` |
| `x()`, `y()`, `is_visible()` | Read the node's values (see the note below) |
| `set_interactive(enabled)` | Toggle whether it takes input |
| `on(event, callback)`, `off(event)` | Bind or unbind an event |
| `tween(values, options)` | Animate to values over time |
| `animate(keyframes, options)` | Animate through keyframes |
| `remove()` | Remove the node |

Every method except the readers, `remove()`, `tween` and `animate` returns the node handle, so calls chain:

```lua
lantern:show():move_to(600, 400):set_opacity(0.8)
```

`tween` and `animate` return an **animation** handle instead, so they end a chain rather than continue one:

```lua
local animation = lantern:tween({ x = 600 }, { duration = 0.4 })
animation:pause()
```

### A handle's local mirror

`x()`, `y()`, `is_visible()` and the relative verbs read a **local mirror** of the node's values that the handle keeps,
rather than asking the host. That mirror is seeded from the node table passed to `scene:add`, and is empty for a handle
obtained from `scene:node(...)` or `GameCanvas.node(...)`.

Two consequences:

- `scene:node("x"):rotate_by(15)` rotates from `0`, not from the node's current rotation, because the mirror does not
  know it.
- `scene:node("x"):x()` returns `0` until the handle has set something.

`set`, `translate`, `move_to` and the other mutators update the mirror as they go, so a handle created by `scene:add` and
driven through its own methods behaves as you would expect. For absolute values, prefer `set` — the host is always
authoritative for what is actually drawn.

## Animations

```lua
local animation = glow:tween(
  { opacity = 0.34, scale = 1.12 },
  { duration = 0.18, yoyo = true, repeat_count = 1, easing = "ease_out_cubic" }
)

animation:pause()
animation:resume()
animation:cancel()
animation:finish()     -- jump to the end value, then stop
```

| Option | Default | Meaning |
|---|---|---|
| `duration` | `0.3` (tween), `1` (keyframes) | Seconds |
| `easing` | `"linear"` | One of the names below |
| `repeat_count` | `0` | Extra repeats after the first. Negative repeats forever |
| `yoyo` | `false` | Reverse direction on each repeat |

Available easings: `linear`, `ease_in_sine`, `ease_out_sine`, `ease_in_out_sine`, `ease_in_cubic`, `ease_out_cubic`,
`ease_in_out_cubic`. An unknown name falls back to `linear`.

### Only numbers interpolate

This is the single most important thing to know about animation. A tween blends values that are numbers on both sides.
Anything else — a colour, a string, a boolean — **switches to the target value at the very end** of the tween, and
switches back at the start of a reversed leg.

So these animate smoothly:

```lua
glow:tween({ opacity = 0.4, scale = 1.2, rotation = 30, x = 400 }, { duration = 0.3 })
```

And these do not — they will appear to do nothing until the tween completes:

```lua
glow:tween({ fill = "#ff0000" }, { duration = 0.3 })   -- no colour blending
glow:tween({ visible = false }, { duration = 0.3 })    -- hides at the end, not gradually
```

To fade something out, tween its `opacity`. To change colour, set it and tween a second overlay node's opacity on top.

### Keyframes

```lua
local drone = scene:node("drone")
drone:animate(
  { { at = 0, x = 100 }, { at = 0.5, x = 400, y = 200 }, { at = 1, x = 100, y = 100 } },
  { duration = 2.4, repeat_count = -1, easing = "ease_in_out_sine" }
)
```

`at` is progress through the tween, `0` to `1`. Frames are sorted by `at`, so they may be written in any order. Keys
present in a frame are interpolated between that frame and the next.

## Frames and cost

The render loop is driven by animation. A frame is requested when something changes, and the loop keeps rescheduling
itself only while at least one animation is running and unpaused.

That means a scene with no running animation **costs no frames at all**, and drawing happens on demand. A scene with a
looping tween runs continuously — which is correct, but worth knowing, since a permanently repeating tween is a
permanently animating scene. Prefer a finite tween (`repeat_count = 1`) plus a timer for occasional motion, which is
what both templates do: a `timers.setInterval` fires a short yoyo tween every few seconds.

Two other things that cost a frame: a canvas command from Lua (which redraws and reschedules), and an image finishing
its load.

## Images

```lua
{ id = "portrait", type = "image", x = 40, y = 40, width = 180, height = 180, asset = "assets/portrait.png" }
```

`asset` is a project path, resolved the same way as every other asset reference. Images load asynchronously; a node
whose image has not arrived yet draws nothing, and a frame is scheduled when it loads. A file that fails to load is
reported as `Asset not found: <path>`.

For a sprite sheet, use `type = "sprite"` with a `frame` rectangle.

## Device pixel ratio

The canvas backing store is sized to the element's box multiplied by the device pixel ratio, **capped at 2**. On a 3x
display a scene therefore renders at 2x, not 1x — sharp enough for the shapes here, and far cheaper than 3x.

A resize of the host redraws the scene, so a responsive layout needs nothing from the author.

## Scenes and the render tree

A scene's canvas is a UI element like any other. Creating a scene adds one to the `canvas` region, which is why it
appears without any further step, and `scene:remove()` takes it away again. Its position among the canvas-region elements
is what decides which scene sits above another, and a scene's canvas survives a repaint with its pointer state intact.

A scene whose element is hidden with `GameUI.hide` stops being drawn, but remains defined — `GameUI.show` brings it back
with its nodes intact.
