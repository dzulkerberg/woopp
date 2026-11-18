import JSZip from 'jszip';
import { ABC, compactLettersMap, countLetters, sumAlphabetMaps } from '../constants';
import {
  Bambu3mfExportProgressEvent,
  LettersMap,
  Master3mfDetectedKeycap,
  Master3mfTemplateRecord,
  PlateLetterPlacement,
  StlBedProfile,
  StlExportValidationResult,
} from '../types';
import {
  formatBatch3mfFilename,
  formatWpPlate3mfFilename,
  normalizePlateCode,
} from './plateIdGenerator';
import {
  buildPlateLetterPlacements,
  DEFAULT_BAMBU_BED_PROFILE,
} from './plateStlLayout';

export interface Plate3mfInputPlate {
  plateNumber: number;
  plateCode?: string | null;
  capacity: number;
  letters: LettersMap;
  placements?: PlateLetterPlacement[];
  colorId?: string | null;
  colorName?: string | null;
  colorHex?: string | null;
  productName?: string | null;
}

interface ParsedXmlTag {
  name: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
  startIndex: number;
  endIndex: number;
  bodyStart: number;
  bodyEnd: number;
}

interface Parsed3mfTriangle {
  v1: number;
  v2: number;
  v3: number;
  extraAttrs: string;
}

export interface Parsed3mfPartMesh {
  partId: string;
  name: string;
  subtype: string;
  extruder: number | null;
  paintColorPresent: boolean;
  paintedExtruder: number | null;
  vertices: Float64Array; // [x0, y0, z0, x1, y1, z1, ...]
  triangles: Parsed3mfTriangle[];
  meshHash: string;
}

export interface ParsedMasterKeycapTemplate {
  letter: string;
  modelRevision: string;
  cacheKey: string; // `${modelRevision}:${letter}` — never a shared generic identifier
  sourceObjectId: string;
  sourceModelPath: string;
  objectName: string;
  defaultExtruder: number | null;
  parts: Parsed3mfPartMesh[];
  partHashes: string[];
  geometryHash: string;
  totalTriangles: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  widthMm: number;
  depthMm: number;
  heightMm: number;
}

export interface ParsedMaster3mfArchive {
  zip: JSZip;
  modelRevision: string;
  keycapsByLetter: Record<string, ParsedMasterKeycapTemplate>;
  detectedLetters: string[];
  multiMaterialPartCount: number;
  filamentCount: number;
  projectFilamentCount: number;
  filamentColors: string[];
  primeTowerEnabled: boolean;
  projectSettingsKeysCount: number;
}

export interface Export3mfPlateSummary {
  plateNumber: number;
  plateCode: string;
  platerId: number;
  platerName: string;
  keycapCount: number;
  letterBreakdown: LettersMap;
  placements: PlateLetterPlacement[];
  validation: StlExportValidationResult;
}

export interface Exported3mfRelationshipEntry {
  id: string;
  target: string;
  type: string;
}

export interface ExportedLetterGeometryAuditEntry {
  letter: string;
  objectId: string;
  modelPath: string;
  subObjectIds: string[];
  partExtruders: number[];
  geometryHash: string;
  raisedPartHash: string;
  instanceCount: number;
}

export interface Exported3mfAuditReport {
  valid: boolean;
  errors: string[];
  warnings: string[];
  rootRelationships: Exported3mfRelationshipEntry[];
  modelRelationships: Exported3mfRelationshipEntry[];
  includedObjectFiles: string[];
  totalBuildItems: number;
  totalVertices: number;
  totalTriangles: number;
  plateCount: number;
  extrudersUsed: number[];
  projectSettingsValid: boolean;
  resolvedLetterGeometryCounts: Record<string, number>;
  letterGeometryAudit: Record<string, ExportedLetterGeometryAuditEntry>;
  distinctGeometryHashesCount: number;
}

export interface SinglePlate3mfExportResult {
  fileName: string;
  plateCode: string;
  threeMfBytes: Uint8Array;
  plateSummary: Export3mfPlateSummary;
  audit: Exported3mfAuditReport;
  warnings: string[];
}

export interface BatchPlates3mfExportResult {
  fileName: string;
  batchId: string;
  threeMfBytes: Uint8Array;
  plateCount: number;
  totalKeycapCount: number;
  combinedLetterBreakdown: LettersMap;
  plates: Export3mfPlateSummary[];
  audit: Exported3mfAuditReport;
  warnings: string[];
}

// ============================================================================
// Pure-TS XML Helpers (Worker & Node Safe — zero DOMParser dependency)
// ============================================================================

function unescapeXml(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseXmlAttributes(attrSource: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(attrSource)) !== null) {
    attrs[match[1]] = unescapeXml(match[2] ?? match[3] ?? '');
  }
  return attrs;
}

function findMatchingTagElements(xml: string, tagName: string): ParsedXmlTag[] {
  const results: ParsedXmlTag[] = [];
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const openOrCloseRegex = new RegExp(`<(\\/)?${escaped}(?=[\\s/>])([^>]*)>`, 'g');

  const stack: Array<{
    attrs: Record<string, string>;
    startIndex: number;
    bodyStart: number;
  }> = [];

  let match: RegExpExecArray | null;
  while ((match = openOrCloseRegex.exec(xml)) !== null) {
    const isClosing = Boolean(match[1]);
    const rawTail = match[2] || '';
    const fullEnd = match.index + match[0].length;

    if (!isClosing) {
      const selfClosing = /\/\s*$/.test(rawTail);
      const cleanAttrs = selfClosing ? rawTail.replace(/\/\s*$/, '') : rawTail;
      const attrs = parseXmlAttributes(cleanAttrs);
      if (selfClosing) {
        results.push({
          name: tagName,
          attrs,
          selfClosing: true,
          startIndex: match.index,
          endIndex: fullEnd,
          bodyStart: fullEnd,
          bodyEnd: fullEnd,
        });
      } else {
        stack.push({
          attrs,
          startIndex: match.index,
          bodyStart: fullEnd,
        });
      }
    } else if (stack.length > 0) {
      const opened = stack.pop()!;
      results.push({
        name: tagName,
        attrs: opened.attrs,
        selfClosing: false,
        startIndex: opened.startIndex,
        endIndex: fullEnd,
        bodyStart: opened.bodyStart,
        bodyEnd: match.index,
      });
    }
  }

  return results.sort((a, b) => a.startIndex - b.startIndex);
}

// ============================================================================
// Letter Name Recognition & 3MF Transform Math
// ============================================================================

export function matchLetterFrom3mfObjectName(rawName: string | undefined | null): string | null {
  if (!rawName) return null;
  const cleaned = rawName
    .trim()
    .replace(/\.(stl|step|stp|3mf|obj)$/i, '')
    .trim();
  if (!cleaned) return null;

  if (cleaned.length === 1) {
    const upper = cleaned.toUpperCase();
    return ABC.includes(upper as any) ? upper : null;
  }

  const patterns = [
    /(?:^|[\s_\-/])(?:keycap[\s_-]*char|keycap|char|letter)[\s_-]*([A-Za-z])(?:[\s_-]*(?:body|base|text|cap|mesh))?(?:[\s_-]*\(\d+\))?$/i,
    /^([A-Za-z])(?:[\s_-]*(?:keycap|cap|body|base))?(?:[\s_-]*\(\d+\))?$/i,
    /[\s_-]([A-Za-z])$/,
  ];

  for (const rx of patterns) {
    const m = cleaned.match(rx);
    if (m && m[1]) {
      const candidate = m[1].toUpperCase();
      if (ABC.includes(candidate as any)) return candidate;
    }
  }
  return null;
}

function computeBufferRevisionHash(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  const step = Math.max(1, Math.floor(bytes.length / 65536));
  for (let i = 0; i < bytes.length; i += step) {
    const b = bytes[i];
    h1 ^= b;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= (b + (i & 0xff)) & 0xff;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `${(bytes.length >>> 0).toString(16)}-${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

function computeMeshGeometryHash(
  vertices: Float64Array,
  triangles: readonly Parsed3mfTriangle[]
): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  const feedInt = (val: number) => {
    h1 ^= val & 0xff;
    h1 = Math.imul(h1, 0x01000193);
    h1 ^= (val >> 8) & 0xff;
    h1 = Math.imul(h1, 0x01000193);
    h1 ^= (val >> 16) & 0xff;
    h1 = Math.imul(h1, 0x01000193);
    h1 ^= (val >> 24) & 0xff;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= val;
    h2 = Math.imul(h2, 0x85ebca6b);
  };

  const vertexCount = Math.floor(vertices.length / 3);
  feedInt(vertexCount);
  feedInt(triangles.length);

  for (let i = 0; i < vertices.length; i += 1) {
    // Quantize consistently with .toFixed(4) serialization in XML so master & reloaded hashes match identically
    const q = Math.round(Number(vertices[i].toFixed(4)) * 10000);
    feedInt(q);
  }
  for (let t = 0; t < triangles.length; t += 1) {
    const tri = triangles[t];
    feedInt(tri.v1);
    feedInt(tri.v2);
    feedInt(tri.v3);
    if (tri.extraAttrs) {
      for (let c = 0; c < tri.extraAttrs.length; c += 1) {
        feedInt(tri.extraAttrs.charCodeAt(c));
      }
    }
  }

  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

function computeCompositeGeometryHash(partHashes: readonly string[]): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  const combined = partHashes.join('|');
  for (let i = 0; i < combined.length; i += 1) {
    const ch = combined.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= (ch + i) & 0xff;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

function multiply3mfTransforms(parent: readonly number[], child: readonly number[]): number[] {
  // Row-major affine 4x3 (last column [0, 0, 0, 1]) composition: child * parent
  const a = child;
  const b = parent;
  return [
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
    a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
    a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
    a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
    a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
    a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
    a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
    a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
    a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
    a[9] * b[0] + a[10] * b[3] + a[11] * b[6] + b[9],
    a[9] * b[1] + a[10] * b[4] + a[11] * b[7] + b[10],
    a[9] * b[2] + a[10] * b[5] + a[11] * b[8] + b[11],
  ];
}

function parseTransformMatrix(rawTransform?: string): number[] {
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  if (!rawTransform) return identity;
  const nums = rawTransform
    .trim()
    .split(/\s+/)
    .map((s) => Number(s));
  if (nums.length !== 12 || nums.some((n) => !Number.isFinite(n))) {
    return identity;
  }
  return nums;
}

function apply3mfTransform(
  m: readonly number[],
  x: number,
  y: number,
  z: number
): [number, number, number] {
  // 3MF row-major affine matrix: [x y z 1] * [[m0 m1 m2 0],[m3 m4 m5 0],[m6 m7 m8 0],[m9 m10 m11 1]]
  return [
    x * m[0] + y * m[3] + z * m[6] + m[9],
    x * m[1] + y * m[4] + z * m[7] + m[10],
    x * m[2] + y * m[5] + z * m[8] + m[11],
  ];
}

/**
 * Decodes Bambu Studio / PrusaSlicer `paint_color` (TriangleSelector hex string)
 * to 1-based extruder numbers found across the triangle's leaf states.
 * Encoding (right-to-left nibbles):
 *  - splitSides = nibble & 0x03 (0 = leaf, 1..3 = split into splitSides+1 children)
 *  - state = (nibble >> 2) & 0x03 (0 = none, 1 = ext 1 ("4"), 2 = ext 2 ("8"), 3 = 3 + nextNibble ("0C"=3, "1C"=4...))
 */
export function decodeBambuPaintColorExtruders(rawHex: string | undefined | null): number[] {
  if (!rawHex) return [];
  const cleaned = rawHex.trim();
  if (!cleaned || !/^[0-9a-fA-F]+$/.test(cleaned)) return [];

  let cursor = cleaned.length - 1;
  const found = new Set<number>();

  const readNode = (depth: number): void => {
    if (cursor < 0 || depth > 24) return;
    const nibble = parseInt(cleaned[cursor--], 16);
    if (!Number.isFinite(nibble)) return;
    const splitSides = nibble & 0x03;
    if (splitSides === 0) {
      const state = (nibble >> 2) & 0x03;
      if (state === 1) {
        found.add(1);
      } else if (state === 2) {
        found.add(2);
      } else if (state === 3 && cursor >= 0) {
        const extNibble = parseInt(cleaned[cursor--], 16);
        if (Number.isFinite(extNibble)) {
          found.add(3 + extNibble);
        }
      }
      return;
    }

    const childCount = splitSides + 1;
    for (let i = 0; i < childCount; i += 1) {
      readNode(depth + 1);
    }
  };

  readNode(0);
  return Array.from(found).sort((a, b) => a - b);
}

function normalizeHexColor6(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const m = raw.trim().match(/^#?([0-9a-fA-F]{6})/);
  return m ? `#${m[1].toUpperCase()}` : null;
}

function parseMeshFromXmlBody(meshBody: string): {
  vertices: Float64Array;
  triangles: Parsed3mfTriangle[];
  paintColorPresent: boolean;
  dominantPaintedExtruder: number | null;
  distinctPaintedExtruders: number[];
  triangleMaterialRefs: Array<{ pid: string; pindex: number }>;
} {
  const vertexRegex = /<vertex\b([^>]*)\/?>/g;
  const coords: number[] = [];
  let vMatch: RegExpExecArray | null;
  while ((vMatch = vertexRegex.exec(meshBody)) !== null) {
    const attrs = parseXmlAttributes(vMatch[1]);
    coords.push(
      Number(attrs.x || 0),
      Number(attrs.y || 0),
      Number(attrs.z || 0)
    );
  }

  const triRegex = /<triangle\b([^>]*)\/?>/g;
  const triangles: Parsed3mfTriangle[] = [];
  let paintColorPresent = false;
  const paintedCounts = new Map<number, number>();
  const triangleMaterialRefs: Array<{ pid: string; pindex: number }> = [];
  let tMatch: RegExpExecArray | null;
  while ((tMatch = triRegex.exec(meshBody)) !== null) {
    const attrs = parseXmlAttributes(tMatch[1]);
    const extraParts: string[] = [];
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'v1' || k === 'v2' || k === 'v3') continue;
      // Strip 3MF basematerials references from serialized triangle attrs (exported models use Bambu model_settings.config extruders)
      if (k === 'pid' || k === 'pindex') continue;
      if (k === 'paint_color' || k === 'slic3rpe:mmu_segmentation') {
        paintColorPresent = true;
        const exts = decodeBambuPaintColorExtruders(v);
        for (const ext of exts) {
          paintedCounts.set(ext, (paintedCounts.get(ext) || 0) + 1);
        }
      }
      extraParts.push(`${k}="${escapeXml(v)}"`);
    }
    if (attrs.pid && attrs.pindex !== undefined) {
      const pidxNum = Math.floor(Number(attrs.pindex));
      if (Number.isFinite(pidxNum) && pidxNum >= 0) {
        triangleMaterialRefs.push({ pid: attrs.pid.trim(), pindex: pidxNum });
      }
    }
    triangles.push({
      v1: Math.floor(Number(attrs.v1 || 0)),
      v2: Math.floor(Number(attrs.v2 || 0)),
      v3: Math.floor(Number(attrs.v3 || 0)),
      extraAttrs: extraParts.join(' '),
    });
  }

  let dominantPaintedExtruder: number | null = null;
  let bestPaintCount = 0;
  for (const [ext, count] of paintedCounts.entries()) {
    if (count > bestPaintCount) {
      bestPaintCount = count;
      dominantPaintedExtruder = ext;
    }
  }

  return {
    vertices: new Float64Array(coords),
    triangles,
    paintColorPresent,
    dominantPaintedExtruder,
    distinctPaintedExtruders: Array.from(paintedCounts.keys()).sort((a, b) => a - b),
    triangleMaterialRefs,
  };
}

