'use strict';
// `tmux list-sessions -F` output that survives every tmux version and locale:
// - tmux 3.4+ replaces control characters (tabs too) with "_", so fields are joined with a printable separator
//   that can't appear in session names (SAFE_NAME) or our labels;
// - without a UTF-8 locale tmux also replaces non-ASCII characters (e.g. the "·" in Arena labels); -u forces UTF-8.
const SEP = '::ah::';
const format = (fields) => fields.map((f) => `#{${f}}`).join(SEP);
const listArgs = (fields) => ['-u', 'list-sessions', '-F', format(fields)];
const parseLine = (line) => line.split(SEP);

module.exports = { SEP, format, listArgs, parseLine };
