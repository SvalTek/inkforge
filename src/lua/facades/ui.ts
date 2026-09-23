/** The `game.ui` Lua facade. */
export const LUA_UI_FACADE = String
  .raw`  ui={create=function(element) __ui_create(json(element)) end,set=function(id,properties) __ui_set(id,json(properties)) end,show=function(id) __ui_show(id) end,hide=function(id) __ui_hide(id) end,remove=function(id) __ui_remove(id) end},
`;