function normalizeZipPath(pathStr: string): string {
  return pathStr.replace(/^\/+/, '').trim();
}

function generatePseudoUuid(seed: string, index: number): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  const full = `${seed}:${index}`;
  for (let i = 0; i < full.length; i += 1) {
    const ch = full.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= (ch + i) & 0xff;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  const p1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const p2 = ((h2 >>> 16) & 0xffff).toString(16).padStart(4, '0');
  const p3 = (0x4000 | (h2 & 0x0fff)).toString(16).padStart(4, '0');
  const p4 = (0x8000 | (index & 0x3fff)).toString(16).padStart(4, '0');
  const p5 = `${p1}${(index >>> 0).toString(16).padStart(4, '0')}`.slice(0, 12);
  return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}

interface ParsedBasematerialsGroup {
  id: string;
  entries: Array<{ name?: string; displayColor?: string }>;
}

interface ModelFileIndex {
  basematerialsById: Map<string, ParsedBasematerialsGroup>;
  objectsById: Map<
    string,
    {
      id: string;
      name?: string;
      pid?: string;
      pindex?: number;
      rawBody: string;
      hasMesh: boolean;
      components: Array<{
        objectId: string;
        path: string | null;
        transform: number[];
        pid?: string;
        pindex?: number;
      }>;
    }
  >;
}

function parseModelFileXml(modelXml: string): ModelFileIndex {
  const basematerialsById = new Map<string, ParsedBasematerialsGroup>();
  const baseMatTags = findMatchingTagElements(modelXml, 'basematerials');
  for (const bmTag of baseMatTags) {
    const id = (bmTag.attrs.id || '').trim();
    if (!id) continue;
    const bmBody = modelXml.slice(bmTag.bodyStart, bmTag.bodyEnd);
    const baseTags = findMatchingTagElements(bmBody, 'base');
    basematerialsById.set(id, {
      id,
      entries: baseTags.map((bt) => ({
        name: bt.attrs.name,
        displayColor: bt.attrs.displaycolor,
      })),
    });
  }

  const objectsById = new Map<
    string,
    {
      id: string;
      name?: string;
      pid?: string;
      pindex?: number;
      rawBody: string;
      hasMesh: boolean;
      components: Array<{
        objectId: string;
        path: string | null;
        transform: number[];
        pid?: string;
        pindex?: number;
      }>;
    }
  >();

  const objectTags = findMatchingTagElements(modelXml, 'object');
  for (const objTag of objectTags) {
    const id = (objTag.attrs.id || '').trim();
    if (!id) continue;
    const rawBody = modelXml.slice(objTag.bodyStart, objTag.bodyEnd);
    const hasMesh = /<mesh[\s>]/.test(rawBody);
    const componentTags = findMatchingTagElements(rawBody, 'component');
    const components = componentTags.map((ct) => {
      const compPindexRaw = ct.attrs.pindex !== undefined ? Math.floor(Number(ct.attrs.pindex)) : NaN;
      return {
        objectId: (ct.attrs.objectid || '').trim(),
        path: ct.attrs['p:path'] ? normalizeZipPath(ct.attrs['p:path']) : null,
        transform: parseTransformMatrix(ct.attrs.transform),
        pid: ct.attrs.pid ? ct.attrs.pid.trim() : undefined,
        pindex: Number.isFinite(compPindexRaw) && compPindexRaw >= 0 ? compPindexRaw : undefined,
      };
    });

    const objPindexRaw = objTag.attrs.pindex !== undefined ? Math.floor(Number(objTag.attrs.pindex)) : NaN;
    objectsById.set(id, {
      id,
      name: objTag.attrs.name,
      pid: objTag.attrs.pid ? objTag.attrs.pid.trim() : undefined,
      pindex: Number.isFinite(objPindexRaw) && objPindexRaw >= 0 ? objPindexRaw : undefined,
      rawBody,
      hasMesh,
      components,
    });
  }

  return { basematerialsById, objectsById };
}

interface ParsedObjectSettings {
  id: string;
  name?: string;
  extruder: number | null;
  parts: Array<{
    id: string;
    subtype: string;
    name?: string;
    extruder: number | null;
    sourceObjectId?: string;
    sourceVolumeId?: string;
  }>;
}

function parsePositiveExtruderValue(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : null;
}

function parseModelSettingsXml(settingsXml: string): Map<string, ParsedObjectSettings> {
  const map = new Map<string, ParsedObjectSettings>();
  const objectTags = findMatchingTagElements(settingsXml, 'object');
  for (const objTag of objectTags) {
    const id = (objTag.attrs.id || '').trim();
    if (!id) continue;
    const body = settingsXml.slice(objTag.bodyStart, objTag.bodyEnd);

    // Exclude nested <part> spans cleanly so object-level metadata before OR after <part>s is read accurately
    const partTags = findMatchingTagElements(body, 'part');
    let objDirectXml = '';
    let cursor = 0;
    for (const pt of partTags) {
      if (pt.startIndex > cursor) {
        objDirectXml += body.slice(cursor, pt.startIndex);
      }
      cursor = Math.max(cursor, pt.endIndex);
    }
    if (cursor < body.length) {
      objDirectXml += body.slice(cursor);
    }

    const objMetaTags = findMatchingTagElements(objDirectXml, 'metadata');
    let objName: string | undefined = objTag.attrs.name;
    let objExtruder: number | null = parsePositiveExtruderValue(objTag.attrs.extruder);
    for (const mt of objMetaTags) {
      if (mt.attrs.key === 'name') objName = mt.attrs.value;
      if (mt.attrs.key === 'extruder' || mt.attrs.key === 'extruder_id') {
        const val = parsePositiveExtruderValue(mt.attrs.value);
        if (val !== null) objExtruder = val;
      }
    }

    const parts: ParsedObjectSettings['parts'] = [];
    for (const pt of partTags) {
      const partBody = body.slice(pt.bodyStart, pt.bodyEnd);
      const partMetas = findMatchingTagElements(partBody, 'metadata');
      let partName: string | undefined = pt.attrs.name;
      let partExtruder: number | null = parsePositiveExtruderValue(pt.attrs.extruder);
      let sourceObjectId: string | undefined;
      let sourceVolumeId: string | undefined;
      for (const pm of partMetas) {
        if (pm.attrs.key === 'name') partName = pm.attrs.value;
        if (pm.attrs.key === 'extruder' || pm.attrs.key === 'extruder_id') {
          const val = parsePositiveExtruderValue(pm.attrs.value);
          if (val !== null) partExtruder = val;
        }
        if (pm.attrs.key === 'source_object_id') sourceObjectId = pm.attrs.value;
        if (pm.attrs.key === 'source_volume_id') sourceVolumeId = pm.attrs.value;
      }
      parts.push({
        id: (pt.attrs.id || '').trim(),
        subtype: (pt.attrs.subtype || 'normal_part').trim(),
        name: partName,
        extruder: partExtruder,
        sourceObjectId,
        sourceVolumeId,
      });
    }

    map.set(id, {
      id,
      name: objName,
      extruder: objExtruder,
      parts,
    });
  }
  return map;
}

// ============================================================================
// Master 3MF Archive Inspection & Parsing
// ============================================================================

