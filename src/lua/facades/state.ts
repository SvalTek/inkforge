/** The `game.state` Lua facade. */
export const LUA_STATE_FACADE = String
  .raw`  state={get=function(path) return __state_get(path) end,set=function(path,value) __state_set(path,value) end},
`;
