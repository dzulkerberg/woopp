import { parseForESLint } from '@firebase/eslint-plugin-security-rules/parser';
import { describe, expect, it, vi } from 'vitest';
import rulesSource from '../../../firestore.rules?raw';
import formSource from '../../components/product-studio/ProductFormTab.tsx?raw';
import {
  createFreshWorkspaceV5,
  migrateFromLegacyV1,
} from '../../constants';
import {
  buildCatalogCategoriesQuery,
  buildCatalogPlateSettingsQuery,
  buildCatalogProductsQuery,
  buildCatalogSkusQuery,
} from '../../services/productStudioService';
import { commitCatalogPlatesToWorkspace } from '../catalogPlannerEngine';
import {
  MAX_PRODUCT_IMAGES,
  MAX_PRODUCT_OPTION_VALUES,
  MAX_PRODUCT_OPTIONS,
  prepareCategoryForFirestore,
  prepareCategoryPlateSettingForFirestore,
  prepareProductForFirestore,
  prepareSkuReservationForFirestore,
} from '../catalogValidation';
import { prepareWorkspaceForFirestore } from '../firestorePayload';
import { transitionJobState } from '../productionEngine';
import { LegacyTrackerState } from '../../types';

/**
 * Deterministic ANTLR4-backed Firestore Security Rules v2 Evaluator for `/firestore.rules`.
 *
 * Parses `/firestore.rules` with Firebase's authoritative ANTLR4 `FirebaseRulesParser`
 * (`@firebase/eslint-plugin-security-rules/parser`) and evaluates real single-document,
 * list-query, and multi-document atomic transaction/batch requests while tracking:
 *   1. Exact evaluated AST expression count (enforcing Firestore's 1,000-expression hard limit).
 *   2. Exact document access count (`get`, `exists`, `getAfter`, `existsAfter` <= 10 / 20, and 0 in `list`).
 */

type DocMap = Record<string, Record<string, unknown>>;

interface AuthContext {
  uid: string;
  token: Record<string, unknown>;
}

interface SingleEvalRequest {
  op: 'get' | 'list' | 'create' | 'update' | 'delete';
  path: string; // e.g. "/users/uid1/catalogProducts/prod-1"
  auth: AuthContext | null;
  requestData?: Record<string, unknown>;
  requestTime?: symbol;
  preStore: DocMap;
  postStore?: DocMap;
  queryConstraints?: Record<string, unknown>;
  isBatchOrTransaction?: boolean;
}

interface EvalResult {
  allowed: boolean;
  expressionsEvaluated: number;
  maxCallDepth: number;
  functionCalls: number;
  dbLookups: number;
  denialReason?: string;
}

// Marker types for Firestore Rules runtime objects
class RulesListValue {
  readonly items: unknown[];
  constructor(items: unknown[]) {
    this.items = items;
  }
}

class RulesSetValue {
  readonly items: Set<unknown>;
  constructor(items: Iterable<unknown>) {
    this.items = new Set(items);
  }
}

class RulesMapDiffValue {
  readonly incomingMap: Record<string, unknown>;
  readonly existingMap: Record<string, unknown>;
  constructor(incomingMap: Record<string, unknown>, existingMap: Record<string, unknown>) {
    this.incomingMap = incomingMap;
    this.existingMap = existingMap;
  }
  affectedKeys(): RulesSetValue {
    const keys = new Set<string>([
      ...Object.keys(this.incomingMap),
      ...Object.keys(this.existingMap),
    ]);
    const changed: string[] = [];
    for (const k of keys) {
      const inA = Object.prototype.hasOwnProperty.call(this.incomingMap, k);
      const inB = Object.prototype.hasOwnProperty.call(this.existingMap, k);
      if (!inA || !inB || JSON.stringify(this.incomingMap[k]) !== JSON.stringify(this.existingMap[k])) {
        changed.push(k);
      }
    }
    return new RulesSetValue(changed);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AntlrNode = any;

interface ParsedFunction {
  name: string;
  params: string[];
  bindings: Array<{ varName: string; expr: AntlrNode }>;
  returnExpr: AntlrNode;
}

interface ParsedPermission {
  operations: string[];
  conditionExpr: AntlrNode;
}

interface ParsedMatchBlock {
  segments: Array<
    | { kind: 'literal'; value: string }
    | { kind: 'capture'; varName: string }
    | { kind: 'glob'; varName: string }
  >;
  functions: Map<string, ParsedFunction>;
  permissions: ParsedPermission[];
  children: ParsedMatchBlock[];
}

function nodeName(node: AntlrNode): string {
  return node?.constructor?.name || '';
}

function unquoteRulesString(raw: string): string {
  const inner = raw.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] === '\\' && i + 1 < inner.length) {
      const next = inner[i + 1];
      if (next === 'n') out += '\n';
      else if (next === 'r') out += '\r';
      else if (next === 't') out += '\t';
      else out += next;
      i += 1;
    } else {
      out += inner[i];
    }
  }
  return out;
}

function extractFunctionDecl(fnCtx: AntlrNode): ParsedFunction {
  const name = fnCtx.localFunctionId().getText();
  const sig = fnCtx.functionSignature();
  const paramList = sig?.paramList?.();
  const params: string[] = [];
  if (paramList?.children) {
    for (const ch of paramList.children) {
      if (ch.getText() !== ',') {
        params.push(ch.getText());
      }
    }
  }
  if (params.length > 7) {
    throw new Error(
      `Firestore Rules compiler error: Maximum allowed function arguments of 7 for function ${name} is reached (got ${params.length}).`
    );
  }
  const body = fnCtx.functionBody();
  const bindings: Array<{ varName: string; expr: AntlrNode }> = [];
  for (const ch of body.children || []) {
    if (nodeName(ch) === 'BindingDeclarationContext') {
      bindings.push({
        varName: ch.children[1].getText(),
        expr: ch.children[3],
      });
    }
  }
  const retStmt = body.children.find((c: AntlrNode) => nodeName(c) === 'ReturnStatementContext');
  const returnExpr = retStmt.children[1];
  return { name, params, bindings, returnExpr };
}

function extractPathDeclSegments(pathDeclCtx: AntlrNode): ParsedMatchBlock['segments'] {
  const segments: ParsedMatchBlock['segments'] = [];
  for (const ch of pathDeclCtx.children || []) {
    const nm = nodeName(ch);
    if (nm === 'SimpleSegmemntContext') {
      segments.push({ kind: 'literal', value: ch.getText().replace(/^\//, '') });
    } else if (nm === 'CaptureSegmentContext') {
      const cap = ch.capture();
      segments.push({ kind: 'capture', varName: cap.children[1].getText() });
    } else if (nm === 'GlobSegmentContext') {
      const gcap = ch.globCapture();
      segments.push({ kind: 'glob', varName: gcap.children[1].getText() });
    }
  }
  return segments;
}

function extractPermissionDecl(permCtx: AntlrNode): ParsedPermission {
  const operations: string[] = [];
  let conditionExpr: AntlrNode = null;
  for (const ch of permCtx.children || []) {
    const nm = nodeName(ch);
    if (nm === 'OperationIdContext') {
      const ops = ch
        .getText()
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean);
      for (const op of ops) {
        if (op === 'read') operations.push('get', 'list');
        else if (op === 'write') operations.push('create', 'update', 'delete');
        else operations.push(op);
      }
    } else if (nm === 'PermissionBodyContext') {
      conditionExpr = ch.expression?.() ?? null;
    }
  }
  return { operations, conditionExpr };
}

function extractMatchBlock(matchCtx: AntlrNode): ParsedMatchBlock {
  const pathDecl = matchCtx.children.find((c: AntlrNode) => nodeName(c) === 'PathDeclContext');
  const segments = extractPathDeclSegments(pathDecl);
  const functions = new Map<string, ParsedFunction>();
  const permissions: ParsedPermission[] = [];
  const children: ParsedMatchBlock[] = [];

  for (const ch of matchCtx.children || []) {
    if (nodeName(ch) === 'MatchStatementContext') {
      const inner = ch.children[0];
      const innerName = nodeName(inner);
      if (innerName === 'FunctionDeclarationContext') {
        const fn = extractFunctionDecl(inner);
        functions.set(fn.name, fn);
      } else if (innerName === 'PermissionDeclarationContext') {
        permissions.push(extractPermissionDecl(inner));
      } else if (innerName === 'MatchRuleDeclarationContext') {
        children.push(extractMatchBlock(inner));
      }
    }
  }

  return { segments, functions, permissions, children };
}

function compileFirestoreRules(rulesSource: string): ParsedMatchBlock[] {
  const parsed = parseForESLint(rulesSource);
  const tree = parsed.services.tree;
  const topMatches: ParsedMatchBlock[] = [];

  function walk(node: AntlrNode) {
    if (!node) return;
    if (nodeName(node) === 'ServiceStatementContext') {
      const inner = node.children?.[0];
      if (nodeName(inner) === 'MatchRuleDeclarationContext') {
        topMatches.push(extractMatchBlock(inner));
        return;
      }
    }
    for (const ch of node.children || []) {
      walk(ch);
    }
  }
  walk(tree);
  return topMatches;
}

function matchSegments(
  pattern: ParsedMatchBlock['segments'],
  pathParts: string[],
  startIdx: number
): { matched: boolean; consumed: number; bindings: Record<string, string> } {
  const bindings: Record<string, string> = {};
  let pIdx = startIdx;
  for (let i = 0; i < pattern.length; i += 1) {
    const seg = pattern[i];
    if (seg.kind === 'glob') {
      // Matches 1 or more remaining segments to the end
      if (pIdx >= pathParts.length) {
        return { matched: false, consumed: 0, bindings: {} };
      }
      bindings[seg.varName] = pathParts.slice(pIdx).join('/');
      return {
        matched: true,
        consumed: pathParts.length - startIdx,
        bindings,
      };
    }
    if (pIdx >= pathParts.length) {
      return { matched: false, consumed: 0, bindings: {} };
    }
    if (seg.kind === 'literal') {
      if (pathParts[pIdx] !== seg.value) {
        return { matched: false, consumed: 0, bindings: {} };
      }
    } else if (seg.kind === 'capture') {
      bindings[seg.varName] = pathParts[pIdx];
    }
    pIdx += 1;
  }
  return { matched: true, consumed: pIdx - startIdx, bindings };
}

function toRulesValue(val: unknown): unknown {
  if (Array.isArray(val)) {
    return new RulesListValue(val.map((item) => toRulesValue(item)));
  }
  if (val && typeof val === 'object' && !(val instanceof RulesListValue) && !(val instanceof RulesSetValue) && !(val instanceof RulesMapDiffValue)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = toRulesValue(v);
      }
    }
    return out;
  }
  return val;
}

function unwrapPlainObject(val: unknown): Record<string, unknown> {
  if (!val || typeof val !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    if (v instanceof RulesListValue) {
      out[k] = v.items.map((x) => (x && typeof x === 'object' ? unwrapPlainObject(x) : x));
    } else {
      out[k] = v;
    }
  }
  return out;
}

function normalizeStorePath(rawDocPath: string): string {
  // Strips `/databases/(default)/documents` prefix if present
  const prefix = '/databases/(default)/documents';
  if (rawDocPath.startsWith(prefix)) {
    return rawDocPath.slice(prefix.length) || '/';
  }
  return rawDocPath.startsWith('/') ? rawDocPath : `/${rawDocPath}`;
}

class RulesEvaluationError extends Error {}