export async function inspectMaster3mfArchive(
  buffer: ArrayBuffer
): Promise<ParsedMaster3mfArchive> {
  if (!buffer || buffer.byteLength < 32) {
    throw new Error('Uploaded .3mf file is empty or corrupted.');
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer.slice(0));
  } catch {
    throw new Error('Invalid .3mf archive: unable to decompress 3MF ZIP container.');
  }

  const rootModelFile =
    zip.file('3D/3dmodel.model') ||
    zip.file('3d/3dmodel.model');
  if (!rootModelFile) {
    throw new Error(
      'Invalid Bambu Studio Master 3MF: missing required 3D/3dmodel.model geometry manifest.'
    );
  }

  const modelRevision = computeBufferRevisionHash(buffer);

  // Parse all .model XML files in the archive (case-insensitive lookup map)
  const modelFilesByPath = new Map<string, ModelFileIndex>();
  const modelPaths = Object.keys(zip.files).filter(
    (p) => !zip.files[p].dir && /\.model$/i.test(p)
  );
  for (const path of modelPaths) {
    const xml = await zip.file(path)!.async('string');
    modelFilesByPath.set(normalizeZipPath(path).toLowerCase(), parseModelFileXml(xml));
  }

  const rootPath = normalizeZipPath(rootModelFile.name);
  const rootPathLower = rootPath.toLowerCase();
  const rootIndex = modelFilesByPath.get(rootPathLower);
  if (!rootIndex || rootIndex.objectsById.size === 0) {
    throw new Error(
      'Bambu Studio Master 3MF contains no 3D objects inside 3D/3dmodel.model.'
    );
  }

  // Parse Metadata/model_settings.config (part names, extruders, multi-material assignments)
  const modelSettingsFile =
    zip.file('Metadata/model_settings.config') ||
    zip.file('metadata/model_settings.config');
  const modelSettingsXml = modelSettingsFile
    ? await modelSettingsFile.async('string')
    : '';
  const objectSettingsMap = modelSettingsXml
    ? parseModelSettingsXml(modelSettingsXml)
    : new Map<string, ParsedObjectSettings>();

  // Parse Metadata/project_settings.config (slicer, filament colors, prime tower)
  const projectSettingsFile =
    zip.file('Metadata/project_settings.config') ||
    zip.file('metadata/project_settings.config');
  let projectFilamentCount = 0;
  let filamentCount = 1;
  let filamentColors: string[] = [];
  let primeTowerEnabled = false;
  let projectSettingsKeysCount = 0;

  if (projectSettingsFile) {
    try {
      const parsedJson = JSON.parse(await projectSettingsFile.async('string')) as Record<
        string,
        unknown
      >;
      projectSettingsKeysCount = Object.keys(parsedJson).length;
      if (Array.isArray(parsedJson.filament_colour)) {
        filamentColors = parsedJson.filament_colour
          .filter((c): c is string => typeof c === 'string')
          .map((c) => c.trim());
        projectFilamentCount = Math.max(projectFilamentCount, filamentColors.length);
      }
      if (Array.isArray(parsedJson.filament_type)) {
        projectFilamentCount = Math.max(projectFilamentCount, parsedJson.filament_type.length);
      }
      if (Array.isArray(parsedJson.filament_settings_id)) {
        projectFilamentCount = Math.max(projectFilamentCount, parsedJson.filament_settings_id.length);
      }
      if (projectFilamentCount > 0) {
        filamentCount = Math.max(1, projectFilamentCount);
      }
      const primeRaw = parsedJson.enable_prime_tower;
      primeTowerEnabled =
        primeRaw === '1' || primeRaw === true || primeRaw === 1 || primeRaw === 'true';
    } catch {
      // Keep non-fatal fallback if project_settings.config uses non-standard format
    }
  }

  // Build lookup index from normalized hex filament colors -> 1-based extruder slot
  const filamentSlotByHex = new Map<string, number>();
  filamentColors.forEach((hex, idx) => {
    const norm = normalizeHexColor6(hex);
    if (norm && !filamentSlotByHex.has(norm)) {
      filamentSlotByHex.set(norm, idx + 1);
    }
  });

  // Collect build items so we know top-level build object IDs cleanly
  const rootXml = await rootModelFile.async('string');
  const buildTags = findMatchingTagElements(rootXml, 'build');
  const buildObjectIds: string[] = [];
  if (buildTags.length > 0) {
    const buildBody = rootXml.slice(buildTags[0].bodyStart, buildTags[0].bodyEnd);
    const itemTags = findMatchingTagElements(buildBody, 'item');
    for (const it of itemTags) {
      if (it.attrs.objectid) buildObjectIds.push(it.attrs.objectid.trim());
    }
  }

  const candidateObjectIds =
    buildObjectIds.length > 0
      ? Array.from(new Set(buildObjectIds))
      : Array.from(rootIndex.objectsById.keys());

  const keycapsByLetter: Record<string, ParsedMasterKeycapTemplate> = {};

  interface LeafMeshResolved {
    sourcePath: string;
    sourceSubObjectId: string;
    topComponentObjectId: string | null;
    name?: string;
    pid?: string;
    pindex?: number;
    transform: number[];
    rawBody: string;
  }

  const collectLeafMeshes = (
    modelPathLower: string,
    targetObjId: string,
    accTransform: number[],
    visited: Set<string>,
    topComponentObjectId: string | null,
    inheritedPid?: string,
    inheritedPindex?: number
  ): LeafMeshResolved[] => {
    const visitKey = `${modelPathLower}#${targetObjId}`;
    if (visited.has(visitKey)) return [];
    const targetIndex = modelFilesByPath.get(modelPathLower);
    const subObj = targetIndex?.objectsById.get(targetObjId);
    if (!subObj) return [];

    const nextVisited = new Set(visited);
    nextVisited.add(visitKey);

    const effPid = subObj.pid ?? inheritedPid;
    const effPindex = subObj.pindex ?? inheritedPindex;

    if (subObj.components.length > 0) {
      const nested: LeafMeshResolved[] = [];
      for (const comp of subObj.components) {
        const childPathLower = (comp.path || modelPathLower).toLowerCase();
        const combinedTransform = multiply3mfTransforms(accTransform, comp.transform);
        const childTopId = topComponentObjectId ?? comp.objectId;
        nested.push(
          ...collectLeafMeshes(
            childPathLower,
            comp.objectId,
            combinedTransform,
            nextVisited,
            childTopId,
            comp.pid ?? effPid,
            comp.pindex ?? effPindex
          )
        );
      }
      return nested;
    }

    if (subObj.hasMesh) {
      return [
        {
          sourcePath: modelPathLower,
          sourceSubObjectId: subObj.id,
          topComponentObjectId,
          name: subObj.name,
          pid: effPid,
          pindex: effPindex,
          transform: accTransform,
          rawBody: subObj.rawBody,
        },
      ];
    }
    return [];
  };

  const resolveBasematerialExtruder = (
    modelPathLower: string,
    pid?: string,
    pindex?: number
  ): number | null => {
    if (pindex === undefined || !Number.isFinite(pindex) || pindex < 0) return null;
    if (pid) {
      const modelIdx = modelFilesByPath.get(modelPathLower) || rootIndex;
      const group = modelIdx.basematerialsById.get(pid) || rootIndex.basematerialsById.get(pid);
      const entry = group?.entries[pindex];
      const hex = normalizeHexColor6(entry?.displayColor);
      if (hex && filamentSlotByHex.has(hex)) {
        return filamentSlotByHex.get(hex)!;
      }
    }
    return pindex + 1;
  };

  for (const objId of candidateObjectIds) {
    const objEntry = rootIndex.objectsById.get(objId);
    if (!objEntry) continue;

    let objMeta = objectSettingsMap.get(objId);
    const prelimName =
      objMeta?.name ||
      objEntry.name ||
      (objEntry.components[0]?.path
        ? objEntry.components[0].path.split('/').pop()
        : undefined);

    // Fallback: if wrapper object in 3D/3dmodel.model delegates to a child object or named metadata entry
    if ((!objMeta || objMeta.parts.length === 0) && objEntry.components.length === 1 && !objEntry.components[0].path) {
      const childMeta = objectSettingsMap.get(objEntry.components[0].objectId);
      if (childMeta && childMeta.parts.length > 0) {
        objMeta = childMeta;
      }
    }
    if ((!objMeta || objMeta.parts.length === 0) && prelimName) {
      const prelimLower = prelimName.trim().toLowerCase();
      for (const candidateMeta of objectSettingsMap.values()) {
        if (candidateMeta.name && candidateMeta.name.trim().toLowerCase() === prelimLower) {
          objMeta = candidateMeta;
          break;
        }
      }
    }

    const resolvedName = objMeta?.name || prelimName;
    const detectedLetter = matchLetterFrom3mfObjectName(resolvedName);
    if (!detectedLetter || Object.prototype.hasOwnProperty.call(keycapsByLetter, detectedLetter)) {
      continue;
    }

    const identityTransform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    const leafMeshes = collectLeafMeshes(
      rootPathLower,
      objId,
      identityTransform,
      new Set(),
      null,
      objEntry.pid,
      objEntry.pindex
    );
    if (leafMeshes.length === 0) continue;

    // Count how often each sourceSubObjectId & topComponentObjectId appears across this object's leaves
    // so duplicate `id="1"` across separate sub-model files NEVER collide onto parts[0].
    const subIdCounts = new Map<string, number>();
    const topCompIdCounts = new Map<string, number>();
    for (const lf of leafMeshes) {
      subIdCounts.set(lf.sourceSubObjectId, (subIdCounts.get(lf.sourceSubObjectId) || 0) + 1);
      if (lf.topComponentObjectId) {
        topCompIdCounts.set(
          lf.topComponentObjectId,
          (topCompIdCounts.get(lf.topComponentObjectId) || 0) + 1
        );
      }
    }

    const availableParts = objMeta?.parts || [];
    const usedPartIndices = new Set<number>();

    const pickUnusedPartMeta = (
      leaf: LeafMeshResolved,
      leafIdx: number
    ): ParsedObjectSettings['parts'][number] | undefined => {
      if (availableParts.length === 0) return undefined;

      // 1. Unique sourceSubObjectId match
      if (subIdCounts.get(leaf.sourceSubObjectId) === 1) {
        const idxById = availableParts.findIndex(
          (p, i) => !usedPartIndices.has(i) && p.id === leaf.sourceSubObjectId
        );
        if (idxById >= 0) {
          usedPartIndices.add(idxById);
          return availableParts[idxById];
        }
      }

      // 2. Unique top-level component objectid match
      if (leaf.topComponentObjectId && topCompIdCounts.get(leaf.topComponentObjectId) === 1) {
        const idxByComp = availableParts.findIndex(
          (p, i) => !usedPartIndices.has(i) && p.id === leaf.topComponentObjectId
        );
        if (idxByComp >= 0) {
          usedPartIndices.add(idxByComp);
          return availableParts[idxByComp];
        }
      }

      // 3. Exact case-insensitive name match
      if (leaf.name) {
        const leafNameLower = leaf.name.trim().toLowerCase();
        const idxByName = availableParts.findIndex(
          (p, i) =>
            !usedPartIndices.has(i) &&
            p.name &&
            p.name.trim().toLowerCase() === leafNameLower
        );
        if (idxByName >= 0) {
          usedPartIndices.add(idxByName);
          return availableParts[idxByName];
        }
      }

      // 4. Text/lettering vs body semantic name match
      const isTextLeaf = Boolean(leaf.name && /(?:text_shape|text|letter|char|raised)/i.test(leaf.name));
      if (isTextLeaf) {
        const idxText = availableParts.findIndex(
          (p, i) =>
            !usedPartIndices.has(i) &&
            Boolean(p.name && /(?:text_shape|text|letter|char|raised)/i.test(p.name))
        );
        if (idxText >= 0) {
          usedPartIndices.add(idxText);
          return availableParts[idxText];
        }
      }

      // 5. Positional match by leafIdx (unused)
      if (leafIdx < availableParts.length && !usedPartIndices.has(leafIdx)) {
        usedPartIndices.add(leafIdx);
        return availableParts[leafIdx];
      }

      // 6. Any remaining unused part
      const firstUnused = availableParts.findIndex((_, i) => !usedPartIndices.has(i));
      if (firstUnused >= 0) {
        usedPartIndices.add(firstUnused);
        return availableParts[firstUnused];
      }

      return undefined;
    };

    const rawParts: Array<{
      partId: string;
      name: string;
      subtype: string;
      extruder: number | null;
      paintColorPresent: boolean;
      paintedExtruder: number | null;
      vertices: Float64Array;
      triangles: Parsed3mfTriangle[];
      sourcePath: string;
    }> = [];

    const objDefaultExtruder = objMeta?.extruder ?? null;

    leafMeshes.forEach((leaf, leafIdx) => {
      const meshParsed = parseMeshFromXmlBody(leaf.rawBody);
      if (meshParsed.vertices.length === 0 || meshParsed.triangles.length === 0) {
        return;
      }

      // Apply full component affine transform into part-local coords so assembly is lossless
      const transformedVerts = new Float64Array(meshParsed.vertices.length);
      for (let i = 0; i < meshParsed.vertices.length; i += 3) {
        const [tx, ty, tz] = apply3mfTransform(
          leaf.transform,
          meshParsed.vertices[i],
          meshParsed.vertices[i + 1],
          meshParsed.vertices[i + 2]
        );
        transformedVerts[i] = tx;
        transformedVerts[i + 1] = ty;
        transformedVerts[i + 2] = tz;
      }

      const matchedPartMeta = pickUnusedPartMeta(leaf, leafIdx);
      const metaExtruder = matchedPartMeta?.extruder ?? null;

      // Resolve 3MF basematerials pid/pindex if present on object, component, or triangles
      const triMatRef = meshParsed.triangleMaterialRefs[0];
      const matExtruder = resolveBasematerialExtruder(
        leaf.sourcePath,
        triMatRef?.pid ?? leaf.pid,
        triMatRef?.pindex ?? leaf.pindex
      );
      const paintedExtruder = meshParsed.dominantPaintedExtruder;

      // Resolve authoritative part extruder without hardcoding filament 2:
      // 1) Explicit <part> extruder in model_settings.config (when set and differing from parent default, or no conflicting triangle paint/material)
      // 2) Painted triangle extruder (when part has no explicit extruder override or matches parent default while triangles are explicitly painted to another filament)
      // 3) 3MF <basematerials> pid/pindex mapped to project filament slots
      // 4) Inherited object default extruder -> fallback 1
      let resolvedExtruder = metaExtruder ?? objDefaultExtruder ?? 1;
      if (
        paintedExtruder !== null &&
        (metaExtruder === null ||
          (metaExtruder === (objDefaultExtruder ?? 1) && paintedExtruder !== metaExtruder))
      ) {
        resolvedExtruder = paintedExtruder;
      } else if (
        matExtruder !== null &&
        (metaExtruder === null ||
          (metaExtruder === (objDefaultExtruder ?? 1) && matExtruder !== metaExtruder))
      ) {
        resolvedExtruder = matExtruder;
      }

      rawParts.push({
        partId: matchedPartMeta?.id || String(leafIdx + 1),
        name:
          matchedPartMeta?.name ||
          leaf.name ||
          (leafIdx === 0 ? `Base_${detectedLetter}` : `Letter_${detectedLetter}`),
        subtype: matchedPartMeta?.subtype || 'normal_part',
        extruder: resolvedExtruder,
        paintColorPresent: meshParsed.paintColorPresent,
        paintedExtruder,
        vertices: transformedVerts,
        triangles: meshParsed.triangles,
        sourcePath: leaf.sourcePath,
      });
    });

    if (rawParts.length === 0) continue;

    // Compute combined bounding box across all parts of this keycap object
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    for (const part of rawParts) {
      for (let i = 0; i < part.vertices.length; i += 3) {
        const x = part.vertices[i];
        const y = part.vertices[i + 1];
        const z = part.vertices[i + 2];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }

    // Center composite XY around local (0, 0) ONLY if exported offset from origin, keeping body+letter locked together
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const shiftX = Math.abs(centerX) > 1.0 ? -centerX : 0;
    const shiftY = Math.abs(centerY) > 1.0 ? -centerY : 0;
    const shiftZ = Math.abs(minZ) > 0.02 ? -minZ : 0;

    if (shiftX !== 0 || shiftY !== 0 || shiftZ !== 0) {
      for (const part of rawParts) {
        for (let i = 0; i < part.vertices.length; i += 3) {
          part.vertices[i] += shiftX;
          part.vertices[i + 1] += shiftY;
          part.vertices[i + 2] += shiftZ;
        }
      }
      minX += shiftX;
      maxX += shiftX;
      minY += shiftY;
      maxY += shiftY;
      minZ += shiftZ;
      maxZ += shiftZ;
    }

    const partsWithHashes: Parsed3mfPartMesh[] = rawParts.map((part) => ({
      partId: part.partId,
      name: part.name,
      subtype: part.subtype,
      extruder: part.extruder,
      paintColorPresent: part.paintColorPresent,
      paintedExtruder: part.paintedExtruder,
      vertices: part.vertices,
      triangles: part.triangles,
      meshHash: computeMeshGeometryHash(part.vertices, part.triangles),
    }));
    const partHashes = partsWithHashes.map((p) => p.meshHash);
    const geometryHash = computeCompositeGeometryHash(partHashes);
    const sourceModelPath = Array.from(new Set(rawParts.map((p) => p.sourcePath))).join(', ');

    const totalTriangles = partsWithHashes.reduce((s, p) => s + p.triangles.length, 0);
    keycapsByLetter[detectedLetter] = {
      letter: detectedLetter,
      modelRevision,
      cacheKey: `${modelRevision}:${detectedLetter}`,
      sourceObjectId: objId,
      sourceModelPath,
      objectName: resolvedName || `keycap-char-${detectedLetter}`,
      defaultExtruder: objMeta?.extruder ?? partsWithHashes[0]?.extruder ?? 1,
      parts: partsWithHashes,
      partHashes,
      geometryHash,
      totalTriangles,
      minX: Number(minX.toFixed(3)),
      maxX: Number(maxX.toFixed(3)),
      minY: Number(minY.toFixed(3)),
      maxY: Number(maxY.toFixed(3)),
      minZ: Number(minZ.toFixed(3)),
      maxZ: Number(maxZ.toFixed(3)),
      widthMm: Number((maxX - minX).toFixed(3)),
      depthMm: Number((maxY - minY).toFixed(3)),
      heightMm: Number((maxZ - minZ).toFixed(3)),
    };
  }

  const detectedLetters = Object.keys(keycapsByLetter).sort();
  if (detectedLetters.length === 0) {
    throw new Error(
      'Master 3MF contains no recognizable A–Z keycap objects. Name objects keycap-char-A..keycap-char-Z (or A..Z) in Bambu Studio.'
    );
  }

  const maxPartsPerKeycap = Math.max(
    1,
    ...detectedLetters.map((l) => keycapsByLetter[l].parts.length)
  );
  const extruderSet = new Set<number>();
  for (const l of detectedLetters) {
    for (const p of keycapsByLetter[l].parts) {
      if (p.extruder) extruderSet.add(p.extruder);
    }
  }
  filamentCount = Math.max(filamentCount, projectFilamentCount, extruderSet.size);

  return {
    zip,
    modelRevision,
    keycapsByLetter,
    detectedLetters,
    multiMaterialPartCount: maxPartsPerKeycap,
    filamentCount,
    projectFilamentCount,
    filamentColors,
    primeTowerEnabled,
    projectSettingsKeysCount,
  };
}

