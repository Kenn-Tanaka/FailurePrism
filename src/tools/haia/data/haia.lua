-- HAIA Pandoc Lua filter
-- Converts Markdown raw HTML <br>, <br/>, and <br /> into native Pandoc line breaks.
-- This is mainly needed when exporting tables to docx, pptx, and odt, because
-- raw HTML line-break tags may be ignored by non-HTML writers.

local function linebreak()
  return pandoc.LineBreak()
end

local function para(inlines)
  return pandoc.Para(inlines)
end

local function make_str(text)
  return pandoc.Str(text)
end

local function is_br_tag(text)
  return type(text) == "string" and text:match("^%s*<[bB][rR]%s*/?>%s*$") ~= nil
end

function RawInline(el)
  if el.format and el.format:match("html") and is_br_tag(el.text) then
    return linebreak()
  end
end

function RawBlock(el)
  if el.format and el.format:match("html") and is_br_tag(el.text) then
    return para({ linebreak() })
  end
end

-- Fallback for cases where <br> has already become plain text.
function Str(el)
  local text = el.text
  if type(text) ~= "string" or not text:find("<[bB][rR]") then
    return nil
  end

  local result = {}
  local pos = 1
  local changed = false

  while true do
    local s, e = text:find("<[bB][rR]%s*/?>", pos)
    if not s then
      break
    end

    if s > pos then
      table.insert(result, make_str(text:sub(pos, s - 1)))
    end
    table.insert(result, linebreak())
    changed = true
    pos = e + 1
  end

  if changed then
    if pos <= #text then
      table.insert(result, make_str(text:sub(pos)))
    end
    return result
  end

  return nil
end
