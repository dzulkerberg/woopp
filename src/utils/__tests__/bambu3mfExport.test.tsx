import JSZip from 'jszip';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AutoPlannerView } from '../../components/AutoPlannerView';
import { KanbanQueueView } from '../../components/KanbanQueueView';
import { ProjectProductionSummaryModal } from '../../components/ProjectProductionSummaryModal';
import { SettingsView } from '../../components/SettingsView';
import { ToastVariant } from '../../components/ToastStack';
import { ABC, createFreshWorkspaceV5 } from '../../constants';
import { validateAndPrepareMaster3mf } from '../../services/master3mfStorage';
import { computeBufferSha256Hex } from '../../services/stlLibraryStorage';
import {
  createInMemoryPlateIdRegistry,
  reservePlateCodesForPreviewPlates,
} from '../../services/plateIdService';
import { CatalogProduct, ProductCategory, ProductionJob } from '../../types';
import {
  decodeBambuPaintColorExtruders,
  exportBatchPlates3mf,
  exportSinglePlate3mf,
  inspectMaster3mfArchive,
  validateExported3mfArchive,
} from '../bambu3mfEngine';
import {
  commitCatalogPlatesToWorkspace,
  generateAutomaticCatalogPlatePreviews,
  generateIndependentKeycapBatchPreviews,
} from '../catalogPlannerEngine';
import {
  formatBatch3mfFilename,
  formatWpPlate3mfFilename,
  generateStableBatchId,
} from '../plateIdGenerator';
import {
  exportBatchPlates3mfAction,
  exportSinglePlate3mfAction,
} from '../platePreviewHelper';
import { commitGeneratedPlatesToWorkspace } from '../productionEngine';
import { computeGlobalSchedule } from '../schedulingEngine';

function buildBoxMeshXml(minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number): string {
  const verts = [
    [minX, minY, minZ],
    [maxX, minY, minZ],
    [maxX, maxY, minZ],
    [minX, maxY, minZ],
    [minX, minY, maxZ],
    [maxX, minY, maxZ],
    [maxX, maxY, maxZ],
    [minX, maxY, maxZ],
  ];
  const tris = [
    [0, 2, 1], [0, 3, 2],
    [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4],
    [2, 3, 7], [2, 7, 6],
    [0, 4, 7], [0, 7, 3],
    [1, 2, 6], [1, 6, 5],
  ];
  return [
    '<mesh>',
    '  <vertices>',
    ...verts.map(([x, y, z]) => `    <vertex x="${x}" y="${y}" z="${z}"/>`),
    '  </vertices>',
    '  <triangles>',
    ...tris.map(([v1, v2, v3]) => `    <triangle v1="${v1}" v2="${v2}" v3="${v3}"/>`),
    '  </triangles>',
    '</mesh>',
  ].join('\n');
}

async function createSyntheticMaster3mfBuffer(
  letters: readonly string[] = ABC,
  options?: {
    /** Map e.g. { E: 'A' } to intentionally inject duplicate A geometry into E for failure tests */
    duplicateLetterFrom?: Record<string, string>;
  }
): Promise<ArrayBuffer> {
  const zip = new JSZip();

  zip.file(
    '[Content_Types].xml',
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
      '  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>',
      '  <Default Extension="config" ContentType="text/plain"/>',
      '</Types>',
    ].join('\n')
  );

  zip.file(
    '_rels/.rels',
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      '  <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>',
      '  <Relationship Target="/Metadata/plate_1.png" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>',
      '</Relationships>',
    ].join('\n')
  );

  // Realistic thumbnail asset in Master 3MF (stripped on export; rels must not dangle)
  zip.file('Metadata/plate_1.png', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));

  const projectSettings = {
    enable_prime_tower: '1',
    prime_tower_width: '35',
    filament_colour: ['#FFFFFF', '#111111'],
    filament_type: ['PLA', 'PLA'],
    layer_height: '0.2',
    wall_loops: '2',
    sparse_infill_density: '15%',
    woopp_custom_profile_marker: 'preserved-master-v1',
  };
  zip.file('Metadata/project_settings.config', JSON.stringify(projectSettings, null, 2));

  const rootObjects: string[] = [];
  const rootBuildItems: string[] = [];
  const modelSettingsObjects: string[] = [];
  const modelSettingsInstances: string[] = [];
  const masterModelRels: string[] = [];

  letters.forEach((letter, idx) => {
    const objId = idx + 1;
    const subPath = `3D/Objects/object_${17538 + idx}.model`;
    masterModelRels.push(
      `  <Relationship Target="/${subPath}" Id="rel-${idx + 1}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>`
    );

    const geomLetter = options?.duplicateLetterFrom?.[letter] || letter;
    const alphaIndex = Math.max(0, ABC.indexOf(geomLetter as (typeof ABC)[number]));
    const raisedMinX = Number((-4.0 + (alphaIndex % 5) * 0.14).toFixed(4));
    const raisedMaxX = Number((4.0 - Math.floor(alphaIndex / 5) * 0.13).toFixed(4));
    const raisedMinY = Number((-3.8 + (alphaIndex % 4) * 0.12).toFixed(4));
    const raisedMaxY = Number((3.8 - alphaIndex * 0.04).toFixed(4));
    const raisedMaxZ = Number((8.6 + alphaIndex * 0.03).toFixed(4));

    // Two-part multi-material keycap geometry: Base Body (id=1, extruder=1) + distinct Raised Letter (id=2, extruder=2)
    zip.file(
      subPath,
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
        '  <resources>',
        `    <object id="1" name="Body_${letter}" type="model">`,
        buildBoxMeshXml(-9.0, 9.0, -9.0, 9.0, 0, 8.0),
        '    </object>',
        `    <object id="2" name="Text_${letter}" type="model">`,
        buildBoxMeshXml(raisedMinX, raisedMaxX, raisedMinY, raisedMaxY, 8.0, raisedMaxZ),
        '    </object>',
        '  </resources>',
        '</model>',
      ].join('\n')
    );

    rootObjects.push(
      `    <object id="${objId}" name="keycap-char-${letter}" type="model">`,
      '      <components>',
      `        <component p:path="/${subPath}" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`,
      `        <component p:path="/${subPath}" objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`,
      '      </components>',
      '    </object>'
    );

    const col = idx % 10;
    const row = Math.floor(idx / 10);
    rootBuildItems.push(
      `    <item objectid="${objId}" transform="1 0 0 0 1 0 0 0 1 ${(30 + col * 22).toFixed(1)} ${(30 + row * 22).toFixed(1)} 0" printable="1"/>`
    );

    modelSettingsObjects.push(
      `  <object id="${objId}">`,
      `    <metadata key="name" value="keycap-char-${letter}"/>`,
      '    <metadata key="extruder" value="1"/>',
      '    <part id="1" subtype="normal_part">',
      `      <metadata key="name" value="Base_${letter}"/>`,
      '      <metadata key="extruder" value="1"/>',
      '    </part>',
      '    <part id="2" subtype="normal_part">',
      `      <metadata key="name" value="RaisedText_${letter}"/>`,
      '      <metadata key="extruder" value="2"/>',
      '    </part>',
      '  </object>'
    );

    modelSettingsInstances.push(
      '    <model_instance>',
      `      <metadata key="object_id" value="${objId}"/>`,
      '      <metadata key="instance_id" value="0"/>',
      `      <metadata key="identify_id" value="${objId}"/>`,
      '    </model_instance>'
    );
  });

  zip.file(
    '3D/_rels/3dmodel.model.rels',
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      ...masterModelRels,
      '</Relationships>',
    ].join('\n')
  );

  zip.file(
    '3D/3dmodel.model',
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">',
      '  <resources>',
      ...rootObjects,
      '  </resources>',
      '  <build>',
      ...rootBuildItems,
      '  </build>',
      '</model>',
    ].join('\n')
  );

  zip.file(
    'Metadata/model_settings.config',
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<config>',
      ...modelSettingsObjects,
      '  <plate>',
      '    <metadata key="plater_id" value="1"/>',
      '    <metadata key="plater_name" value="Master-A-Z"/>',
      ...modelSettingsInstances,
      '  </plate>',
      '</config>',
    ].join('\n')
  );

  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