export function buildMasterTemplateSummaryFromParsed(params: {
  templateId: string;
  fileName: string;
  byteLength: number;
  sha256: string;
  uploadedAt: string;
  uploadedBy: string | null;
  parsed: ParsedMaster3mfArchive;
}): Master3mfTemplateRecord {
  const summaryKeycaps: Record<string, Master3mfDetectedKeycap> = {};
  for (const letter of params.parsed.detectedLetters) {
    const src = params.parsed.keycapsByLetter[letter];
    summaryKeycaps[letter] = {
      letter: src.letter,
      objectId: src.sourceObjectId,
      objectName: src.objectName,
      defaultExtruder: src.defaultExtruder,
      parts: src.parts.map((p) => ({
        partId: p.partId,
        name: p.name,
        subtype: p.subtype,
        extruder: p.extruder,
        triangleCount: p.triangles.length,
      })),
      totalTriangles: src.totalTriangles,
      widthMm: src.widthMm,
      depthMm: src.depthMm,
      heightMm: src.heightMm,
    };
  }

  return {
    templateId: params.templateId,
    fileName: params.fileName,
    byteLength: params.byteLength,
    sha256: params.sha256,
    uploadedAt: params.uploadedAt,
    uploadedBy: params.uploadedBy,
    detectedLetters: params.parsed.detectedLetters,
    keycapsByLetter: summaryKeycaps,
    multiMaterialPartCount: params.parsed.multiMaterialPartCount,
    filamentCount: params.parsed.filamentCount,
    filamentColors: params.parsed.filamentColors,
    primeTowerEnabled: params.parsed.primeTowerEnabled,
    projectSettingsKeysCount: params.parsed.projectSettingsKeysCount,
    isValid: true,
  };
}

// ============================================================================
// Validation & Multi-Plate XML Packaging
// ============================================================================

function validate3mfPlatePlacements(params: {
  plateNumber: number;
  letters: LettersMap;
  placements: readonly PlateLetterPlacement[];
  keycapsByLetter: Record<string, ParsedMasterKeycapTemplate>;
  bedProfile: StlBedProfile;
}): StlExportValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const expectedCount = countLetters(params.letters);

  if (expectedCount === 0) {
    errors.push(`Plate ${params.plateNumber} contains 0 alphabet keycaps (A–Z).`);
  }
  if (params.placements.length !== expectedCount) {
    errors.push(
      `Plate ${params.plateNumber} placement count (${params.placements.length}) does not match expected keycaps (${expectedCount}).`
    );
  }

  const placedCounts: LettersMap = {};
  const boxes: Array<{ minX: number; maxX: number; minY: number; maxY: number; label: string }> =
    [];

  for (const pl of params.placements) {
    const letter = pl.letter.trim().toUpperCase();
    placedCounts[letter] = (placedCounts[letter] || 0) + 1;
    const tpl = params.keycapsByLetter[letter];
    if (!tpl) {
      errors.push(`Plate ${params.plateNumber}: Missing keycap letter "${letter}" in Master 3MF.`);
      continue;
    }

    const halfW = tpl.widthMm / 2;
    const halfD = tpl.depthMm / 2;
    const minX = pl.xMm - halfW;
    const maxX = pl.xMm + halfW;
    const minY = pl.yMm - halfD;
    const maxY = pl.yMm + halfD;

    if (minX < -0.5 || maxX > params.bedProfile.widthMm + 0.5 || minY < -0.5 || maxY > params.bedProfile.depthMm + 0.5) {
      errors.push(
        `Plate ${params.plateNumber} (${letter} #${pl.index + 1}) exceeds Bambu bed bounds (${params.bedProfile.widthMm}×${params.bedProfile.depthMm}mm).`
      );
      break;
    }

    if (tpl.widthMm > pl.slotWidthMm + 0.05 || tpl.depthMm > pl.slotDepthMm + 0.05) {
      warnings.push(
        `Keycap ${letter} XY footprint (${tpl.widthMm.toFixed(1)}×${tpl.depthMm.toFixed(1)}mm) is wider than slot pitch (${pl.slotWidthMm}×${pl.slotDepthMm}mm).`
      );
    }

    boxes.push({ minX, maxX, minY, maxY, label: `${letter}#${pl.index + 1}` });
  }

  for (const letter of ABC) {
    const exp = Math.floor(Number(params.letters[letter] || 0));
    const got = Math.floor(Number(placedCounts[letter] || 0));
    if (exp !== got) {
      errors.push(
        `Plate ${params.plateNumber} letter "${letter}" count mismatch: planned ${exp}, placed ${got}.`
      );
    }
  }

  // O(N^2) pairwise AABB overlap check across all keycaps on this plate (N <= 138 -> ultra fast)
  for (let i = 0; i < boxes.length; i += 1) {
    const a = boxes[i];
    for (let j = i + 1; j < boxes.length; j += 1) {
      const b = boxes[j];
      const overlapX = a.minX < b.maxX - 0.02 && a.maxX > b.minX + 0.02;
      const overlapY = a.minY < b.maxY - 0.02 && a.maxY > b.minY + 0.02;
      if (overlapX && overlapY) {
        errors.push(
          `Plate ${params.plateNumber} keycap collision detected between ${a.label} and ${b.label}.`
        );
        return { valid: false, errors, warnings: Array.from(new Set(warnings)) };
      }
    }
  }

  if (params.placements.length >= 138) {
    warnings.push(
      `Plate ${params.plateNumber} has 138 keycaps across a 256×256mm bed — verify prime tower & cutter keep-out clearance in Bambu Studio.`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: Array.from(new Set(warnings)),
  };
}

function serializeSubObjectModelXml(
  letterTpl: ParsedMasterKeycapTemplate,
  subObjectIds: readonly number[]
): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">',
    '  <metadata name="BambuStudio:3mfVersion">1</metadata>',
    '  <resources>',
  ];

  letterTpl.parts.forEach((part, idx) => {
    const subId = subObjectIds[idx];
    const partUuid = generatePseudoUuid(
      `part:${letterTpl.cacheKey}`,
      subId
    );
    lines.push(
      `    <object id="${subId}" name="${escapeXml(part.name)}" p:UUID="${partUuid}" type="model">`
    );
    lines.push('      <mesh>');
    lines.push('        <vertices>');
    for (let v = 0; v < part.vertices.length; v += 3) {
      lines.push(
        `          <vertex x="${part.vertices[v].toFixed(4)}" y="${part.vertices[v + 1].toFixed(4)}" z="${part.vertices[v + 2].toFixed(4)}"/>`
      );
    }
    lines.push('        </vertices>');
    lines.push('        <triangles>');
    for (const t of part.triangles) {
      const extra = t.extraAttrs ? ` ${t.extraAttrs}` : '';
      lines.push(`          <triangle v1="${t.v1}" v2="${t.v2}" v3="${t.v3}"${extra}/>`);
    }
    lines.push('        </triangles>');
    lines.push('      </mesh>');
    lines.push('    </object>');
  });

  lines.push('  </resources>');
  lines.push('  <build/>');
  lines.push('</model>');
  return lines.join('\n');
}

const THREE_MF_MODEL_REL_TYPE =
  'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';

function resolveZipFileKey(zip: JSZip, targetPath: string): string | null {
  const norm = normalizeZipPath(targetPath);
  if (!norm) return null;
  const direct = zip.files[norm];
  if (direct && !direct.dir) return norm;
  const targetLower = norm.toLowerCase();
  for (const key of Object.keys(zip.files)) {
    const entry = zip.files[key];
    if (!entry.dir && normalizeZipPath(key).toLowerCase() === targetLower) {
      return key;
    }
  }
  return null;
}

function parseRelationshipsXml(relsXml: string): Exported3mfRelationshipEntry[] {
  const relTags = findMatchingTagElements(relsXml, 'Relationship');
  return relTags.map((tag) => ({
    id: (tag.attrs.Id || '').trim(),
    target: (tag.attrs.Target || '').trim(),
    type: (tag.attrs.Type || '').trim(),
  }));
}

function buildEnsureContentTypesXml(existingXml: string | null): string {
  if (
    existingXml &&
    existingXml.includes('Extension="model"') &&
    existingXml.includes('Extension="rels"')
  ) {
    return existingXml;
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>',
    '  <Default Extension="config" ContentType="text/plain"/>',
    '  <Default Extension="xml" ContentType="application/xml"/>',
    '  <Default Extension="json" ContentType="application/json"/>',
    '  <Default Extension="png" ContentType="image/png"/>',
    '</Types>',
  ].join('\n');
}

