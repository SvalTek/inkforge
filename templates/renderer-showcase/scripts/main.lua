local flat_scene
local iso_scene
local oblique_scene
local mixed_scene
local flat_glow
local iso_beacon
local oblique_needle
local elapsed = 0

local function hide_previews()
  game.ui.hide("showcase_flat")
  game.ui.hide("showcase_iso")
  game.ui.hide("showcase_oblique")
  game.ui.hide("showcase_mixed")
end

local function show_preview(id, label)
  hide_previews()
  game.ui.show(id)
  game.state.set("activePreview", id:gsub("showcase_", ""))
  game.output("Preview: " .. label)
end

function show_flat()
  show_preview("showcase_flat", "flat composition")
end

function show_iso()
  show_preview("showcase_iso", "isometric depth and elevation")
end

function show_oblique()
  show_preview("showcase_oblique", "oblique pseudo-3D machinery")
end

function show_mixed()
  show_preview("showcase_mixed", "projected world with screen-space VN layers")
end

function open_map()
  game.output("Map tool action dispatched to Lua.")
end

function hide_runtime_tool()
  game.tool.hide("lua_tool")
  game.output("Lua-registered tool hidden. Use the author restart to reset runtime state.")
end

function show_runtime_tool()
  game.tool.show("lua_tool")
  game.output("Lua-registered tool shown.")
end

function open_lua_panel()
  game.output("Lua-registered tool action dispatched.")
end

function remove_runtime_tool()
  game.tool.remove("lua_tool")
  game.output("Lua-registered tool removed.")
end

function disable_map_tool()
  game.tool.disable("map_tool")
  game.output("Map tool disabled.")
end

function enable_map_tool()
  game.tool.enable("map_tool")
  game.output("Map tool enabled.")
end

game.ui.create({
  id = "showcase_intro",
  type = "text",
  location = "output",
  fields = {
    { id = "text", type = "text", value = "RENDERER STAGE / FOUR COMPOSITIONS" }
  }
})

local function preview_button(id, label, callback)
  game.ui.create({
    id = id,
    type = "button",
    location = "output",
    fields = { { id = "label", type = "text", value = label } },
    events = { activate = { callback = callback } }
  })
end

preview_button("flat_button", "Flat / layered 2D", "show_flat")
preview_button("iso_button", "Isometric / depth", "show_iso")
preview_button("oblique_button", "Oblique / pseudo-3D", "show_oblique")
preview_button("mixed_button", "Mixed world + VN overlay", "show_mixed")

game.tool.register({
  id = "lua_tool",
  label = "Lua tool",
  icon = "⚙",
  action = "open_lua_panel"
})

flat_scene = game.canvas.create({
  id = "showcase_flat",
  accessibleLabel = "Flat layered composition preview",
  viewport = { width = 900, height = 600, fit = "contain" },
  background = "#111923",
  layers = {
    { id = "backdrop", order = 0, space = "screen" },
    { id = "art", order = 10, space = "screen" },
    { id = "foreground", order = 20, space = "screen" },
    { id = "caption", order = 30, space = "screen" }
  },
  nodes = {
    { id = "flat_panel", type = "rect", x = 42, y = 42, width = 816, height = 516, radius = 18,
      fill = "#172536", stroke = "#36516b", lineWidth = 3, layer = "backdrop" },
    { id = "flat_header", type = "text", x = 76, y = 72, text = "FLAT 2D / LAYERED COMPOSITION",
      fontSize = 20, fontWeight = 700, fontFamily = "ui-monospace, monospace", fill = "#d8ecff", layer = "caption" },
    { id = "flat_subtitle", type = "text", x = 76, y = 103, text = "explicit order • ordinary screen coordinates • familiar canvas primitives",
      fontSize = 14, fontFamily = "ui-monospace, monospace", fill = "#7fa1bd", layer = "caption" },
    { id = "flat_horizon", type = "rect", x = 76, y = 170, width = 748, height = 270, radius = 14,
      fill = "#203b4d", layer = "art" },
    { id = "flat_moon", type = "circle", x = 690, y = 238, radius = 62,
      fill = "#f4d9a3", shadowColor = "#f4d9a3", shadowBlur = 34, layer = "art" },
    { id = "flat_moon_cut", type = "circle", x = 712, y = 218, radius = 62, fill = "#203b4d", layer = "foreground" },
    { id = "flat_ridge", type = "path", points = { { x = 76, y = 440 }, { x = 220, y = 318 }, { x = 340, y = 418 }, { x = 520, y = 282 }, { x = 824, y = 440 } },
      closed = true, fill = "#15252f", stroke = "#4c7180", lineWidth = 2, layer = "foreground" },
    { id = "flat_glow", type = "circle", x = 332, y = 360, radius = 74, fill = "#73e0c1", opacity = 0.13,
      shadowColor = "#73e0c1", shadowBlur = 34, layer = "art" },
    { id = "flat_core", type = "circle", x = 332, y = 360, radius = 30, fill = "#73e0c1", stroke = "#d5fff1", lineWidth = 3,
      cursor = "pointer", hit = { type = "circle", padding = 12 }, layer = "foreground",
      events = { activate = { callback = "inspect_flat" } } },
    { id = "flat_hint", type = "text", x = 286, y = 414, text = "click the core", fontSize = 13, fill = "#b4dccc", layer = "caption" },
    { id = "flat_footer", type = "text", x = 76, y = 510, text = "The viewport remains the stage; layers decide what composes it.",
      fontSize = 15, fill = "#9ab6c8", layer = "caption" }
  }
})
flat_glow = flat_scene:node("flat_glow")

