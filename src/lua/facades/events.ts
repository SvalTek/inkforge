/**
 * Canvas event routing.
 *
 * The host emits one `canvas:event` per pointer interaction, carrying the same
 * payload shape authors already receive. Routing to the per-node callback
 * happens here in Lua, where the callbacks live, so no callback ever crosses
 * the bridge as a string reference.
 */
export const LUA_EVENTS = String.raw`Events:On("canvas:event", function(payload)
  local callback=resolve_node_event(node_events[node_event_key(payload.sceneId,payload.nodeId,payload.type)])
  if type(callback)=='function' then callback(payload) end
end)
`;
