/** Canvas facade support and the `game.canvas` Lua facade. */
export const LUA_CANVAS_SUPPORT = String.raw`local function prepare_events(events)
  if type(events)~='table' then return events end
  local prepared={}
  for name,binding in pairs(events) do
    if type(binding)=='function' or type(binding)=='string' then prepared[name]={callback=callback_ref(binding)}
    elseif type(binding)=='table' then
      local copy={};for key,value in pairs(binding) do copy[key]=value end
      if copy.callback then copy.callback=callback_ref(copy.callback) end
      prepared[name]=copy
    end
  end
  return prepared
end
local function prepare_node(node)
  local copy={};for key,value in pairs(node) do copy[key]=value end
  copy.events=prepare_events(node.events)
  if type(node.children)=='table' then copy.children={};for index,child in ipairs(node.children) do copy.children[index]=prepare_node(child) end end
  return copy
end
local function animation_handle(id)
  local handle={id=id}
  function handle:pause() __canvas_command(json({op='animation.control',id=self.id,action='pause'}));return self end
  function handle:resume() __canvas_command(json({op='animation.control',id=self.id,action='resume'}));return self end
  function handle:cancel() __canvas_command(json({op='animation.control',id=self.id,action='cancel'}));return self end
  function handle:finish() __canvas_command(json({op='animation.control',id=self.id,action='finish'}));return self end
  return handle
end
local function node_handle(scene_id,node_id,properties)
  local handle={scene_id=scene_id,id=node_id,properties=properties or {}}
  function handle:set(values)
    for key,value in pairs(values) do self.properties[key]=value end
    __canvas_command(json({op='node.set',sceneId=self.scene_id,nodeId=self.id,values=values}));return self
  end
  function handle:translate(dx,dy)
    self.properties.x=(self.properties.x or 0)+dx;self.properties.y=(self.properties.y or 0)+dy
    __canvas_command(json({op='node.translate',sceneId=self.scene_id,nodeId=self.id,dx=dx,dy=dy}));return self
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
    __canvas_command(json({op='event.set',sceneId=self.scene_id,nodeId=self.id,event=event_name,binding={callback=callback_ref(callback)}}));return self
  end
  function handle:off(event_name)
    __canvas_command(json({op='event.remove',sceneId=self.scene_id,nodeId=self.id,event=event_name}));return self
  end
  function handle:tween(values,options)
    animation_serial=animation_serial+1;local id='animation_'..animation_serial
    __canvas_command(json({op='animation.create',id=id,sceneId=self.scene_id,nodeId=self.id,values=values,options=options or {}}))
    return animation_handle(id)
  end
  function handle:animate(keyframes,options)
    animation_serial=animation_serial+1;local id='animation_'..animation_serial
    __canvas_command(json({op='animation.keyframes',id=id,sceneId=self.scene_id,nodeId=self.id,keyframes=keyframes,options=options or {}}))
    return animation_handle(id)
  end
  function handle:remove() __canvas_command(json({op='node.remove',sceneId=self.scene_id,nodeId=self.id})) end
  return handle
end
local function scene_handle(scene_id)
  local handle={id=scene_id}
  function handle:add(node)
    local prepared=prepare_node(node);__canvas_command(json({op='node.add',sceneId=self.id,node=prepared}))
    return node_handle(self.id,node.id,node)
  end
  function handle:node(node_id) return node_handle(self.id,node_id,{}) end
  function handle:clear() __canvas_command(json({op='scene.clear',sceneId=self.id}));return self end
  function handle:remove() __canvas_command(json({op='scene.remove',sceneId=self.id})) end
  return handle
end
`;

export const LUA_CANVAS_FACADE = String.raw`  canvas={},`;

export const LUA_CANVAS_IMPLEMENTATION = String.raw`function game.canvas.create(specification)
  local prepared={};for key,value in pairs(specification) do prepared[key]=value end
  if type(specification.nodes)=='table' then prepared.nodes={};for index,node in ipairs(specification.nodes) do prepared.nodes[index]=prepare_node(node) end end
  __canvas_command(json({op='scene.create',scene=prepared}));return scene_handle(specification.id)
end
function game.canvas.node(scene_id,node_id) return node_handle(scene_id,node_id,{}) end
`;
