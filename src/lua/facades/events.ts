/** Lua callback entry points invoked by the canvas and timer hosts. */
export const LUA_EVENTS = String
  .raw`function __canvas_event(reference,scene_id,node_id,event_type,x,y,world_x,world_y,world_z,local_x,local_y,button,pointer_type,alt_key,ctrl_key,shift_key)
  local callback=callbacks[reference] or _G[reference]
  if callback then callback({sceneId=scene_id,nodeId=node_id,type=event_type,x=x,y=y,worldX=world_x,worldY=world_y,worldZ=world_z,localX=local_x,localY=local_y,button=button,pointerType=pointer_type,altKey=alt_key,ctrlKey=ctrl_key,shiftKey=shift_key}) end
end
function __timer_event(reference,timer_id,iteration)
  local callback=callbacks[reference] or _G[reference]
  if callback then callback(timer_handle(timer_id),iteration) end
end
`;