iso_scene = game.canvas.create({
  id = "showcase_iso",
  accessibleLabel = "Isometric depth and elevation preview",
  viewport = { width = 900, height = 600, fit = "contain",
    projection = { type = "isometric", originX = 450, originY = 82, tileWidth = 58, tileHeight = 30, elevation = 30 } },
  background = "#171526",
  layers = {
    { id = "sky", order = 0, space = "screen" },
    { id = "world", order = 10, space = "world", sort = "depth" },
    { id = "world_effects", order = 20, space = "world", sort = "depth" },
    { id = "iso_ui", order = 30, space = "screen" }
  },
  nodes = {
    { id = "iso_sky", type = "rect", x = 34, y = 34, width = 832, height = 532, radius = 18, fill = "#211e3b", stroke = "#514d83", lineWidth = 3, layer = "sky", space = "screen" },
    { id = "iso_title", type = "text", x = 68, y = 66, text = "ISOMETRIC / DEPTH-SORTED WORLD", fontSize = 20, fontWeight = 700, fontFamily = "ui-monospace, monospace", fill = "#eee9ff", layer = "iso_ui", space = "screen" },
    { id = "iso_grid", type = "rect", x = 0, y = 0, width = 14, height = 10, fill = "#314d59", stroke = "#69919a", lineWidth = 2, layer = "world" },
    { id = "iso_tile_a", type = "rect", x = 3, y = 3, width = 2, height = 2, fill = "#386b69", stroke = "#79c4ad", lineWidth = 2, layer = "world", z = 0 },
    { id = "iso_tile_b", type = "rect", x = 7, y = 2, width = 2, height = 2, fill = "#755d83", stroke = "#c79bd1", lineWidth = 2, layer = "world", z = 1, depth = 8 },
    { id = "iso_tower_low", type = "rect", x = 8, y = 5, width = 2, height = 2, fill = "#9b7255", stroke = "#f0c28c", lineWidth = 2, elevation = 1, layer = "world" },
    { id = "iso_tower_high", type = "rect", x = 8, y = 5, width = 2, height = 2, fill = "#d28b59", stroke = "#ffe0a9", lineWidth = 2, elevation = 3, layer = "world" },
    { id = "iso_beacon", type = "marker", x = 5, y = 5, radius = 0.42, fill = "#f7d36f", stroke = "#fff7c7", lineWidth = 0.08, elevation = 2, layer = "world_effects",
      cursor = "pointer", hit = { type = "circle", padding = 0.28 }, events = { activate = { callback = "inspect_iso" } } },
    { id = "iso_badge", type = "rect", x = 58, y = 112, width = 300, height = 54, radius = 10, fill = "#19182b", stroke = "#7467a7", lineWidth = 2, layer = "iso_ui", space = "screen" },
    { id = "iso_badge_text", type = "text", x = 78, y = 129, text = "WORLD X/Y + ELEVATION", fontSize = 15, fontWeight = 700, fontFamily = "ui-monospace, monospace", fill = "#d9cdf7", layer = "iso_ui", space = "screen" },
    { id = "iso_footer", type = "text", x = 68, y = 528, text = "Depth sorting keeps nearer tiles and elevated objects in front.", fontSize = 15, fill = "#aaa3c9", layer = "iso_ui", space = "screen" }
  }
})
iso_beacon = iso_scene:node("iso_beacon")

