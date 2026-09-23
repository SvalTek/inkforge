/** The `game.tool` Lua facade for the shared authored tool registry. */
export const LUA_TOOL_FACADE = String
  .raw`  tool={register=function(definition) __tool_register(json(definition)) end,remove=function(id) __tool_remove(id) end,show=function(id) __tool_show(id) end,hide=function(id) __tool_hide(id) end,enable=function(id) __tool_enable(id) end,disable=function(id) __tool_disable(id) end},
`;
