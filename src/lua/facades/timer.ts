/** Timer facade support and the `game.timer` Lua facade. */
export const LUA_TIMER_SUPPORT = String.raw`local function timer_handle(id)
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

`;

export const LUA_TIMER_FACADE = String.raw`timer={}
`;

export const LUA_TIMER_IMPLEMENTATION = String.raw`local function create_timer(delay,callback,options,repeating)
  timer_serial=timer_serial+1;local id='timer_'..timer_serial;local settings=options or {}
  __timer_command(json({op='create',id=id,delay=delay,callback=callback_ref(callback),repeating=repeating,repeatCount=settings.repeat_count,immediate=settings.immediate==true}))
  return timer_handle(id)
end
function game.timer.after(delay,callback,options) return create_timer(delay,callback,options,false) end
function game.timer.every(delay,callback,options) return create_timer(delay,callback,options,true) end
`;