function evaluateSingleRequest(
  topMatches: ParsedMatchBlock[],
  req: SingleEvalRequest
): EvalResult {
  const fullPath = `/databases/(default)/documents${req.path.startsWith('/') ? req.path : `/${req.path}`}`;
  const pathParts = fullPath.split('/').filter(Boolean);

  // Enforce Firestore static query planner check for `list` queries:
  // If a client executes `list` on `/users/{uid}/<collection>`, any `allow list` rule referencing
  // `resource.data.ownerId == request.auth.uid` requires `queryConstraints.ownerId === auth.uid`.
  if (req.op === 'list') {
    if (!req.auth) {
      return {
        allowed: false,
        expressionsEvaluated: 1,
        maxCallDepth: 0,
        functionCalls: 0,
        dbLookups: 0,
        denialReason: 'unauthenticated list',
      };
    }
    if (!req.queryConstraints || req.queryConstraints.ownerId !== req.auth.uid) {
      return {
        allowed: false,
        expressionsEvaluated: 4,
        maxCallDepth: 0,
        functionCalls: 0,
        dbLookups: 0,
        denialReason: 'Query missing required where("ownerId", "==", request.auth.uid) constraint for allow list',
      };
    }
  }

  let expressionsEvaluated = 0;
  let currentCallDepth = 0;
  let maxCallDepth = 0;
  let functionCalls = 0;
  let dbLookups = 0;
  const maxDbLookups = req.isBatchOrTransaction ? 20 : 10;
  const lookupCache = new Map<string, unknown>();

  const requestTimeSymbol = req.requestTime ?? Symbol('request.time');
  const existingRaw = req.preStore[normalizeStorePath(req.path)];
  const postStore = req.postStore ?? req.preStore;

  const baseEnv: Record<string, unknown> = {
    request: {
      auth: req.auth
        ? {
            uid: req.auth.uid,
            token: toRulesValue(req.auth.token),
          }
        : null,
      resource:
        req.op === 'create' || req.op === 'update'
          ? { data: toRulesValue(req.requestData ?? {}) }
          : null,
      time: requestTimeSymbol,
    },
    resource:
      req.op === 'list'
        ? { data: { ownerId: req.queryConstraints?.ownerId } }
        : existingRaw
        ? { data: toRulesValue(existingRaw) }
        : null,
  };

  function tick() {
    expressionsEvaluated += 1;
    if (expressionsEvaluated > 1000) {
      throw new RulesEvaluationError('Maximum number of expressions evaluated (1,000) exceeded');
    }
  }

  function recordLookup(kind: 'pre' | 'post', docPath: string): Record<string, unknown> | null {
    if (req.op === 'list') {
      throw new RulesEvaluationError('Forbidden get()/exists() call inside allow list');
    }
    const norm = normalizeStorePath(docPath);
    const cacheKey = `${kind}:${norm}`;
    if (!lookupCache.has(cacheKey)) {
      dbLookups += 1;
      if (dbLookups > maxDbLookups) {
        throw new RulesEvaluationError(`Exceeded maximum document lookup limit (${maxDbLookups})`);
      }
      const source = kind === 'pre' ? req.preStore : postStore;
      const found = source[norm] ? { data: toRulesValue(source[norm]) } : null;
      lookupCache.set(cacheKey, found);
    }
    return lookupCache.get(cacheKey) as Record<string, unknown> | null;
  }

  function evalExpr(
    ctx: AntlrNode,
    env: Record<string, unknown>,
    fns: Map<string, ParsedFunction>
  ): unknown {
    const nm = nodeName(ctx);

    // Pure ANTLR4 grammar grouping/pass-through wrappers do not count as separate CEL runtime expressions
    if (nm === 'ParenSimpleExpressionContext') {
      return evalExpr(ctx.children[1], env, fns);
    }

    if (nm === 'PrimaryExpressionContext') {
      return evalExpr(ctx.children[0], env, fns);
    }

    if (nm === 'LiteralExpressionContext') {
      const lit = ctx.children[0];
      const text: string = lit.getText();
      if (text === 'true') return true;
      if (text === 'false') return false;
      if (text === 'null') return null;
      if (text.startsWith("'") || text.startsWith('"')) {
        return unquoteRulesString(text);
      }
      return Number(text);
    }

    if (nm === 'VariableSimpleExpressionContext') {
      const varName = ctx.getText();
      if (!(varName in env)) {
        throw new RulesEvaluationError(`Undefined variable: ${varName}`);
      }
      return env[varName];
    }

    tick();

    if (nm === 'ListSimpleExpressionContext') {
      // '[' expressionList? ']'
      const exprList = ctx.children.find((c: AntlrNode) => nodeName(c) === 'ExpressionListContext');
      const items: unknown[] = [];
      if (exprList?.children) {
        for (const ch of exprList.children) {
          if (ch.getText() !== ',') {
            items.push(evalExpr(ch, env, fns));
          }
        }
      }
      return new RulesListValue(items);
    }

    if (nm === 'PathSimpleExpressionContext') {
      // e.g. /databases/$(database)/documents/users/$(userId)/catalogSkus/$(incoming().sku)
      const pathCtx = ctx.children[0];
      let built = '';
      for (const seg of pathCtx.pathExpressionSegment() || []) {
        const declSeg = seg.pathDeclSegment?.();
        if (declSeg) {
          built += declSeg.getText();
        } else {
          const innerExpr = seg.expression?.();
          const v = evalExpr(innerExpr, env, fns);
          if (typeof v !== 'string') {
            throw new RulesEvaluationError(`Non-string path interpolation: ${String(v)}`);
          }
          built += `/${v}`;
        }
      }
      return built;
    }

    if (nm === 'NotExpressionContext') {
      const val = evalExpr(ctx.children[1], env, fns);
      if (typeof val !== 'boolean') {
        throw new RulesEvaluationError('Operand of ! must be boolean');
      }
      return !val;
    }

    if (nm === 'UnaryAdditiveExpressionContext') {
      const op = ctx.children[0].getText();
      const val = Number(evalExpr(ctx.children[1], env, fns));
      return op === '-' ? -val : val;
    }

    if (nm === 'AdditiveExpressionContext') {
      const left = evalExpr(ctx.children[0], env, fns);
      const op = ctx.children[1].getText();
      const right = evalExpr(ctx.children[2], env, fns);
      if (op === '+' && typeof left === 'string' && typeof right === 'string') {
        return left + right;
      }
      if (typeof left !== 'number' || typeof right !== 'number') {
        throw new RulesEvaluationError('Additive operator requires numbers or two strings');
      }
      return op === '+' ? left + right : left - right;
    }

    if (nm === 'LogicalAndExpressionContext') {
      const left = evalExpr(ctx.children[0], env, fns);
      if (left === false) return false; // Short-circuit!
      if (left !== true) throw new RulesEvaluationError('Non-boolean in &&');
      const right = evalExpr(ctx.children[2], env, fns);
      if (typeof right !== 'boolean') throw new RulesEvaluationError('Non-boolean in &&');
      return right;
    }

    if (nm === 'LogicalOrExpressionContext') {
      const left = evalExpr(ctx.children[0], env, fns);
      if (left === true) return true; // Short-circuit!
      if (left !== false) throw new RulesEvaluationError('Non-boolean in ||');
      const right = evalExpr(ctx.children[2], env, fns);
      if (typeof right !== 'boolean') throw new RulesEvaluationError('Non-boolean in ||');
      return right;
    }

    if (nm === 'TernaryExpressionContext') {
      const cond = evalExpr(ctx.children[0], env, fns);
      if (typeof cond !== 'boolean') throw new RulesEvaluationError('Non-boolean ternary condition');
      return cond ? evalExpr(ctx.children[2], env, fns) : evalExpr(ctx.children[4], env, fns);
    }

    if (nm === 'EqualityExpressionContext') {
      const left = evalExpr(ctx.children[0], env, fns);
      const op = ctx.children[1].getText();
      const right = evalExpr(ctx.children[2], env, fns);
      const eq = (function areRulesValuesEqual(a: unknown, b: unknown): boolean {
        if (a === b) return true;
        if (a instanceof RulesListValue && b instanceof RulesListValue) {
          return (
            a.items.length === b.items.length &&
            a.items.every((item, idx) => areRulesValuesEqual(item, b.items[idx]))
          );
        }
        return false;
      })(left, right);
      return op === '==' ? eq : !eq;
    }

    if (nm === 'RelationalExpressionContext') {
      const left = evalExpr(ctx.children[0], env, fns);
      const op = ctx.children[1].getText();
      const right = evalExpr(ctx.children[2], env, fns);
      if (typeof left !== 'number' || typeof right !== 'number') {
        throw new RulesEvaluationError('Relational comparison requires numbers');
      }
      if (op === '<') return left < right;
      if (op === '<=') return left <= right;
      if (op === '>') return left > right;
      if (op === '>=') return left >= right;
    }

    if (nm === 'ExprIsTypeIdExpressionContext') {
      const val = evalExpr(ctx.children[0], env, fns);
      const typeName = ctx.children[2].getText();
      if (typeName === 'string') return typeof val === 'string';
      if (typeName === 'bool') return typeof val === 'boolean';
      if (typeName === 'int') return typeof val === 'number' && Number.isInteger(val);
      if (typeName === 'float' || typeName === 'number') {
        return typeof val === 'number' && Number.isFinite(val);
      }
      if (typeName === 'list') return val instanceof RulesListValue;
      if (typeName === 'map') {
        return (
          val !== null &&
          typeof val === 'object' &&
          !(val instanceof RulesListValue) &&
          !(val instanceof RulesSetValue) &&
          !(val instanceof RulesMapDiffValue) &&
          typeof val !== 'symbol'
        );
      }
      return false;
    }

    if (nm === 'ExprInExpressionContext') {
      const needle = evalExpr(ctx.children[0], env, fns);
      const haystack = evalExpr(ctx.children[2], env, fns);
      if (haystack instanceof RulesListValue) {
        return haystack.items.includes(needle);
      }
      if (haystack instanceof RulesSetValue) {
        return haystack.items.has(needle);
      }
      if (haystack && typeof haystack === 'object') {
        return typeof needle === 'string' && Object.prototype.hasOwnProperty.call(haystack, needle);
      }
      throw new RulesEvaluationError('Invalid right-hand side of `in`');
    }

    if (nm === 'MemberLookupSimpleExpressionContext') {
      const target = evalExpr(ctx.children[0], env, fns);
      const prop = ctx.children[2].getText();
      if (!target || typeof target !== 'object') {
        throw new RulesEvaluationError(`Null/non-object member lookup .${prop}`);
      }
      if (!Object.prototype.hasOwnProperty.call(target, prop)) {
        throw new RulesEvaluationError(`Property "${prop}" does not exist on map`);
      }
      return (target as Record<string, unknown>)[prop];
    }

    if (nm === 'ListLookupSimpleExpressionContext') {
      const target = evalExpr(ctx.children[0], env, fns);
      const indexCtx = ctx.children[2]; // IndexLookupContext
      const idx = evalExpr(indexCtx.children[0], env, fns);
      if (target instanceof RulesListValue) {
        if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= target.items.length) {
          throw new RulesEvaluationError(`List index ${String(idx)} out of bounds`);
        }
        return target.items[idx];
      }
      if (target && typeof target === 'object' && typeof idx === 'string') {
        if (!Object.prototype.hasOwnProperty.call(target, idx)) {
          throw new RulesEvaluationError(`Key "${idx}" not found in map`);
        }
        return (target as Record<string, unknown>)[idx];
      }
      throw new RulesEvaluationError('Invalid index lookup');
    }

    if (nm === 'FunctionCallSimpleExpressionContext') {
      const fnName = ctx.children[0].getText();
      const exprList = ctx.children.find((c: AntlrNode) => nodeName(c) === 'ExpressionListContext');
      const args: unknown[] = [];
      if (exprList?.children) {
        for (const ch of exprList.children) {
          if (ch.getText() !== ',') {
            args.push(evalExpr(ch, env, fns));
          }
        }
      }

      if (fnName === 'exists') {
        return recordLookup('pre', String(args[0])) !== null;
      }
      if (fnName === 'get') {
        return recordLookup('pre', String(args[0]));
      }
      if (fnName === 'existsAfter') {
        return recordLookup('post', String(args[0])) !== null;
      }
      if (fnName === 'getAfter') {
        return recordLookup('post', String(args[0]));
      }
      if (fnName === 'string') {
        if (args.length !== 1) {
          throw new RulesEvaluationError('string() expects 1 argument');
        }
        const arg = args[0];
        if (
          arg !== null &&
          typeof arg !== 'string' &&
          typeof arg !== 'number' &&
          typeof arg !== 'boolean'
        ) {
          throw new RulesEvaluationError('Invalid argument to string()');
        }
        if (typeof arg === 'number' && !Number.isFinite(arg)) {
          throw new RulesEvaluationError('Non-finite number in string()');
        }
        return String(arg);
      }

      const fn = fns.get(fnName);
      if (!fn) {
        throw new RulesEvaluationError(`Unknown function "${fnName}"`);
      }
      functionCalls += 1;
      currentCallDepth += 1;
      maxCallDepth = Math.max(maxCallDepth, currentCallDepth);
      if (currentCallDepth > 20) {
        currentCallDepth -= 1;
        throw new RulesEvaluationError('Maximum function call stack depth (20) exceeded');
      }
      const childEnv: Record<string, unknown> = { ...env };
      fn.params.forEach((paramName, idx) => {
        childEnv[paramName] = args[idx];
      });
      try {
        for (const b of fn.bindings) {
          childEnv[b.varName] = evalExpr(b.expr, childEnv, fns);
        }
        return evalExpr(fn.returnExpr, childEnv, fns);
      } finally {
        currentCallDepth -= 1;
      }
    }

    if (
      nm === 'MemberFunctionCallSimpleExpressionContext' ||
      nm === 'IdMemberFunctionCallSimpleExpressionContext'
    ) {
      if (
        nm === 'IdMemberFunctionCallSimpleExpressionContext' &&
        ctx.id().getText() === 'math'
      ) {
        const mathMethod = ctx.memberId().getText();
        const exprList = ctx.expressionList?.();
        const mathArgs: unknown[] = [];
        if (exprList?.children) {
          for (const ch of exprList.children) {
            if (ch.getText() !== ',') {
              mathArgs.push(evalExpr(ch, env, fns));
            }
          }
        }
        if (mathMethod === 'abs') {
          if (typeof mathArgs[0] !== 'number') {
            throw new RulesEvaluationError('math.abs() requires number');
          }
          return Math.abs(mathArgs[0]);
        }
        throw new RulesEvaluationError(`Unsupported math.${mathMethod}()`);
      }

      const target =
        nm === 'IdMemberFunctionCallSimpleExpressionContext'
          ? (() => {
              const varName = ctx.id().getText();
              if (!(varName in env)) {
                throw new RulesEvaluationError(`Undefined variable: ${varName}`);
              }
              return env[varName];
            })()
          : evalExpr(ctx.children[0], env, fns);
      const methodName = ctx.memberId().getText();
      const exprList = ctx.expressionList?.();
      const args: unknown[] = [];
      if (exprList?.children) {
        for (const ch of exprList.children) {
          if (ch.getText() !== ',') {
            args.push(evalExpr(ch, env, fns));
          }
        }
      }

      if (methodName === 'size') {
        if (typeof target === 'string') return target.length;
        if (target instanceof RulesListValue) return target.items.length;
        if (target instanceof RulesSetValue) return target.items.size;
        if (target && typeof target === 'object') return Object.keys(target).length;
        throw new RulesEvaluationError('.size() called on unsupported value');
      }

      if (methodName === 'matches') {
        if (typeof target !== 'string' || typeof args[0] !== 'string') {
          throw new RulesEvaluationError('.matches() requires string');
        }
        return new RegExp(args[0]).test(target);
      }

      if (methodName === 'join') {
        if (!(target instanceof RulesListValue) || typeof args[0] !== 'string') {
          throw new RulesEvaluationError('.join() requires list and string separator');
        }
        // Match real Firebase CEL ListType$Join: primitives (string, number, boolean, null)
        // are stringified via ToString; maps, lists, symbols, and non-finite numbers throw.
        const parts: string[] = [];
        for (const item of target.items) {
          if (item === null) {
            parts.push('null');
          } else if (typeof item === 'string') {
            parts.push(item);
          } else if (typeof item === 'boolean') {
            parts.push(item ? 'true' : 'false');
          } else if (typeof item === 'number' && Number.isFinite(item)) {
            parts.push(String(item));
          } else {
            throw new RulesEvaluationError('.join() cannot stringify non-primitive item');
          }
        }
        return parts.join(args[0]);
      }

      if (methodName === 'concat') {
        if (!(target instanceof RulesListValue) || !(args[0] instanceof RulesListValue)) {
          throw new RulesEvaluationError('.concat() requires two lists');
        }
        return new RulesListValue([...target.items, ...args[0].items]);
      }

      if (methodName === 'split') {
        if (typeof target !== 'string' || typeof args[0] !== 'string') {
          throw new RulesEvaluationError('.split() requires string and regex');
        }
        const parts = target.split(new RegExp(args[0]));
        while (parts.length > 1 && parts[parts.length - 1] === '') {
          parts.pop();
        }
        return new RulesListValue(parts);
      }

      if (methodName === 'keys') {
        if (
          !target ||
          typeof target !== 'object' ||
          target instanceof RulesListValue ||
          target instanceof RulesSetValue ||
          target instanceof RulesMapDiffValue ||
          typeof target === 'symbol'
        ) {
          throw new RulesEvaluationError('.keys() requires map');
        }
        return new RulesListValue(Object.keys(target));
      }

      if (methodName === 'values') {
        if (
          !target ||
          typeof target !== 'object' ||
          target instanceof RulesListValue ||
          target instanceof RulesSetValue ||
          target instanceof RulesMapDiffValue ||
          typeof target === 'symbol'
        ) {
          throw new RulesEvaluationError('.values() requires map');
        }
        return new RulesListValue(Object.values(target));
      }

      if (methodName === 'hasAll') {
        const allow = args[0] as RulesListValue;
        const set =
          target instanceof RulesListValue
            ? new Set(target.items)
            : target instanceof RulesSetValue
            ? target.items
            : null;
        if (!set || !(allow instanceof RulesListValue)) {
          throw new RulesEvaluationError('.hasAll() requires list/set');
        }
        return allow.items.every((item) => set.has(item));
      }

      if (methodName === 'hasOnly') {
        const allow = args[0] as RulesListValue;
        const items =
          target instanceof RulesListValue
            ? target.items
            : target instanceof RulesSetValue
            ? Array.from(target.items)
            : null;
        if (!items || !(allow instanceof RulesListValue)) {
          throw new RulesEvaluationError('.hasOnly() requires list/set');
        }
        const allowSet = new Set(allow.items);
        return items.every((item) => allowSet.has(item));
      }

      if (methodName === 'diff') {
        if (!target || typeof target !== 'object' || !args[0] || typeof args[0] !== 'object') {
          throw new RulesEvaluationError('.diff() requires two maps');
        }
        return new RulesMapDiffValue(
          unwrapPlainObject(target),
          unwrapPlainObject(args[0])
        );
      }

      if (methodName === 'affectedKeys') {
        if (!(target instanceof RulesMapDiffValue)) {
          throw new RulesEvaluationError('.affectedKeys() requires MapDiff');
        }
        return target.affectedKeys();
      }

      throw new RulesEvaluationError(`Unsupported method .${methodName}()`);
    }

    throw new RulesEvaluationError(`Unhandled AST node: ${nm}`);
  }

  // Collect all matching permission declarations across nested match blocks (Firestore ORs matching allow blocks)
  const matchedPermissions: Array<{
    perm: ParsedPermission;
    bindings: Record<string, string>;
    fns: Map<string, ParsedFunction>;
  }> = [];

  function traverseMatches(
    blocks: ParsedMatchBlock[],
    partIdx: number,
    inheritedBindings: Record<string, string>,
    inheritedFns: Map<string, ParsedFunction>
  ) {
    for (const blk of blocks) {
      const m = matchSegments(blk.segments, pathParts, partIdx);
      if (!m.matched) continue;
      const nextBindings = { ...inheritedBindings, ...m.bindings };
      const nextFns = new Map(inheritedFns);
      for (const [k, v] of blk.functions.entries()) {
        nextFns.set(k, v);
      }
      const nextIdx = partIdx + m.consumed;
      if (nextIdx === pathParts.length) {
        for (const perm of blk.permissions) {
          if (perm.operations.includes(req.op)) {
            matchedPermissions.push({ perm, bindings: nextBindings, fns: nextFns });
          }
        }
      }
      if (nextIdx < pathParts.length && blk.children.length > 0) {
        traverseMatches(blk.children, nextIdx, nextBindings, nextFns);
      }
    }
  }

  traverseMatches(topMatches, 0, {}, new Map());

  if (matchedPermissions.length === 0) {
    return {
      allowed: false,
      expressionsEvaluated: 0,
      maxCallDepth: 0,
      functionCalls: 0,
      dbLookups: 0,
      denialReason: 'No matching rule',
    };
  }

  let lastReason: string | undefined;
  for (const candidate of matchedPermissions) {
    if (!candidate.perm.conditionExpr) {
      return { allowed: true, expressionsEvaluated, maxCallDepth, functionCalls, dbLookups };
    }
    const env = { ...baseEnv, ...candidate.bindings };
    try {
      const result = evalExpr(candidate.perm.conditionExpr, env, candidate.fns);
      if (result === true) {
        return { allowed: true, expressionsEvaluated, maxCallDepth, functionCalls, dbLookups };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('1,000') ||
        msg.includes('stack depth') ||
        msg.includes('lookup limit') ||
        msg.includes('Forbidden get()')
      ) {
        return {
          allowed: false,
          expressionsEvaluated,
          maxCallDepth,
          functionCalls,
          dbLookups,
          denialReason: msg,
        };
      }
      lastReason = msg;
    }
  }

  return {
    allowed: false,
    expressionsEvaluated,
    maxCallDepth,
    functionCalls,
    dbLookups,
    denialReason: lastReason || 'Rule condition evaluated to false',
  };
}

