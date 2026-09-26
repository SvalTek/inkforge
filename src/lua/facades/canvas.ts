/**
 * The `GameCanvas` namespace and its support code.
 *
 * This is the one host namespace that stays Lua rather than becoming a
 * `LuaClass`: its handles are created per node with closures and carry fluent
 * chaining, which a fixed set of JS methods cannot express. The transport is a
 * single bound JS function (`__canvas_command`).
 *
 * Node event callbacks are held here as plain Lua closures, keyed by
 * scene/node/event. Only a marker for "this event is bound" crosses to JS,
 * because the host still needs to know which events to dispatch; the callback
 * itself never leaves Lua.
 */
export const LUA_CANVAS_SUPPORT = String.raw`local node_events={}
local animation_serial=0
local function node_event_key(scene_id,node_id,event_name)
  return scene_id..'\1'..node_id..'\1'..event_name
end
-- A binding is either a closure or the name of a global function. Names are
-- resolved when the event fires, so a handler may be defined after the node
-- that binds it.
local function bind_node_event(scene_id,node_id,event_name,callback)
  local kind=type(callback)
  if kind~='function' and kind~='string' then return end
  node_events[node_event_key(scene_id,node_id,event_name)]=callback
end
local function unbind_node_event(scene_id,node_id,event_name)
  node_events[node_event_key(scene_id,node_id,event_name)]=nil
end
local function resolve_node_event(callback)
  if type(callback)=='string' then return _G[callback] end
  return callback
end

local function prepare_events(scene_id,node_id,events)
  if type(events)~='table' then return nil end
  local prepared={}
  for name,binding in pairs(events) do
    local callback=binding
    local options=nil
    if type(binding)=='table' then
      callback=binding.callback
      for key,value in pairs(binding) do
        if key~='callback' then options=options or {};options[key]=value end
      end
    end
    local kind=type(callback)
    if kind=='function' or kind=='string' then
      bind_node_event(scene_id,node_id,name,callback)
      prepared[name]=options or true
    end
  end
  return prepared
end
local function prepare_node(scene_id,node)
  local copy={};for key,value in pairs(node) do copy[key]=value end
  copy.events=prepare_events(scene_id,node.id,node.events)
  if type(node.children)=='table' then
    copy.children={}
    for index,child in ipairs(node.children) do copy.children[index]=prepare_node(scene_id,child) end
  end
  return copy
end
local function animation_handle(id)
  local handle={id=id}
  function handle:pause() __canvas_command({op='animation.control',id=self.id,action='pause'});return self end
  function handle:resume() __canvas_command({op='animation.control',id=self.id,action='resume'});return self end
  function handle:cancel() __canvas_command({op='animation.control',id=self.id,action='cancel'});return self end
  function handle:finish() __canvas_command({op='animation.control',id=self.id,action='finish'});return self end
  return handle
end
local function node_handle(scene_id,node_id,properties)
  local handle={scene_id=scene_id,id=node_id,properties=properties or {}}
  function handle:set(values)
    for key,value in pairs(values) do self.properties[key]=value end
    __canvas_command({op='node.set',sceneId=self.scene_id,nodeId=self.id,values=values});return self
  end
  function handle:translate(dx,dy)
    self.properties.x=(self.properties.x or 0)+dx;self.properties.y=(self.properties.y or 0)+dy
    __canvas_command({op='node.translate',sceneId=self.scene_id,nodeId=self.id,dx=dx,dy=dy});return self
  end
  function handle:move_to(x,y) return self:set({x=x,y=y}) end
  function handle:rotate_by(degrees) return self:set({rotation=(self.properties.rotation or 0)+degrees}) end
  function handle:rotate_to(degrees) return self:set({rotation=degrees}) end
  function handle:scale_to(scale) return self:set({scale=scale}) end
  function handle:set_opacity(opacity) return self:set({opacity=opacity}) end
  function handle:show() return self:set({visible=true}) end
  function handle:hide() return self:set({visible=false}) end
  function handle:x() return self.properties.x or 0 end
  function handle:y() return self.properties.y or 0 end
  function handle:is_visible() return self.properties.visible~=false end
  function handle:set_interactive(enabled) return self:set({interactive=enabled}) end
  function handle:on(event_name,callback)
    bind_node_event(self.scene_id,self.id,event_name,callback)
    __canvas_command({op='event.set',sceneId=self.scene_id,nodeId=self.id,event=event_name,binding=true})
    return self
  end
  function handle:off(event_name)
    unbind_node_event(self.scene_id,self.id,event_name)
    __canvas_command({op='event.remove',sceneId=self.scene_id,nodeId=self.id,event=event_name})
    return self
  end
  function handle:tween(values,options)
    animation_serial=animation_serial+1;local id='animation_'..animation_serial
    __canvas_command({op='animation.create',id=id,sceneId=self.scene_id,nodeId=self.id,values=values,options=options or {}})
    return animation_handle(id)
  end
  function handle:animate(keyframes,options)
    animation_serial=animation_serial+1;local id='animation_'..animation_serial
    __canvas_command({op='animation.keyframes',id=id,sceneId=self.scene_id,nodeId=self.id,keyframes=keyframes,options=options or {}})
    return animation_handle(id)
  end
  function handle:remove() __canvas_command({op='node.remove',sceneId=self.scene_id,nodeId=self.id}) end
  return handle
end
local function scene_handle(scene_id)
  local handle={id=scene_id}
  function handle:add(node)
    local prepared=prepare_node(self.id,node);__canvas_command({op='node.add',sceneId=self.id,node=prepared})
    return node_handle(self.id,node.id,node)
  end
  function handle:node(node_id) return node_handle(self.id,node_id,{}) end
  function handle:clear() __canvas_command({op='scene.clear',sceneId=self.id});return self end
  function handle:remove() __canvas_command({op='scene.remove',sceneId=self.id}) end
  return handle
end
`;

export const LUA_CANVAS_IMPLEMENTATION = String.raw`GameCanvas={}
function GameCanvas.create(specification)
  local prepared={};for key,value in pairs(specification) do prepared[key]=value end
  if type(specification.nodes)=='table' then
    prepared.nodes={}
    for index,node in ipairs(specification.nodes) do prepared.nodes[index]=prepare_node(specification.id,node) end
  end
  __canvas_command({op='scene.create',scene=prepared});return scene_handle(specification.id)
end
function GameCanvas.node(scene_id,node_id) return node_handle(scene_id,node_id,{}) end
`;