function buildSanitizedRootRelsXml(existingXml: string | null, outZip: JSZip): string {
  const keptRelationships: Exported3mfRelationshipEntry[] = [
    {
      id: 'rel-1',
      target: '/3D/3dmodel.model',
      type: THREE_MF_MODEL_REL_TYPE,
    },
  ];
  const usedIds = new Set<string>(['rel-1']);
  const seenTargets = new Set<string>(['3d/3dmodel.model']);

  if (existingXml) {
    const parsedExisting = parseRelationshipsXml(existingXml);
    let nextSeq = 2;
    for (const rel of parsedExisting) {
      if (!rel.target) continue;
      const normTarget = normalizeZipPath(rel.target);
      const normLower = normTarget.toLowerCase();
      if (!normLower || seenTargets.has(normLower)) continue;
      // Never preserve stale main-model overrides or dangling thumbnail/cache references
      if (rel.type === THREE_MF_MODEL_REL_TYPE) continue;
      if (/^(?:metadata|auxiliaries)\/.*(?:plate_|top_|pick_|thumbnail)/i.test(normLower)) {
        continue;
      }
      if (!resolveZipFileKey(outZip, normTarget)) {
        continue;
      }

      let relId = rel.id;
      if (!relId || usedIds.has(relId)) {
        while (usedIds.has(`rel-${nextSeq}`)) {
          nextSeq += 1;
        }
        relId = `rel-${nextSeq}`;
        nextSeq += 1;
      }
      usedIds.add(relId);
      seenTargets.add(normLower);
      keptRelationships.push({
        id: relId,
        target: rel.target.startsWith('/') ? rel.target : `/${normTarget}`,
        type: rel.type || THREE_MF_MODEL_REL_TYPE,
      });
    }
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    ...keptRelationships.map(
      (r) =>
        `  <Relationship Target="${escapeXml(r.target)}" Id="${escapeXml(r.id)}" Type="${escapeXml(r.type)}"/>`
    ),
    '</Relationships>',
  ].join('\n');
}

function buildModelRelationshipsXml(subModelPaths: readonly string[]): string {
  const uniquePaths = Array.from(
    new Set(
      subModelPaths
        .map((p) => {
          const clean = normalizeZipPath(p);
          return clean ? `/${clean}` : '';
        })
        .filter(Boolean)
    )
  ).sort();

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    ...uniquePaths.map(
      (target, idx) =>
        `  <Relationship Target="${escapeXml(target)}" Id="rel-${idx + 1}" Type="${THREE_MF_MODEL_REL_TYPE}"/>`
    ),
    '</Relationships>',
  ].join('\n');
}

async function assembleBambu3mfPackage(params: {
  parsedMaster: ParsedMaster3mfArchive;
  plates: readonly {
    plateNumber: number;
    plateCode: string;
    letters: LettersMap;
    placements: PlateLetterPlacement[];
    validation: StlExportValidationResult;
  }[];
  projectName?: string;
  batchId?: string;
  onProgress?: (event: Bambu3mfExportProgressEvent) => void;
}): Promise<{
  threeMfBytes: Uint8Array;
  plateSummaries: Export3mfPlateSummary[];
  warnings: string[];
}> {
  const outZip = new JSZip();

  // 1. Copy preserved slicer/filament settings from Master 3MF cleanly,
  //    explicitly excluding Master model geometry, stale Master 3D/_rels/*,
  //    stale Metadata/model_settings.config, and stripped preview thumbnails.
  let existingContentTypes: string | null = null;
  let existingRootRels: string | null = null;

  for (const [rawPath, zipEntry] of Object.entries(params.parsedMaster.zip.files)) {
    if (zipEntry.dir) continue;
    const norm = normalizeZipPath(rawPath);
    const normLower = norm.toLowerCase();

    if (
      normLower === '3d/3dmodel.model' ||
      normLower.startsWith('3d/objects/') ||
      normLower === '3d/_rels/3dmodel.model.rels' ||
      normLower.startsWith('3d/_rels/') ||
      normLower === 'metadata/model_settings.config' ||
      /^metadata\/(?:plate_|top_|pick_|slice_info|cut_information|thumbnail)/i.test(normLower) ||
      /^auxiliaries\/\.?thumbnails\//i.test(normLower)
    ) {
      continue;
    }

    const content = await zipEntry.async('uint8array');
    if (normLower === '[content_types].xml') {
      existingContentTypes = new TextDecoder().decode(content);
      continue;
    }
    if (normLower === '_rels/.rels') {
      existingRootRels = new TextDecoder().decode(content);
      continue;
    }

    outZip.file(norm, content, { binary: true });
  }

  // 2. Write reusable sub-object mesh files (/3D/Objects/keycap_{LETTER}.model) once per used letter
  //    Strict isolation:
  //    - Lookup keyed by exact letter (zero fallback to 'A' or first model)
  //    - Reject missing, mismatched, or duplicate geometry across distinct letters
  //    - Assign globally disjoint sub-object IDs starting at 1001 so Bambu Studio never collides sub-objects across files
  const usedLettersSet = new Set<string>();
  for (const plate of params.plates) {
    for (const pl of plate.placements) {
      const letter = pl.letter.trim().toUpperCase();
      if (!letter || !ABC.includes(letter as any)) {
        throw new Error(
          `Plate ${plate.plateNumber} contains invalid keycap letter identifier "${pl.letter}". Export aborted.`
        );
      }
      usedLettersSet.add(letter);
    }
  }
  const usedLetters = Array.from(usedLettersSet).sort();

  const letterToObjectId = new Map<string, number>();
  const letterToSubObjectIds = new Map<string, number[]>();
  const letterSubObjectPath = new Map<string, string>();
  const writtenSubModelPaths: string[] = [];

  const seenSourceObjectIds = new Map<string, string>();
  const seenGeometryHashes = new Map<string, string>();
  const seenRaisedPartHashes = new Map<string, string>();

  // Keep sub-object mesh IDs strictly separated from top-level parent object IDs (1..usedLetters.length)
  let nextGlobalSubObjectId = Math.max(1001, usedLetters.length + 100);

  usedLetters.forEach((letter, idx) => {
    const objId = idx + 1;
    const tpl = Object.prototype.hasOwnProperty.call(
      params.parsedMaster.keycapsByLetter,
      letter
    )
      ? params.parsedMaster.keycapsByLetter[letter]
      : undefined;

    if (!tpl || tpl.letter !== letter || tpl.parts.length === 0 || tpl.totalTriangles <= 0) {
      throw new Error(
        `Missing or invalid 3D geometry for keycap letter "${letter}" in Master .3MF. Export aborted (never substituting another letter).`
      );
    }

    const prevSourceLetter = seenSourceObjectIds.get(tpl.sourceObjectId);
    if (prevSourceLetter && prevSourceLetter !== letter) {
      throw new Error(
        `Master .3MF maps letters "${prevSourceLetter}" and "${letter}" to the same source object id="${tpl.sourceObjectId}". Export aborted.`
      );
    }
    seenSourceObjectIds.set(tpl.sourceObjectId, letter);

    const prevGeomLetter = seenGeometryHashes.get(tpl.geometryHash);
    if (prevGeomLetter && prevGeomLetter !== letter) {
      throw new Error(
        `Invalid Master .3MF geometry: letter "${letter}" has identical mesh geometry to "${prevGeomLetter}" (${tpl.geometryHash}). Re-export a clean Master .3MF with distinct A–Z models.`
      );
    }
    seenGeometryHashes.set(tpl.geometryHash, letter);

    if (tpl.partHashes.length >= 2) {
      const raisedHash = tpl.partHashes[tpl.partHashes.length - 1];
      const prevRaisedLetter = seenRaisedPartHashes.get(raisedHash);
      if (prevRaisedLetter && prevRaisedLetter !== letter) {
        throw new Error(
          `Invalid Master .3MF geometry: raised character mesh for "${letter}" is identical to "${prevRaisedLetter}" (${raisedHash}).`
        );
      }
      seenRaisedPartHashes.set(raisedHash, letter);
    }

    // Strict pre-export material mapping validation (no silent fallback to extruder 1 or hardcoded slot 2)
    const letterEffectiveExtruders = new Set<number>();
    tpl.parts.forEach((part, partIdx) => {
      if (part.extruder === null || !Number.isInteger(part.extruder) || part.extruder < 1) {
        throw new Error(
          `Material mapping error for keycap "${letter}" part #${partIdx + 1} ("${part.name}"): missing valid extruder assignment.`
        );
      }
      if (
        params.parsedMaster.projectFilamentCount > 0 &&
        part.extruder > params.parsedMaster.projectFilamentCount
      ) {
        throw new Error(
          `Material mapping error for keycap "${letter}" part "${part.name}": assigned extruder ${part.extruder} exceeds Master 3MF filament count (${params.parsedMaster.projectFilamentCount}).`
        );
      }
      letterEffectiveExtruders.add(part.extruder);
      if (part.paintedExtruder !== null && part.paintedExtruder >= 1) {
        letterEffectiveExtruders.add(part.paintedExtruder);
      }
    });

    if (tpl.parts.length >= 2 && letterEffectiveExtruders.size < 2) {
      throw new Error(
        `Two-colour material mapping validation failed for keycap "${letter}": all ${tpl.parts.length} parts (${tpl.parts.map((p) => p.name).join(', ')}) resolved to extruder ${Array.from(letterEffectiveExtruders)[0] ?? 1}. Assign separate filament/extruder slots in the Master .3MF before exporting.`
      );
    }

    const subObjectIds = tpl.parts.map(() => nextGlobalSubObjectId++);
    const objModelPath = `3D/Objects/keycap_${letter}.model`;
    const pPath = `/${objModelPath}`;
    letterToObjectId.set(letter, objId);
    letterToSubObjectIds.set(letter, subObjectIds);
    letterSubObjectPath.set(letter, pPath);
    writtenSubModelPaths.push(pPath);
    outZip.file(objModelPath, serializeSubObjectModelXml(tpl, subObjectIds));
  });

  // 3. Construct 3D/3dmodel.model + Metadata/model_settings.config (strict multi-plate bindings)
  const rootModelLines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" requiredextensions="p">',
    '  <metadata name="Application">BambuStudio-WOOPP6</metadata>',
    '  <metadata name="BambuStudio:3mfVersion">1</metadata>',
    ...(params.batchId
      ? [`  <metadata name="WOOPP:BatchId">${escapeXml(params.batchId)}</metadata>`]
      : []),
    ...(params.projectName
      ? [`  <metadata name="WOOPP:Project">${escapeXml(params.projectName)}</metadata>`]
      : []),
    '  <resources>',
  ];

  const modelSettingsLines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<config>',
  ];

  for (const letter of usedLetters) {
    const objId = letterToObjectId.get(letter)!;
    const subObjectIds = letterToSubObjectIds.get(letter)!;
    const pPath = letterSubObjectPath.get(letter)!;
    const tpl = params.parsedMaster.keycapsByLetter[letter];
    const objUuid = generatePseudoUuid(`obj:${tpl.cacheKey}`, objId);

    rootModelLines.push(
      `    <object id="${objId}" p:UUID="${objUuid}" name="${escapeXml(`keycap-char-${letter}`)}" type="model">`
    );
    rootModelLines.push('      <components>');
    tpl.parts.forEach((_, pIdx) => {
      const subId = subObjectIds[pIdx];
      const compUuid = generatePseudoUuid(`comp:${tpl.cacheKey}`, subId);
      rootModelLines.push(
        `        <component p:path="${pPath}" objectid="${subId}" p:UUID="${compUuid}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`
      );
    });
    rootModelLines.push('      </components>');
    rootModelLines.push('    </object>');

    const objectBaseExtruder = tpl.defaultExtruder ?? tpl.parts[0]?.extruder ?? 1;
    modelSettingsLines.push(`  <object id="${objId}">`);
    modelSettingsLines.push(
      `    <metadata key="name" value="${escapeXml(`keycap-char-${letter}`)}"/>`
    );
    modelSettingsLines.push(
      `    <metadata key="extruder" value="${objectBaseExtruder}"/>`
    );
    tpl.parts.forEach((part, pIdx) => {
      const subId = subObjectIds[pIdx];
      const resolvedPartExtruder = part.extruder ?? objectBaseExtruder;
      modelSettingsLines.push(
        `    <part id="${subId}" subtype="${escapeXml(part.subtype)}">`
      );
      modelSettingsLines.push(`      <metadata key="name" value="${escapeXml(part.name)}"/>`);
      modelSettingsLines.push(
        '      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>'
      );
      modelSettingsLines.push(
        `      <metadata key="extruder" value="${resolvedPartExtruder}"/>`
      );
      modelSettingsLines.push(`      <metadata key="source_object_id" value="${pIdx}"/>`);
      modelSettingsLines.push('      <metadata key="source_volume_id" value="0"/>');
      modelSettingsLines.push('    </part>');
    });
    modelSettingsLines.push('  </object>');
  }

  const buildUuid = generatePseudoUuid(
    `build:${params.batchId || params.plates.map((p) => p.plateCode).join('-')}`,
    params.plates.length
  );
  rootModelLines.push('  </resources>');
  rootModelLines.push(`  <build p:UUID="${buildUuid}">`);

  const instanceCounterByObjectId = new Map<number, number>();
  let globalIdentifyId = 1;

  const assembleLines: string[] = ['  <assemble>'];
  const plateBlocksLines: string[] = [];
  const plateSummaries: Export3mfPlateSummary[] = [];
  const warningSet = new Set<string>();

  params.plates.forEach((plate, pIdx) => {
    const platerId = pIdx + 1;
    const platerName = `WP-${plate.plateCode}`;
    for (const w of plate.validation.warnings) {
      warningSet.add(w);
    }

    plateBlocksLines.push('  <plate>');
    plateBlocksLines.push(`    <metadata key="plater_id" value="${platerId}"/>`);
    plateBlocksLines.push(
      `    <metadata key="plater_name" value="${escapeXml(platerName)}"/>`
    );
    plateBlocksLines.push('    <metadata key="locked" value="false"/>');

    for (const pl of plate.placements) {
      const letter = pl.letter.trim().toUpperCase();
      const objId = letterToObjectId.get(letter)!;
      const instanceId = instanceCounterByObjectId.get(objId) ?? 0;
      instanceCounterByObjectId.set(objId, instanceId + 1);
      const identifyId = globalIdentifyId++;

      const itemUuid = generatePseudoUuid(`item:${plate.plateCode}`, identifyId);
      rootModelLines.push(
        `    <item objectid="${objId}" p:UUID="${itemUuid}" transform="1 0 0 0 1 0 0 0 1 ${pl.xMm.toFixed(3)} ${pl.yMm.toFixed(3)} 0.000" printable="1"/>`
      );

      plateBlocksLines.push('    <model_instance>');
      plateBlocksLines.push(`      <metadata key="object_id" value="${objId}"/>`);
      plateBlocksLines.push(`      <metadata key="instance_id" value="${instanceId}"/>`);
      plateBlocksLines.push(`      <metadata key="identify_id" value="${identifyId}"/>`);
      plateBlocksLines.push('    </model_instance>');

      assembleLines.push(
        `    <assemble_item object_id="${objId}" instance_id="${instanceId}" transform="1 0 0 0 1 0 0 0 1 0 0 0" offset="0 0 0"/>`
      );
    }

    plateBlocksLines.push('  </plate>');

    plateSummaries.push({
      plateNumber: plate.plateNumber,
      plateCode: plate.plateCode,
      platerId,
      platerName,
      keycapCount: plate.placements.length,
      letterBreakdown: compactLettersMap(plate.letters),
      placements: plate.placements,
      validation: plate.validation,
    });
  });

  rootModelLines.push('  </build>');
  rootModelLines.push('</model>');

  assembleLines.push('  </assemble>');
  modelSettingsLines.push(...plateBlocksLines);
  modelSettingsLines.push(...assembleLines);
  modelSettingsLines.push('</config>');

  outZip.file('3D/3dmodel.model', rootModelLines.join('\n'));
  outZip.file('Metadata/model_settings.config', modelSettingsLines.join('\n'));

  // 4. Write [Content_Types].xml, dynamic 3D/_rels/3dmodel.model.rels, and sanitized _rels/.rels
  //    AFTER all referenced files exist in outZip so zero dangling relationships can occur.
  outZip.file('[Content_Types].xml', buildEnsureContentTypesXml(existingContentTypes));
  outZip.file(
    '3D/_rels/3dmodel.model.rels',
    buildModelRelationshipsXml(writtenSubModelPaths)
  );
  outZip.file('_rels/.rels', buildSanitizedRootRelsXml(existingRootRels, outZip));

  params.onProgress?.({
    phase: 'packaging_3mf',
    completedPlates: params.plates.length,
    totalPlates: params.plates.length,
    percent: 85,
    message: `Compressing ${params.plates.length}-plate Bambu Studio .3mf archive...`,
  });

  const threeMfBytes = await outZip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 3 },
  });

  return {
    threeMfBytes,
    plateSummaries,
    warnings: Array.from(warningSet),
  };
}

