import { ABC } from '../constants';
import {
  JobCatalogItemSnapshot,
  LettersMap,
  PlateLetterPlacement,
  StlBedProfile,
} from '../types';

export const DEFAULT_BAMBU_BED_PROFILE: StlBedProfile = {
  name: 'Bambu Lab 256 × 256 mm Plate',
  widthMm: 256,
  depthMm: 256,
  maxHeightMm: 256,
  slotPitchXMm: 19.2,
  slotPitchYMm: 19.2,
};

interface GridSlot {
  slotIndex: number;
  row: number;
  col: number;
  xMm: number;
  yMm: number;
}

/**
 * Computes deterministic physical X/Y bed slots on a 256 × 256 mm build plate.
 * Standard 12×12 matrix = 144 cells with 6 corner exclusion cells (front-left filament
 * cutter keep-out & back-right corner) yielding exact 138 physical keycap slots.
 * If more than 138 slots are needed on a single plate, expands symmetrically so
 * bounds/overlap validation can accurately inspect physical fit.
 */
export function buildBedGridSlots(
  requiredCount: number,
  profile: StlBedProfile = DEFAULT_BAMBU_BED_PROFILE
): GridSlot[] {
  const safeCount = Math.max(0, Math.floor(requiredCount));
  if (safeCount === 0) return [];

  if (safeCount <= 138) {
    const cols = 12;
    const rows = 12;
    const spanX = (cols - 1) * profile.slotPitchXMm;
    const spanY = (rows - 1) * profile.slotPitchYMm;
    const startX = (profile.widthMm - spanX) / 2;
    const startY = (profile.depthMm - spanY) / 2;

    const isExcludedCorner = (row: number, col: number): boolean => {
      // Front-left filament cutter / purge corner (3 slots)
      if (row === 0 && (col === 0 || col === 1)) return true;
      if (row === 1 && col === 0) return true;
      // Back-right corner clearance (3 slots)
      if (row === 11 && (col === 9 || col === 10 || col === 11)) return true;
      return false;
    };

    const slots: GridSlot[] = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        if (isExcludedCorner(row, col)) continue;
        slots.push({
          slotIndex: slots.length,
          row,
          col,
          xMm: Number((startX + col * profile.slotPitchXMm).toFixed(3)),
          yMm: Number((startY + row * profile.slotPitchYMm).toFixed(3)),
        });
      }
    }
    return slots.slice(0, safeCount);
  }

  // Fallback for custom plate capacities > 138: compute tightest square grid
  const cols = Math.ceil(Math.sqrt(safeCount));
  const rows = Math.ceil(safeCount / cols);
  const spanX = (cols - 1) * profile.slotPitchXMm;
  const spanY = (rows - 1) * profile.slotPitchYMm;
  const startX = (profile.widthMm - spanX) / 2;
  const startY = (profile.depthMm - spanY) / 2;

  const slots: GridSlot[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (slots.length >= safeCount) break;
      slots.push({
        slotIndex: slots.length,
        row,
        col,
        xMm: Number((startX + col * profile.slotPitchXMm).toFixed(3)),
        yMm: Number((startY + row * profile.slotPitchYMm).toFixed(3)),
      });
    }
  }
  return slots;
}

/**
 * Expands an Auto Plate Planner per-plate letter composition (`letters`) into exact
 * deterministic `(xMm, yMm)` bed placement coordinates WITHOUT changing letter counts
 * or introducing a separate letter distribution algorithm.
 */
export function buildPlateLetterPlacements(
  letters: LettersMap,
  profile: StlBedProfile = DEFAULT_BAMBU_BED_PROFILE
): PlateLetterPlacement[] {
  const orderedSequence: string[] = [];

  // Deterministic order: canonical A–Z, plus any sorted uppercase fallback keys
  for (const letter of ABC) {
    const qty = Math.max(0, Math.floor(Number(letters[letter] || 0)));
    for (let i = 0; i < qty; i += 1) {
      orderedSequence.push(letter);
    }
  }

  const extraKeys = Object.keys(letters)
    .filter((k) => !ABC.includes(k as any) && Math.floor(Number(letters[k] || 0)) > 0)
    .sort();
  for (const k of extraKeys) {
    const qty = Math.max(0, Math.floor(Number(letters[k] || 0)));
    for (let i = 0; i < qty; i += 1) {
      orderedSequence.push(k.trim().toUpperCase());
    }
  }

  if (orderedSequence.length === 0) return [];

  const slots = buildBedGridSlots(orderedSequence.length, profile);
  return orderedSequence.map((letter, idx) => {
    const slot = slots[idx];
    return {
      index: idx,
      letter,
      row: slot.row,
      col: slot.col,
      xMm: slot.xMm,
      yMm: slot.yMm,
      slotWidthMm: profile.slotPitchXMm,
      slotDepthMm: profile.slotPitchYMm,
    };
  });
}

/**
 * Extracts a clean canonical A–Z LettersMap from Product Studio `JobCatalogItemSnapshot[]`
 * when a product uses A–Z letter variations (e.g., `Keycap Letter A–Z`).
 * Preserves exact quantities planned on the plate.
 */
export function extractLettersMapFromCatalogItems(
  items: readonly JobCatalogItemSnapshot[] | undefined | null
): {
  letters: LettersMap;
  nonLetterLabels: string[];
} {
  const letters: LettersMap = {};
  const nonLetterLabels: string[] = [];

  if (!items || items.length === 0) {
    return { letters, nonLetterLabels };
  }

  for (const item of items) {
    const qty = Math.max(0, Math.floor(Number(item.quantity || 0)));
    if (qty <= 0) continue;
    const candidate = resolveSingleAlphabetLetter(item.variantLabel || '');
    if (candidate) {
      letters[candidate] = (letters[candidate] || 0) + qty;
    } else {
      nonLetterLabels.push(item.variantLabel || item.productName);
    }
  }

  return { letters, nonLetterLabels };
}

/**
 * Resolves single letter A–Z from labels like `"P"`, `"A"`, or `"Letter P"`.
 * Returns `null` when label does not cleanly denote a single alphabet keycap letter.
 */
export function resolveSingleAlphabetLetter(rawLabel: string): string | null {
  const trimmed = rawLabel.trim().toUpperCase();
  if (!trimmed) return null;
  if (trimmed.length === 1 && ABC.includes(trimmed as any)) {
    return trimmed;
  }
  const match = trimmed.match(/^(?:LETTER|CHAR|KEYCAP)\s+([A-Z])$/);
  if (match && ABC.includes(match[1] as any)) {
    return match[1];
  }
  return null;
}
