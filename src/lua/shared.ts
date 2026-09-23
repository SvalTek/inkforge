/** Shared Lua serialization and callback state used by the facade modules. */
export const LUA_SHARED = String.raw`
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
`;
