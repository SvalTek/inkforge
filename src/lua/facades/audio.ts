/** The `game.audio` Lua facade. */
export const LUA_AUDIO_FACADE = String
  .raw`  audio={play=function(path,options) return __audio_play(path,json(options or {})) end,stop=function(id) __audio_stop(id) end,pause=function(id) __audio_pause(id) end,resume=function(id) __audio_resume(id) end,set_volume=function(id,value) __audio_set_volume(id,value) end,set_loop=function(id,value) __audio_set_loop(id,value) end,stop_all=function() __audio_stop_all() end},
`;
