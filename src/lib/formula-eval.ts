/** Safe arithmetic for super-admin portfolio formulas. No JS eval. */

const ALLOWED_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

type Tok =
  | { kind: "num"; value: number }
  | { kind: "id"; value: string }
  | { kind: "op"; value: string };

function tokenize(expr: string): Tok[] {
  const src = expr.replace(/\s+/g, "");
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "(" || ch === ")" || "+-*/^".includes(ch)) {
      out.push({ kind: "op", value: ch });
      i += 1;
      continue;
    }
    if (ch >= "0" && ch <= "9" || ch === ".") {
      let j = i + 1;
      while (j < src.length && ((src[j] >= "0" && src[j] <= "9") || src[j] === ".")) j += 1;
      const n = Number(src.slice(i, j));
      if (!Number.isFinite(n)) throw new Error(`Invalid number in formula`);
      out.push({ kind: "num", value: n });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      const id = src.slice(i, j);
      if (!ALLOWED_IDENT.test(id)) throw new Error(`Invalid name ${id}`);
      out.push({ kind: "id", value: id });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character '${ch}' in formula`);
  }
  return out;
}

function prec(op: string): number {
  if (op === "u-" || op === "u+") return 5;
  if (op === "^") return 4;
  if (op === "*" || op === "/") return 3;
  if (op === "+" || op === "-") return 2;
  return 0;
}

function toRpn(tokens: Tok[]): Tok[] {
  const output: Tok[] = [];
  const ops: string[] = [];
  let prev: Tok | null = null;
  for (const tok of tokens) {
    if (tok.kind === "num" || tok.kind === "id") {
      output.push(tok);
      prev = tok;
      continue;
    }
    if (tok.value === "(") {
      ops.push("(");
      prev = tok;
      continue;
    }
    if (tok.value === ")") {
      while (ops.length && ops[ops.length - 1] !== "(") {
        output.push({ kind: "op", value: ops.pop()! });
      }
      if (ops.pop() !== "(") throw new Error("Unbalanced parentheses");
      prev = tok;
      continue;
    }
    let op = tok.value;
    const unary = (op === "+" || op === "-") && (prev == null || (prev.kind === "op" && prev.value !== ")"));
    if (unary) op = op === "-" ? "u-" : "u+";
    while (ops.length) {
      const top = ops[ops.length - 1];
      if (top === "(") break;
      const prTop = prec(top);
      const prOp = prec(op);
      const rightAssoc = op === "^" || op === "u-" || op === "u+";
      if (prTop > prOp || (prTop === prOp && !rightAssoc)) {
        output.push({ kind: "op", value: ops.pop()! });
      } else break;
    }
    ops.push(op);
    prev = tok;
  }
  while (ops.length) {
    const op = ops.pop()!;
    if (op === "(") throw new Error("Unbalanced parentheses");
    output.push({ kind: "op", value: op });
  }
  return output;
}

function applyOp(op: string, a: number, b?: number): number {
  if (op === "u-") return -a;
  if (op === "u+") return a;
  if (b == null || !Number.isFinite(b)) throw new Error("Missing operand");
  if (op === "+") return a + b;
  if (op === "-") return a - b;
  if (op === "*") return a * b;
  if (op === "/") {
    if (b === 0) throw new Error("Division by zero");
    return a / b;
  }
  if (op === "^") return a ** b;
  throw new Error(`Unknown operator ${op}`);
}

function evalRpn(rpn: Tok[], vars: Record<string, number>): number {
  const stack: number[] = [];
  for (const tok of rpn) {
    if (tok.kind === "num") {
      stack.push(tok.value);
      continue;
    }
    if (tok.kind === "id") {
      if (!(tok.value in vars)) throw new Error(`Unknown variable ${tok.value}`);
      const v = vars[tok.value];
      if (!Number.isFinite(v)) throw new Error(`Non-numeric ${tok.value}`);
      stack.push(v);
      continue;
    }
    if (tok.value === "u-" || tok.value === "u+") {
      const a = stack.pop();
      if (a == null) throw new Error("Missing operand");
      stack.push(applyOp(tok.value, a));
      continue;
    }
    const b = stack.pop();
    const a = stack.pop();
    if (a == null || b == null) throw new Error("Missing operand");
    stack.push(applyOp(tok.value, a, b));
  }
  if (stack.length !== 1) throw new Error("Invalid formula");
  return stack[0];
}

export function evaluateFormula(expression: string, vars: Record<string, number>): number {
  const expr = String(expression || "").trim();
  if (!expr) throw new Error("Empty formula");
  return evalRpn(toRpn(tokenize(expr)), vars);
}

export function tryEvaluateFormula(expression: string, vars: Record<string, number>, fallback: number | null): number | null {
  try {
    const n = evaluateFormula(expression, vars);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}