describe('Bambu Studio Multi-Plate .3MF Export Engine & Workflow Integration', () => {
  it('validates multi-colour Master .3MF template (26 A-Z keycaps with extruder 1 & 2 parts) and keeps original buffer immutable across exports', async () => {
    const rawBuffer = await createSyntheticMaster3mfBuffer(ABC);
    const originalSha = await computeBufferSha256Hex(rawBuffer);

    const prep = await validateAndPrepareMaster3mf({
      fileName: 'Master_Keycaps_A_Z.3mf',
      buffer: rawBuffer,
      uploadedBy: 'admin@woopp.test',
    });
    expect(prep.ok).toBe(true);
    if (!prep.ok) throw new Error('Expected valid Master 3MF');

    const { record, buffer: storedBuffer } = prep.asset;
    expect(record.detectedLetters).toEqual([...ABC]);
    expect(record.multiMaterialPartCount).toBe(2);
    expect(record.filamentCount).toBe(2);
    expect(record.filamentColors).toEqual(['#FFFFFF', '#111111']);
    expect(record.primeTowerEnabled).toBe(true);
    expect(record.keycapsByLetter.A.parts.map((p) => p.extruder)).toEqual([1, 2]);

    // Export single plate and batch, then verify stored Master buffer & original buffer hashes are completely unchanged
    const storedShaBefore = await computeBufferSha256Hex(storedBuffer);
    await exportSinglePlate3mf({
      plate: {
        plateNumber: 1,
        plateCode: 'K7M2Q',
        capacity: 138,
        letters: { A: 20, B: 10 },
      },
      master3mfBuffer: storedBuffer,
      projectName: 'WOOPP Test Project',
    });
    const storedShaAfterSingle = await computeBufferSha256Hex(storedBuffer);
    expect(storedShaAfterSingle).toBe(storedShaBefore);
    expect(await computeBufferSha256Hex(rawBuffer)).toBe(originalSha);
  });

  it('exports 414 keycaps (1 batch = 3 plates x 138) into ONE multi-plate WOOPP-Batch-{BatchID}.3mf preserving plate coordinates, extruders, and project settings', async () => {
    const masterBuffer = await createSyntheticMaster3mfBuffer(ABC);
    const registry = createInMemoryPlateIdRegistry();
    const ws = createFreshWorkspaceV5('owner-batch-3mf');
    const projectId = ws.projects[0].id;
    const colorId = ws.colors[0].id;
    const batchId = generateStableBatchId();

    const preview = generateIndependentKeycapBatchPreviews({
      existingJobs: ws.jobs,
      projectId,
      mode: 'alphabet_only',
      batchLetters: { A: 138, B: 138, C: 138 },
      capacity: 138,
      defaultMinutesPerPlate: 195,
    });
    expect(preview.fullPlates).toHaveLength(3);

    const reservedPlates = await reservePlateCodesForPreviewPlates({
      plates: preview.fullPlates,
      ownerId: 'owner-batch-3mf',
      projectId,
      batchId,
      existingJobs: ws.jobs,
      registry,
    });

    const batchRes = await exportBatchPlates3mf({
      batchId,
      plates: reservedPlates.map((p) => ({
        plateNumber: p.plateNumber,
        plateCode: p.plateCode,
        capacity: p.capacity,
        letters: p.letters,
      })),
      master3mfBuffer: masterBuffer,
      projectName: ws.projects[0].name,
    });

    expect(batchRes.fileName).toBe(formatBatch3mfFilename(batchId));
    expect(batchRes.fileName).toBe(`WOOPP-Batch-${batchId}.3mf`);
    expect(batchRes.plateCount).toBe(3);
    expect(batchRes.totalKeycapCount).toBe(414);
    expect(batchRes.combinedLetterBreakdown).toEqual({ A: 138, B: 138, C: 138 });

    // Confirm workspace commit preserves EXACT same Batch ID and Plate IDs
    const committed = commitGeneratedPlatesToWorkspace(ws, {
      projectId,
      colorId,
      plateCapacity: 138,
      mode: 'alphabet_only',
      targetLetters: { A: 138, B: 138, C: 138 },
      targetCharms: {},
      carryForwardLetters: {},
      carryForwardCharms: {},
      confirmedPlates: reservedPlates,
      batchId,
      preserveQueuedPlates: true,
    });
    expect(committed.createdJobs).toHaveLength(3);
    expect(committed.createdJobs!.map((j) => j.batchId)).toEqual([
      batchId,
      batchId,
      batchId,
    ]);
    expect(committed.createdJobs!.map((j) => j.plateCode)).toEqual(
      reservedPlates.map((p) => p.plateCode)
    );

    // Inspect generated 3MF archive structure & Bambu Studio metadata
    const outZip = await JSZip.loadAsync(batchRes.threeMfBytes);
    const projectSettingsRaw = await outZip
      .file('Metadata/project_settings.config')!
      .async('string');
    const parsedSettings = JSON.parse(projectSettingsRaw);
    expect(parsedSettings.enable_prime_tower).toBe('1');
    expect(parsedSettings.filament_colour).toEqual(['#FFFFFF', '#111111']);
    expect(parsedSettings.woopp_custom_profile_marker).toBe('preserved-master-v1');

    // Reusable multi-part object files created only for used letters A, B, C
    expect(outZip.file('3D/Objects/keycap_A.model')).toBeTruthy();
    expect(outZip.file('3D/Objects/keycap_B.model')).toBeTruthy();
    expect(outZip.file('3D/Objects/keycap_C.model')).toBeTruthy();

    const modelSettingsXml = await outZip
      .file('Metadata/model_settings.config')!
      .async('string');
    expect(modelSettingsXml).toContain('<metadata key="plater_id" value="1"/>');
    expect(modelSettingsXml).toContain('<metadata key="plater_id" value="2"/>');
    expect(modelSettingsXml).toContain('<metadata key="plater_id" value="3"/>');
    expect(modelSettingsXml).toContain(
      `<metadata key="plater_name" value="WP-${reservedPlates[0].plateCode}"/>`
    );
    expect(modelSettingsXml).toContain(
      `<metadata key="plater_name" value="WP-${reservedPlates[1].plateCode}"/>`
    );
    expect(modelSettingsXml).toContain(
      `<metadata key="plater_name" value="WP-${reservedPlates[2].plateCode}"/>`
    );
    expect(modelSettingsXml).toContain('<metadata key="extruder" value="2"/>');

    const plateBlocks = modelSettingsXml.match(/<plate>[\s\S]*?<\/plate>/g) || [];
    expect(plateBlocks).toHaveLength(3);
    for (const block of plateBlocks) {
      const instanceMatches = block.match(/<model_instance>/g) || [];
      expect(instanceMatches).toHaveLength(138);
    }

    const rootModelXml = await outZip.file('3D/3dmodel.model')!.async('string');
    const buildItems = rootModelXml.match(/<item\b[^>]*\/>/g) || [];
    expect(buildItems).toHaveLength(414);

    // Every exported plate re-inspected cleanly via inspectMaster3mfArchive
    const outArrayBuffer = batchRes.threeMfBytes.buffer.slice(
      batchRes.threeMfBytes.byteOffset,
      batchRes.threeMfBytes.byteOffset + batchRes.threeMfBytes.byteLength
    ) as ArrayBuffer;
    const reinspected = await inspectMaster3mfArchive(outArrayBuffer);
    expect(reinspected.detectedLetters).toEqual(['A', 'B', 'C']);
    expect(reinspected.primeTowerEnabled).toBe(true);
    expect(reinspected.multiMaterialPartCount).toBe(2);
  });

  it('exports single plate WP-{PlateID}.3mf cleanly with ONLY that plate (zero leakage) and isolates multiple batches', async () => {
    const masterBuffer = await createSyntheticMaster3mfBuffer(['A', 'B', 'C', 'D']);

    // Batch 1 (2 plates: Plate 1 has A, Plate 2 has B)
    const batch1Res = await exportBatchPlates3mf({
      batchId: 'BATCH-ALPHA-1',
      plates: [
        { plateNumber: 1, plateCode: 'AAAA2', capacity: 138, letters: { A: 25 } },
        { plateNumber: 2, plateCode: 'BBBB3', capacity: 138, letters: { B: 40 } },
      ],
      master3mfBuffer: masterBuffer,
    });
    // Batch 2 (1 plate: Plate 1 has C & D)
    const batch2Res = await exportBatchPlates3mf({
      batchId: 'BATCH-BETA-2',
      plates: [{ plateNumber: 1, plateCode: 'CCCC4', capacity: 138, letters: { C: 10, D: 5 } }],
      master3mfBuffer: masterBuffer,
    });

    expect(batch1Res.fileName).toBe('WOOPP-Batch-BATCH-ALPHA-1.3mf');
    expect(batch1Res.totalKeycapCount).toBe(65);
    expect(batch1Res.combinedLetterBreakdown).toEqual({ A: 25, B: 40 });
    expect(batch2Res.fileName).toBe('WOOPP-Batch-BATCH-BETA-2.3mf');
    expect(batch2Res.totalKeycapCount).toBe(15);
    expect(batch2Res.combinedLetterBreakdown).toEqual({ C: 10, D: 5 });

    // Single plate export for Plate 2 ONLY
    const singlePlate2 = await exportSinglePlate3mf({
      plate: { plateNumber: 2, plateCode: 'BBBB3', capacity: 138, letters: { B: 40 } },
      master3mfBuffer: masterBuffer,
    });
    expect(singlePlate2.fileName).toBe(formatWpPlate3mfFilename('BBBB3'));
    expect(singlePlate2.fileName).toBe('WP-BBBB3.3mf');
    expect(singlePlate2.plateSummary.keycapCount).toBe(40);
    expect(singlePlate2.plateSummary.letterBreakdown).toEqual({ B: 40 });

    const singleZip = await JSZip.loadAsync(singlePlate2.threeMfBytes);
    expect(singleZip.file('3D/Objects/keycap_A.model')).toBeNull();
    expect(singleZip.file('3D/Objects/keycap_B.model')).toBeTruthy();
    const singleSettings = await singleZip
      .file('Metadata/model_settings.config')!
      .async('string');
    const singlePlates = singleSettings.match(/<plate>[\s\S]*?<\/plate>/g) || [];
    expect(singlePlates).toHaveLength(1);
    expect(singlePlates[0]).toContain('<metadata key="plater_name" value="WP-BBBB3"/>');
    expect((singlePlates[0] || '').match(/<model_instance>/g) || []).toHaveLength(40);
  });

  it('preserves catalog staged batchId upon commitCatalogPlatesToWorkspace', () => {
    const ws = createFreshWorkspaceV5('owner-cat-3mf');
    const category: ProductCategory = {
      id: 'cat-keycaps',
      ownerId: 'owner-cat-3mf',
      name: 'Alphabet Keycaps',
      description: '',
      imageUrl: null,
      iconName: 'key',
      sortOrder: 1,
      status: 'active',
      createdAt: '2026-11-18T00:00:00.000Z',
      updatedAt: '2026-11-18T00:00:00.000Z',
    };
    const product: CatalogProduct = {
      id: 'prod-alpha',
      ownerId: 'owner-cat-3mf',
      categoryId: 'cat-keycaps',
      name: '3D Keycap A–Z',
      sku: 'KEY-AZ',
      description: '',
      priceMyr: 5,
      images: [],
      options: [
        {
          id: 'opt-letter',
          name: 'Letter',
          values: ['A', 'B'],
          sortOrder: 0,
        },
      ],
      variants: [
        {
          id: 'v-a',
          label: 'A',
          optionValues: { Letter: 'A' },
          priceMyr: null,
          imageUrl: null,
          sortOrder: 0,
        },
        {
          id: 'v-b',
          label: 'B',
          optionValues: { Letter: 'B' },
          priceMyr: null,
          imageUrl: null,
          sortOrder: 1,
        },
      ],
      status: 'active',
      createdAt: '2026-11-18T00:00:00.000Z',
      updatedAt: '2026-11-18T00:00:00.000Z',
    };

    const preview = generateAutomaticCatalogPlatePreviews({
      existingJobs: ws.jobs,
      project: ws.projects[0],
      color: ws.colors[0],
      workspaceColors: ws.colors,
      category,
      products: [product],
      selections: [
        { productId: product.id, variantId: 'v-a', quantity: 10 },
        { productId: product.id, variantId: 'v-b', quantity: 10 },
      ],
      plateSetting: {
        allocationMode: 'automatic_capacity',
        plateCapacity: 10,
        defaultEstimatedMinutes: 60,
      },
      includePartialRemainderPlate: true,
    });
    expect(preview.previews).toHaveLength(2);
    const platesWithCodes = preview.previews!.map((p, i) => ({
      ...p,
      plateCode: i === 0 ? 'CAT22' : 'CAT33',
    }));

    const fixedBatchId = '20261118-FIXED1';
    const commitRes = commitCatalogPlatesToWorkspace(ws, {
      projectId: ws.projects[0].id,
      category,
      confirmedPlates: platesWithCodes,
      batchId: fixedBatchId,
    });
    expect(commitRes.createdJobs).toHaveLength(2);
    expect(commitRes.createdJobs!.map((j) => j.batchId)).toEqual([
      fixedBatchId,
      fixedBatchId,
    ]);
    expect(commitRes.createdJobs!.map((j) => j.plateCode)).toEqual(['CAT22', 'CAT33']);
  });

  it('surfaces missing Master .3MF and missing keycap errors via toast without crashing', async () => {
    const toasts: Array<{ variant: ToastVariant; message: string }> = [];

    await exportBatchPlates3mfAction({
      batchId: 'B-MISSING',
      plates: [{ plateNumber: 1, plateCode: 'AAAA2', capacity: 138, letters: { A: 5 } }],
      getMaster3mfAsset: async () => null,
      onToast: (variant, message) => toasts.push({ variant, message }),
    });
    expect(toasts).toHaveLength(1);
    expect(toasts[0].variant).toBe('error');
    expect(toasts[0].message).toContain('Master .3MF');

    // Missing letter Z in Master 3MF that only contains A
    const partialMaster = await createSyntheticMaster3mfBuffer(['A']);
    const prep = await validateAndPrepareMaster3mf({
      fileName: 'Master_Only_A.3mf',
      buffer: partialMaster,
      uploadedBy: null,
    });
    if (!prep.ok) throw new Error('Prep failed');

    toasts.length = 0;
    await exportSinglePlate3mfAction({
      plateNumber: 1,
      plateCode: 'AAAA2',
      capacity: 138,
      letters: { Z: 3 },
      master3mfAsset: prep.asset,
      onToast: (variant, message) => toasts.push({ variant, message }),
    });
    expect(toasts).toHaveLength(1);
    expect(toasts[0].variant).toBe('error');
    expect(toasts[0].message).toContain('Z');
  });

  it('hosts Master .3MF Template Panel in SettingsView, keeps AutoPlannerView free of extra export panels, and exposes saved batch/plate .3MF exports cleanly', () => {
    const ws = createFreshWorkspaceV5('owner-ui-3mf');
    const savedJob: ProductionJob = {
      id: 'job-saved-1',
      projectId: ws.projects[0].id,
      colorId: ws.colors[0].id,
      plateNumber: 1,
      plateCode: 'M3MF2',
      plateCapacity: 138,
      letters: { A: 70, B: 68 },
      batchId: '20261118-UI99',
      stage: 'Completed',
      machineId: null,
      estimatedMinutes: 195,
      actualMinutes: 190,
      slicerVerified: true,
      stockApplied: true,
      stockTransactionId: 'tx-ui-1',
      failedCount: 0,
      failureReason: '',
      notes: '',
      createdIso: '2026-11-18T08:00:00.000Z',
      updatedIso: '2026-11-18T11:10:00.000Z',
      completedIso: '2026-11-18T11:10:00.000Z',
      actualCompletedAt: '2026-11-18T11:10:00.000Z',
    };
    ws.jobs = [savedJob];
    ws.projects[0].productionBatches = [
      {
        id: '20261118-UI99',
        batchNumber: 1,
        projectId: ws.projects[0].id,
        productId: 'builtin:alphabet',
        productName: 'Alphabet Keycaps A–Z',
        sku: null,
        categoryId: 'builtin:alphabet',
        categoryName: 'Alphabet Keycaps',
        colorId: ws.colors[0].id,
        colorName: ws.colors[0].name,
        mode: 'alphabet_only',
        plateCapacity: 138,
        requestedQuantity: 138,
        committedQuantity: 138,
        generatedJobIds: [savedJob.id],
        plateNumbers: [1],
        requestedVariations: [
          { variationKey: 'A', variantId: 'A', label: 'A', requestedQuantity: 70 },
          { variationKey: 'B', variantId: 'B', label: 'B', requestedQuantity: 68 },
        ],
        createdIso: '2026-11-18T08:00:00.000Z',
        updatedIso: '2026-11-18T11:10:00.000Z',
      },
    ];

    const settingsHtml = renderToStaticMarkup(
      <SettingsView
        workspace={ws}
        isAdmin={true}
        ownerId="owner-ui-3mf"
        onUpdateWorkspaceDefaults={vi.fn()}
        onAddColor={vi.fn()}
        onRenameColor={vi.fn()}
        onExportBackup={vi.fn()}
        onImportBackup={vi.fn()}
        onClearActivityLog={vi.fn()}
      />
    );
    expect(settingsHtml).toContain('Bambu Studio Master 3MF Template');

    const plannerHtml = renderToStaticMarkup(
      <AutoPlannerView
        workspace={ws}
        selectedProjectId={ws.projects[0].id}
        isAdmin={true}
        ownerId="owner-ui-3mf"
        onSelectProject={vi.fn()}
        onSavePreset={vi.fn()}
        onDeletePreset={vi.fn()}
        onCommitGeneratedPlates={vi.fn()}
        onAlert={vi.fn()}
        onToast={vi.fn()}
      />
    );
    expect(plannerHtml).not.toContain('Confirmed Batch STL Export');
    expect(plannerHtml).not.toContain('Master .3MF Template (A–Z Multi-Colour)');
    expect(plannerHtml).not.toContain('data-testid="batch-3mf-export-progress"');

    const summaryHtml = renderToStaticMarkup(
      <ProjectProductionSummaryModal
        workspace={ws}
        project={ws.projects[0]}
        ownerId="owner-ui-3mf"
        onClose={vi.fn()}
      />
    );
    expect(summaryHtml).toContain('data-testid="export-saved-batch-3mf"');
    expect(summaryHtml).toContain('Export All Plates (.3MF)');
    expect(summaryHtml).not.toContain('data-testid="saved-batch-3mf-export-progress"');

    const schedule = computeGlobalSchedule(ws, Date.now());
    const queueHtml = renderToStaticMarkup(
      <KanbanQueueView
        workspace={ws}
        schedule={schedule}
        selectedProjectId={ws.projects[0].id}
        isAdmin={true}
        busyJobIds={new Set()}
        ownerId="owner-ui-3mf"
        onSelectProject={vi.fn()}
        onTransitionStage={vi.fn()}
        onPauseOrResume={vi.fn()}
        onRecalibrateJobEta={vi.fn()}
        onUpdateJobMetadata={vi.fn()}
        onCopyQueueSummary={vi.fn()}
        onRequestDeletePlate={vi.fn()}
        onRequestCancelPrinting={vi.fn()}
        onArchivePlate={vi.fn()}
        onRestorePlate={vi.fn()}
        onRequestBulkAction={vi.fn()}
      />
    );
    expect(queueHtml).toContain('data-testid="queue-export-3mf-job-saved-1"');
    expect(queueHtml).toContain('Export 3MF');
  });

  it('fixes WP-ARLBB.3mf package relationships: regenerates 3D/_rels/3dmodel.model.rels for A/E/I/N only, strips dangling thumbnails from _rels/.rels, and passes full 138-keycap audit', async () => {
    const masterBuffer = await createSyntheticMaster3mfBuffer(ABC);

    const res = await exportSinglePlate3mf({
      plate: {
        plateNumber: 1,
        plateCode: 'ARLBB',
        capacity: 138,
        letters: { A: 35, E: 35, I: 34, N: 34 },
      },
      master3mfBuffer: masterBuffer,
      projectName: 'WOOPP ARLBB Regression',
    });

    expect(res.fileName).toBe('WP-ARLBB.3mf');
    expect(res.plateSummary.keycapCount).toBe(138);
    expect(res.audit.valid).toBe(true);
    expect(res.audit.errors).toEqual([]);
    expect(res.audit.totalBuildItems).toBe(138);
    expect(res.audit.plateCount).toBe(1);
    expect(res.audit.extrudersUsed).toEqual([1, 2]);
    expect(res.audit.projectSettingsValid).toBe(true);

    const zip = await JSZip.loadAsync(res.threeMfBytes);

    // 1. Verify 3D/_rels/3dmodel.model.rels strictly lists ONLY the 4 present A,E,I,N models (never object_17538.model)
    const modelRelsXml = await zip.file('3D/_rels/3dmodel.model.rels')!.async('string');
    expect(modelRelsXml).not.toContain('object_17538');
    expect(modelRelsXml).not.toContain('keycap_B.model');
    expect(res.audit.modelRelationships.map((r) => r.target)).toEqual([
      '/3D/Objects/keycap_A.model',
      '/3D/Objects/keycap_E.model',
      '/3D/Objects/keycap_I.model',
      '/3D/Objects/keycap_N.model',
    ]);
    for (const rel of res.audit.modelRelationships) {
      expect(rel.type).toBe('http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel');
      expect(zip.file(rel.target.replace(/^\/+/, ''))).toBeTruthy();
    }

    // 2. Verify root _rels/.rels keeps /3D/3dmodel.model and stripped missing /Metadata/plate_1.png
    const rootRelsXml = await zip.file('_rels/.rels')!.async('string');
    expect(rootRelsXml).not.toContain('plate_1.png');
    expect(zip.file('Metadata/plate_1.png')).toBeNull();
    expect(res.audit.rootRelationships).toEqual([
      {
        id: 'rel-1',
        target: '/3D/3dmodel.model',
        type: 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel',
      },
    ]);

    // 3. Verify 3D/3dmodel.model component paths match 3D/_rels/3dmodel.model.rels 1:1
    const rootModelXml = await zip.file('3D/3dmodel.model')!.async('string');
    expect(rootModelXml).toContain('p:path="/3D/Objects/keycap_A.model"');
    expect(rootModelXml).toContain('p:path="/3D/Objects/keycap_E.model"');
    expect(rootModelXml).toContain('p:path="/3D/Objects/keycap_I.model"');
    expect(rootModelXml).toContain('p:path="/3D/Objects/keycap_N.model"');
    expect((rootModelXml.match(/<item\b[^>]*\/>/g) || [])).toHaveLength(138);
  });

  it('exports 1 complete multi-part keycap with valid relationships, geometry, and extruder bindings', async () => {
    const masterBuffer = await createSyntheticMaster3mfBuffer(ABC);

    const res = await exportSinglePlate3mf({
      plate: {
        plateNumber: 1,
        plateCode: 'ANK22',
        capacity: 138,
        letters: { A: 1 },
      },
      master3mfBuffer: masterBuffer,
    });

    expect(res.audit.valid).toBe(true);
    expect(res.audit.modelRelationships.map((r) => r.target)).toEqual([
      '/3D/Objects/keycap_A.model',
    ]);
    expect(res.audit.includedObjectFiles).toEqual(['3D/Objects/keycap_A.model']);
    expect(res.audit.totalBuildItems).toBe(1);
    expect(res.audit.totalVertices).toBe(16); // 2 parts x 8 vertices each
    expect(res.audit.totalTriangles).toBe(24); // 2 parts x 12 triangles each
    expect(res.audit.extrudersUsed).toEqual([1, 2]);
  });

  it('exports 3-plate batch with accurate union of model relationships and zero dangling references', async () => {
    const masterBuffer = await createSyntheticMaster3mfBuffer(ABC);

    const res = await exportBatchPlates3mf({
      batchId: 'BATCH-REL-3P',
      plates: [
        { plateNumber: 1, plateCode: 'PLT2A', capacity: 138, letters: { A: 10 } },
        { plateNumber: 2, plateCode: 'PLT3E', capacity: 138, letters: { E: 12 } },
        { plateNumber: 3, plateCode: 'PLT4N', capacity: 138, letters: { I: 8, N: 6 } },
      ],
      master3mfBuffer: masterBuffer,
    });

    expect(res.audit.valid).toBe(true);
    expect(res.audit.plateCount).toBe(3);
    expect(res.audit.totalBuildItems).toBe(36);
    expect(res.audit.modelRelationships.map((r) => r.target)).toEqual([
      '/3D/Objects/keycap_A.model',
      '/3D/Objects/keycap_E.model',
      '/3D/Objects/keycap_I.model',
      '/3D/Objects/keycap_N.model',
    ]);
    expect(res.audit.rootRelationships.map((r) => r.target)).toEqual(['/3D/3dmodel.model']);
  });

  it('rejects any .3MF archive with dangling relationships or missing geometry and blocks download via Print Queue action', async () => {
    const masterBuffer = await createSyntheticMaster3mfBuffer(ABC);
    const validRes = await exportSinglePlate3mf({
      plate: {
        plateNumber: 1,
        plateCode: 'ARLBB',
        capacity: 138,
        letters: { A: 35, E: 35, I: 34, N: 34 },
      },
      master3mfBuffer: masterBuffer,
    });

    // Inject the exact WP-ARLBB defects into a mutated copy and confirm validator rejects both
    const corruptedZip = await JSZip.loadAsync(validRes.threeMfBytes);
    corruptedZip.file(
      '3D/_rels/3dmodel.model.rels',
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        '  <Relationship Target="/3D/Objects/object_17538.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>',
        '</Relationships>',
      ].join('\n')
    );
    corruptedZip.file(
      '_rels/.rels',
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        '  <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>',
        '  <Relationship Target="/Metadata/plate_1.png" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>',
        '</Relationships>',
      ].join('\n')
    );
    const corruptedBytes = await corruptedZip.generateAsync({ type: 'uint8array' });
    const failedAudit = await validateExported3mfArchive({ threeMfBytes: corruptedBytes });
    expect(failedAudit.valid).toBe(false);
    expect(failedAudit.errors.join(' ')).toContain('object_17538.model');
    expect(failedAudit.errors.join(' ')).toContain('plate_1.png');

    // Simulate Print Queue card exportSinglePlate3mfAction with mocked browser download primitives
    const prep = await validateAndPrepareMaster3mf({
      fileName: 'Master_Realistic.3mf',
      buffer: masterBuffer,
      uploadedBy: 'admin@woopp.test',
    });
    if (!prep.ok) throw new Error('Expected Master 3MF prep to succeed');

    const downloaded: Array<{ download: string; href: string }> = [];
    const capturedBlobs: Blob[] = [];
    const origDoc = (globalThis as any).document;
    const origWin = (globalThis as any).window;
    const origCreateObjectUrl = URL.createObjectURL;
    const origRevokeObjectUrl = URL.revokeObjectURL;

    URL.createObjectURL = vi.fn((blob: Blob) => {
      capturedBlobs.push(blob);
      return 'blob:woopp-test-arlbb';
    });
    URL.revokeObjectURL = vi.fn();
    (globalThis as any).window = { setTimeout: globalThis.setTimeout };
    (globalThis as any).document = {
      body: {
        appendChild: vi.fn(),
        removeChild: vi.fn(),
      },
      createElement: vi.fn(() => {
        const anchor = {
          href: '',
          download: '',
          style: { display: '' },
          click: vi.fn(() => {
            downloaded.push({ download: anchor.download, href: anchor.href });
          }),
        };
        return anchor;
      }),
    };

    try {
      const toasts: Array<{ variant: ToastVariant; message: string }> = [];
      await exportSinglePlate3mfAction({
        plateNumber: 1,
        plateCode: 'ARLBB',
        capacity: 138,
        letters: { A: 35, E: 35, I: 34, N: 34 },
        master3mfAsset: prep.asset,
        projectName: 'Queue Card Test',
        onToast: (variant, message) => toasts.push({ variant, message }),
      });

      expect(downloaded).toEqual([{ download: 'WP-ARLBB.3mf', href: 'blob:woopp-test-arlbb' }]);
      expect(toasts.some((t) => t.variant === 'success' && t.message.includes('WP-ARLBB.3mf'))).toBe(true);
      expect(capturedBlobs).toHaveLength(1);
      const blobAudit = await validateExported3mfArchive({
        threeMfBytes: new Uint8Array(await capturedBlobs[0].arrayBuffer()),
      });
      expect(blobAudit.valid).toBe(true);
      expect(blobAudit.modelRelationships.map((r) => r.target)).toEqual([
        '/3D/Objects/keycap_A.model',
        '/3D/Objects/keycap_E.model',
        '/3D/Objects/keycap_I.model',
        '/3D/Objects/keycap_N.model',
      ]);

      // Confirm invalid letter missing in Master aborts without triggering download
      downloaded.length = 0;
      toasts.length = 0;
      const partialMaster = await createSyntheticMaster3mfBuffer(['A']);
      const partialPrep = await validateAndPrepareMaster3mf({
        fileName: 'Master_Only_A.3mf',
        buffer: partialMaster,
        uploadedBy: null,
      });
      if (!partialPrep.ok) throw new Error('Prep failed');

      await exportSinglePlate3mfAction({
        plateNumber: 1,
        plateCode: 'BAD99',
        capacity: 138,
        letters: { Z: 1 },
        master3mfAsset: partialPrep.asset,
        onToast: (variant, message) => toasts.push({ variant, message }),
      });
      expect(downloaded).toHaveLength(0);
      expect(toasts).toHaveLength(1);
      expect(toasts[0].variant).toBe('error');
    } finally {
      (globalThis as any).document = origDoc;
      (globalThis as any).window = origWin;
      URL.createObjectURL = origCreateObjectUrl;
      URL.revokeObjectURL = origRevokeObjectUrl;
    }
  });

  it('Test 1: exports 4 keycaps (A, E, I, N) with distinct original Master geometry hashes and globally disjoint sub-object IDs', async () => {
    const masterBuffer = await createSyntheticMaster3mfBuffer(ABC);
    const parsedMaster = await inspectMaster3mfArchive(masterBuffer);

    const res = await exportSinglePlate3mf({
      plate: {
        plateNumber: 1,
        plateCode: 'AEKN4',
        capacity: 138,
        letters: { A: 1, E: 1, I: 1, N: 1 },
      },
      master3mfBuffer: masterBuffer,
    });

    expect(res.audit.valid).toBe(true);
    expect(res.audit.errors).toEqual([]);
    expect(res.audit.distinctGeometryHashesCount).toBe(4);
    expect(res.audit.resolvedLetterGeometryCounts).toEqual({ A: 1, E: 1, I: 1, N: 1 });

    // Confirm 4 separate sub-model files, globally disjoint sub-object IDs, and exact Master mesh hash match
    const seenSubIds = new Set<string>();
    const seenRootIds = new Set<string>();
    for (const letter of ['A', 'E', 'I', 'N']) {
      const entry = res.audit.letterGeometryAudit[letter];
      expect(entry).toBeDefined();
      expect(entry.modelPath).toBe(`/3D/Objects/keycap_${letter}.model`);
      expect(entry.geometryHash).toBe(parsedMaster.keycapsByLetter[letter].geometryHash);
      expect(entry.raisedPartHash).toBe(
        parsedMaster.keycapsByLetter[letter].partHashes[
          parsedMaster.keycapsByLetter[letter].partHashes.length - 1
        ]
      );
      expect(entry.instanceCount).toBe(1);
      expect(seenRootIds.has(entry.objectId)).toBe(false);
      seenRootIds.add(entry.objectId);
      for (const sid of entry.subObjectIds) {
        expect(seenRootIds.has(sid)).toBe(false);
        expect(seenSubIds.has(sid)).toBe(false);
        seenSubIds.add(sid);
      }
    }

    const zip = await JSZip.loadAsync(res.threeMfBytes);
    const rootModelXml = await zip.file('3D/3dmodel.model')!.async('string');
    expect(rootModelXml).toContain('requiredextensions="p"');
  });

  it('Test 2 & Test 5: exports Plate 6 (A:60, E:18, I:30, N:30 = 138) with exact live per-instance 3D letter geometry and preserves Plate ID on re-export', async () => {
    const masterBuffer = await createSyntheticMaster3mfBuffer(ABC);
    const plate6Letters = { A: 60, E: 18, I: 30, N: 30 };

    const firstExport = await exportSinglePlate3mf({
      plate: {
        plateNumber: 6,
        plateCode: 'PLT6A',
        capacity: 138,
        letters: plate6Letters,
      },
      master3mfBuffer: masterBuffer,
      projectName: 'WOOPP Plate 6 Verification',
    });

    expect(firstExport.fileName).toBe('WP-PLT6A.3mf');
    expect(firstExport.plateCode).toBe('PLT6A');
    expect(firstExport.plateSummary.keycapCount).toBe(138);
    expect(firstExport.audit.valid).toBe(true);
    expect(firstExport.audit.errors).toEqual([]);
    expect(firstExport.audit.totalBuildItems).toBe(138);
    expect(firstExport.audit.distinctGeometryHashesCount).toBe(4);
    expect(firstExport.audit.resolvedLetterGeometryCounts).toEqual({
      A: 60,
      E: 18,
      I: 30,
      N: 30,
    });

    // Test 5: Re-export the exact same plate -> identical WP-PLT6A filename, Plate ID, and verified geometry hashes
    const secondExport = await exportSinglePlate3mf({
      plate: {
        plateNumber: 6,
        plateCode: 'PLT6A',
        capacity: 138,
        letters: plate6Letters,
      },
      master3mfBuffer: masterBuffer,
      projectName: 'WOOPP Plate 6 Verification',
    });

    expect(secondExport.fileName).toBe(firstExport.fileName);
    expect(secondExport.plateCode).toBe('PLT6A');
    expect(secondExport.audit.valid).toBe(true);
    expect(secondExport.audit.resolvedLetterGeometryCounts).toEqual(
      firstExport.audit.resolvedLetterGeometryCounts
    );
    expect(secondExport.audit.letterGeometryAudit).toEqual(
      firstExport.audit.letterGeometryAudit
    );
  });

  it('Test 3 & Test 4: Print Queue single-plate Plate 6 export and Batch Export All Plates preserve exact planned letter geometry', async () => {
    const masterBuffer = await createSyntheticMaster3mfBuffer(ABC);
    const prep = await validateAndPrepareMaster3mf({
      fileName: 'Master_Realistic_AZ.3mf',
      buffer: masterBuffer,
      uploadedBy: 'admin@woopp.test',
    });
    if (!prep.ok) throw new Error('Expected Master 3MF prep to succeed');

    // Test 4: Multi-plate batch export including Plate 6 (60 A, 18 E, 30 I, 30 N)
    const batchRes = await exportBatchPlates3mf({
      batchId: '20261118-PLT6B',
      plates: [
        { plateNumber: 5, plateCode: 'PLT5X', capacity: 138, letters: { B: 50, C: 50, D: 38 } },
        { plateNumber: 6, plateCode: 'PLT6A', capacity: 138, letters: { A: 60, E: 18, I: 30, N: 30 } },
      ],
      master3mfBuffer: masterBuffer,
      projectName: 'Batch Multi-Letter Verification',
    });

    expect(batchRes.audit.valid).toBe(true);
    expect(batchRes.audit.errors).toEqual([]);
    expect(batchRes.plateCount).toBe(2);
    expect(batchRes.totalKeycapCount).toBe(276);
    expect(batchRes.audit.distinctGeometryHashesCount).toBe(7);
    expect(batchRes.audit.resolvedLetterGeometryCounts).toEqual({
      B: 50,
      C: 50,
      D: 38,
      A: 60,
      E: 18,
      I: 30,
      N: 30,
    });

    // Test 3: Simulate Print Queue exportSinglePlate3mfAction for Plate 6 & inspect captured Blob
    const downloaded: Array<{ download: string; href: string }> = [];
    const capturedBlobs: Blob[] = [];
    const origDoc = (globalThis as any).document;
    const origWin = (globalThis as any).window;
    const origCreateObjectUrl = URL.createObjectURL;
    const origRevokeObjectUrl = URL.revokeObjectURL;

    URL.createObjectURL = vi.fn((blob: Blob) => {
      capturedBlobs.push(blob);
      return 'blob:woopp-plate6-queue';
    });
    URL.revokeObjectURL = vi.fn();
    (globalThis as any).window = { setTimeout: globalThis.setTimeout };
    (globalThis as any).document = {
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
      createElement: vi.fn(() => {
        const anchor = {
          href: '',
          download: '',
          style: { display: '' },
          click: vi.fn(() => {
            downloaded.push({ download: anchor.download, href: anchor.href });
          }),
        };
        return anchor;
      }),
    };

    try {
      const toasts: Array<{ variant: ToastVariant; message: string }> = [];
      await exportSinglePlate3mfAction({
        plateNumber: 6,
        plateCode: 'PLT6A',
        capacity: 138,
        letters: { A: 60, E: 18, I: 30, N: 30 },
        master3mfAsset: prep.asset,
        projectName: 'Print Queue Plate 6',
        onToast: (variant, message) => toasts.push({ variant, message }),
      });

      expect(downloaded).toEqual([{ download: 'WP-PLT6A.3mf', href: 'blob:woopp-plate6-queue' }]);
      expect(toasts.some((t) => t.variant === 'success' && t.message.includes('WP-PLT6A.3mf'))).toBe(
        true
      );
      expect(capturedBlobs).toHaveLength(1);

      const queueAudit = await validateExported3mfArchive({
        threeMfBytes: new Uint8Array(await capturedBlobs[0].arrayBuffer()),
      });
      expect(queueAudit.valid).toBe(true);
      expect(queueAudit.resolvedLetterGeometryCounts).toEqual({
        A: 60,
        E: 18,
        I: 30,
        N: 30,
      });
      expect(queueAudit.distinctGeometryHashesCount).toBe(4);
    } finally {
      (globalThis as any).document = origDoc;
      (globalThis as any).window = origWin;
      URL.createObjectURL = origCreateObjectUrl;
      URL.revokeObjectURL = origRevokeObjectUrl;
    }
  });

  it('rejects Master .3MF templates where distinct letters share identical/substituted A geometry (never falls back silently)', async () => {
    const brokenMasterBuffer = await createSyntheticMaster3mfBuffer(['A', 'E', 'I', 'N'], {
      duplicateLetterFrom: { E: 'A', I: 'A', N: 'A' },
    });

    await expect(
      exportSinglePlate3mf({
        plate: {
          plateNumber: 6,
          plateCode: 'PLT6A',
          capacity: 138,
          letters: { A: 60, E: 18, I: 30, N: 30 },
        },
        master3mfBuffer: brokenMasterBuffer,
      })
    ).rejects.toThrow(/identical/i);
  });

  it('decodes Bambu Studio paint_color hex codes and preserves non-slot-2 Master filament assignments on 4-letter sample (D, H, M, R)', async () => {
    expect(decodeBambuPaintColorExtruders('4')).toEqual([1]);
    expect(decodeBambuPaintColorExtruders('8')).toEqual([2]);
    expect(decodeBambuPaintColorExtruders('0C')).toEqual([3]);
    expect(decodeBambuPaintColorExtruders('1C')).toEqual([4]);
    expect(decodeBambuPaintColorExtruders('2C')).toEqual([5]);

    // Build a realistic 4-filament Bambu Master 3MF where:
    // - D, H, M, R, S, U, Y use body extruder 1 (inherited from <object>, omitted on body <part>)
    // - text_shape uses filament 3 (NOT filament 2!) via <part> metadata (or separate sub-model files both using objectid="1")
    const letters = ['D', 'H', 'M', 'R', 'S', 'U', 'Y'];
    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
        '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        '  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>',
        '  <Default Extension="config" ContentType="text/plain"/>',
        '</Types>',
      ].join('\n')
    );
    zip.file(
      '_rels/.rels',
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        '  <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>',
        '</Relationships>',
      ].join('\n')
    );
    zip.file(
      'Metadata/project_settings.config',
      JSON.stringify(
        {
          enable_prime_tower: '1',
          filament_colour: ['#FFFFFF', '#FF0000', '#111111', '#00AAFF'],
          filament_type: ['PLA', 'PLA', 'PLA', 'PLA'],
          layer_height: '0.2',
        },
        null,
        2
      )
    );

    const rootObjects: string[] = [];
    const buildItems: string[] = [];
    const modelSettingsObjects: string[] = [];
    const modelRels: string[] = [];

    letters.forEach((letter, idx) => {
      const objId = idx + 1;
      const bodySubPath = `3D/Objects/body_${letter}.model`;
      const textSubPath = `3D/Objects/text_${letter}.model`;
      modelRels.push(
        `  <Relationship Target="/${bodySubPath}" Id="rel-${idx * 2 + 1}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>`,
        `  <Relationship Target="/${textSubPath}" Id="rel-${idx * 2 + 2}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>`
      );

      const alphaIdx = ABC.indexOf(letter as (typeof ABC)[number]);
      // Notice BOTH separate files use <object id="1"> — testing the duplicate sub-object ID fix!
      zip.file(
        bodySubPath,
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
          '  <resources>',
          `    <object id="1" name="Body_${letter}" type="model">`,
          buildBoxMeshXml(-9.0, 9.0, -9.0, 9.0, 0, 8.0),
          '    </object>',
          '  </resources>',
          '</model>',
        ].join('\n')
      );
      zip.file(
        textSubPath,
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
          '  <resources>',
          '    <object id="1" name="text_shape" type="model">',
          buildBoxMeshXml(-3.5, 3.5, -3.5, 3.5 - alphaIdx * 0.04, 8.0, 8.6 + alphaIdx * 0.03),
          '    </object>',
          '  </resources>',
          '</model>',
        ].join('\n')
      );

      rootObjects.push(
        `    <object id="${objId}" name="keycap-char-${letter}" type="model">`,
        '      <components>',
        `        <component p:path="/${bodySubPath}" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`,
        `        <component p:path="/${textSubPath}" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`,
        '      </components>',
        '    </object>'
      );
      buildItems.push(
        `    <item objectid="${objId}" transform="1 0 0 0 1 0 0 0 1 ${(30 + idx * 25).toFixed(1)} 40.0 0" printable="1"/>`
      );

      // Body omits extruder (inherits object default 1); text_shape explicitly maps to filament 3!
      modelSettingsObjects.push(
        `  <object id="${objId}">`,
        `    <metadata key="name" value="keycap-char-${letter}"/>`,
        '    <metadata key="extruder" value="1"/>',
        '    <part id="1" subtype="normal_part">',
        `      <metadata key="name" value="keycap-char-${letter}.stl"/>`,
        '    </part>',
        '    <part id="2" subtype="normal_part">',
        '      <metadata key="name" value="text_shape"/>',
        '      <metadata key="extruder" value="3"/>',
        '    </part>',
        '  </object>'
      );
    });

    zip.file(
      '3D/_rels/3dmodel.model.rels',
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        ...modelRels,
        '</Relationships>',
      ].join('\n')
    );
    zip.file(
      '3D/3dmodel.model',
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">',
        '  <resources>',
        ...rootObjects,
        '  </resources>',
        '  <build>',
        ...buildItems,
        '  </build>',
        '</model>',
      ].join('\n')
    );
    zip.file(
      'Metadata/model_settings.config',
      ['<?xml version="1.0" encoding="UTF-8"?>', '<config>', ...modelSettingsObjects, '</config>'].join('\n')
    );

    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const masterBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

    // Step 1 (Requirement #12): Test 4-letter sample (D, H, M, R) BEFORE testing full 138-keycap plate
    const sample4 = await exportSinglePlate3mf({
      plate: {
        plateNumber: 1,
        plateCode: 'DHMR4',
        capacity: 138,
        letters: { D: 1, H: 1, M: 1, R: 1 },
      },
      master3mfBuffer: masterBuffer,
      projectName: '4-Letter Two-Colour Sample',
    });

    expect(sample4.audit.valid).toBe(true);
    expect(sample4.audit.extrudersUsed).toEqual([1, 3]);
    expect(sample4.audit.distinctGeometryHashesCount).toBe(4);
    for (const l of ['D', 'H', 'M', 'R']) {
      expect(sample4.audit.letterGeometryAudit[l].partExtruders).toEqual([1, 3]);
    }

    // Step 2: Test complete 138-keycap plate matching WP-UW9L8 (D=18, H=24, M=24, R=24, S=24, U=18, Y=6)
    const fullPlate = await exportSinglePlate3mf({
      plate: {
        plateNumber: 2,
        plateCode: 'UW9L8',
        capacity: 138,
        letters: { D: 18, H: 24, M: 24, R: 24, S: 24, U: 18, Y: 6 },
      },
      master3mfBuffer: masterBuffer,
      projectName: 'Full 138-Keycap Two-Colour Verification',
    });

    expect(fullPlate.fileName).toBe('WP-UW9L8.3mf');
    expect(fullPlate.plateSummary.keycapCount).toBe(138);
    expect(fullPlate.audit.valid).toBe(true);
    expect(fullPlate.audit.errors).toEqual([]);
    expect(fullPlate.audit.totalBuildItems).toBe(138);
    expect(fullPlate.audit.extrudersUsed).toEqual([1, 3]);
    expect(fullPlate.audit.distinctGeometryHashesCount).toBe(7);
    expect(fullPlate.audit.resolvedLetterGeometryCounts).toEqual({
      D: 18,
      H: 24,
      M: 24,
      R: 24,
      S: 24,
      U: 18,
      Y: 6,
    });
    for (const l of letters) {
      expect(fullPlate.audit.letterGeometryAudit[l].partExtruders).toEqual([1, 3]);
    }

    // Inspect exported Metadata/model_settings.config & project_settings.config directly
    const outZip = await JSZip.loadAsync(fullPlate.threeMfBytes);
    const outSettingsXml = await outZip.file('Metadata/model_settings.config')!.async('string');
    expect(outSettingsXml).toContain('<metadata key="name" value="text_shape"/>');
    expect(outSettingsXml).toContain('<metadata key="extruder" value="3"/>');
    expect(outSettingsXml).not.toContain('<metadata key="extruder" value="2"/>');
    const outProject = JSON.parse(
      await outZip.file('Metadata/project_settings.config')!.async('string')
    );
    expect(outProject.filament_colour).toEqual(['#FFFFFF', '#FF0000', '#111111', '#00AAFF']);
    expect(outProject.enable_prime_tower).toBe('1');
  });

  it('recovers lettering extruder from triangle paint_color ("0C" -> filament 3) & <basematerials> when model_settings.config leaves text_shape on extruder 1, and blocks collapsed single-extruder exports', async () => {
    // 1. Paint-color & basematerials recovery test
    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
        '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        '  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>',
        '  <Default Extension="config" ContentType="text/plain"/>',
        '</Types>',
      ].join('\n')
    );
    zip.file(
      '_rels/.rels',
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        '  <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>',
        '</Relationships>',
      ].join('\n')
    );
    zip.file(
      'Metadata/project_settings.config',
      JSON.stringify(
        {
          enable_prime_tower: '1',
          filament_colour: ['#FFFFFF', '#FF0000', '#222222'],
          filament_type: ['PLA', 'PLA', 'PLA'],
        },
        null,
        2
      )
    );

    // Letter A uses paint_color="0C" (extruder 3) on text_shape while model_settings.config says extruder="1"
    // Letter E uses <basematerials> pid="10" pindex="2" (#222222 -> extruder 3) on text_shape
    const textMeshWithPaint = buildBoxMeshXml(-3.5, 3.5, -3.5, 3.5, 8.0, 8.7).replace(
      /<triangle ([^>]+)\/>/g,
      '<triangle $1 paint_color="0C"/>'
    );
    const textMeshWithBaseMat = buildBoxMeshXml(-3.2, 3.2, -3.2, 3.2, 8.0, 8.9).replace(
      /<triangle ([^>]+)\/>/g,
      '<triangle $1 pid="10" pindex="2"/>'
    );

    zip.file(
      '3D/Objects/letter_A.model',
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
        '  <resources>',
        '    <object id="1" name="Body_A" type="model">',
        buildBoxMeshXml(-9.0, 9.0, -9.0, 9.0, 0, 8.0),
        '    </object>',
        '    <object id="2" name="text_shape" type="model">',
        textMeshWithPaint,
        '    </object>',
        '  </resources>',
        '</model>',
      ].join('\n')
    );
    zip.file(
      '3D/Objects/letter_E.model',
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
        '  <resources>',
        '    <basematerials id="10">',
        '      <base name="White" displaycolor="#FFFFFF"/>',
        '      <base name="Red" displaycolor="#FF0000"/>',
        '      <base name="Dark" displaycolor="#222222"/>',
        '    </basematerials>',
        '    <object id="1" name="Body_E" type="model">',
        buildBoxMeshXml(-9.0, 9.0, -9.0, 9.0, 0, 8.0),
        '    </object>',
        '    <object id="2" name="text_shape" type="model">',
        textMeshWithBaseMat,
        '    </object>',
        '  </resources>',
        '</model>',
      ].join('\n')
    );
    zip.file(
      '3D/_rels/3dmodel.model.rels',
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        '  <Relationship Target="/3D/Objects/letter_A.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>',
        '  <Relationship Target="/3D/Objects/letter_E.model" Id="rel-2" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>',
        '</Relationships>',
      ].join('\n')
    );
    zip.file(
      '3D/3dmodel.model',
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">',
        '  <resources>',
        '    <object id="1" name="keycap-char-A" type="model">',
        '      <components>',
        '        <component p:path="/3D/Objects/letter_A.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>',
        '        <component p:path="/3D/Objects/letter_A.model" objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>',
        '      </components>',
        '    </object>',
        '    <object id="2" name="keycap-char-E" type="model">',
        '      <components>',
        '        <component p:path="/3D/Objects/letter_E.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>',
        '        <component p:path="/3D/Objects/letter_E.model" objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>',
        '      </components>',
        '    </object>',
        '  </resources>',
        '  <build>',
        '    <item objectid="1" transform="1 0 0 0 1 0 0 0 1 30 30 0" printable="1"/>',
        '    <item objectid="2" transform="1 0 0 0 1 0 0 0 1 55 30 0" printable="1"/>',
        '  </build>',
        '</model>',
      ].join('\n')
    );
    zip.file(
      'Metadata/model_settings.config',
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<config>',
        '  <object id="1">',
        '    <metadata key="name" value="keycap-char-A"/>',
        '    <metadata key="extruder" value="1"/>',
        '    <part id="1" subtype="normal_part"><metadata key="name" value="Body_A"/><metadata key="extruder" value="1"/></part>',
        '    <part id="2" subtype="normal_part"><metadata key="name" value="text_shape"/><metadata key="extruder" value="1"/></part>',
        '  </object>',
        '  <object id="2">',
        '    <metadata key="name" value="keycap-char-E"/>',
        '    <metadata key="extruder" value="1"/>',
        '    <part id="1" subtype="normal_part"><metadata key="name" value="Body_E"/><metadata key="extruder" value="1"/></part>',
        '    <part id="2" subtype="normal_part"><metadata key="name" value="text_shape"/><metadata key="extruder" value="1"/></part>',
        '  </object>',
        '</config>',
      ].join('\n')
    );

    const rawBytes = await zip.generateAsync({ type: 'uint8array' });
    const recoveredBuffer = rawBytes.buffer.slice(
      rawBytes.byteOffset,
      rawBytes.byteOffset + rawBytes.byteLength
    ) as ArrayBuffer;

    const recoveredRes = await exportSinglePlate3mf({
      plate: { plateNumber: 1, plateCode: 'PNT3C', capacity: 138, letters: { A: 2, E: 2 } },
      master3mfBuffer: recoveredBuffer,
    });
    expect(recoveredRes.audit.valid).toBe(true);
    expect(recoveredRes.audit.extrudersUsed).toEqual([1, 3]);
    expect(recoveredRes.audit.letterGeometryAudit.A.partExtruders).toEqual([1, 3]);
    expect(recoveredRes.audit.letterGeometryAudit.E.partExtruders).toEqual([1, 3]);

    // Verify pid/pindex stripped cleanly from keycap_E.model while paint_color="0C" kept on keycap_A.model
    const outZip = await JSZip.loadAsync(recoveredRes.threeMfBytes);
    const eModelXml = await outZip.file('3D/Objects/keycap_E.model')!.async('string');
    expect(eModelXml).not.toContain('pid=');
    expect(eModelXml).not.toContain('pindex=');

    // 2. Material collapse rejection test: two-part keycap with BOTH parts stuck on extruder="1" MUST fail export
    const collapsedMaster = await createSyntheticMaster3mfBuffer(['A', 'E']);
    const collapsedZip = await JSZip.loadAsync(collapsedMaster);
    const collapsedSettings = (await collapsedZip.file('Metadata/model_settings.config')!.async('string')).replace(
      /<metadata key="extruder" value="2"\/>/g,
      '<metadata key="extruder" value="1"/>'
    );
    collapsedZip.file('Metadata/model_settings.config', collapsedSettings);
    const collapsedBytes = await collapsedZip.generateAsync({ type: 'uint8array' });
    const collapsedBuf = collapsedBytes.buffer.slice(
      collapsedBytes.byteOffset,
      collapsedBytes.byteOffset + collapsedBytes.byteLength
    ) as ArrayBuffer;

    await expect(
      exportSinglePlate3mf({
        plate: { plateNumber: 1, plateCode: 'KQL22', capacity: 138, letters: { A: 2, E: 2 } },
        master3mfBuffer: collapsedBuf,
      })
    ).rejects.toThrow(/Two-colour material mapping validation failed/i);

    // 3. Post-export audit catches tampered exported archive with collapsed model_settings.config
    const tamperedZip = await JSZip.loadAsync(recoveredRes.threeMfBytes);
    const tamperedSettings = (await tamperedZip.file('Metadata/model_settings.config')!.async('string')).replace(
      /<metadata key="extruder" value="3"\/>/g,
      '<metadata key="extruder" value="1"/>'
    );
    tamperedZip.file('Metadata/model_settings.config', tamperedSettings);
    const tamperedA = (await tamperedZip.file('3D/Objects/keycap_A.model')!.async('string')).replace(
      / paint_color="0C"/g,
      ''
    );
    tamperedZip.file('3D/Objects/keycap_A.model', tamperedA);
    const tamperedAudit = await validateExported3mfArchive({
      threeMfBytes: await tamperedZip.generateAsync({ type: 'uint8array' }),
    });
    expect(tamperedAudit.valid).toBe(false);
    expect(tamperedAudit.errors.join(' ')).toContain('Two-colour material collapse detected');
  });
});