// ============================================================================
// Post-Pack Automatic 3MF Structural, OPC & Geometry Self-Validation
// ============================================================================

export async function validateExported3mfArchive(params: {
  threeMfBytes: Uint8Array;
  expectedPlates?: readonly {
    plateNumber: number;
    plateCode: string;
    letters: LettersMap;
    placements: readonly PlateLetterPlacement[];
  }[];
  parsedMaster?: ParsedMaster3mfArchive;
}): Promise<Exported3mfAuditReport> {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!params.threeMfBytes || params.threeMfBytes.byteLength < 32) {
    return {
      valid: false,
      errors: ['Generated .3MF archive is empty or truncated.'],
      warnings,
      rootRelationships: [],
      modelRelationships: [],
      includedObjectFiles: [],
      totalBuildItems: 0,
      totalVertices: 0,
      totalTriangles: 0,
      plateCount: 0,
      extrudersUsed: [],
      projectSettingsValid: false,
      resolvedLetterGeometryCounts: {},
      letterGeometryAudit: {},
      distinctGeometryHashesCount: 0,
    };
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(params.threeMfBytes);
  } catch {
    return {
      valid: false,
      errors: ['Generated .3MF bytes could not be re-opened as a valid ZIP archive.'],
      warnings,
      rootRelationships: [],
      modelRelationships: [],
      includedObjectFiles: [],
      totalBuildItems: 0,
      totalVertices: 0,
      totalTriangles: 0,
      plateCount: 0,
      extrudersUsed: [],
      projectSettingsValid: false,
      resolvedLetterGeometryCounts: {},
      letterGeometryAudit: {},
      distinctGeometryHashesCount: 0,
    };
  }

  // 1. Validate [Content_Types].xml
  const contentTypesKey = resolveZipFileKey(zip, '[Content_Types].xml');
  if (!contentTypesKey) {
    errors.push('Missing required [Content_Types].xml in .3MF archive.');
  } else {
    const ctXml = await zip.file(contentTypesKey)!.async('string');
    if (!ctXml.includes('Extension="rels"') || !ctXml.includes('Extension="model"')) {
      errors.push('[Content_Types].xml does not declare both "rels" and "model" extensions.');
    }
  }

  // 2. Validate root _rels/.rels and verify every target exists inside ZIP
  const rootRelsKey = resolveZipFileKey(zip, '_rels/.rels');
  let rootRelationships: Exported3mfRelationshipEntry[] = [];
  if (!rootRelsKey) {
    errors.push('Missing required root _rels/.rels relationship file.');
  } else {
    const rootRelsXml = await zip.file(rootRelsKey)!.async('string');
    rootRelationships = parseRelationshipsXml(rootRelsXml);
    if (rootRelationships.length === 0) {
      errors.push('_rels/.rels contains zero OPC relationships.');
    }
    const rootIds = new Set<string>();
    let hasMainModelRel = false;
    for (const rel of rootRelationships) {
      if (!rel.id) {
        errors.push(`_rels/.rels contains a relationship without an Id (target: "${rel.target}").`);
      } else if (rootIds.has(rel.id)) {
        errors.push(`_rels/.rels contains duplicate relationship Id "${rel.id}".`);
      } else {
        rootIds.add(rel.id);
      }

      if (!rel.target) {
        errors.push(`_rels/.rels contains a relationship "${rel.id}" with an empty Target.`);
        continue;
      }

      const resolvedKey = resolveZipFileKey(zip, rel.target);
      if (!resolvedKey) {
        errors.push(
          `_rels/.rels references missing target "${rel.target}" that does not exist in archive.`
        );
      }
      if (
        normalizeZipPath(rel.target).toLowerCase() === '3d/3dmodel.model' &&
        rel.type === THREE_MF_MODEL_REL_TYPE
      ) {
        hasMainModelRel = true;
      }
    }
    if (!hasMainModelRel) {
      errors.push('_rels/.rels is missing the primary /3D/3dmodel.model 3MF relationship.');
    }
  }

  // 3. Collect all non-root .model files in 3D/Objects/ (or any sub-model paths)
  const includedObjectFiles = Object.keys(zip.files)
    .filter((k) => {
      const entry = zip.files[k];
      if (entry.dir) return false;
      const normLower = normalizeZipPath(k).toLowerCase();
      return normLower.endsWith('.model') && normLower !== '3d/3dmodel.model';
    })
    .map((k) => normalizeZipPath(k))
    .sort();

  // 4. Parse 3D/3dmodel.model
  const rootModelKey = resolveZipFileKey(zip, '3D/3dmodel.model');
  let rootModelXml = '';
  let rootIndex: ModelFileIndex | null = null;
  const referencedSubModelTargets = new Set<string>();
  const buildItems: Array<{ objectId: string; transform: number[] }> = [];

  if (!rootModelKey) {
    errors.push('Missing required 3D/3dmodel.model in exported .3MF archive.');
  } else {
    rootModelXml = await zip.file(rootModelKey)!.async('string');
    rootIndex = parseModelFileXml(rootModelXml);

    if (rootIndex.objectsById.size === 0) {
      errors.push('3D/3dmodel.model defines zero <object> entries.');
    }

    for (const obj of rootIndex.objectsById.values()) {
      for (const comp of obj.components) {
        if (comp.path) {
          referencedSubModelTargets.add(normalizeZipPath(comp.path).toLowerCase());
        }
      }
    }

    const buildTags = findMatchingTagElements(rootModelXml, 'build');
    if (buildTags.length === 0) {
      errors.push('3D/3dmodel.model is missing a <build> section.');
    } else {
      const buildBody = rootModelXml.slice(buildTags[0].bodyStart, buildTags[0].bodyEnd);
      const itemTags = findMatchingTagElements(buildBody, 'item');
      for (const it of itemTags) {
        const oid = (it.attrs.objectid || '').trim();
        buildItems.push({
          objectId: oid,
          transform: parseTransformMatrix(it.attrs.transform),
        });
      }
    }
  }

  // 5. Validate 3D/_rels/3dmodel.model.rels matches actual component targets & archive files
  const modelRelsKey = resolveZipFileKey(zip, '3D/_rels/3dmodel.model.rels');
  let modelRelationships: Exported3mfRelationshipEntry[] = [];
  const relTargetsLower = new Set<string>();

  if (referencedSubModelTargets.size > 0 && !modelRelsKey) {
    errors.push(
      'Missing 3D/_rels/3dmodel.model.rels while 3D/3dmodel.model references external component files.'
    );
  } else if (modelRelsKey) {
    const modelRelsXml = await zip.file(modelRelsKey)!.async('string');
    modelRelationships = parseRelationshipsXml(modelRelsXml);
    const modelRelIds = new Set<string>();

    for (const rel of modelRelationships) {
      if (!rel.id) {
        errors.push(
          `3D/_rels/3dmodel.model.rels has relationship missing Id (target "${rel.target}").`
        );
      } else if (modelRelIds.has(rel.id)) {
        errors.push(`3D/_rels/3dmodel.model.rels has duplicate Id "${rel.id}".`);
      } else {
        modelRelIds.add(rel.id);
      }

      if (rel.type !== THREE_MF_MODEL_REL_TYPE) {
        errors.push(
          `3D/_rels/3dmodel.model.rels relationship "${rel.id}" has unexpected Type "${rel.type}".`
        );
      }

      if (!rel.target) {
        errors.push(`3D/_rels/3dmodel.model.rels relationship "${rel.id}" has empty Target.`);
        continue;
      }

      const normLower = normalizeZipPath(rel.target).toLowerCase();
      if (relTargetsLower.has(normLower)) {
        errors.push(`3D/_rels/3dmodel.model.rels contains duplicate Target "${rel.target}".`);
      }
      relTargetsLower.add(normLower);

      const resolvedKey = resolveZipFileKey(zip, rel.target);
      if (!resolvedKey) {
        errors.push(
          `3D/_rels/3dmodel.model.rels references missing geometry file "${rel.target}" not present in archive.`
        );
      }
    }

    for (const refPath of referencedSubModelTargets) {
      if (!relTargetsLower.has(refPath)) {
        errors.push(
          `3D/3dmodel.model references component "${refPath}" that is missing from 3D/_rels/3dmodel.model.rels.`
        );
      }
    }

    for (const relTarget of relTargetsLower) {
      if (!referencedSubModelTargets.has(relTarget)) {
        errors.push(
          `3D/_rels/3dmodel.model.rels contains unreferenced relationship target "${relTarget}".`
        );
      }
    }
  }

  // 6. Verify every component mesh, live mesh hashes, globally disjoint object IDs, and geometry integrity
  const subModelIndexByPath = new Map<string, ModelFileIndex>();
  const subObjectMeshHashByPathAndId = new Map<string, string>();
  const subObjectPaintedExtruderByPathAndId = new Map<string, number>();
  const seenGlobalObjectIds = new Map<string, string>(); // objectId -> defining model file
  let totalVertices = 0;
  let totalTriangles = 0;

  if (rootIndex) {
    for (const rootObj of rootIndex.objectsById.values()) {
      seenGlobalObjectIds.set(rootObj.id, '3D/3dmodel.model');
    }
  }

  for (const subPath of includedObjectFiles) {
    const subKey = resolveZipFileKey(zip, subPath);
    if (!subKey) {
      errors.push(`Unable to open geometry file "${subPath}" inside .3MF archive.`);
      continue;
    }
    const subXml = await zip.file(subKey)!.async('string');
    const subIndex = parseModelFileXml(subXml);
    const subPathLower = subPath.toLowerCase();
    subModelIndexByPath.set(subPathLower, subIndex);

    for (const subObj of subIndex.objectsById.values()) {
      const priorOwner = seenGlobalObjectIds.get(subObj.id);
      if (priorOwner && priorOwner !== subPath) {
        errors.push(
          `Object ID collision detected: object id="${subObj.id}" in "${subPath}" collides with "${priorOwner}". Sub-object IDs must be globally unique across the 3MF archive.`
        );
      } else {
        seenGlobalObjectIds.set(subObj.id, subPath);
      }

      if (!subObj.hasMesh) {
        errors.push(`Geometry file "${subPath}" object id="${subObj.id}" has no <mesh>.`);
        continue;
      }
      const meshParsed = parseMeshFromXmlBody(subObj.rawBody);
      const vertexCount = Math.floor(meshParsed.vertices.length / 3);
      if (vertexCount < 3 || meshParsed.triangles.length === 0) {
        errors.push(
          `Geometry file "${subPath}" object id="${subObj.id}" has invalid mesh (${vertexCount} vertices, ${meshParsed.triangles.length} triangles).`
        );
        continue;
      }
      for (let i = 0; i < meshParsed.vertices.length; i += 1) {
        if (!Number.isFinite(meshParsed.vertices[i])) {
          errors.push(`Geometry file "${subPath}" object id="${subObj.id}" has non-finite vertex coordinate.`);
          break;
        }
      }
      for (const tri of meshParsed.triangles) {
        if (
          tri.v1 < 0 ||
          tri.v1 >= vertexCount ||
          tri.v2 < 0 ||
          tri.v2 >= vertexCount ||
          tri.v3 < 0 ||
          tri.v3 >= vertexCount
        ) {
          errors.push(
            `Geometry file "${subPath}" object id="${subObj.id}" has out-of-range triangle vertex index.`
          );
          break;
        }
      }

      const partHash = computeMeshGeometryHash(meshParsed.vertices, meshParsed.triangles);
      subObjectMeshHashByPathAndId.set(`${subPathLower}#${subObj.id}`, partHash);
      if (meshParsed.dominantPaintedExtruder !== null) {
        subObjectPaintedExtruderByPathAndId.set(
          `${subPathLower}#${subObj.id}`,
          meshParsed.dominantPaintedExtruder
        );
      }

      totalVertices += vertexCount;
      totalTriangles += meshParsed.triangles.length;
    }
  }

  if (rootIndex) {
    for (const obj of rootIndex.objectsById.values()) {
      if (obj.components.length === 0 && !obj.hasMesh) {
        errors.push(`3D/3dmodel.model object id="${obj.id}" has neither components nor mesh.`);
      }
      for (const comp of obj.components) {
        const compPathLower = (comp.path ? normalizeZipPath(comp.path) : '3d/3dmodel.model').toLowerCase();
        const targetIndex =
          compPathLower === '3d/3dmodel.model'
            ? rootIndex
            : subModelIndexByPath.get(compPathLower);
        if (!targetIndex) {
          errors.push(
            `Object id="${obj.id}" component references missing model file "${comp.path}".`
          );
          continue;
        }
        if (!targetIndex.objectsById.has(comp.objectId)) {
          errors.push(
            `Object id="${obj.id}" component references missing objectid="${comp.objectId}" in "${comp.path}".`
          );
        }
      }
    }

    for (const item of buildItems) {
      if (!item.objectId || !rootIndex.objectsById.has(item.objectId)) {
        errors.push(
          `3D/3dmodel.model <build> references missing objectid="${item.objectId}".`
        );
      }
    }
  }

  // Parse Metadata/project_settings.config early so material slot bounds are known during model_settings audit
  let projectSettingsValid = true;
  let exportedProjectFilamentCount = params.parsedMaster?.projectFilamentCount ?? 0;
  const projectSettingsKey = resolveZipFileKey(zip, 'Metadata/project_settings.config');
  if (projectSettingsKey) {
    try {
      const parsed = JSON.parse(await zip.file(projectSettingsKey)!.async('string'));
      if (!parsed || typeof parsed !== 'object') {
        projectSettingsValid = false;
        errors.push('Metadata/project_settings.config is not a valid JSON object.');
      } else {
        const pObj = parsed as Record<string, unknown>;
        if (Array.isArray(pObj.filament_colour)) {
          exportedProjectFilamentCount = Math.max(
            exportedProjectFilamentCount,
            pObj.filament_colour.length
          );
        }
        if (Array.isArray(pObj.filament_type)) {
          exportedProjectFilamentCount = Math.max(
            exportedProjectFilamentCount,
            pObj.filament_type.length
          );
        }
      }
    } catch {
      projectSettingsValid = false;
      errors.push('Metadata/project_settings.config is corrupted or invalid JSON.');
    }
  } else if (params.parsedMaster && params.parsedMaster.projectSettingsKeysCount > 0) {
    projectSettingsValid = false;
    errors.push('Master Metadata/project_settings.config was lost during .3MF export.');
  }

  // 7. Verify Metadata/model_settings.config + live geometry-to-letter resolution & material audit
  const modelSettingsKey = resolveZipFileKey(zip, 'Metadata/model_settings.config');
  let plateCount = 0;
  const extrudersSet = new Set<number>();
  const resolvedLetterGeometryCounts: Record<string, number> = {};
  const letterGeometryAudit: Record<string, ExportedLetterGeometryAuditEntry> = {};
  const distinctHashes = new Set<string>();

  if (!modelSettingsKey) {
    errors.push('Missing Metadata/model_settings.config in exported .3MF archive.');
  } else {
    const settingsXml = await zip.file(modelSettingsKey)!.async('string');
    const objSettingsMap = parseModelSettingsXml(settingsXml);

    // Map every top-level root objectId -> resolved actual letter & verified reloaded geometry hash
    const rootObjectIdToResolvedLetter = new Map<string, string>();
    const geomHashToLetter = new Map<string, string>();
    const raisedHashToLetter = new Map<string, string>();

    if (rootIndex) {
      for (const rootObj of rootIndex.objectsById.values()) {
        const objMeta = objSettingsMap.get(rootObj.id);
        const labelCandidate = objMeta?.name || rootObj.name;
        const resolvedLetter = matchLetterFrom3mfObjectName(labelCandidate);

        if (!resolvedLetter) {
          errors.push(
            `Unable to determine keycap letter for 3D/3dmodel.model object id="${rootObj.id}" (name="${labelCandidate || ''}").`
          );
          continue;
        }

        if (!objMeta) {
          errors.push(
            `Metadata/model_settings.config is missing <object id="${rootObj.id}"> entry for keycap "${resolvedLetter}".`
          );
        }

        const expectedSubPath = `3d/objects/keycap_${resolvedLetter.toLowerCase()}.model`;
        const reloadedPartHashes: string[] = [];
        const subObjectIds: string[] = [];
        const exportedPartExtruders: number[] = [];
        const effectiveMaterialExtruders = new Set<number>();
        let resolvedModelPath = '';

        rootObj.components.forEach((comp, compIdx) => {
          const compPathNorm = comp.path ? normalizeZipPath(comp.path) : '';
          const compPathLower = compPathNorm.toLowerCase();
          if (compPathLower !== expectedSubPath) {
            errors.push(
              `Letter "${resolvedLetter}" (object id="${rootObj.id}") points to wrong component file "${comp.path}" instead of "/3D/Objects/keycap_${resolvedLetter}.model".`
            );
          }
          if (!resolvedModelPath && compPathNorm) resolvedModelPath = `/${compPathNorm}`;
          subObjectIds.push(comp.objectId);
          const partHash = subObjectMeshHashByPathAndId.get(`${compPathLower}#${comp.objectId}`);
          if (partHash) {
            reloadedPartHashes.push(partHash);
          } else {
            errors.push(
              `Letter "${resolvedLetter}" (object id="${rootObj.id}") failed live mesh hash lookup for "${compPathNorm}#${comp.objectId}".`
            );
          }

          const matchedExportedPart =
            objMeta?.parts.find((p) => p.id === comp.objectId) || objMeta?.parts[compIdx];
          if (!matchedExportedPart) {
            errors.push(
              `Metadata/model_settings.config object id="${rootObj.id}" ("${resolvedLetter}") is missing <part id="${comp.objectId}"> entry.`
            );
          } else {
            const pExt = matchedExportedPart.extruder;
            if (pExt === null || !Number.isInteger(pExt) || pExt < 1) {
              errors.push(
                `Metadata/model_settings.config keycap "${resolvedLetter}" part "${matchedExportedPart.name || comp.objectId}" is missing a valid extruder assignment.`
              );
            } else {
              exportedPartExtruders.push(pExt);
              effectiveMaterialExtruders.add(pExt);
              if (exportedProjectFilamentCount > 0 && pExt > exportedProjectFilamentCount) {
                errors.push(
                  `Keycap "${resolvedLetter}" part "${matchedExportedPart.name || comp.objectId}" references extruder ${pExt}, exceeding project filament count (${exportedProjectFilamentCount}).`
                );
              }
            }
          }

          const paintedExt = subObjectPaintedExtruderByPathAndId.get(
            `${compPathLower}#${comp.objectId}`
          );
          if (paintedExt !== undefined && paintedExt >= 1) {
            effectiveMaterialExtruders.add(paintedExt);
          }
        });

        if (rootObj.components.length >= 2 && effectiveMaterialExtruders.size < 2) {
          errors.push(
            `Two-colour material collapse detected for keycap "${resolvedLetter}": all ${rootObj.components.length} parts in Metadata/model_settings.config share extruder ${Array.from(effectiveMaterialExtruders)[0] ?? 1}.`
          );
        }

        const reloadedGeometryHash = computeCompositeGeometryHash(reloadedPartHashes);
        const raisedPartHash = reloadedPartHashes[reloadedPartHashes.length - 1] || '';

        if (params.parsedMaster) {
          const masterTpl = Object.prototype.hasOwnProperty.call(
            params.parsedMaster.keycapsByLetter,
            resolvedLetter
          )
            ? params.parsedMaster.keycapsByLetter[resolvedLetter]
            : undefined;
          if (!masterTpl) {
            errors.push(
              `Exported object "${resolvedLetter}" has no corresponding original letter template in Master .3MF.`
            );
          } else {
            if (reloadedGeometryHash !== masterTpl.geometryHash) {
              errors.push(
                `Exported mesh hash for letter "${resolvedLetter}" (${reloadedGeometryHash}) does not match Master .3MF original geometry (${masterTpl.geometryHash}).`
              );
            }
            const expectedMasterExtruders = masterTpl.parts.map((p) => p.extruder ?? 1);
            if (
              exportedPartExtruders.length !== expectedMasterExtruders.length ||
              exportedPartExtruders.some((ext, idx) => ext !== expectedMasterExtruders[idx])
            ) {
              errors.push(
                `Material assignment mismatch for letter "${resolvedLetter}": exported extruders [${exportedPartExtruders.join(', ')}] do not match Master .3MF [${expectedMasterExtruders.join(', ')}].`
              );
            }
          }
        }

        const prevLetterSameHash = geomHashToLetter.get(reloadedGeometryHash);
        if (prevLetterSameHash && prevLetterSameHash !== resolvedLetter) {
          errors.push(
            `Wrong letter geometry substitution detected: exported letter "${resolvedLetter}" resolves to the exact same 3D mesh hash (${reloadedGeometryHash}) as "${prevLetterSameHash}".`
          );
        } else {
          geomHashToLetter.set(reloadedGeometryHash, resolvedLetter);
        }

        if (reloadedPartHashes.length >= 2 && raisedPartHash) {
          const prevRaisedLetter = raisedHashToLetter.get(raisedPartHash);
          if (prevRaisedLetter && prevRaisedLetter !== resolvedLetter) {
            errors.push(
              `Wrong raised-letter geometry substitution detected: letter "${resolvedLetter}" shares identical raised-letter mesh (${raisedPartHash}) with "${prevRaisedLetter}".`
            );
          } else {
            raisedHashToLetter.set(raisedPartHash, resolvedLetter);
          }
        }

        distinctHashes.add(reloadedGeometryHash);
        rootObjectIdToResolvedLetter.set(rootObj.id, resolvedLetter);
        letterGeometryAudit[resolvedLetter] = {
          letter: resolvedLetter,
          objectId: rootObj.id,
          modelPath: resolvedModelPath || `/3D/Objects/keycap_${resolvedLetter}.model`,
          subObjectIds,
          partExtruders: exportedPartExtruders,
          geometryHash: reloadedGeometryHash,
          raisedPartHash,
          instanceCount: 0,
        };
      }
    }

    for (const objMeta of objSettingsMap.values()) {
      if (objMeta.extruder !== null) extrudersSet.add(objMeta.extruder);
      for (const part of objMeta.parts) {
        if (part.extruder !== null) extrudersSet.add(part.extruder);
      }

      if (params.parsedMaster && objMeta.name) {
        const letter = matchLetterFrom3mfObjectName(objMeta.name);
        const masterTpl = letter ? params.parsedMaster.keycapsByLetter[letter] : undefined;
        if (masterTpl && objMeta.parts.length !== masterTpl.parts.length) {
          errors.push(
            `Object "${objMeta.name}" part count (${objMeta.parts.length}) does not match Master 3MF (${masterTpl.parts.length}).`
          );
        }
      }
    }

    // Tally actual geometry-resolved letter counts across ALL <build> <item>s
    for (const item of buildItems) {
      const resolvedLetter = rootObjectIdToResolvedLetter.get(item.objectId);
      if (resolvedLetter) {
        resolvedLetterGeometryCounts[resolvedLetter] =
          (resolvedLetterGeometryCounts[resolvedLetter] || 0) + 1;
        if (letterGeometryAudit[resolvedLetter]) {
          letterGeometryAudit[resolvedLetter].instanceCount += 1;
        }
      }
    }

    const plateTags = findMatchingTagElements(settingsXml, 'plate');
    plateCount = plateTags.length;

    if (params.expectedPlates) {
      if (plateCount !== params.expectedPlates.length) {
        errors.push(
          `Metadata/model_settings.config plate count (${plateCount}) does not match expected (${params.expectedPlates.length}).`
        );
      }

      const expectedTotalItems = params.expectedPlates.reduce(
        (sum, p) => sum + p.placements.length,
        0
      );
      if (buildItems.length !== expectedTotalItems) {
        errors.push(
          `3D/3dmodel.model build item count (${buildItems.length}) does not match expected keycap count (${expectedTotalItems}).`
        );
      }

      let buildCursor = 0;
      params.expectedPlates.forEach((expPlate, idx) => {
        const plateTag = plateTags[idx];
        if (!plateTag) return;
        const plateBody = settingsXml.slice(plateTag.bodyStart, plateTag.bodyEnd);
        const metaTags = findMatchingTagElements(plateBody, 'metadata');
        const platerNameMeta = metaTags.find((m) => m.attrs.key === 'plater_name');
        const expectedName = `WP-${expPlate.plateCode}`;
        if (!platerNameMeta || platerNameMeta.attrs.value !== expectedName) {
          errors.push(
            `Plate ${idx + 1} plater_name ("${platerNameMeta?.attrs.value || ''}") does not match "${expectedName}".`
          );
        }

        const instanceTags = findMatchingTagElements(plateBody, 'model_instance');
        if (instanceTags.length !== expPlate.placements.length) {
          errors.push(
            `Plate ${expectedName} model_instance count (${instanceTags.length}) does not match placement count (${expPlate.placements.length}).`
          );
        }

        for (const instTag of instanceTags) {
          const instBody = plateBody.slice(instTag.bodyStart, instTag.bodyEnd);
          const instMetas = findMatchingTagElements(instBody, 'metadata');
          const oidMeta = instMetas.find((m) => m.attrs.key === 'object_id');
          if (oidMeta && rootIndex && !rootIndex.objectsById.has(oidMeta.attrs.value)) {
            errors.push(
              `Plate ${expectedName} references missing object_id="${oidMeta.attrs.value}".`
            );
          }
        }

        for (const expPl of expPlate.placements) {
          const item = buildItems[buildCursor++];
          if (!item) break;
          const expectedLetter = expPl.letter.trim().toUpperCase();
          const resolvedLetter = rootObjectIdToResolvedLetter.get(item.objectId);
          if (resolvedLetter !== expectedLetter) {
            errors.push(
              `Plate ${expectedName} placement #${expPl.index + 1} expected geometry for "${expectedLetter}", but build item resolved to "${resolvedLetter || 'UNKNOWN'}" (objectid="${item.objectId}").`
            );
            break;
          }

          const dx = Math.abs(item.transform[9] - expPl.xMm);
          const dy = Math.abs(item.transform[10] - expPl.yMm);
          if (dx > 0.01 || dy > 0.01) {
            errors.push(
              `Plate ${expectedName} placement ${expPl.letter}#${expPl.index + 1} coordinate mismatch (${item.transform[9].toFixed(3)}, ${item.transform[10].toFixed(3)}) vs expected (${expPl.xMm.toFixed(3)}, ${expPl.yMm.toFixed(3)}).`
            );
            break;
          }
        }
      });

      // Verify exact aggregate geometry-resolved letter counts across all plates
      const expectedAggregateCounts: Record<string, number> = {};
      for (const expPlate of params.expectedPlates) {
        for (const expPl of expPlate.placements) {
          const l = expPl.letter.trim().toUpperCase();
          expectedAggregateCounts[l] = (expectedAggregateCounts[l] || 0) + 1;
        }
      }
      for (const [l, expQty] of Object.entries(expectedAggregateCounts)) {
        const gotQty = resolvedLetterGeometryCounts[l] || 0;
        if (gotQty !== expQty) {
          errors.push(
            `Exported 3D geometry count mismatch for letter "${l}": expected ${expQty} instances resolving to ${l} geometry, got ${gotQty}.`
          );
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    rootRelationships,
    modelRelationships,
    includedObjectFiles,
    totalBuildItems: buildItems.length,
    totalVertices,
    totalTriangles,
    plateCount,
    extrudersUsed: Array.from(extrudersSet).sort((a, b) => a - b),
    projectSettingsValid,
    resolvedLetterGeometryCounts,
    letterGeometryAudit,
    distinctGeometryHashesCount: distinctHashes.size,
  };
}

// ============================================================================
// Public Export APIs (Single Plate & Multi-Plate Batch)
// ============================================================================

export async function exportSinglePlate3mf(params: {
  plate: Plate3mfInputPlate;
  master3mfBuffer: ArrayBuffer;
  projectName?: string;
  bedProfile?: StlBedProfile;
  onProgress?: (event: Bambu3mfExportProgressEvent) => void;
}): Promise<SinglePlate3mfExportResult> {
  const bedProfile = params.bedProfile || DEFAULT_BAMBU_BED_PROFILE;
  const cleanCode = normalizePlateCode(params.plate.plateCode);
  if (!cleanCode) {
    throw new Error(
      `Plate ${params.plate.plateNumber} requires a valid 5-character Plate ID (WP-XXXXX) before .3MF export.`
    );
  }
  const fileName = formatWpPlate3mfFilename(cleanCode);

  params.onProgress?.({
    phase: 'parsing_master',
    completedPlates: 0,
    totalPlates: 1,
    currentPlateNumber: params.plate.plateNumber,
    percent: 20,
    message: `Reading Master 3MF template for WP-${cleanCode}...`,
  });

  const parsedMaster = await inspectMaster3mfArchive(params.master3mfBuffer);

  params.onProgress?.({
    phase: 'validating',
    completedPlates: 0,
    totalPlates: 1,
    currentPlateNumber: params.plate.plateNumber,
    percent: 45,
    message: `Validating ${countLetters(params.plate.letters)} keycap coordinates on Plate ${params.plate.plateNumber}...`,
  });

  const placements =
    params.plate.placements && params.plate.placements.length > 0
      ? params.plate.placements
      : buildPlateLetterPlacements(params.plate.letters, bedProfile);

  const validation = validate3mfPlatePlacements({
    plateNumber: params.plate.plateNumber,
    letters: params.plate.letters,
    placements,
    keycapsByLetter: parsedMaster.keycapsByLetter,
    bedProfile,
  });

  if (!validation.valid) {
    throw new Error(validation.errors.join(' '));
  }

  params.onProgress?.({
    phase: 'building_plates',
    completedPlates: 0,
    totalPlates: 1,
    currentPlateNumber: params.plate.plateNumber,
    percent: 65,
    message: `Building Bambu Studio plate WP-${cleanCode}...`,
  });

  const expectedPlates = [
    {
      plateNumber: params.plate.plateNumber,
      plateCode: cleanCode,
      letters: params.plate.letters,
      placements,
      validation,
    },
  ];

  const packaged = await assembleBambu3mfPackage({
    parsedMaster,
    plates: expectedPlates,
    projectName: params.projectName,
    onProgress: params.onProgress,
  });

  params.onProgress?.({
    phase: 'validating',
    completedPlates: 1,
    totalPlates: 1,
    currentPlateNumber: params.plate.plateNumber,
    percent: 94,
    message: `Self-validating relationships and geometry inside ${fileName}...`,
  });

  const audit = await validateExported3mfArchive({
    threeMfBytes: packaged.threeMfBytes,
    expectedPlates,
    parsedMaster,
  });

  if (!audit.valid) {
    throw new Error(
      `3MF export validation failed for ${fileName}: ${audit.errors.join(' ')}`
    );
  }

  params.onProgress?.({
    phase: 'complete',
    completedPlates: 1,
    totalPlates: 1,
    currentPlateNumber: params.plate.plateNumber,
    percent: 100,
    message: `Exported ${fileName} (${placements.length} keycaps).`,
  });

  return {
    fileName,
    plateCode: cleanCode,
    threeMfBytes: packaged.threeMfBytes,
    plateSummary: packaged.plateSummaries[0],
    audit,
    warnings: Array.from(new Set([...packaged.warnings, ...audit.warnings])),
  };
}

export async function exportBatchPlates3mf(params: {
  batchId: string;
  plates: readonly Plate3mfInputPlate[];
  master3mfBuffer: ArrayBuffer;
  projectName?: string;
  bedProfile?: StlBedProfile;
  onProgress?: (event: Bambu3mfExportProgressEvent) => void;
}): Promise<BatchPlates3mfExportResult> {
  const cleanBatchId = params.batchId.trim();
  if (!cleanBatchId) {
    throw new Error('Batch ID is required before exporting All Plates (.3MF).');
  }
  if (!params.plates || params.plates.length === 0) {
    throw new Error('No plates provided for batch .3MF export.');
  }

  const bedProfile = params.bedProfile || DEFAULT_BAMBU_BED_PROFILE;
  const fileName = formatBatch3mfFilename(cleanBatchId);
  const totalPlates = params.plates.length;

  params.onProgress?.({
    phase: 'parsing_master',
    completedPlates: 0,
    totalPlates,
    percent: 15,
    message: `Inspecting Master 3MF template for Batch ${cleanBatchId}...`,
  });

  const parsedMaster = await inspectMaster3mfArchive(params.master3mfBuffer);

  const preparedPlates: Array<{
    plateNumber: number;
    plateCode: string;
    letters: LettersMap;
    placements: PlateLetterPlacement[];
    validation: StlExportValidationResult;
  }> = [];

  for (let i = 0; i < totalPlates; i += 1) {
    const plate = params.plates[i];
    const plateCode = normalizePlateCode(plate.plateCode);
    if (!plateCode) {
      throw new Error(
        `Plate ${plate.plateNumber} requires a valid 5-character Plate ID before batch .3MF export.`
      );
    }

    const pct = 25 + Math.round(((i + 0.5) / totalPlates) * 50);
    params.onProgress?.({
      phase: 'building_plates',
      completedPlates: i,
      totalPlates,
      currentPlateNumber: plate.plateNumber,
      percent: pct,
      message: `Preparing Plate ${plate.plateNumber} (WP-${plateCode}, ${i + 1}/${totalPlates})...`,
    });

    const placements =
      plate.placements && plate.placements.length > 0
        ? plate.placements
        : buildPlateLetterPlacements(plate.letters, bedProfile);

    const validation = validate3mfPlatePlacements({
      plateNumber: plate.plateNumber,
      letters: plate.letters,
      placements,
      keycapsByLetter: parsedMaster.keycapsByLetter,
      bedProfile,
    });

    if (!validation.valid) {
      throw new Error(validation.errors.join(' '));
    }

    preparedPlates.push({
      plateNumber: plate.plateNumber,
      plateCode,
      letters: compactLettersMap(plate.letters),
      placements,
      validation,
    });
  }

  const packaged = await assembleBambu3mfPackage({
    parsedMaster,
    plates: preparedPlates,
    projectName: params.projectName,
    batchId: cleanBatchId,
    onProgress: params.onProgress,
  });

  params.onProgress?.({
    phase: 'validating',
    completedPlates: totalPlates,
    totalPlates,
    percent: 94,
    message: `Self-validating relationships and geometry inside ${fileName}...`,
  });

  const audit = await validateExported3mfArchive({
    threeMfBytes: packaged.threeMfBytes,
    expectedPlates: preparedPlates,
    parsedMaster,
  });

  if (!audit.valid) {
    throw new Error(
      `3MF export validation failed for ${fileName}: ${audit.errors.join(' ')}`
    );
  }

  const totalKeycapCount = packaged.plateSummaries.reduce(
    (s, p) => s + p.keycapCount,
    0
  );
  const combinedLetterBreakdown = compactLettersMap(
    sumAlphabetMaps(packaged.plateSummaries.map((p) => p.letterBreakdown))
  );

  params.onProgress?.({
    phase: 'complete',
    completedPlates: totalPlates,
    totalPlates,
    percent: 100,
    message: `Exported ${fileName} (${totalPlates} plates, ${totalKeycapCount} keycaps).`,
  });

  return {
    fileName,
    batchId: cleanBatchId,
    threeMfBytes: packaged.threeMfBytes,
    plateCount: totalPlates,
    totalKeycapCount,
    combinedLetterBreakdown,
    plates: packaged.plateSummaries,
    audit,
    warnings: Array.from(new Set([...packaged.warnings, ...audit.warnings])),
  };
}
