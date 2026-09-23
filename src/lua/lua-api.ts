/**
 * The live canvas Lua API source (`CANVAS_LUA_API` in the original runtime).
 *
 * Reproduced byte-for-byte as a `String.raw` template so the embedded Lua keeps
 * its original escapes and spacing; `deno fmt` must not reflow the interior.
 */
export const CANVAS_LUA_API = String.raw`
local function quote(text)
  text=text:gsub('\\','\\\\'):gsub('"','\\"'):gsub('\n','\\n'):gsub('\r','\\r'):gsub('\t','\\t')
  return '"'..text..'"'
end
local function json(value)
  local kind=type(value)
  if kind=='nil' then return 'null' end
  if kind=='boolean' then return value and 'true' or 'false' end
  if kind=='number' then return tostring(value) end
  if kind=='string' then return quote(value) end
  if kind~='table' then error('Cannot encode '..kind) end
  local count,array=0,true
  for key in pairs(value) do count=count+1;if type(key)~='number' or key<1 or key%1~=0 then array=false end end
  local parts={}
  if array then for index=1,count do parts[#parts+1]=json(value[index]) end;return '['..table.concat(parts,',')..']' end
  for key,item in pairs(value) do parts[#parts+1]=quote(tostring(key))..':'..json(item) end
  return '{'..table.concat(parts,',')..'}'
end

local callbacks,callback_serial,timer_serial,animation_serial,timer_handles={},0,0,0,{}
local function callback_ref(callback)
  if type(callback)=='string' then return callback end
  if type(callback)~='function' then return nil end
  callback_serial=callback_serial+1
  local reference='__callback_'..callback_serial
  callbacks[reference]=callback
  return reference
end
local function prepare_events(events)
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
local function timer_handle(id)
  if timer_handles[id] then return timer_handles[id] end
  local handle={id=id}
  function handle:pause() __timer_command(json({op='pause',id=self.id}));return self end
  function handle:resume() __timer_command(json({op='resume',id=self.id}));return self end
  function handle:restart() __timer_command(json({op='restart',id=self.id}));return self end
  function handle:cancel() __timer_command(json({op='cancel',id=self.id}));return self end
  function handle:remaining() return __timer_remaining(self.id) end
  function handle:is_active() return __timer_active(self.id) end
  timer_handles[id]=handle;return handle
end

game={
  output=function(text) __output(text) end,
  state={get=function(path) return __state_get(path) end,set=function(path,value) __state_set(path,value) end},
  ui={create=function(element) __ui_create(json(element)) end,set=function(id,properties) __ui_set(id,json(properties)) end,show=function(id) __ui_show(id) end,hide=function(id) __ui_hide(id) end,remove=function(id) __ui_remove(id) end},
  canvas={},timer={}
}
function game.canvas.create(specification)
  local prepared={};for key,value in pairs(specification) do prepared[key]=value end
  if type(specification.nodes)=='table' then prepared.nodes={};for index,node in ipairs(specification.nodes) do prepared.nodes[index]=prepare_node(node) end end
  __canvas_command(json({op='scene.create',scene=prepared}));return scene_handle(specification.id)
end
function game.canvas.node(scene_id,node_id) return node_handle(scene_id,node_id,{}) end
local function create_timer(delay,callback,options,repeating)
  timer_serial=timer_serial+1;local id='timer_'..timer_serial;local settings=options or {}
  __timer_command(json({op='create',id=id,delay=delay,callback=callback_ref(callback),repeating=repeating,repeatCount=settings.repeat_count,immediate=settings.immediate==true}))
  return timer_handle(id)
end
function game.timer.after(delay,callback,options) return create_timer(delay,callback,options,false) end
function game.timer.every(delay,callback,options) return create_timer(delay,callback,options,true) end
function __canvas_event(reference,scene_id,node_id,event_type,x,y,local_x,local_y,button,pointer_type,alt_key,ctrl_key,shift_key)
  local callback=callbacks[reference] or _G[reference]
  if callback then callback({sceneId=scene_id,nodeId=node_id,type=event_type,x=x,y=y,localX=local_x,localY=local_y,button=button,pointerType=pointer_type,altKey=alt_key,ctrlKey=ctrl_key,shiftKey=shift_key}) end
end
function __timer_event(reference,timer_id,iteration)
  local callback=callbacks[reference] or _G[reference]
  if callback then callback(timer_handle(timer_id),iteration) end
end
`;