oblique_scene = game.canvas.create({
  id = "showcase_oblique",
  accessibleLabel = "Oblique pseudo 3D machinery preview",
  viewport = { width = 900, height = 600, fit = "contain",
    projection = { type = "oblique", originX = -150, originY = 100, elevation = 30, skew = 0.48 } },
  background = "#201713",
  layers = {
    { id = "machine_back", order = 0, space = "screen" },
    { id = "machine_world", order = 10, space = "world", sort = "depth" },
    { id = "machine_front", order = 20, space = "world", sort = "depth" },
    { id = "machine_ui", order = 30, space = "screen" }
  },
  nodes = {
    { id = "machine_panel", type = "rect", x = 34, y = 34, width = 832, height = 532, radius = 18, fill = "#2c1d18", stroke = "#76513b", lineWidth = 3, layer = "machine_back", space = "screen" },
    { id = "machine_title", type = "text", x = 68, y = 68, text = "OBLIQUE / PSEUDO-3D MACHINERY", fontSize = 20, fontWeight = 700, fontFamily = "ui-monospace, monospace", fill = "#ffe1b5", layer = "machine_ui", space = "screen" },
    { id = "machine_floor", type = "rect", x = 82, y = 360, width = 700, height = 120, fill = "#4b2b20", stroke = "#bd7650", lineWidth = 4, layer = "machine_world" },
    { id = "machine_column", type = "rect", x = 170, y = 168, width = 90, height = 290, fill = "#71442e", stroke = "#e0a06a", lineWidth = 4, elevation = 2, layer = "machine_world" },
    { id = "machine_column_2", type = "rect", x = 632, y = 196, width = 90, height = 262, fill = "#653b2d", stroke = "#c78960", lineWidth = 4, elevation = 1, layer = "machine_world" },
    { id = "machine_rail", type = "line", points = { { x = 150, y = 318 }, { x = 735, y = 318 } }, stroke = "#f2c27f", lineWidth = 12, layer = "machine_front" },
    { id = "machine_needle", type = "rect", x = 420, y = 215, width = 30, height = 148, radius = 8, fill = "#f2b15e", stroke = "#ffe7ba", lineWidth = 3, elevation = 4, layer = "machine_front" },
    { id = "machine_gear", type = "circle", x = 420, y = 390, radius = 58, fill = "#c56f43", stroke = "#ffd49a", lineWidth = 6, elevation = 5, layer = "machine_front", cursor = "pointer", events = { activate = { callback = "inspect_oblique" } } },
    { id = "machine_hub", type = "circle", x = 420, y = 390, radius = 18, fill = "#3b211c", stroke = "#ffe1ad", lineWidth = 4, elevation = 6, layer = "machine_front" },
    { id = "machine_badge", type = "rect", x = 68, y = 112, width = 270, height = 50, radius = 10, fill = "#231915", stroke = "#906043", lineWidth = 2, layer = "machine_ui", space = "screen" },
    { id = "machine_badge_text", type = "text", x = 88, y = 129, text = "SKEW + ELEVATION", fontSize = 15, fontWeight = 700, fontFamily = "ui-monospace, monospace", fill = "#efbf84", layer = "machine_ui", space = "screen" },
    { id = "machine_footer", type = "text", x = 68, y = 528, text = "A drawing can imply volume without becoming a modern 3D scene.", fontSize = 15, fill = "#c79e7d", layer = "machine_ui", space = "screen" }
  }
})
oblique_needle = oblique_scene:node("machine_needle")

