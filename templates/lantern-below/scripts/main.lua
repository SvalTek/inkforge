local threshold = require("scripts/threshold")

GameUI.create({
  id = "focus",
  type = "meter",
  location = "hud",
  fields = {
    { id = "label", type = "text", value = "Focus" },
    { id = "value", type = "state", path = "focus" },
    { id = "max", type = "state", path = "focusMax" }
  }
})

local scene = GameCanvas.create({
  id = "entry_scene",
  accessibleLabel = "Stone entry",
  viewport = { width = 960, height = 720, fit = "contain" },
  background = "#17120f",
  nodes = {
    {
      id = "back_wall",
      type = "rect",
      x = 70, y = 54,
      width = 820, height = 612,
      radius = 8,
      fill = "#211a16",
      stroke = "#4e3c2d",
      lineWidth = 3
    },
    {
      id = "doorway",
      type = "path",
      x = 0, y = 0,
      points = {
        { x = 264, y = 610 },
        { x = 264, y = 292 },
        { x = 302, y = 202 },
        { x = 380, y = 150 },
        { x = 480, y = 132 },
        { x = 580, y = 150 },
        { x = 658, y = 202 },
        { x = 696, y = 292 },
        { x = 696, y = 610 }
      },
      closed = true,
      fill = "#0d0c0b",
      stroke = "#594331",
      lineWidth = 8
    },
    {
      id = "threshold",
      type = "line",
      points = {
        { x = 218, y = 610 },
        { x = 742, y = 610 }
      },
      stroke = "#77583b",
      lineWidth = 12
    },
    {
      id = "lantern_glow",
      type = "circle",
      x = 632, y = 476,
      radius = 105,
      fill = "#d8843d",
      opacity = 0.18,
      shadowColor = "#d8843d",
      shadowBlur = 48
    },
    {
      id = "lantern",
      type = "rect",
      x = 598, y = 430,
      width = 68, height = 104,
      radius = 8,
      fill = "#b87336",
      stroke = "#efbd72",
      lineWidth = 4,
      shadowColor = "#d8843d",
      shadowBlur = 20,
      cursor = "pointer",
      hit = { type = "rect", padding = 18 },
      events = {
        activate = { callback = "inspect_lantern" }
      }
    },
    {
      id = "flame",
      type = "circle",
      x = 632, y = 469,
      radius = 13,
      fill = "#ffd27a",
      shadowColor = "#ff9a3d",
      shadowBlur = 22
    },
    {
      id = "scene_label",
      type = "text",
      x = 94, y = 82,
      text = "STONE ENTRY",
      fontSize = 17,
      fontWeight = 600,
      fontFamily = "ui-monospace, monospace",
      fill = "#b79870"
    }
  }
})

local glow = scene:node("lantern_glow")
local flame = scene:node("flame")
local elapsed = 0

function inspect_lantern(event)
  GameOutput.add("The lantern's hood is warm. Its flame leans toward the passage.")
  glow:tween(
    { opacity = 0.34, scale = 1.12 },
    { duration = 0.18, yoyo = true, repeat_count = 1, easing = "ease_out_cubic" }
  )
end

function listen_at_threshold()
  threshold.listen()
end

GameUI.create({
  id = "listen",
  type = "button",
  location = "output",
  fields = {
    { id = "label", type = "text", value = "Listen at the threshold" }
  },
  events = {
    activate = { callback = "listen_at_threshold" }
  }
})

timers.setInterval(function()
  flame:tween(
    { scale = 1.16, opacity = 0.72 },
    { duration = 0.22, yoyo = true, repeat_count = 1, easing = "ease_in_out_sine" }
  )
end, 2400)

function Update(dt)
  elapsed = elapsed + dt
  glow:set({ opacity = 0.18 + math.sin(elapsed * 1.7) * 0.025 })
end

-- A global, not a local: authored `call: keeper.asked` is resolved against the
-- loaded globals at boot, and a local table would leave `_G.keeper` nil.
keeper = {}

function keeper.asked()
  local npc = GameNPCs.get("passage_keeper")
  if npc == nil then
    GameOutput.add("There is nobody here to ask.", "warning")
    return
  end
  -- Authored data comes from the definition and is a detached copy...
  GameOutput.add("Rowan grunts. \"" .. npc.definition.lamps .. " still burn. Some don't.\"")
  -- ...while the current values are ordinary state, in the same store `set:` and
  -- `npcSet:` write to. This is read before the action's `npcSet` runs.
  GameOutput.add("Rowan's trust is " .. tostring(GameState.get("npc.passage_keeper.trust")) .. ".")
end

function keeper.which_lamp()
  local npc = GameNPCs.get("passage_keeper")
  local lit = GameState.get("npc.passage_keeper.lampsLit") or 0
  GameOutput.add("\"The third one,\" Rowan says. \"You have lit " .. lit .. " of " .. npc.definition.lamps .. ".\"")
end
