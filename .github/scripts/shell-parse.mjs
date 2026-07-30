/**
 * Just enough shell structure to tell WHERE a value goes.
 *
 * WHY THIS EXISTS. The first cut of `check-docs-secret-argv.mjs` scanned
 * physical lines and associated every secret-shaped token with the first
 * external command anywhere on the line. That was wrong in three ways at
 * once (#1467 r1), and two of them are the kind of wrong that discredits a
 * check:
 *
 *   - It **flagged the pattern the docs recommend.** In
 *     `printf 'fmt' "$TOKEN" | curl -K -` the token is expanded by a shell
 *     builtin and `curl` receives only stdin — nothing enters any argv — yet
 *     the check reported it as reaching curl's arguments. A check that
 *     condemns the safe pattern teaches people to ignore it.
 *   - It **missed real instances** on backslash continuations, where the
 *     command and the credential sit on different physical lines. Two live
 *     examples in `BaseSepoliaDeploy.md`.
 *   - It **exempted every assignment**, on the reasoning that the value stays
 *     in the shell. `DEPLOYER=$(cast wallet address $PRIVATE_KEY)` launches a
 *     child process with its own argv.
 *
 * The common cause: "does this value reach a process's argv" is a question
 * about shell STRUCTURE, and no line-level regex answers it. So structure is
 * what this module recovers — logical lines, pipeline stages, and command
 * substitutions, each with its own leading command.
 *
 * NOT a shell parser. It does not handle quoting subtleties, `eval`, arrays,
 * process substitution or here-strings, and is not trying to. It answers one
 * question well enough to be trusted, and its caller states what it cannot
 * see.
 */

/** Join backslash continuations into logical lines, keeping the start line. */
export function logicalLines(lines) {
  const out = [];
  let buf = null;
  for (const { n, line } of lines) {
    const body = line.replace(/^\s*>?\s?/, '');
    if (buf === null) buf = { n, text: body };
    else buf.text += ` ${body.trim()}`;
    if (/\\\s*$/.test(buf.text)) {
      buf.text = buf.text.replace(/\\\s*$/, ' ');
      continue;
    }
    out.push(buf);
    buf = null;
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * Split on pipeline and list separators. `&&` / `||` operands are each their
 * own command, so splitting on them is correct here.
 */
function stages(text) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    if (c === ')') depth = Math.max(0, depth - 1);
    const two = text.slice(i, i + 2);
    if (depth === 0 && (two === '&&' || two === '||')) {
      parts.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (depth === 0 && (c === '|' || c === ';')) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts.filter((p) => p.trim().length > 0);
}

/** Every `$(...)` body, innermost included, by balanced-paren scanning. */
function substitutions(text) {
  const out = [];
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] !== '$' || text[i + 1] !== '(') continue;
    let depth = 0;
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')') {
        depth--;
        if (depth === 0) {
          const body = text.slice(i + 2, j);
          out.push(body, ...substitutions(body));
          i = j;
          break;
        }
      }
    }
  }
  return out;
}

/**
 * The command a stage actually invokes.
 *
 * Skips leading `VAR=value` env prefixes (`FOO=1 curl …` invokes curl) and
 * returns null for a bare assignment, which invokes nothing. Substitutions
 * inside the assigned value are surfaced separately by `argvUnits`, which is
 * what closes the `DEPLOYER=$(cast …)` hole without re-opening the
 * value-stays-in-the-shell exemption.
 */
export function leadingCommand(stage) {
  let s = stage.trim().replace(/^[({\s]+/, '');
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(s)) {
    const rest = s.slice(s.indexOf('=') + 1);
    const m = rest.match(/^(?:"[^"]*"|'[^']*'|\S*)\s+(\S.*)$/s);
    if (!m) return null; // bare assignment — invokes nothing
    s = m[1];
  }
  const tok = s.split(/\s/)[0] ?? '';
  return tok.replace(/^.*\//, '').replace(/^["']/, '') || null;
}

/**
 * Decompose a logical line into `{ cmd, text }` units, where `text` is the
 * argument region whose contents would reach `cmd`'s argv.
 *
 * A pipeline stage contributes its own text MINUS its substitutions; each
 * substitution contributes a unit of its own. That separation is the point:
 * it is what lets `printf … | curl -K -` read as safe while
 * `DEPLOYER=$(cast … $KEY)` reads as not.
 */
export function argvUnits(text) {
  const units = [];
  for (const stage of stages(text)) {
    const subs = substitutions(stage);
    let own = stage;
    for (const sub of subs) own = own.split(`$(${sub})`).join(' ');
    const cmd = leadingCommand(own);
    if (cmd) units.push({ cmd, text: own });
    for (const sub of subs) {
      const subCmd = leadingCommand(sub);
      if (subCmd) units.push({ cmd: subCmd, text: sub });
    }
  }
  return units;
}