mixed_scene = game.canvas.create({
  id = "showcase_mixed",
  accessibleLabel = "Mixed projected world and VN overlay preview",
  viewport = { width = 900, height = 600, fit = "contain",
    projection = { type = "isometric", originX = 390, originY = 92, tileWidth = 54, tileHeight = 28, elevation = 26 } },
  background = "#151c25",
  layers = {
    { id = "mixed_world", order = 0, space = "world", sort = "depth" },
    { id = "mixed_effects", order = 10, space = "world", sort = "depth" },
    { id = "vn_backdrop", order = 20, space = "screen" },
    { id = "vn_characters", order = 30, space = "screen" },
    { id = "vn_foreground", order = 40, space = "screen" }
  },
  nodes = {
    { id = "mixed_ground", type = "rect", x = 0, y = 0, width = 13, height = 10, fill = "#28434a", stroke = "#557e7c", lineWidth = 2, layer = "mixed_world" },
    { id = "mixed_house", type = "rect", x = 5, y = 3, width = 3, height = 2, fill = "#7c5261", stroke = "#d5989a", lineWidth = 2, elevation = 2, layer = "mixed_world" },
    { id = "mixed_tree", type = "circle", x = 2, y = 6, radius = 0.8, fill = "#4f916f", stroke = "#a7e0ad", lineWidth = 0.1, elevation = 1, layer = "mixed_effects" },
    { id = "mixed_point", type = "marker", x = 8, y = 6, radius = 0.42, fill = "#f3c56b", stroke = "#fff4c5", lineWidth = 0.08, elevation = 1, layer = "mixed_effects", cursor = "pointer", events = { activate = { callback = "inspect_mixed" } } },
    { id = "vn_strip", type = "rect", x = 30, y = 30, width = 840, height = 104, radius = 14, fill = "#17202b", opacity = 0.93, stroke = "#5e7892", lineWidth = 2, layer = "vn_backdrop", space = "screen" },
    { id = "vn_kicker", type = "text", x = 58, y = 54, text = "MIXED STAGE / WORLD + SCREEN", fontSize = 15, fontWeight = 700, fontFamily = "ui-monospace, monospace", fill = "#c8d9eb", layer = "vn_foreground", space = "screen" },
    { id = "vn_line", type = "text", x = 58, y = 84, text = "The world can stay projected while authored portraits and captions stay upright.", fontSize = 15, fill = "#91adc7", layer = "vn_foreground", space = "screen" },
    { id = "vn_portrait", type = "circle", x = 770, y = 82, radius = 34, fill = "#d68b72", stroke = "#ffe0b1", lineWidth = 3, layer = "vn_characters", space = "screen" },
    { id = "vn_portrait_eye", type = "circle", x = 782, y = 75, radius = 5, fill = "#342735", layer = "vn_characters", space = "screen" },
    { id = "vn_card", type = "rect", x = 30, y = 456, width = 840, height = 104, radius = 14, fill = "#17202b", opacity = 0.95, stroke = "#5e7892", lineWidth = 2, layer = "vn_foreground", space = "screen" },
    { id = "vn_card_text", type = "text", x = 58, y = 480, text = "Click the gold marker in the projected world.", fontSize = 16, fontWeight = 700, fill = "#d7e7f5", layer = "vn_foreground", space = "screen" },
    { id = "vn_card_hint", type = "text", x = 58, y = 510, text = "Its Lua event receives worldX/worldY from inverse projection.", fontSize = 14, fill = "#91adc7", layer = "vn_foreground", space = "screen" }
  }
})

function inspect_flat()
  game.output("Flat scene clicked: the core is ordinary screen-space geometry inside ordered layers.")
  flat_glow:tween({ opacity = 0.38, scale = 1.25 }, { duration = 0.24, yoyo = true, repeat_count = 1, easing = "ease_out_cubic" })
end

function inspect_iso(event)
  game.output("Isometric marker at world " .. math.floor(event.worldX + 0.5) .. "," .. math.floor(event.worldY + 0.5) .. ".")
  iso_beacon:tween({ scale = 1.45, opacity = 0.55 }, { duration = 0.2, yoyo = true, repeat_count = 1, easing = "ease_out_cubic" })
end

function inspect_oblique()
  game.output("Oblique gear clicked: its shape is still 2D canvas geometry, just skewed and elevated.")
  oblique_needle:tween({ rotation = 24 }, { duration = 0.35, yoyo = true, repeat_count = 1, easing = "ease_in_out_sine" })
end

function inspect_mixed(event)
  game.output("Mixed scene marker: projected world " .. math.floor(event.worldX + 0.5) .. "," .. math.floor(event.worldY + 0.5) .. " beneath a screen-space VN stage.")
end

hide_previews()
game.ui.show("showcase_flat")

game.timer.every(2.8, function()
  if flat_glow then flat_glow:tween({ scale = 1.12, opacity = 0.2 }, { duration = 0.28, yoyo = true, repeat_count = 1, easing = "ease_in_out_sine" }) end
end)

game.timer.every(3.4, function()
  elapsed = elapsed + 3.4
  if iso_beacon then iso_beacon:set({ opacity = 0.74 + math.sin(elapsed) * 0.2 }) end
end)

function update(dt)
  elapsed = elapsed + dt
end
