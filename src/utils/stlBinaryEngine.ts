import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ABC, countLetters } from '../constants';
import {
  LettersMap,
  PlateLetterPlacement,
  StlBedProfile,
  StlExportValidationResult,
  StlMeshBounds,
} from '../types';
import { DEFAULT_BAMBU_BED_PROFILE } from './plateStlLayout';

export interface ParsedStlMesh {
  letter: string;
  fileName: string;
  format: 'binary' | 'ascii';
  triangleCount: number;
  /** Interleaved 9 floats per triangle: [v1x,v1y,v1z, v2x,v2y,v2z, v3x,v3y,v3z] */
  positions: Float32Array;
  /** 3 floats per triangle: [nx, ny, nz] */
  normals: Float32Array;
  bounds: StlMeshBounds;
  centerX: number;
  centerY: number;
}

const sharedStlLoader = new STLLoader();

/**
 * Detects whether a raw ArrayBuffer holds an ASCII STL vs Binary STL.
 * Note: Some binary STL headers start with `"solid "` accidentally; we check exact
 * binary byte-length `84 + triangleCount * 50` first (the standard disambiguation rule).
 */
export function detectStlFormat(buffer: ArrayBuffer): 'binary' | 'ascii' {
  if (buffer.byteLength >= 84) {
    const view = new DataView(buffer);
    const triCount = view.getUint32(80, true);
    const expectedBinarySize = 84 + triCount * 50;
    if (triCount > 0 && expectedBinarySize === buffer.byteLength) {
      return 'binary';
    }
  }
  const headerBytes = new Uint8Array(buffer, 0, Math.min(256, buffer.byteLength));
  let headerText = '';
  for (let i = 0; i < headerBytes.length; i += 1) {
    headerText += String.fromCharCode(headerBytes[i]);
  }
  if (/^\s*solid\b/i.test(headerText) && /\bfacet\s+normal\b/i.test(headerText)) {
    return 'ascii';
  }
  return 'binary';
}

/**
 * Estimates the Z height where a raised embossed keycap letter starts above the base top face.
 * Scans upward-facing horizontal triangles (`nz > 0.85`) below `maxZ` to locate the highest
 * significant flat top plateau below the letter top surface.
 * Strictly a geometric estimate helper for manual Bambu Studio layer-based filament swaps.
 */
export function estimateRaisedLetterStartZ(
  positions: Float32Array,
  normals: Float32Array,
  triangleCount: number,
  minZ: number,
  maxZ: number
): number | null {
  const height = maxZ - minZ;
  if (!Number.isFinite(height) || height <= 0.4 || triangleCount < 4) {
    return null;
  }

  // Bucket upward-facing flat surfaces by 0.05mm Z quantization
  const bucketArea = new Map<number, number>();
  for (let t = 0; t < triangleCount; t += 1) {
    const nz = normals[t * 3 + 2];
    if (nz < 0.85) continue;

    const pIdx = t * 9;
    const z1 = positions[pIdx + 2];
    const z2 = positions[pIdx + 5];
    const z3 = positions[pIdx + 8];
    const maxTriZ = Math.max(z1, z2, z3);
    const minTriZ = Math.min(z1, z2, z3);
    if (maxTriZ - minTriZ > 0.15) continue; // Only near-horizontal planes

    const avgZ = (z1 + z2 + z3) / 3;
    // Candidate top plateau sits strictly below top of embossed letter and in upper half of keycap
    if (avgZ >= maxZ - 0.15 || avgZ <= minZ + height * 0.4) continue;

    // Cross-product area in X/Y
    const ux = positions[pIdx + 3] - positions[pIdx];
    const uy = positions[pIdx + 4] - positions[pIdx + 1];
    const vx = positions[pIdx + 6] - positions[pIdx];
    const vy = positions[pIdx + 7] - positions[pIdx + 1];
    const area2 = Math.abs(ux * vy - uy * vx);
    if (area2 <= 1e-6) continue;

    const quantizedZ = Math.round(avgZ * 20) / 20;
    bucketArea.set(quantizedZ, (bucketArea.get(quantizedZ) || 0) + area2);
  }

  if (bucketArea.size === 0) return null;

  let bestZ: number | null = null;
  let bestScore = -1;
  for (const [zVal, areaSum] of bucketArea.entries()) {
    if (areaSum > bestScore) {
      bestScore = areaSum;
      bestZ = zVal;
    }
  }

  return bestZ !== null ? Number(bestZ.toFixed(2)) : null;
}