interface AtomicWriteOp {
  op: 'create' | 'update' | 'delete';
  path: string;
  data?: Record<string, unknown>;
}

function evaluateAtomicBatch(
  topMatches: ParsedMatchBlock[],
  params: {
    auth: AuthContext | null;
    preStore: DocMap;
    writes: AtomicWriteOp[];
  }
): {
  allowed: boolean;
  postStore: DocMap;
  maxExpressionsSingleRule: number;
  totalDbLookups: number;
  results: EvalResult[];
} {
  const postStore: DocMap = { ...params.preStore };
  for (const w of params.writes) {
    const norm = normalizeStorePath(w.path);
    if (w.op === 'create') {
      if (params.preStore[norm]) {
        return {
          allowed: false,
          postStore: params.preStore,
          maxExpressionsSingleRule: 0,
          totalDbLookups: 0,
          results: [
            {
              allowed: false,
              expressionsEvaluated: 0,
              maxCallDepth: 0,
              functionCalls: 0,
              dbLookups: 0,
              denialReason: 'Document already exists on create',
            },
          ],
        };
      }
      postStore[norm] = w.data ?? {};
    } else if (w.op === 'update') {
      if (!params.preStore[norm]) {
        return {
          allowed: false,
          postStore: params.preStore,
          maxExpressionsSingleRule: 0,
          totalDbLookups: 0,
          results: [
            {
              allowed: false,
              expressionsEvaluated: 0,
              maxCallDepth: 0,
              functionCalls: 0,
              dbLookups: 0,
              denialReason: 'Document does not exist on update',
            },
          ],
        };
      }
      postStore[norm] = w.data ?? {};
    } else if (w.op === 'delete') {
      delete postStore[norm];
    }
  }

  const results: EvalResult[] = [];
  let maxExpressionsSingleRule = 0;
  let totalDbLookups = 0;

  for (const w of params.writes) {
    const res = evaluateSingleRequest(topMatches, {
      op: w.op,
      path: w.path,
      auth: params.auth,
      requestData: w.data,
      preStore: params.preStore,
      postStore,
      isBatchOrTransaction: true,
    });
    results.push(res);
    maxExpressionsSingleRule = Math.max(maxExpressionsSingleRule, res.expressionsEvaluated);
    totalDbLookups += res.dbLookups;
  }

  const allowed = results.every((r) => r.allowed) && totalDbLookups <= 20;
  return {
    allowed,
    postStore: allowed ? postStore : params.preStore,
    maxExpressionsSingleRule,
    totalDbLookups,
    results,
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('WOOPP 6.0 Hardened Firestore Security Rules & Query Compliance Suite', () => {
  const compiledRules = compileFirestoreRules(rulesSource);

  const OWNER_UID = 'owner-woopp-admin';
  const OTHER_UID = 'other-user-999';
  const NOW_ISO = '2026-10-31T08:00:00.000Z';
  const LATER_ISO = '2026-10-31T09:15:00.000Z';

  // Simulates real `signInWithEmailAndPassword` token for `hellodzul@gmail.com` (even with email_verified: false)
  const OWNER_AUTH: AuthContext = {
    uid: OWNER_UID,
    token: {
      email: 'hellodzul@gmail.com',
      email_verified: false,
      firebase: {
        sign_in_provider: 'password',
      },
    },
  };

  const OTHER_AUTH: AuthContext = {
    uid: OTHER_UID,
    token: {
      email: 'intruder@example.com',
      email_verified: true,
      firebase: {
        sign_in_provider: 'password',
      },
    },
  };

  const ANON_AUTH: AuthContext = {
    uid: OWNER_UID,
    token: {
      firebase: {
        sign_in_provider: 'anonymous',
      },
    },
  };

  function makeActiveCategory(id = 'cat-charms', ownerId = OWNER_UID) {
    return prepareCategoryForFirestore(
      {
        id,
        ownerId,
        name: 'Charm Keycaps',
        description: '3D printed charm keycaps',
        imageUrl: 'https://cdn.woopp.my/categories/charms.webp',
        iconName: 'sparkles',
        sortOrder: 0,
        status: 'active',
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
      ownerId
    ) as unknown as Record<string, unknown>;
  }

  function makeProduct(overrides: Record<string, unknown> = {}) {
    const base = prepareProductForFirestore(
      {
        id: 'prod-charm-moon',
        ownerId: OWNER_UID,
        sku: 'WOOPP-8KM4NP2Q',
        name: 'Charm Moon',
        description: 'Crescent moon charm keycap',
        categoryId: 'cat-charms',
        priceMyr: 14.9,
        images: ['https://cdn.woopp.my/products/charm-moon-1.webp'],
        options: [],
        variants: [],
        status: 'active',
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
      OWNER_UID
    ) as unknown as Record<string, unknown>;
    return { ...base, ...overrides };
  }

  function makeSkuDoc(sku = 'WOOPP-8KM4NP2Q', productId = 'prod-charm-moon', ownerId = OWNER_UID) {
    return prepareSkuReservationForFirestore(
      {
        sku,
        ownerId,
        productId,
        createdAt: NOW_ISO,
      },
      ownerId
    ) as unknown as Record<string, unknown>;
  }

  it('1. allows valid category creation, atomic product + SKU creation, and preserves immutable SKUs on edit', () => {
    let store: DocMap = {};

    // Create category
    const catDoc = makeActiveCategory('cat-charms');
    const catCreate = evaluateAtomicBatch(compiledRules, {
      auth: OWNER_AUTH,
      preStore: store,
      writes: [
        {
          op: 'create',
          path: `/users/${OWNER_UID}/catalogCategories/cat-charms`,
          data: catDoc,
        },
      ],
    });
    expect(catCreate.allowed).toBe(true);
    store = catCreate.postStore;

    // Atomically create product + matching SKU reservation
    const prodDoc = makeProduct();
    const skuDoc = makeSkuDoc();
    const atomicCreate = evaluateAtomicBatch(compiledRules, {
      auth: OWNER_AUTH,
      preStore: store,
      writes: [
        {
          op: 'create',
          path: `/users/${OWNER_UID}/catalogSkus/WOOPP-8KM4NP2Q`,
          data: skuDoc,
        },
        {
          op: 'create',
          path: `/users/${OWNER_UID}/catalogProducts/prod-charm-moon`,
          data: prodDoc,
        },
      ],
    });
    expect(atomicCreate.allowed).toBe(true);
    expect(atomicCreate.maxExpressionsSingleRule).toBeLessThan(1000);
    store = atomicCreate.postStore;

    // Valid product edit preserving immutable SKU succeeds
    const validUpdate = evaluateAtomicBatch(compiledRules, {
      auth: OWNER_AUTH,
      preStore: store,
      writes: [
        {
          op: 'update',
          path: `/users/${OWNER_UID}/catalogProducts/prod-charm-moon`,
          data: {
            ...prodDoc,
            name: 'Charm Moon Deluxe',
            priceMyr: 16.5,
            updatedAt: LATER_ISO,
          },
        },
      ],
    });
    expect(validUpdate.allowed).toBe(true);
  });

  it('2. enforces strict two-way atomic SKU integrity and rejects standalone, orphaned, mismatched, duplicate, or mutated SKUs', () => {
    const catDoc = makeActiveCategory('cat-charms');
    const existingProd = makeProduct({
      id: 'prod-existing',
      sku: 'WOOPP-EXIST123',
    });
    const existingSku = makeSkuDoc('WOOPP-EXIST123', 'prod-existing');

    const store: DocMap = {
      [`/users/${OWNER_UID}/catalogCategories/cat-charms`]: catDoc,
      [`/users/${OWNER_UID}/catalogProducts/prod-existing`]: existingProd,
      [`/users/${OWNER_UID}/catalogSkus/WOOPP-EXIST123`]: existingSku,
    };

    // 2a. Reject standalone product creation without SKU reservation
    const standaloneProd = evaluateAtomicBatch(compiledRules, {
      auth: OWNER_AUTH,
      preStore: store,
      writes: [
        {
          op: 'create',
          path: `/users/${OWNER_UID}/catalogProducts/prod-solo`,
          data: makeProduct({ id: 'prod-solo', sku: 'WOOPP-SOLO1234' }),
        },
      ],
    });
    expect(standaloneProd.allowed).toBe(false);

    // 2b. Reject standalone orphaned SKU reservation without product
    const standaloneSku = evaluateAtomicBatch(compiledRules, {
      auth: OWNER_AUTH,
      preStore: store,
      writes: [
        {
          op: 'create',
          path: `/users/${OWNER_UID}/catalogSkus/WOOPP-ORPHAN99`,
          data: makeSkuDoc('WOOPP-ORPHAN99', 'prod-missing'),
        },
      ],
    });
    expect(standaloneSku.allowed).toBe(false);

    // 2c. Reject orphaned secondary SKU pointing to an ALREADY-EXISTING product
    const secondarySkuOnExistingProduct = evaluateAtomicBatch(compiledRules, {
      auth: OWNER_AUTH,
      preStore: store,
      writes: [
        {
          op: 'create',
          path: `/users/${OWNER_UID}/catalogSkus/WOOPP-SECOND99`,
          data: makeSkuDoc('WOOPP-SECOND99', 'prod-existing'),
        },
      ],
    });
    expect(secondarySkuOnExistingProduct.allowed).toBe(false);

    // 2d. Reject mismatched productId in atomic batch (prod-A +prod-B mismatch)
    const mismatchedBatch = evaluateAtomicBatch(compiledRules, {
      auth: OWNER_AUTH,
      preStore: store,
      writes: [
        {
          op: 'create',
          path: `/users/${OWNER_UID}/catalogProducts/prod-alpha`,
          data: makeProduct({ id: 'prod-alpha', sku: 'WOOPP-MISMATCH' }),
        },
        {
          op: 'create',
          path: `/users/${OWNER_UID}/catalogSkus/WOOPP-MISMATCH`,
          data: makeSkuDoc('WOOPP-MISMATCH', 'prod-beta'),
        },
      ],
    });
    expect(mismatchedBatch.allowed).toBe(false);

    // 2e. Reject duplicate SKU hijacking (new product trying to claim WOOPP-EXIST123)
    const hijackExistingSku = evaluateAtomicBatch(compiledRules, {
      auth: OWNER_AUTH,
      preStore: store,
      writes: [
        {
          op: 'create',
          path: `/users/${OWNER_UID}/catalogProducts/prod-hijack`,
          data: makeProduct({ id: 'prod-hijack', sku: 'WOOPP-EXIST123' }),
        },
      ],
    });
    expect(hijackExistingSku.allowed).toBe(false);

    // 2f. Reject mutating SKU on existing product update
    const mutateSku = evaluateAtomicBatch(compiledRules, {
      auth: OWNER_AUTH,
      preStore: store,
      writes: [
        {
          op: 'update',
          path: `/users/${OWNER_UID}/catalogProducts/prod-existing`,
          data: {
            ...existingProd,
            sku: 'WOOPP-CHANGED9',
            updatedAt: LATER_ISO,
          },
        },
      ],
    });
    expect(mutateSku.allowed).toBe(false);

    // 2g. Reject updating or deleting catalogSkus directly
    const updateSkuDoc = evaluateSingleRequest(compiledRules, {
      op: 'update',
      path: `/users/${OWNER_UID}/catalogSkus/WOOPP-EXIST123`,
      auth: OWNER_AUTH,
      requestData: makeSkuDoc('WOOPP-EXIST123', 'prod-hijack'),
      preStore: store,
    });
    expect(updateSkuDoc.allowed).toBe(false);

    const deleteSkuDoc = evaluateSingleRequest(compiledRules, {
      op: 'delete',
      path: `/users/${OWNER_UID}/catalogSkus/WOOPP-EXIST123`,
      auth: OWNER_AUTH,
      preStore: store,
    });
    expect(deleteSkuDoc.allowed).toBe(false);
  });

  it('3. validates ALL product images (indices 0..11) and ALL variant imageUrls, and stays below 1,000 expressions even at full capacity', () => {
    const store: DocMap = {
      [`/users/${OWNER_UID}/catalogCategories/cat-charms`]: makeActiveCategory('cat-charms'),
    };

    // 3a. Reject base64 data URI injected at index 5 while index 0 is valid HTTPS!
    const badMiddleImages = [
      'https://cdn.woopp.my/p/0.webp',
      'https://cdn.woopp.my/p/1.webp',
      'https://cdn.woopp.my/p/2.webp',
      'https://cdn.woopp.my/p/3.webp',
      'https://cdn.woopp.my/p/4.webp',
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA',
    ];
    const rejectMiddleBase64 = evaluateAtomicBatch(compiledRules, {
      auth: OWNER_AUTH,
      preStore: store,
      writes: [
        {
          op: 'create',
          path: `/users/${OWNER_UID}/catalogSkus/WOOPP-BADIMG05`,
          data: makeSkuDoc('WOOPP-BADIMG05', 'prod-bad-5'),
        },
        {
          op: 'create',
          path: `/users/${OWNER_UID}/catalogProducts/prod-bad-5`,
          data: makeProduct({
            id: 'prod-bad-5',
            sku: 'WOOPP-BADIMG05',
            images: badMiddleImages,
          }),
        },
      ],
    });
    expect(rejectMiddleBase64.allowed).toBe(false);

    // 3b. Reject insecure http:// URL at the very last allowed slot (index 11)
    const elevenHttpsPlusLastHttp = Array.from({ length: 12 }, (_, idx) =>
      idx === 11
        ? 'http://insecure.example.com/photo-11.jpg'
        : `https://cdn.woopp.my/p/${idx}.webp`
    );
    const rejectLastHttp = evaluateAtomicBatch(compiledRules, {
      auth: OWNER_AUTH,
      preStore: store,
      writes: [
        {
          op: 'create',
          path: `/users/${OWNER_UID}/catalogSkus/WOOPP-BADIMG11`,
          data: makeSkuDoc('WOOPP-BADIMG11', 'prod-bad-11'),
        },
        {
          op: 'create',
          path: `/users/${OWNER_UID}/catalogProducts/prod-bad-11`,
          data: makeProduct({
            id: 'prod-bad-11',
            sku: 'WOOPP-BADIMG11',
            images: elevenHttpsPlusLastHttp,
          }),
        },
      ],
    });
    expect(rejectLastHttp.allowed).toBe(false);

    // 3c. Reject >2048 character HTTPS URL at index 2
    const oversizedUrl = `https://cdn.woopp.my/${'a'.repeat(2040)}.webp`;
    expect(oversizedUrl.length).toBeGreaterThan(2048);
    const rejectOversized = evaluateAtomicBatch(compiledRules, {
      auth: OWNER_AUTH,
      preStore: store,
      writes: [
        {
          op: 'create',
          path: `/users/${OWNER_UID}/catalogSkus/WOOPP-OVER2048`,
          data: makeSkuDoc('WOOPP-OVER2048', 'prod-oversized'),
        },
        {
          op: 'create',
          path: `/users/${OWNER_UID}/catalogProducts/prod-oversized`,
          data: makeProduct({
            id: 'prod-oversized',
            sku: 'WOOPP-OVER2048',
            images: [
              'https://cdn.woopp.my/0.webp',
              'https://cdn.woopp.my/1.webp',
              oversizedUrl,
            ],
          }),
        },
      ],
    });
    expect(rejectOversized.allowed).toBe(false);

    // 3d. Reject >12 images (13 valid HTTPS URLs)
    const thirteenImages = Array.from(
      { length: 13 },
      (_, idx) => `https://cdn.woopp.my/p/${idx}.webp`
    );
    const rejectThirteen = evaluateAtomicBatch(compiledRules, {
      auth: OWNER_AUTH,
      preStore: store,
      writes: [
        {
          op: 'create',
          path: `/users/${OWNER_UID}/catalogSkus/WOOPP-IMGCOUNT`,
          data: makeSkuDoc('WOOPP-IMGCOUNT', 'prod-13'),
        },
        {
          op: 'create',
          path: `/users/${OWNER_UID}/catalogProducts/prod-13`,
          data: makeProduct({
            id: 'prod-13',
            sku: 'WOOPP-IMGCOUNT',
            images: thirteenImages,
          }),
        },
      ],
    });
    expect(rejectThirteen.allowed).toBe(false);

    // 3e. Reject non-HTTPS / base64 imageUrl inside a secondary variant (variants[3].imageUrl)
    const badVariants = Array.from({ length: 4 }, (_, idx) => ({
      id: `var-${idx + 1}`,
      label: `Variant ${idx + 1}`,
      optionValues: { Style: `V${idx + 1}` },
      priceMyr: 15,
      imageUrl:
        idx === 3
          ? 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
          : `https://cdn.woopp.my/v/${idx}.webp`,
      sortOrder: idx,
    }));
    const rejectBadVariantImg = evaluateAtomicBatch(compiledRules, {
      auth: OWNER_AUTH,
      preStore: store,
      writes: [
        {
          op: 'create',
          path: `/users/${OWNER_UID}/catalogSkus/WOOPP-BADVAR03`,
          data: makeSkuDoc('WOOPP-BADVAR03', 'prod-bad-var'),
        },
        {
          op: 'create',
          path: `/users/${OWNER_UID}/catalogProducts/prod-bad-var`,
          data: makeProduct({
            id: 'prod-bad-var',
            sku: 'WOOPP-BADVAR03',
            options: [{ id: 'opt-1', name: 'Style', values: ['V1', 'V2', 'V3', 'V4'], sortOrder: 0 }],
            variants: badVariants,
          }),
        },
      ],
    });
    expect(rejectBadVariantImg.allowed).toBe(false);

    // 3f. Worst-case maxed-out valid product (12 HTTPS images + 4 options + 12 HTTPS-imaged variants)
    // MUST pass AND stay safely under Firestore's 1,000-expression ceiling!
    const maxImages = Array.from(
      { length: MAX_PRODUCT_IMAGES },
      (_, idx) => `https://cdn.woopp.my/gallery/img-${idx}.webp`
    );
    const maxOptions = Array.from({ length: MAX_PRODUCT_OPTIONS }, (_, idx) => ({
      id: `opt-${idx + 1}`,
      name: `Option ${idx + 1}`,
      values: ['A', 'B'],
      sortOrder: idx,
    }));
    const maxVariants = Array.from({ length: 12 }, (_, idx) => ({
      id: `var-${idx + 1}`,
      label: `Combo ${idx + 1}`,
      optionValues: { 'Option 1': 'A', 'Option 2': 'B' },
      priceMyr: 19.9,
      imageUrl: `https://cdn.woopp.my/variants/v-${idx}.webp`,
      sortOrder: idx,
    }));

    const maxedOutValid = evaluateAtomicBatch(compiledRules, {
      auth: OWNER_AUTH,
      preStore: store,
      writes: [
        {
          op: 'create',
          path: `/users/${OWNER_UID}/catalogSkus/WOOPP-MAXCAP12`,
          data: makeSkuDoc('WOOPP-MAXCAP12', 'prod-maxed'),
        },
        {
          op: 'create',
          path: `/users/${OWNER_UID}/catalogProducts/prod-maxed`,
          data: makeProduct({
            id: 'prod-maxed',
            sku: 'WOOPP-MAXCAP12',
            images: maxImages,
            options: maxOptions,
            variants: maxVariants,
          }),
        },
      ],
    });
    expect(maxedOutValid.allowed, JSON.stringify(maxedOutValid.results)).toBe(true);
    expect(maxedOutValid.maxExpressionsSingleRule).toBeLessThan(1000);
    expect(maxedOutValid.totalDbLookups).toBe(5);
    for (const r of maxedOutValid.results) {
      expect(r.maxCallDepth).toBeLessThanOrEqual(20);
      expect(r.dbLookups).toBeLessThanOrEqual(10);
    }
  });

  it('4. enforces list query alignment between frontend query builders and Firestore allow list rules', () => {
    const store: DocMap = {
      [`/users/${OWNER_UID}/catalogCategories/cat-charms`]: makeActiveCategory('cat-charms'),
      [`/users/${OWNER_UID}/catalogProducts/prod-charm-moon`]: makeProduct(),
    };

    // 4a. Verify all 4 frontend query builders construct filtered queries (`type === "query"`)
    // with an explicit `where("ownerId", "==", ownerId)` constraint
    const catQuery = buildCatalogCategoriesQuery(OWNER_UID);
    const prodQuery = buildCatalogProductsQuery(OWNER_UID);
    const skuQuery = buildCatalogSkusQuery(OWNER_UID);
    const setQuery = buildCatalogPlateSettingsQuery(OWNER_UID);

    for (const q of [catQuery, prodQuery, skuQuery, setQuery]) {
      expect(q.type).toBe('query');
      const internalFilters = (
        q as unknown as {
          _query?: {
            filters?: Array<{
              field?: { canonicalString?: () => string };
              op?: string;
              value?: { stringValue?: string };
            }>;
          };
        }
      )._query?.filters;
      expect(Array.isArray(internalFilters)).toBe(true);
      expect(internalFilters).toHaveLength(1);
      expect(internalFilters?.[0]?.field?.canonicalString?.()).toBe('ownerId');
      expect(internalFilters?.[0]?.op).toBe('==');
      expect(internalFilters?.[0]?.value?.stringValue).toBe(OWNER_UID);
    }

    // 4b. Filtered owner list queries succeed with 0 DB lookups inside `allow list`
    for (const subcol of [
      'catalogCategories',
      'catalogProducts',
      'catalogSkus',
      'catalogPlateSettings',
    ]) {
      const allowedList = evaluateSingleRequest(compiledRules, {
        op: 'list',
        path: `/users/${OWNER_UID}/${subcol}/any-doc`,
        auth: OWNER_AUTH,
        preStore: store,
        queryConstraints: { ownerId: OWNER_UID },
      });
      expect(allowedList.allowed).toBe(true);
      expect(allowedList.dbLookups).toBe(0);
      expect(allowedList.maxCallDepth).toBeLessThanOrEqual(20);

      // Unfiltered list query (missing `where('ownerId', '==', uid)`) is rejected
      const unfilteredList = evaluateSingleRequest(compiledRules, {
        op: 'list',
        path: `/users/${OWNER_UID}/${subcol}/any-doc`,
        auth: OWNER_AUTH,
        preStore: store,
      });
      expect(unfilteredList.allowed).toBe(false);

      // Cross-user list query is rejected even if attacker passes `where('ownerId', '==', OTHER_UID)`
      const crossUserList = evaluateSingleRequest(compiledRules, {
        op: 'list',
        path: `/users/${OWNER_UID}/${subcol}/any-doc`,
        auth: OTHER_AUTH,
        preStore: store,
        queryConstraints: { ownerId: OTHER_UID },
      });
      expect(crossUserList.allowed).toBe(false);

      // Anonymous list query is rejected even if UID matches
      const anonList = evaluateSingleRequest(compiledRules, {
        op: 'list',
        path: `/users/${OWNER_UID}/${subcol}/any-doc`,
        auth: ANON_AUTH,
        preStore: store,
        queryConstraints: { ownerId: OWNER_UID },
      });
      expect(anonList.allowed).toBe(false);
    }
  });

  it('5. denies unauthenticated, anonymous, cross-tenant, and shadow-field access while preserving independent single-owner workspaces', () => {
    const store: DocMap = {
      [`/users/${OWNER_UID}/catalogCategories/cat-charms`]: makeActiveCategory('cat-charms'),
      [`/users/${OWNER_UID}/catalogProducts/prod-charm-moon`]: makeProduct(),
    };

    // Unauthenticated read & write denied
    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'get',
        path: `/users/${OWNER_UID}/catalogProducts/prod-charm-moon`,
        auth: null,
        preStore: store,
      }).allowed
    ).toBe(false);

    // Anonymous provider read & write denied even if UID matches
    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'get',
        path: `/users/${OWNER_UID}/catalogProducts/prod-charm-moon`,
        auth: ANON_AUTH,
        preStore: store,
      }).allowed
    ).toBe(false);

    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'create',
        path: `/users/${OWNER_UID}/catalogCategories/cat-anon`,
        auth: ANON_AUTH,
        requestData: makeActiveCategory('cat-anon'),
        preStore: store,
      }).allowed
    ).toBe(false);

    // Cross-user read & write denied
    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'get',
        path: `/users/${OWNER_UID}/catalogProducts/prod-charm-moon`,
        auth: OTHER_AUTH,
        preStore: store,
      }).allowed
    ).toBe(false);

    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'update',
        path: `/users/${OWNER_UID}/catalogCategories/cat-charms`,
        auth: OTHER_AUTH,
        requestData: { ...makeActiveCategory('cat-charms'), name: 'Hacked' },
        preStore: store,
      }).allowed
    ).toBe(false);

    // Independent second owner (`OTHER_AUTH`) CAN read/write their OWN isolated `/users/${OTHER_UID}/...` workspace
    // (confirming no hardcoded single-email regression breaks other non-anonymous owners)
    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'create',
        path: `/users/${OTHER_UID}/catalogCategories/cat-own`,
        auth: OTHER_AUTH,
        requestData: makeActiveCategory('cat-own', OTHER_UID),
        preStore: store,
      }).allowed
    ).toBe(true);

    // Shadow / ghost field injection (`printable: true` or `isAdmin: true`) denied
    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'update',
        path: `/users/${OWNER_UID}/catalogProducts/prod-charm-moon`,
        auth: OWNER_AUTH,
        requestData: {
          ...makeProduct(),
          printable: true,
          updatedAt: LATER_ISO,
        },
        preStore: store,
      }).allowed
    ).toBe(false);

    // Global default-deny blocks undeclared root collections
    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'get',
        path: '/publicCatalog/item-1',
        auth: OWNER_AUTH,
        preStore: store,
      }).allowed
    ).toBe(false);
  });

  it('6. enforces same-owner category references and safe archived-category behavior without breaking historical products', () => {
    const activeCatA = makeActiveCategory('cat-active-a');
    const activeCatB = makeActiveCategory('cat-active-b');
    const archivedCat: Record<string, unknown> = {
      ...makeActiveCategory('cat-archived'),
      status: 'archived',
    };
    const otherUserCat = makeActiveCategory('cat-other-owner', OTHER_UID);

    const existingProdInArchivedCat = makeProduct({
      id: 'prod-legacy-in-archived',
      sku: 'WOOPP-ARCHPROD',
      categoryId: 'cat-archived',
    });

    const store: DocMap = {
      [`/users/${OWNER_UID}/catalogCategories/cat-active-a`]: activeCatA,
      [`/users/${OWNER_UID}/catalogCategories/cat-active-b`]: activeCatB,
      [`/users/${OWNER_UID}/catalogCategories/cat-archived`]: archivedCat,
      [`/users/${OTHER_UID}/catalogCategories/cat-other-owner`]: otherUserCat,
      [`/users/${OWNER_UID}/catalogProducts/prod-legacy-in-archived`]: existingProdInArchivedCat,
      [`/users/${OWNER_UID}/catalogSkus/WOOPP-ARCHPROD`]: makeSkuDoc(
        'WOOPP-ARCHPROD',
        'prod-legacy-in-archived'
      ),
    };

    // 6a. Reject creating a product referencing a nonexistent category
    expect(
      evaluateAtomicBatch(compiledRules, {
        auth: OWNER_AUTH,
        preStore: store,
        writes: [
          {
            op: 'create',
            path: `/users/${OWNER_UID}/catalogSkus/WOOPP-NOCAT123`,
            data: makeSkuDoc('WOOPP-NOCAT123', 'prod-nocat'),
          },
          {
            op: 'create',
            path: `/users/${OWNER_UID}/catalogProducts/prod-nocat`,
            data: makeProduct({
              id: 'prod-nocat',
              sku: 'WOOPP-NOCAT123',
              categoryId: 'cat-does-not-exist',
            }),
          },
        ],
      }).allowed
    ).toBe(false);

    // 6b. Reject creating a product referencing another user's category ID
    expect(
      evaluateAtomicBatch(compiledRules, {
        auth: OWNER_AUTH,
        preStore: store,
        writes: [
          {
            op: 'create',
            path: `/users/${OWNER_UID}/catalogSkus/WOOPP-OTHERCAT`,
            data: makeSkuDoc('WOOPP-OTHERCAT', 'prod-othercat'),
          },
          {
            op: 'create',
            path: `/users/${OWNER_UID}/catalogProducts/prod-othercat`,
            data: makeProduct({
              id: 'prod-othercat',
              sku: 'WOOPP-OTHERCAT',
              categoryId: 'cat-other-owner',
            }),
          },
        ],
      }).allowed
    ).toBe(false);

    // 6c. Reject creating a NEW product inside an archived category
    expect(
      evaluateAtomicBatch(compiledRules, {
        auth: OWNER_AUTH,
        preStore: store,
        writes: [
          {
            op: 'create',
            path: `/users/${OWNER_UID}/catalogSkus/WOOPP-NEWINARC`,
            data: makeSkuDoc('WOOPP-NEWINARC', 'prod-new-in-arch'),
          },
          {
            op: 'create',
            path: `/users/${OWNER_UID}/catalogProducts/prod-new-in-arch`,
            data: makeProduct({
              id: 'prod-new-in-arch',
              sku: 'WOOPP-NEWINARC',
              categoryId: 'cat-archived',
            }),
          },
        ],
      }).allowed
    ).toBe(false);

    // 6d. ALLOW editing or archiving an EXISTING product whose category was previously archived
    const editInArchived = evaluateSingleRequest(compiledRules, {
      op: 'update',
      path: `/users/${OWNER_UID}/catalogProducts/prod-legacy-in-archived`,
      auth: OWNER_AUTH,
      requestData: {
        ...existingProdInArchivedCat,
        priceMyr: 18.0,
        status: 'archived',
        updatedAt: LATER_ISO,
      },
      preStore: store,
    });
    expect(editInArchived.allowed).toBe(true);

    // 6e. ALLOW moving that product from `cat-archived` to an ACTIVE category (`cat-active-b`)
    const moveToActive = evaluateSingleRequest(compiledRules, {
      op: 'update',
      path: `/users/${OWNER_UID}/catalogProducts/prod-legacy-in-archived`,
      auth: OWNER_AUTH,
      requestData: {
        ...existingProdInArchivedCat,
        categoryId: 'cat-active-b',
        updatedAt: LATER_ISO,
      },
      preStore: store,
    });
    expect(moveToActive.allowed).toBe(true);

    // 6f. REJECT moving a product from `cat-active-a` INTO `cat-archived`
    const prodInActive = makeProduct({
      id: 'prod-in-active',
      sku: 'WOOPP-ACTPROD1',
      categoryId: 'cat-active-a',
    });
    const storeWithActiveProd: DocMap = {
      ...store,
      [`/users/${OWNER_UID}/catalogProducts/prod-in-active`]: prodInActive,
    };
    const moveIntoArchived = evaluateSingleRequest(compiledRules, {
      op: 'update',
      path: `/users/${OWNER_UID}/catalogProducts/prod-in-active`,
      auth: OWNER_AUTH,
      requestData: {
        ...prodInActive,
        categoryId: 'cat-archived',
        updatedAt: LATER_ISO,
      },
      preStore: storeWithActiveProd,
    });
    expect(moveIntoArchived.allowed).toBe(false);
  });

  it('7. preserves existing production workspace read AND write compatibility (`tracker/main` and `tracker/v5_workspace`) across legacy v1, v5, and WOOPP 6.0 snapshots', () => {
    const requestTime = Symbol('serverTimestamp');
    const historicalServerTime = Symbol('historicalServerTimestamp');

    // Real LegacyTrackerState (`tracker/main`) with 6 colors + historical print jobs
    const legacyV1Doc: LegacyTrackerState = {
      colors: ['Lavender', 'Ivory', 'Charcoal', 'Mint', 'Coral', 'Sky'],
      machines: ['Bambu P1S #1', 'Bambu A1 - 01'],
      jobs: [
        {
          id: 'v1-job-1',
          color: 0,
          plate: 1,
          letters: { A: 60, I: 40, N: 28, E: 10 },
          status: 'Siap' as const,
          machine: 'Bambu P1S #1',
          notes: 'Completed v1 batch',
          updated: '20/10/2026',
        },
        {
          id: 'v1-job-2',
          color: 1,
          plate: 2,
          letters: { E: 14, H: 24, M: 24 },
          status: 'Sedang print' as const,
          machine: 'Bambu A1 - 01',
          notes: 'Active v1 batch',
          updated: '21/10/2026',
        },
      ],
      log: [{ at: '21/10/2026 10:00', msg: 'Started plate 2' }],
    };

    // Migrate real v1 state -> v5, then start a live countdown job AND commit a WOOPP 6.0 catalog plate snapshot
    let activeWs = migrateFromLegacyV1(legacyV1Doc, OWNER_UID);
    const plannedJob = activeWs.jobs.find((j) => j.stage !== 'Completed')!;
    activeWs =
      transitionJobState(activeWs, plannedJob.id, 'Printing', {
        machineId: activeWs.machines[1].id,
        nowMs: 1_760_000_000_000,
      }).nextWorkspace ?? activeWs;

    const commitRes = commitCatalogPlatesToWorkspace(activeWs, {
      projectId: activeWs.projects[0].id,
      colorId: activeWs.colors[0].id,
      category: {
        id: 'cat-charms',
        ownerId: OWNER_UID,
        name: 'Charm Keycaps',
        description: '',
        imageUrl: null,
        iconName: 'sparkles',
        sortOrder: 0,
        status: 'active',
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
      confirmedPlates: [
        {
          tempId: 'draft-1',
          plateNumber: 10,
          categoryId: 'cat-charms',
          categoryName: 'Charm Keycaps',
          capacity: 30,
          estimatedMinutes: 150,
          slicerVerified: true,
          notes: 'Charm batch',
          items: [
            {
              productId: 'prod-charm-moon',
              productName: 'Charm Moon',
              sku: 'WOOPP-8KM4NP2Q',
              categoryId: 'cat-charms',
              categoryName: 'Charm Keycaps',
              variantId: null,
              variantLabel: null,
              colorId: activeWs.colors[0].id,
              colorName: activeWs.colors[0].name,
              quantity: 25,
            },
          ],
        },
      ],
      nowMs: 1_760_000_120_000,
    });
    expect(commitRes.error).toBeUndefined();
    activeWs = commitRes.nextWorkspace!;

    activeWs = {
      ...activeWs,
      settings: {
        ...activeWs.settings,
        adminEmails: ['hellodzul@gmail.com'],
      },
    };

    const validatedV5 = prepareWorkspaceForFirestore(
      activeWs,
      OWNER_UID
    ) as unknown as Record<string, unknown>;

    const store: DocMap = {
      [`/users/${OWNER_UID}/tracker/main`]: legacyV1Doc as unknown as Record<string, unknown>,
      [`/users/${OWNER_UID}/tracker/v5_workspace`]: {
        ...validatedV5,
        serverUpdatedAt: historicalServerTime,
      },
    };

    // 7a. `tracker/main` is readable (`get`), creatable (`create`), and updatable (`update`)
    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'get',
        path: `/users/${OWNER_UID}/tracker/main`,
        auth: OWNER_AUTH,
        preStore: store,
      }).allowed
    ).toBe(true);

    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'create',
        path: `/users/${OWNER_UID}/tracker/main`,
        auth: OWNER_AUTH,
        requestData: legacyV1Doc as unknown as Record<string, unknown>,
        preStore: {},
      }).allowed
    ).toBe(true);

    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'update',
        path: `/users/${OWNER_UID}/tracker/main`,
        auth: OWNER_AUTH,
        requestData: {
          ...legacyV1Doc,
          log: [...legacyV1Doc.log, { at: '22/10/2026', msg: 'Updated v1 log' }],
        } as unknown as Record<string, unknown>,
        preStore: store,
      }).allowed
    ).toBe(true);

    // 7b. `tracker/v5_workspace` is readable (`get`), creatable (`create` with or without `serverUpdatedAt`), and updatable (`update`)
    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'get',
        path: `/users/${OWNER_UID}/tracker/v5_workspace`,
        auth: OWNER_AUTH,
        preStore: store,
      }).allowed
    ).toBe(true);

    const freshWs = prepareWorkspaceForFirestore(
      createFreshWorkspaceV5(OWNER_UID),
      OWNER_UID
    ) as unknown as Record<string, unknown>;

    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'create',
        path: `/users/${OWNER_UID}/tracker/v5_workspace`,
        auth: OWNER_AUTH,
        requestTime,
        requestData: { ...freshWs, serverUpdatedAt: requestTime },
        preStore: {},
      }).allowed
    ).toBe(true);

    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'create',
        path: `/users/${OWNER_UID}/tracker/v5_workspace`,
        auth: OWNER_AUTH,
        requestData: freshWs,
        preStore: {},
      }).allowed
    ).toBe(true);

    // Full `setDoc` with `serverTimestamp()` (`serverUpdatedAt == request.time`) succeeds
    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'update',
        path: `/users/${OWNER_UID}/tracker/v5_workspace`,
        auth: OWNER_AUTH,
        requestTime,
        requestData: {
          ...validatedV5,
          updatedIso: LATER_ISO,
          serverUpdatedAt: requestTime,
        },
        preStore: store,
      }).allowed
    ).toBe(true);

    // Fallback 12-key `setDoc` without `serverUpdatedAt` ALSO succeeds
    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'update',
        path: `/users/${OWNER_UID}/tracker/v5_workspace`,
        auth: OWNER_AUTH,
        requestTime,
        requestData: {
          ...validatedV5,
          updatedIso: LATER_ISO,
        },
        preStore: store,
      }).allowed
    ).toBe(true);

    // Partial/merge update preserving existing `historicalServerTime` ALSO succeeds
    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'update',
        path: `/users/${OWNER_UID}/tracker/v5_workspace`,
        auth: OWNER_AUTH,
        requestTime,
        requestData: {
          ...validatedV5,
          updatedIso: LATER_ISO,
          serverUpdatedAt: historicalServerTime,
        },
        preStore: store,
      }).allowed
    ).toBe(true);

    // Client-forged `serverUpdatedAt` (neither `request.time` nor `existing().serverUpdatedAt`) is REJECTED
    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'update',
        path: `/users/${OWNER_UID}/tracker/v5_workspace`,
        auth: OWNER_AUTH,
        requestTime,
        requestData: {
          ...validatedV5,
          updatedIso: LATER_ISO,
          serverUpdatedAt: '2099-01-01T00:00:00.000Z',
        },
        preStore: store,
      }).allowed
    ).toBe(false);

    // Mutating `ownerId` or deleting either production document is strictly rejected
    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'update',
        path: `/users/${OWNER_UID}/tracker/v5_workspace`,
        auth: OWNER_AUTH,
        requestTime,
        requestData: {
          ...validatedV5,
          ownerId: OTHER_UID,
          serverUpdatedAt: requestTime,
        },
        preStore: store,
      }).allowed
    ).toBe(false);

    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'delete',
        path: `/users/${OWNER_UID}/tracker/main`,
        auth: OWNER_AUTH,
        preStore: store,
      }).allowed
    ).toBe(false);

    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'delete',
        path: `/users/${OWNER_UID}/tracker/v5_workspace`,
        auth: OWNER_AUTH,
        preStore: store,
      }).allowed
    ).toBe(false);
  });

  it('8. validates ALL 12 product variants (indices 0..11) in full with zero weaker validation on indices 1..11', () => {
    const existingProd = makeProduct({
      id: 'prod-12vars',
      sku: 'WOOPP-VARS1212',
      options: [{ id: 'opt-style', name: 'Style', values: ['S1', 'S2'], sortOrder: 0 }],
    });
    const store: DocMap = {
      [`/users/${OWNER_UID}/catalogCategories/cat-charms`]: makeActiveCategory('cat-charms'),
      [`/users/${OWNER_UID}/catalogProducts/prod-12vars`]: existingProd,
      [`/users/${OWNER_UID}/catalogSkus/WOOPP-VARS1212`]: makeSkuDoc('WOOPP-VARS1212', 'prod-12vars'),
    };

    const buildTwelveValidVariants = () =>
      Array.from({ length: 12 }, (_, idx) => ({
        id: `var-item-${idx + 1}`,
        label: `Style Variant ${idx + 1}`,
        optionValues: { Style: `S${idx + 1}` },
        priceMyr: idx % 2 === 0 ? 15.9 : null,
        imageUrl: idx % 2 === 0 ? `https://cdn.woopp.my/v/${idx}.webp` : null,
        sortOrder: idx,
      }));

    // Baseline: all 12 valid variants succeed
    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'update',
        path: `/users/${OWNER_UID}/catalogProducts/prod-12vars`,
        auth: OWNER_AUTH,
        requestData: {
          ...existingProd,
          variants: buildTwelveValidVariants(),
          updatedAt: LATER_ISO,
        },
        preStore: store,
      }).allowed
    ).toBe(true);

    // Every single variant index 0..11 MUST reject invalid fields identically (including ToString coercion, delimiter injection, whitespace, and nested optionValues)
    for (let targetIndex = 0; targetIndex < 12; targetIndex += 1) {
      const invalidCases: Array<(v: Record<string, unknown>) => Record<string, unknown>> = [
        (v) => ({ ...v, id: '' }), // empty id
        (v) => ({ ...v, id: 'bad id with spaces!' }), // invalid id pattern
        (v) => ({ ...v, id: 'x'.repeat(129) }), // id > 128 chars
        (v) => ({ ...v, id: 12345 }), // non-string int id (List.join ToString coercion)
        (v) => ({ ...v, id: true }), // non-string bool id (List.join ToString coercion)
        (v) => ({ ...v, id: null }), // null id (List.join ToString coercion)
        (v) => ({ ...v, label: '' }), // empty label
        (v) => ({ ...v, label: '   ' }), // whitespace-only label
        (v) => ({ ...v, label: 'Valid\n10000\nvar-forged\n10\nnull\nForged' }), // newline delimiter injection
        (v) => ({ ...v, label: 'Valid\rInjected' }), // CR injection
        (v) => ({ ...v, label: 'L'.repeat(201) }), // label > 200 chars
        (v) => ({ ...v, label: 999 }), // non-string int label (List.join ToString coercion)
        (v) => ({ ...v, label: false }), // non-string bool label
        (v) => ({ ...v, label: null }), // null label
        (v) => ({ ...v, optionValues: 'not-a-map' }), // non-map optionValues
        (v) => ({ ...v, optionValues: ['S1'] }), // list optionValues
        (v) => ({
          ...v,
          optionValues: { A: '1', B: '2', C: '3', D: '4', E: '5' }, // >4 keys in optionValues
        }),
        (v) => ({ ...v, optionValues: { Style: 123 } }), // int nested optionValues value
        (v) => ({ ...v, optionValues: { Style: true } }), // bool nested optionValues value
        (v) => ({ ...v, optionValues: { Style: null } }), // null nested optionValues value
        (v) => ({ ...v, optionValues: { Style: { nested: 'x' } } }), // map nested optionValues value
        (v) => ({ ...v, optionValues: { '': 'S1' } }), // empty nested optionValues key
        (v) => ({ ...v, optionValues: { Style: '   ' } }), // whitespace-only nested optionValues value
        (v) => ({ ...v, optionValues: { 'Style\nExtra': 'S1' } }), // newline in nested key
        (v) => ({ ...v, optionValues: { Style: 'S1\nS2' } }), // newline in nested value
        (v) => ({ ...v, optionValues: { ['K'.repeat(61)]: 'S1' } }), // >60-char nested key
        (v) => ({ ...v, optionValues: { Style: 'V'.repeat(81) } }), // >80-char nested value
        (v) => ({ ...v, priceMyr: -0.01 }), // negative priceMyr
        (v) => ({ ...v, priceMyr: 10000001 }), // priceMyr > 10,000,000
        (v) => ({ ...v, priceMyr: '15.90' }), // string priceMyr
        (v) => ({ ...v, priceMyr: true }), // bool priceMyr
        (v) => ({ ...v, imageUrl: 'http://cdn.woopp.my/insecure.jpg' }), // http:// variant image
        (v) => ({ ...v, imageUrl: 'null' }), // string "null" imageUrl
        (v) => ({ ...v, imageUrl: 'https://cdn.woopp.my/ok.jpg 10000 0 null' }), // space delimiter injection in imageUrl
        (v) => ({ ...v, sortOrder: -1 }), // negative sortOrder
        (v) => ({ ...v, sortOrder: 10001 }), // sortOrder > 10000
        (v) => ({ ...v, sortOrder: 1.5 }), // float sortOrder
        (v) => ({ ...v, sortOrder: '0' }), // string sortOrder
        (v) => ({ ...v, sortOrder: true }), // bool sortOrder
        (v) => ({ ...v, extraShadowKey: true }), // extra shadow key
        (v) => {
          const copy = { ...v };
          delete copy.sortOrder; // missing required key
          return copy;
        },
      ];

      for (const mutate of invalidCases) {
        const tamperedVariants = buildTwelveValidVariants().map((v, idx) =>
          idx === targetIndex ? mutate(v) : v
        );
        const res = evaluateSingleRequest(compiledRules, {
          op: 'update',
          path: `/users/${OWNER_UID}/catalogProducts/prod-12vars`,
          auth: OWNER_AUTH,
          requestData: {
            ...existingProd,
            variants: tamperedVariants,
            updatedAt: LATER_ISO,
          },
          preStore: store,
        });
        expect(
          res.allowed,
          `Expected variant[${targetIndex}] mutation ${JSON.stringify(tamperedVariants[targetIndex])} to be rejected`
        ).toBe(false);
      }
    }

    // 13 variants (>12 max) rejected
    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'update',
        path: `/users/${OWNER_UID}/catalogProducts/prod-12vars`,
        auth: OWNER_AUTH,
        requestData: {
          ...existingProd,
          variants: [...buildTwelveValidVariants(), {
            id: 'var-13',
            label: 'Extra 13',
            optionValues: { Style: 'S13' },
            priceMyr: null,
            imageUrl: null,
            sortOrder: 12,
          }],
          updatedAt: LATER_ISO,
        },
        preStore: store,
      }).allowed
    ).toBe(false);
  });

  it('9. fully validates product options (indices 0..3) including id, name, sortOrder, and ALL allowed option values (indices 0..11)', () => {
    const existingProd = makeProduct({
      id: 'prod-opts',
      sku: 'WOOPP-OPTS1234',
    });
    const store: DocMap = {
      [`/users/${OWNER_UID}/catalogCategories/cat-charms`]: makeActiveCategory('cat-charms'),
      [`/users/${OWNER_UID}/catalogProducts/prod-opts`]: existingProd,
      [`/users/${OWNER_UID}/catalogSkus/WOOPP-OPTS1234`]: makeSkuDoc('WOOPP-OPTS1234', 'prod-opts'),
    };

    // Valid single option with all 12 allowed values (1..80 chars each) succeeds
    const twelveValues = Array.from(
      { length: MAX_PRODUCT_OPTION_VALUES },
      (_, idx) => `Value-${idx + 1}`
    );
    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'update',
        path: `/users/${OWNER_UID}/catalogProducts/prod-opts`,
        auth: OWNER_AUTH,
        requestData: {
          ...existingProd,
          options: [{ id: 'opt-12', name: 'Design', values: twelveValues, sortOrder: 0 }],
          updatedAt: LATER_ISO,
        },
        preStore: store,
      }).allowed
    ).toBe(true);

    // Invalid option entry checks across options[0..3]
    const validFourOptions = [
      { id: 'opt-1', name: 'Color', values: ['Black', 'White'], sortOrder: 0 },
      { id: 'opt-2', name: 'Size', values: ['S', 'M'], sortOrder: 1 },
      { id: 'opt-3', name: 'Finish', values: ['Matte', 'Gloss'], sortOrder: 2 },
      { id: 'opt-4', name: 'Clip', values: ['Gold', 'Silver'], sortOrder: 3 },
    ];
    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'update',
        path: `/users/${OWNER_UID}/catalogProducts/prod-opts`,
        auth: OWNER_AUTH,
        requestData: { ...existingProd, options: validFourOptions, updatedAt: LATER_ISO },
        preStore: store,
      }).allowed
    ).toBe(true);

    for (const optIdx of [0, 1, 2, 3]) {
      const invalidOptMutations: Array<(o: Record<string, unknown>) => Record<string, unknown>> = [
        (o) => ({ ...o, id: '' }), // empty id
        (o) => ({ ...o, id: 'invalid id!' }), // bad id chars
        (o) => ({ ...o, id: 'i'.repeat(129) }), // id > 128 chars
        (o) => ({ ...o, id: 42 }), // non-string id
        (o) => ({ ...o, id: 'opt-1\nColor' }), // newline delimiter injection in id
        (o) => ({ ...o, name: '' }), // empty name
        (o) => ({ ...o, name: '   ' }), // whitespace-only name
        (o) => ({ ...o, name: ' Leading' }), // untrimmed name
        (o) => ({ ...o, name: 'Color\n10000\n2\nopt-x\nHack' }), // newline delimiter injection in name
        (o) => ({ ...o, name: true }), // non-string bool name
        (o) => ({ ...o, name: 'N'.repeat(61) }), // name > 60 chars
        (o) => ({ ...o, sortOrder: -1 }), // negative sortOrder
        (o) => ({ ...o, sortOrder: 10001 }), // sortOrder > 10000
        (o) => ({ ...o, sortOrder: 0.5 }), // float sortOrder
        (o) => ({ ...o, sortOrder: '0' }), // string sortOrder
        (o) => ({ ...o, values: [] }), // empty values list
        (o) => ({ ...o, values: ['', 'Valid'] }), // empty string at values[0]
        (o) => ({ ...o, values: ['Valid', ''] }), // empty string at values[1]
        (o) => ({ ...o, values: ['Valid', '   '] }), // whitespace-only at values[1]
        (o) => ({ ...o, values: ['Black\nWhite', ''] }), // split() trailing-empty delimiter trick
        (o) => ({ ...o, values: ['Valid', 'X'.repeat(81)] }), // >80 chars at values[1]
        (o) => ({ ...o, values: ['Valid', 123] }), // non-string int at values[1]
        (o) => ({ ...o, values: ['Valid', true] }), // non-string bool at values[1]
        (o) => ({ ...o, values: ['Valid', null] }), // null at values[1]
        (o) => ({ ...o, extraFlag: true }), // shadow key
        (o) => {
          const copy = { ...o };
          delete copy.sortOrder; // missing sortOrder
          return copy;
        },
      ];

      for (const mutate of invalidOptMutations) {
        const badOptions = validFourOptions.map((o, idx) =>
          idx === optIdx ? mutate(o) : o
        );
        expect(
          evaluateSingleRequest(compiledRules, {
            op: 'update',
            path: `/users/${OWNER_UID}/catalogProducts/prod-opts`,
            auth: OWNER_AUTH,
            requestData: { ...existingProd, options: badOptions, updatedAt: LATER_ISO },
            preStore: store,
          }).allowed,
          `Expected option[${optIdx}] mutation ${JSON.stringify(badOptions[optIdx])} to be rejected`
        ).toBe(false);
      }
    }

    // Invalid option value at the very last allowed slot (`values[11]`) MUST also be rejected
    const badLastValue = [...twelveValues.slice(0, 11), 'V'.repeat(81)];
    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'update',
        path: `/users/${OWNER_UID}/catalogProducts/prod-opts`,
        auth: OWNER_AUTH,
        requestData: {
          ...existingProd,
          options: [{ id: 'opt-12', name: 'Design', values: badLastValue, sortOrder: 0 }],
          updatedAt: LATER_ISO,
        },
        preStore: store,
      }).allowed
    ).toBe(false);

    // 13 option values on a single option (>12 max) rejected
    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'update',
        path: `/users/${OWNER_UID}/catalogProducts/prod-opts`,
        auth: OWNER_AUTH,
        requestData: {
          ...existingProd,
          options: [
            {
              id: 'opt-13',
              name: 'Design',
              values: [...twelveValues, 'Value-13'],
              sortOrder: 0,
            },
          ],
          updatedAt: LATER_ISO,
        },
        preStore: store,
      }).allowed
    ).toBe(false);
  });

  it('10. verifies failed transactions, concurrent SKU/product creation races, category/plate-setting schemas, and worst-case Firestore expression/call/lookup limits', () => {
    let store: DocMap = {
      [`/users/${OWNER_UID}/catalogCategories/cat-charms`]: makeActiveCategory('cat-charms'),
    };

    // 10a. Failed transaction rollback: if `variants[11]` is invalid, the atomic transaction is rejected
    // and NEITHER `catalogProducts` NOR `catalogSkus` is committed to `store`
    const brokenVariants = Array.from({ length: 12 }, (_, idx) => ({
      id: `var-${idx + 1}`,
      label: idx === 11 ? '' : `Variant ${idx + 1}`, // invalid empty label at index 11!
      optionValues: { Style: `S${idx + 1}` },
      priceMyr: 12,
      imageUrl: null,
      sortOrder: idx,
    }));
    const failedTx = evaluateAtomicBatch(compiledRules, {
      auth: OWNER_AUTH,
      preStore: store,
      writes: [
        {
          op: 'create',
          path: `/users/${OWNER_UID}/catalogSkus/WOOPP-ROLLBACK`,
          data: makeSkuDoc('WOOPP-ROLLBACK', 'prod-rollback'),
        },
        {
          op: 'create',
          path: `/users/${OWNER_UID}/catalogProducts/prod-rollback`,
          data: makeProduct({
            id: 'prod-rollback',
            sku: 'WOOPP-ROLLBACK',
            options: [{ id: 'opt-1', name: 'Style', values: ['S1', 'S2'], sortOrder: 0 }],
            variants: brokenVariants,
          }),
        },
      ],
    });
    expect(failedTx.allowed).toBe(false);
    expect(failedTx.postStore[`/users/${OWNER_UID}/catalogSkus/WOOPP-ROLLBACK`]).toBeUndefined();
    expect(failedTx.postStore[`/users/${OWNER_UID}/catalogProducts/prod-rollback`]).toBeUndefined();

    // 10b. Concurrent creation race on the SAME candidate SKU (`WOOPP-RACE8888`):
    // Transaction A and Transaction B both read `store` before commit; A commits first; B fails cleanly against post-A store!
    const txA = evaluateAtomicBatch(compiledRules, {
      auth: OWNER_AUTH,
      preStore: store,
      writes: [
        {
          op: 'create',
          path: `/users/${OWNER_UID}/catalogSkus/WOOPP-RACE8888`,
          data: makeSkuDoc('WOOPP-RACE8888', 'prod-race-a'),
        },
        {
          op: 'create',
          path: `/users/${OWNER_UID}/catalogProducts/prod-race-a`,
          data: makeProduct({ id: 'prod-race-a', sku: 'WOOPP-RACE8888' }),
        },
      ],
    });
    expect(txA.allowed).toBe(true);
    store = txA.postStore;

    const txBCollidingSku = evaluateAtomicBatch(compiledRules, {
      auth: OWNER_AUTH,
      preStore: store,
      writes: [
        {
          op: 'create',
          path: `/users/${OWNER_UID}/catalogSkus/WOOPP-RACE8888`,
          data: makeSkuDoc('WOOPP-RACE8888', 'prod-race-b'),
        },
        {
          op: 'create',
          path: `/users/${OWNER_UID}/catalogProducts/prod-race-b`,
          data: makeProduct({ id: 'prod-race-b', sku: 'WOOPP-RACE8888' }),
        },
      ],
    });
    expect(txBCollidingSku.allowed).toBe(false);
    expect(store[`/users/${OWNER_UID}/catalogProducts/prod-race-b`]).toBeUndefined();

    // Retry of Transaction B with a newly generated unique SKU (`WOOPP-RACE9999`) commits cleanly
    const txBRetried = evaluateAtomicBatch(compiledRules, {
      auth: OWNER_AUTH,
      preStore: store,
      writes: [
        {
          op: 'create',
          path: `/users/${OWNER_UID}/catalogSkus/WOOPP-RACE9999`,
          data: makeSkuDoc('WOOPP-RACE9999', 'prod-race-b'),
        },
        {
          op: 'create',
          path: `/users/${OWNER_UID}/catalogProducts/prod-race-b`,
          data: makeProduct({ id: 'prod-race-b', sku: 'WOOPP-RACE9999' }),
        },
      ],
    });
    expect(txBRetried.allowed).toBe(true);
    store = txBRetried.postStore;

    // 10c. Valid & invalid writes on `catalogCategories` and `catalogPlateSettings`
    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'create',
        path: `/users/${OWNER_UID}/catalogCategories/cat-bad-icon`,
        auth: OWNER_AUTH,
        requestData: { ...makeActiveCategory('cat-bad-icon'), iconName: 'rocket-invalid' },
        preStore: store,
      }).allowed
    ).toBe(false);

    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'create',
        path: `/users/${OWNER_UID}/catalogCategories/cat-bad-img`,
        auth: OWNER_AUTH,
        requestData: {
          ...makeActiveCategory('cat-bad-img'),
          imageUrl: 'data:image/png;base64,AAAA',
        },
        preStore: store,
      }).allowed
    ).toBe(false);

    const manualSettingNullCap = prepareCategoryPlateSettingForFirestore(
      {
        categoryId: 'cat-charms',
        ownerId: OWNER_UID,
        allocationMode: 'manual_plate',
        plateCapacity: null,
        defaultEstimatedMinutes: 180,
        updatedAt: NOW_ISO,
      },
      OWNER_UID
    ) as unknown as Record<string, unknown>;

    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'create',
        path: `/users/${OWNER_UID}/catalogPlateSettings/cat-charms`,
        auth: OWNER_AUTH,
        requestData: manualSettingNullCap,
        preStore: store,
      }).allowed
    ).toBe(true);

    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'create',
        path: `/users/${OWNER_UID}/catalogPlateSettings/cat-charms`,
        auth: OWNER_AUTH,
        requestData: { ...manualSettingNullCap, plateCapacity: 0 },
        preStore: store,
      }).allowed
    ).toBe(false);

    expect(
      evaluateSingleRequest(compiledRules, {
        op: 'create',
        path: `/users/${OWNER_UID}/catalogPlateSettings/cat-charms`,
        auth: OWNER_AUTH,
        requestData: { ...manualSettingNullCap, defaultEstimatedMinutes: 5000 },
        preStore: store,
      }).allowed
    ).toBe(false);

    // 10d. Exhaustive Firebase Security Rules Limits Check across worst-case valid product shapes
    // on BOTH `create` and `update` (12 gallery images + max options/values + 12 full variants with prices & HTTPS images)
    const maxGallery12 = Array.from(
      { length: 12 },
      (_, idx) => `https://cdn.woopp.my/gallery/${idx}.webp`
    );
    const maxGallery11 = maxGallery12.slice(0, 11);
    const maxFullVariants12 = Array.from({ length: 12 }, (_, idx) => ({
      id: `var-max-${idx + 1}`,
      label: `Full Variant ${idx + 1}`,
      optionValues: { O1: 'V1', O2: 'V2', O3: 'V3', O4: 'V4' },
      priceMyr: 29.9,
      imageUrl: `https://cdn.woopp.my/variants/${idx}.webp`,
      sortOrder: idx,
    }));

    const optionShapes = [
      // 1 option x 12 values
      [
        {
          id: 'opt-1',
          name: 'Style',
          values: Array.from({ length: 12 }, (_, i) => `Style-${i + 1}`),
          sortOrder: 0,
        },
      ],
      // 2 options x [6, 6] = 12 values
      [
        { id: 'opt-1', name: 'Color', values: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'], sortOrder: 0 },
        { id: 'opt-2', name: 'Finish', values: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'], sortOrder: 1 },
      ],
      // 4 options x [4, 2, 2, 2] = 10 values (hits exact complexity budget 4 + 10 = 14)
      [
        { id: 'opt-1', name: 'Color', values: ['C1', 'C2', 'C3', 'C4'], sortOrder: 0 },
        { id: 'opt-2', name: 'Size', values: ['S', 'L'], sortOrder: 1 },
        { id: 'opt-3', name: 'Finish', values: ['Matte', 'Gloss'], sortOrder: 2 },
        { id: 'opt-4', name: 'Ring', values: ['Gold', 'Silver'], sortOrder: 3 },
      ],
    ];

    let observedPeakExpressions = 0;
    let observedPeakCallDepth = 0;

    for (let sIdx = 0; sIdx < optionShapes.length; sIdx += 1) {
      for (const gallery of [maxGallery11, maxGallery12]) {
        const pid = `prod-limit-${sIdx}-${gallery.length}`;
        const sku = `WOOPP-LIM00${sIdx}${gallery.length}`;
        const docPayload = makeProduct({
          id: pid,
          sku,
          images: gallery,
          options: optionShapes[sIdx],
          variants: maxFullVariants12,
        });

        const createBatch = evaluateAtomicBatch(compiledRules, {
          auth: OWNER_AUTH,
          preStore: store,
          writes: [
            {
              op: 'create',
              path: `/users/${OWNER_UID}/catalogSkus/${sku}`,
              data: makeSkuDoc(sku, pid),
            },
            {
              op: 'create',
              path: `/users/${OWNER_UID}/catalogProducts/${pid}`,
              data: docPayload,
            },
          ],
        });
        expect(createBatch.allowed, JSON.stringify(createBatch.results)).toBe(true);
        expect(createBatch.maxExpressionsSingleRule).toBeLessThan(1000);
        expect(createBatch.totalDbLookups).toBe(5);
        observedPeakExpressions = Math.max(
          observedPeakExpressions,
          createBatch.maxExpressionsSingleRule
        );
        for (const r of createBatch.results) {
          observedPeakCallDepth = Math.max(observedPeakCallDepth, r.maxCallDepth);
          expect(r.maxCallDepth).toBeLessThanOrEqual(20);
        }

        // Also test `update` (category changed -> activeCategoryExistsForOwner + diff().affectedKeys())
        const storeWithCreated = createBatch.postStore;
        const storeWithSecondCat: DocMap = {
          ...storeWithCreated,
          [`/users/${OWNER_UID}/catalogCategories/cat-second`]: makeActiveCategory('cat-second'),
        };
        const updateRes = evaluateSingleRequest(compiledRules, {
          op: 'update',
          path: `/users/${OWNER_UID}/catalogProducts/${pid}`,
          auth: OWNER_AUTH,
          requestData: {
            ...docPayload,
            name: 'Updated Max Product',
            categoryId: 'cat-second',
            updatedAt: LATER_ISO,
          },
          preStore: storeWithSecondCat,
        });
        expect(updateRes.allowed, updateRes.denialReason).toBe(true);
        expect(updateRes.expressionsEvaluated).toBeLessThan(1000);
        expect(updateRes.maxCallDepth).toBeLessThanOrEqual(20);
        expect(updateRes.dbLookups).toBe(1);
        observedPeakExpressions = Math.max(
          observedPeakExpressions,
          updateRes.expressionsEvaluated
        );
        observedPeakCallDepth = Math.max(observedPeakCallDepth, updateRes.maxCallDepth);
      }
    }

    expect(observedPeakExpressions).toBeLessThan(1000);
    expect(observedPeakCallDepth).toBeLessThanOrEqual(8);
  });

  it('11. verifies Product Studio UI form remains clean with zero Printable, Production Group, Mixed Plate, or Print Ready controls', () => {
    expect(formSource).not.toMatch(/Production Group/i);
    expect(formSource).not.toMatch(/Mixed Plate/i);
    expect(formSource).not.toMatch(/Print Ready/i);
    expect(formSource).not.toMatch(/plateCapacity/i);
    expect(formSource).not.toMatch(/defaultEstimatedMinutes/i);
    expect(vi).toBeDefined();
  });
});