/**
 * Parses and rigorously validates an authentic binary or ASCII STL buffer using Three.js `STLLoader`.
 * NEVER simplifies, regenerates, repairs topology, or separates raised letter meshes from base body.
 */
export function parseAndValidateStlBuffer(params: {
  buffer: ArrayBuffer;
  letter: string;
  fileName: string;
}): ParsedStlMesh {
  const { buffer, letter, fileName } = params;
  if (!buffer || buffer.byteLength === 0) {
    throw new Error(`STL file "${fileName}" is empty (0 bytes).`);
  }

  const format = detectStlFormat(buffer);
  if (format === 'binary') {
    if (buffer.byteLength < 84) {
      throw new Error(
        `Binary STL "${fileName}" is truncated (${buffer.byteLength} bytes < 84-byte header).`
      );
    }
    const headerView = new DataView(buffer);
    const declaredCount = headerView.getUint32(80, true);
    if (declaredCount === 0) {
      throw new Error(`STL file "${fileName}" declares 0 triangles.`);
    }
    const expectedBytes = 84 + declaredCount * 50;
    if (buffer.byteLength !== expectedBytes) {
      throw new Error(
        `Binary STL "${fileName}" byte size mismatch: expected ${expectedBytes} bytes for ${declaredCount} triangles, got ${buffer.byteLength} bytes.`
      );
    }
  }

  let geometry: THREE.BufferGeometry;
  try {
    geometry = sharedStlLoader.parse(buffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse STL "${fileName}": ${msg}`);
  }

  const posAttr = geometry.getAttribute('position');
  if (!posAttr || posAttr.count < 12 || posAttr.count % 3 !== 0) {
    geometry.dispose();
    throw new Error(
      `STL "${fileName}" contains invalid vertex geometry (${posAttr?.count || 0} vertices).`
    );
  }

  const triangleCount = posAttr.count / 3;
  const rawPositions = posAttr.array as Float32Array;
  const positions = new Float32Array(triangleCount * 9);
  positions.set(rawPositions.subarray(0, triangleCount * 9));

  const normalAttr = geometry.getAttribute('normal');
  const normals = new Float32Array(triangleCount * 3);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (let t = 0; t < triangleCount; t += 1) {
    const pBase = t * 9;
    const x1 = positions[pBase];
    const y1 = positions[pBase + 1];
    const z1 = positions[pBase + 2];
    const x2 = positions[pBase + 3];
    const y2 = positions[pBase + 4];
    const z2 = positions[pBase + 5];
    const x3 = positions[pBase + 6];
    const y3 = positions[pBase + 7];
    const z3 = positions[pBase + 8];

    if (
      !Number.isFinite(x1) ||
      !Number.isFinite(y1) ||
      !Number.isFinite(z1) ||
      !Number.isFinite(x2) ||
      !Number.isFinite(y2) ||
      !Number.isFinite(z2) ||
      !Number.isFinite(x3) ||
      !Number.isFinite(y3) ||
      !Number.isFinite(z3)
    ) {
      geometry.dispose();
      throw new Error(`STL "${fileName}" contains NaN/Infinity vertex coordinates.`);
    }

    if (x1 < minX) minX = x1;
    if (x1 > maxX) maxX = x1;
    if (x2 < minX) minX = x2;
    if (x2 > maxX) maxX = x2;
    if (x3 < minX) minX = x3;
    if (x3 > maxX) maxX = x3;

    if (y1 < minY) minY = y1;
    if (y1 > maxY) maxY = y1;
    if (y2 < minY) minY = y2;
    if (y2 > maxY) maxY = y2;
    if (y3 < minY) minY = y3;
    if (y3 > maxY) maxY = y3;

    if (z1 < minZ) minZ = z1;
    if (z1 > maxZ) maxZ = z1;
    if (z2 < minZ) minZ = z2;
    if (z2 > maxZ) maxZ = z2;
    if (z3 < minZ) minZ = z3;
    if (z3 > maxZ) maxZ = z3;

    // Preserve triangle normal if valid, else compute right-hand cross product normal
    let nx = 0;
    let ny = 0;
    let nz = 0;
    if (normalAttr && normalAttr.count >= (t + 1) * 3) {
      nx = normalAttr.getX(t * 3);
      ny = normalAttr.getY(t * 3);
      nz = normalAttr.getZ(t * 3);
    }
    const nLen = Math.hypot(nx, ny, nz);
    if (!Number.isFinite(nLen) || nLen < 1e-6) {
      const ux = x2 - x1;
      const uy = y2 - y1;
      const uz = z2 - z1;
      const vx = x3 - x1;
      const vy = y3 - y1;
      const vz = z3 - z1;
      const cx = uy * vz - uz * vy;
      const cy = uz * vx - ux * vz;
      const cz = ux * vy - uy * vx;
      const cLen = Math.hypot(cx, cy, cz) || 1;
      nx = cx / cLen;
      ny = cy / cLen;
      nz = cz / cLen;
    }

    const nBase = t * 3;
    normals[nBase] = nx;
    normals[nBase + 1] = ny;
    normals[nBase + 2] = nz;
  }

  geometry.dispose();

  const widthMm = Number((maxX - minX).toFixed(3));
  const depthMm = Number((maxY - minY).toFixed(3));
  const heightMm = Number((maxZ - minZ).toFixed(3));

  if (widthMm <= 0.1 || depthMm <= 0.1 || heightMm <= 0.1) {
    throw new Error(
      `STL "${fileName}" has degenerate bounding dimensions (${widthMm} × ${depthMm} × ${heightMm} mm).`
    );
  }

  const estimatedLetterStartZMm = estimateRaisedLetterStartZ(
    positions,
    normals,
    triangleCount,
    minZ,
    maxZ
  );

  return {
    letter: letter.trim().toUpperCase(),
    fileName,
    format,
    triangleCount,
    positions,
    normals,
    bounds: {
      minX: Number(minX.toFixed(3)),
      maxX: Number(maxX.toFixed(3)),
      minY: Number(minY.toFixed(3)),
      maxY: Number(maxY.toFixed(3)),
      minZ: Number(minZ.toFixed(3)),
      maxZ: Number(maxZ.toFixed(3)),
      widthMm,
      depthMm,
      heightMm,
      estimatedLetterStartZMm,
    },
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
}

/**
 * Validates all required meshes, counts, bed X/Y bounds, Z bounds, coordinate consistency,
 * and pairwise X/Y overlap BEFORE concatenation.
 * Never rearranges keycaps silently if an overlap or bounds violation is detected.
 */
export function validatePlatePlacementGeometry(params: {
  plateNumber: number;
  letters: LettersMap;
  placements: readonly PlateLetterPlacement[];
  meshesByLetter: ReadonlyMap<string, ParsedStlMesh>;
  bedProfile?: StlBedProfile;
}): StlExportValidationResult {
  const { plateNumber, letters, placements, meshesByLetter } = params;
  const bedProfile = params.bedProfile || DEFAULT_BAMBU_BED_PROFILE;
  const errors: string[] = [];
  const warnings: string[] = [];

  const expectedTotal = countLetters(letters);
  if (expectedTotal <= 0) {
    errors.push(`Plate ${plateNumber} has 0 keycaps to export.`);
    return { valid: false, errors, warnings };
  }

  if (placements.length !== expectedTotal) {
    errors.push(
      `Plate ${plateNumber} coordinate count mismatch: expected ${expectedTotal} placements from planner composition, received ${placements.length}.`
    );
  }

  // Verify exact letter frequency match between Auto Plate Planner counts and placements
  const placementLetterCounts: Record<string, number> = {};
  for (const p of placements) {
    placementLetterCounts[p.letter] = (placementLetterCounts[p.letter] || 0) + 1;
  }
  for (const letter of ABC) {
    const expected = Math.max(0, Math.floor(Number(letters[letter] || 0)));
    const actual = placementLetterCounts[letter] || 0;
    if (expected !== actual) {
      errors.push(
        `Plate ${plateNumber} coordinate mismatch for letter "${letter}": planner specified ${expected}, placements contain ${actual}.`
      );
    }
  }

  // Verify every required letter has a valid loaded STL mesh
  const missingLetters = new Set<string>();
  for (const p of placements) {
    if (!meshesByLetter.has(p.letter)) {
      missingLetters.add(p.letter);
    }
  }
  if (missingLetters.size > 0) {
    const missingNames = Array.from(missingLetters)
      .sort()
      .map((l) => `keycap-char-${l}.stl`)
      .join(', ');
    errors.push(
      `Plate ${plateNumber} cannot export: missing authentic STL model(s) in library: ${missingNames}.`
    );
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  // Compute actual placed world-space AABB for each keycap and validate bed bounds + overlaps
  interface PlacedBox {
    index: number;
    letter: string;
    row: number;
    col: number;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
  }

  const boxes: PlacedBox[] = [];
  const BOUND_EPS = 0.01;
  const OVERLAP_EPS = 0.02;

  for (const p of placements) {
    const mesh = meshesByLetter.get(p.letter)!;
    const dx = p.xMm - mesh.centerX;
    const dy = p.yMm - mesh.centerY;

    const minX = mesh.bounds.minX + dx;
    const maxX = mesh.bounds.maxX + dx;
    const minY = mesh.bounds.minY + dy;
    const maxY = mesh.bounds.maxY + dy;
    const minZ = mesh.bounds.minZ;
    const maxZ = mesh.bounds.maxZ;

    if (
      minX < -BOUND_EPS ||
      maxX > bedProfile.widthMm + BOUND_EPS ||
      minY < -BOUND_EPS ||
      maxY > bedProfile.depthMm + BOUND_EPS
    ) {
      errors.push(
        `Plate ${plateNumber} keycap #${p.index + 1} (${p.letter} at ${p.xMm.toFixed(1)}, ${p.yMm.toFixed(1)} mm) exceeds ${bedProfile.widthMm}×${bedProfile.depthMm} mm build plate bounds ([${minX.toFixed(1)}..${maxX.toFixed(1)}, ${minY.toFixed(1)}..${maxY.toFixed(1)}]).`
      );
    }

    if (minZ < -0.1 || maxZ > bedProfile.maxHeightMm) {
      errors.push(
        `Plate ${plateNumber} keycap #${p.index + 1} (${p.letter}) has out-of-range Z height [${minZ.toFixed(2)}..${maxZ.toFixed(2)}] mm (allowed [0..${bedProfile.maxHeightMm}] mm).`
      );
    }

    boxes.push({
      index: p.index,
      letter: p.letter,
      row: p.row,
      col: p.col,
      minX,
      maxX,
      minY,
      maxY,
      minZ,
      maxZ,
    });
  }

  // Pairwise overlap check (strict: never rearrange colliding keycaps silently)
  let overlapCount = 0;
  let firstOverlapMsg = '';
  for (let i = 0; i < boxes.length; i += 1) {
    const a = boxes[i];
    for (let j = i + 1; j < boxes.length; j += 1) {
      const b = boxes[j];
      const overlapX = a.minX < b.maxX - OVERLAP_EPS && a.maxX > b.minX + OVERLAP_EPS;
      const overlapY = a.minY < b.maxY - OVERLAP_EPS && a.maxY > b.minY + OVERLAP_EPS;
      if (overlapX && overlapY) {
        overlapCount += 1;
        if (!firstOverlapMsg) {
          firstOverlapMsg = `Keycap #${a.index + 1} (${a.letter}, row ${a.row + 1} col ${a.col + 1}) overlaps keycap #${b.index + 1} (${b.letter}, row ${b.row + 1} col ${b.col + 1}). Check STL XY dimensions vs ${bedProfile.slotPitchXMm}mm grid spacing.`;
        }
      }
    }
  }

  if (overlapCount > 0) {
    errors.push(
      `Plate ${plateNumber} detected ${overlapCount} keycap collision(s): ${firstOverlapMsg}`
    );
  }

  // Dense 138-keycap plate safety warning for Bambu Studio prime tower & toolhead clearance
  if (placements.length >= 120) {
    warnings.push(
      `Dense layout (${placements.length} keycaps on ${bedProfile.widthMm}×${bedProfile.depthMm} mm bed) leaves limited margin for a Bambu Studio prime tower and front-left cutter keep-out clearance. Inspect prime tower placement manually in Bambu Studio before printing — slicer verification is NOT automatic.`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Generates ONE unified Binary STL (`Uint8Array`) for an entire plate by translating
 * each original keycap mesh to its exact Auto Plate Planner `(xMm, yMm)` coordinate,
 * preserving local `Z` orientation and keeping raised letter + keycap body unified.
 */
export function buildUnifiedPlateBinaryStl(params: {
  plateNumber: number;
  headerComment?: string;
  placements: readonly PlateLetterPlacement[];
  meshesByLetter: ReadonlyMap<string, ParsedStlMesh>;
}): {
  stlBytes: Uint8Array;
  triangleCount: number;
  bounds: StlMeshBounds;
} {
  const { plateNumber, placements, meshesByLetter, headerComment } = params;

  let totalTriangles = 0;
  for (const p of placements) {
    const mesh = meshesByLetter.get(p.letter);
    if (!mesh) {
      throw new Error(`Missing cached STL mesh for letter "${p.letter}" during build.`);
    }
    totalTriangles += mesh.triangleCount;
  }

  const totalBytes = 84 + totalTriangles * 50;
  const output = new Uint8Array(totalBytes);
  const view = new DataView(output.buffer);

  // 80-byte binary STL header (cannot start with ASCII "solid ")
  const headerStr = (
    headerComment ||
    `WOOPP Plate ${String(plateNumber).padStart(2, '0')} (${placements.length} keycaps)`
  ).slice(0, 79);
  for (let i = 0; i < headerStr.length; i += 1) {
    output[i] = headerStr.charCodeAt(i) & 0x7f;
  }
  view.setUint32(80, totalTriangles, true);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  let offset = 84;
  for (const p of placements) {
    const mesh = meshesByLetter.get(p.letter)!;
    const dx = p.xMm - mesh.centerX;
    const dy = p.yMm - mesh.centerY;
    // Retain local Z orientation completely untouched
    const dz = 0;

    const pMinX = mesh.bounds.minX + dx;
    const pMaxX = mesh.bounds.maxX + dx;
    const pMinY = mesh.bounds.minY + dy;
    const pMaxY = mesh.bounds.maxY + dy;
    if (pMinX < minX) minX = pMinX;
    if (pMaxX > maxX) maxX = pMaxX;
    if (pMinY < minY) minY = pMinY;
    if (pMaxY > maxY) maxY = pMaxY;
    if (mesh.bounds.minZ < minZ) minZ = mesh.bounds.minZ;
    if (mesh.bounds.maxZ > maxZ) maxZ = mesh.bounds.maxZ;

    const pos = mesh.positions;
    const norm = mesh.normals;
    const triCount = mesh.triangleCount;

    for (let t = 0; t < triCount; t += 1) {
      const nBase = t * 3;
      const pBase = t * 9;

      view.setFloat32(offset, norm[nBase], true);
      view.setFloat32(offset + 4, norm[nBase + 1], true);
      view.setFloat32(offset + 8, norm[nBase + 2], true);

      view.setFloat32(offset + 12, pos[pBase] + dx, true);
      view.setFloat32(offset + 16, pos[pBase + 1] + dy, true);
      view.setFloat32(offset + 20, pos[pBase + 2] + dz, true);

      view.setFloat32(offset + 24, pos[pBase + 3] + dx, true);
      view.setFloat32(offset + 28, pos[pBase + 4] + dy, true);
      view.setFloat32(offset + 32, pos[pBase + 5] + dz, true);

      view.setFloat32(offset + 36, pos[pBase + 6] + dx, true);
      view.setFloat32(offset + 40, pos[pBase + 7] + dy, true);
      view.setFloat32(offset + 44, pos[pBase + 8] + dz, true);

      // uint16 attributeByteCount = 0
      view.setUint16(offset + 48, 0, true);
      offset += 50;
    }
  }

  return {
    stlBytes: output,
    triangleCount: totalTriangles,
    bounds: {
      minX: Number(minX.toFixed(3)),
      maxX: Number(maxX.toFixed(3)),
      minY: Number(minY.toFixed(3)),
      maxY: Number(maxY.toFixed(3)),
      minZ: Number(minZ.toFixed(3)),
      maxZ: Number(maxZ.toFixed(3)),
      widthMm: Number((maxX - minX).toFixed(3)),
      depthMm: Number((maxY - minY).toFixed(3)),
      heightMm: Number((maxZ - minZ).toFixed(3)),
      estimatedLetterStartZMm: null,
    },
  };
}
