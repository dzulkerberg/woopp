import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  Copy,
  ImagePlus,
  Plus,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import {
  CatalogProduct,
  ProductCategory,
  ProductOptionDefinition,
  ProductVariant,
} from '../../types';
import {
  MAX_OPTION_COMPLEXITY_BUDGET,
  MAX_PRODUCT_IMAGES,
  MAX_PRODUCT_OPTION_VALUES,
  MAX_PRODUCT_OPTIONS,
  syncVariantsFromOptions,
  validateHttpsImageUrl,
} from '../../utils/catalogValidation';
import { generateUniqueWooppSku } from '../../utils/skuGenerator';

interface ProductFormTabProps {
  ownerId: string;
  categories: readonly ProductCategory[];
  existingSkus: ReadonlySet<string>;
  editingProduct: CatalogProduct | null;
  onSaveNewProduct: (
    draft: Omit<CatalogProduct, 'sku'> & { sku?: string }
  ) => Promise<CatalogProduct>;
  onSaveEditedProduct: (
    existing: CatalogProduct,
    updatedDraft: CatalogProduct
  ) => Promise<CatalogProduct>;
  onCancelEdit: () => void;
  onOpenCategoriesTab: () => void;
  onSavedSuccess: (saved: CatalogProduct) => void;
}

const OPTION_PRESET_SUGGESTIONS = ['Alphabet', 'Color', 'Style', 'Size', 'Design'] as const;

export const ALPHABET_A_TO_Z = Array.from({ length: 26 }, (_, i) =>
  String.fromCharCode(65 + i)
);
export const NUMBERS_0_TO_9 = Array.from({ length: 10 }, (_, i) => String(i));
export const POPULAR_COLORS = [
  'White',
  'Black',
  'Red',
  'Blue',
  'Gold',
  'Silver',
  'Green',
  'Yellow',
  'Purple',
  'Orange',
];

export const ProductFormTab: React.FC<ProductFormTabProps> = ({
  ownerId,
  categories,
  existingSkus,
  editingProduct,
  onSaveNewProduct,
  onSaveEditedProduct,
  onCancelEdit,
  onOpenCategoriesTab,
  onSavedSuccess,
}) => {
  const activeCategories = useMemo(
    () => categories.filter((c) => c.status === 'active'),
    [categories]
  );

  //Selectable categories: active categories + current product's category if it was archived
  const selectableCategories = useMemo(() => {
    if (!editingProduct) return activeCategories;
    const currentCat = categories.find((c) => c.id === editingProduct.categoryId);
    if (currentCat && currentCat.status === 'archived') {
      return [currentCat, ...activeCategories];
    }
    return activeCategories;
  }, [activeCategories, categories, editingProduct]);

  const [draftSku, setDraftSku] = useState<string>(() =>
    editingProduct ? editingProduct.sku : generateUniqueWooppSku(existingSkus)
  );
  const [name, setName] = useState<string>(editingProduct?.name || '');
  const [description, setDescription] = useState<string>(
    editingProduct?.description || ''
  );
  const [categoryId, setCategoryId] = useState<string>(
    editingProduct?.categoryId || activeCategories[0]?.id || ''
  );
  const [priceInput, setPriceInput] = useState<string>(
    editingProduct && editingProduct.priceMyr !== null
      ? String(editingProduct.priceMyr)
      : ''
  );

  // Images state (index 0 = main image)
  const [images, setImages] = useState<string[]>(editingProduct?.images || []);
  const [newImageUrlInput, setNewImageUrlInput] = useState<string>('');
  const [imageError, setImageError] = useState<string | null>(null);

  // Variations state
  const [options, setOptions] = useState<ProductOptionDefinition[]>(
    editingProduct?.options || []
  );
  const [variants, setVariants] = useState<ProductVariant[]>(
    editingProduct?.variants || []
  );
  const [newOptionValueByOptId, setNewOptionValueByOptId] = useState<
    Record<string, string>
  >({});

  const [copiedSku, setCopiedSku] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState<boolean>(false);

  // Sync form state when switching between Add Mode and Edit Mode
  useEffect(() => {
    if (editingProduct) {
      setDraftSku(editingProduct.sku);
      setName(editingProduct.name);
      setDescription(editingProduct.description);
      setCategoryId(editingProduct.categoryId);
      setPriceInput(
        editingProduct.priceMyr !== null ? String(editingProduct.priceMyr) : ''
      );
      setImages([...editingProduct.images]);
      setOptions(editingProduct.options.map((o) => ({ ...o, values: [...o.values] })));
      setVariants(
        editingProduct.variants.map((v) => ({
          ...v,
          optionValues: { ...v.optionValues },
        }))
      );
    } else {
      setDraftSku(generateUniqueWooppSku(existingSkus));
      setName('');
      setDescription('');
      setCategoryId((prev) =>
        activeCategories.some((c) => c.id === prev)
          ? prev
          : activeCategories[0]?.id || ''
      );
      setPriceInput('');
      setImages([]);
      setOptions([]);
      setVariants([]);
    }
    setNewImageUrlInput('');
    setImageError(null);
    setFormError(null);
  }, [editingProduct]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ensure default category selection when first category is created
  useEffect(() => {
    if (!editingProduct && !categoryId && activeCategories[0]) {
      setCategoryId(activeCategories[0].id);
    }
  }, [activeCategories, categoryId, editingProduct]);

  const handleCopySku = () => {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(draftSku).then(() => {
        setCopiedSku(true);
        setTimeout(() => setCopiedSku(false), 1500);
      });
    }
  };

  // --- Product Image Handlers ---
  const handleAddImageUrl = () => {
    setImageError(null);
    if (images.length >= MAX_PRODUCT_IMAGES) {
      setImageError(`Maximum of ${MAX_PRODUCT_IMAGES} images reached.`);
      return;
    }
    const raw = newImageUrlInput.trim();
    if (!raw) {
      setImageError('Paste an https:// image URL before clicking Add Image.');
      return;
    }
    const check = validateHttpsImageUrl(raw);
    if (!check.valid || !check.normalizedUrl) {
      setImageError(check.error || 'Enter a valid external https:// image URL.');
      return;
    }
    if (images.includes(check.normalizedUrl)) {
      setImageError('This image URL is already added to the product.');
      return;
    }
    setImages((prev) => [...prev, check.normalizedUrl!]);
    setNewImageUrlInput('');
  };

  const handleMoveImage = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (index < 0 || target < 0 || target >= images.length) return;
    const next = [...images];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    setImages(next);
  };

  const handleSetMainImage = (index: number) => {
    if (index <= 0 || index >= images.length) return;
    const next = [...images];
    const [picked] = next.splice(index, 1);
    next.unshift(picked);
    setImages(next);
  };

  const handleRemoveImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  // --- Variations Handlers ---
  const recomputeVariants = (nextOptions: ProductOptionDefinition[]) => {
    const normalizedOpts = nextOptions.map((o, idx) => ({
      ...o,
      sortOrder: idx,
    }));
    setOptions(normalizedOpts);
    setVariants((prevVariants) => syncVariantsFromOptions(normalizedOpts, prevVariants));
  };

  const handleAddOption = (initialName = '') => {
    if (options.length >= MAX_PRODUCT_OPTIONS) return;
    const isAlphabet = initialName.toLowerCase() === 'alphabet';
    const nextOpt: ProductOptionDefinition = {
      id: `opt-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      name: initialName,
      values: isAlphabet ? [...ALPHABET_A_TO_Z] : [],
      sortOrder: options.length,
    };
    recomputeVariants([...options, nextOpt]);
  };

  const handleRenameOption = (optId: string, nextName: string) => {
    const nextOptions = options.map((o) =>
      o.id === optId ? { ...o, name: nextName } : o
    );
    recomputeVariants(nextOptions);
  };

  const handleMoveOption = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (index < 0 || target < 0 || target >= options.length) return;
    const next = [...options];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    recomputeVariants(next);
  };

  const handleRemoveOption = (optId: string) => {
    recomputeVariants(options.filter((o) => o.id !== optId));
  };

  const handleAddMultipleOptionValues = (optId: string, valuesToAdd: string[]) => {
    const targetOpt = options.find((o) => o.id === optId);
    if (!targetOpt) return;

    const existingLower = new Set(targetOpt.values.map((v) => v.toLowerCase()));
    const validNew: string[] = [];

    for (const raw of valuesToAdd) {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.length > 80) continue;
      if (!existingLower.has(trimmed.toLowerCase())) {
        existingLower.add(trimmed.toLowerCase());
        validNew.push(trimmed);
      }
    }

    if (validNew.length === 0) return;

    if (targetOpt.values.length + validNew.length > MAX_PRODUCT_OPTION_VALUES) {
      setFormError(`Each option supports at most ${MAX_PRODUCT_OPTION_VALUES} values.`);
      return;
    }

    const currentTotalValues = options.reduce((sum, o) => sum + o.values.length, 0);
    if (options.length + currentTotalValues + validNew.length > MAX_OPTION_COMPLEXITY_BUDGET) {
      setFormError(
        `Maximum variation option complexity reached across configured option groups (up to ${MAX_PRODUCT_OPTION_VALUES} values per option).`
      );
      return;
    }

    setFormError(null);
    const nextOptions = options.map((opt) =>
      opt.id === optId
        ? {
            ...opt,
            values: [...opt.values, ...validNew],
          }
        : opt
    );

    setNewOptionValueByOptId((prev) => ({ ...prev, [optId]: '' }));
    recomputeVariants(nextOptions);
  };

  const handleAddOptionValue = (optId: string) => {
    const rawVal = (newOptionValueByOptId[optId] || '').trim();
    if (!rawVal) return;
    if (rawVal.includes(',')) {
      const parts = rawVal
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      handleAddMultipleOptionValues(optId, parts);
      return;
    }
    handleAddMultipleOptionValues(optId, [rawVal]);
  };

  const handleRemoveOptionValue = (optId: string, valToRemove: string) => {
    const nextOptions = options.map((opt) =>
      opt.id === optId
        ? { ...opt, values: opt.values.filter((v) => v !== valToRemove) }
        : opt
    );
    recomputeVariants(nextOptions);
  };

  const handleUpdateVariantPrice = (variantId: string, rawPrice: string) => {
    setVariants((prev) =>
      prev.map((v) => {
        if (v.id !== variantId) return v;
        if (rawPrice.trim() === '') {
          return { ...v, priceMyr: null };
        }
        const parsed = Number(rawPrice);
        return {
          ...v,
          priceMyr:
            Number.isFinite(parsed) && parsed >= 0
              ? Math.round(parsed * 100) / 100
              : v.priceMyr,
        };
      })
    );
  };

  const handleUpdateVariantImage = (variantId: string, rawUrl: string) => {
    setVariants((prev) =>
      prev.map((v) =>
        v.id === variantId
          ? { ...v, imageUrl: rawUrl.trim().length > 0 ? rawUrl : null }
          : v
      )
    );
  };

  // --- Submit Handler ---
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving) return;
    setFormError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError('Product Name is required.');
      return;
    }

    if (!categoryId) {
      setFormError('Select a product category before saving.');
      return;
    }

    let parsedPriceMyr: number | null = null;
    if (priceInput.trim() !== '') {
      const num = Number(priceInput);
      if (!Number.isFinite(num) || num < 0) {
        setFormError('Selling Price (MYR) must be a valid non-negative amount.');
        return;
      }
      parsedPriceMyr = Math.round(num * 100) / 100;
    }

    // Validate any pending unadded image URL so users don't lose typed URLs or submit invalid links
    let finalImages = [...images];
    if (newImageUrlInput.trim().length > 0) {
      const pendingCheck = validateHttpsImageUrl(newImageUrlInput);
      if (!pendingCheck.valid || !pendingCheck.normalizedUrl) {
        setFormError(
          pendingCheck.error || 'Fix or clear the pending Product Image URL before saving.'
        );
        return;
      }
      if (!finalImages.includes(pendingCheck.normalizedUrl)) {
        finalImages = [...finalImages, pendingCheck.normalizedUrl];
      }
    }

    // Validate options if any were added
    for (const opt of options) {
      if (!opt.name.trim()) {
        setFormError('Every variation option must have an option name (or remove empty options).');
        return;
      }
      if (opt.values.length === 0) {
        setFormError(
          `Option "${opt.name.trim()}" must include at least one option value.`
        );
        return;
      }
    }

    // Validate variant HTTPS image URLs if entered
    const normalizedVariants: ProductVariant[] = [];
    for (let i = 0; i < variants.length; i += 1) {
      const v = variants[i];
      const vImg = validateHttpsImageUrl(v.imageUrl);
      if (!vImg.valid) {
        setFormError(`Variant "${v.label}": ${vImg.error}`);
        return;
      }
      normalizedVariants.push({
        ...v,
        imageUrl: vImg.normalizedUrl,
        sortOrder: i,
      });
    }

    const nowIso = new Date().toISOString();

    setIsSaving(true);
    try {
      if (editingProduct) {
        const saved = await onSaveEditedProduct(editingProduct, {
          id: editingProduct.id,
          ownerId,
          sku: editingProduct.sku, // Preserved verbatim on edit and category change
          name: trimmedName,
          description: description.trim(),
          categoryId,
          priceMyr: parsedPriceMyr,
          images: finalImages,
          options: options.map((o, idx) => ({
            id: o.id,
            name: o.name.trim(),
            values: o.values,
            sortOrder: idx,
          })),
          variants: normalizedVariants,
          status: editingProduct.status,
          createdAt: editingProduct.createdAt,
          updatedAt: nowIso,
        });
        onSavedSuccess(saved);
      } else {
        const saved = await onSaveNewProduct({
          id: `prod-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          ownerId,
          sku: draftSku,
          name: trimmedName,
          description: description.trim(),
          categoryId,
          priceMyr: parsedPriceMyr,
          images: finalImages,
          options: options.map((o, idx) => ({
            id: o.id,
            name: o.name.trim(),
            values: o.values,
            sortOrder: idx,
          })),
          variants: normalizedVariants,
          status: 'active',
          createdAt: nowIso,
          updatedAt: nowIso,
        });
        onSavedSuccess(saved);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setFormError(msg);
    } finally {
      setIsSaving(false);
    }
  };

  if (selectableCategories.length === 0) {
    return (
      <div className="bg-surface border border-line rounded-xl p-8 text-center space-y-3">
        <div className="text-base font-semibold text-ink">
          Create an Active Category First
        </div>
        <p className="text-xs text-muted max-w-md mx-auto">
          Every catalog product belongs to a category (for example, &ldquo;Charm Keycaps&rdquo; or &ldquo;Keychains&rdquo;), which also determines plate sharing in Auto Plate Planner.
        </p>
        <button
          type="button"
          onClick={onOpenCategoriesTab}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-brand hover:bg-brand-hover text-white text-xs font-semibold transition-colors"
        >
          <Plus className="w-4 h-4" />
          <span>Open Categories</span>
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-4xl">
      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink">
            {editingProduct ? `Edit Product · ${editingProduct.name}` : 'Add New Product'}
          </h2>
          <p className="text-xs text-muted mt-0.5">
            Saved products in active categories appear automatically inside Auto Plate Planner.
          </p>
        </div>

        {editingProduct && (
          <button
            type="button"
            onClick={onCancelEdit}
            className="px-3 py-1.5 rounded-lg border border-line bg-surface hover:bg-elevated text-xs font-medium text-ink transition-colors"
          >
            Cancel Editing
          </button>
        )}
      </div>

      {/* Section 1: Basic Info */}
      <section className="bg-surface border border-line rounded-xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-line">
          <h3 className="text-sm font-semibold text-ink">Basic Information</h3>

          {/* Read-Only Auto-Generated SKU Display */}
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium text-muted">Auto SKU:</span>
            <span
              aria-label="Auto-generated read-only SKU"
              className="px-2.5 py-1 rounded-lg bg-recessed border border-line text-xs font-mono-data font-semibold text-ink select-all"
            >
              {draftSku}
            </span>
            <button
              type="button"
              onClick={handleCopySku}
              title="Copy read-only SKU"
              className="p-1.5 rounded-lg border border-line bg-elevated hover:bg-recessed text-muted hover:text-ink transition-colors"
            >
              {copiedSku ? (
                <Check className="w-3.5 h-3.5 text-brand-text" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
          <div className="md:col-span-6">
            <label
              htmlFor="product-name-input"
              className="block text-xs font-semibold text-ink-secondary mb-1"
            >
              Product Name *
            </label>
            <input
              id="product-name-input"
              type="text"
              required
              maxLength={160}
              placeholder="e.g., Charm Moon"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-line bg-input text-sm text-ink focus:border-brand focus:outline-none"
            />
          </div>

          <div className="md:col-span-4">
            <label
              htmlFor="product-category-select"
              className="block text-xs font-semibold text-ink-secondary mb-1"
            >
              Category *
            </label>
            <select
              id="product-category-select"
              required
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-line bg-input text-sm text-ink focus:border-brand focus:outline-none"
            >
              {selectableCategories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                  {cat.status === 'archived' ? ' (Archived)' : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-2">
            <label
              htmlFor="product-price-input"
              className="block text-xs font-semibold text-ink-secondary mb-1"
            >
              Price (MYR)
            </label>
            <input
              id="product-price-input"
              type="number"
              min={0}
              step="0.01"
              placeholder="0.00"
              value={priceInput}
              onChange={(e) => setPriceInput(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-line bg-input text-sm font-mono-data text-ink focus:border-brand focus:outline-none"
            />
          </div>
        </div>

        <div>
          <label
            htmlFor="product-description-input"
            className="block text-xs font-semibold text-ink-secondary mb-1"
          >
            Product Description (Optional)
          </label>
          <textarea
            id="product-description-input"
            rows={3}
            maxLength={4000}
            placeholder="Describe design details, finish, or retail notes..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-line bg-input text-xs text-ink focus:border-brand focus:outline-none resize-y"
          />
        </div>
      </section>

      {/* Section 2: Product Images (HTTPS URLs Only) */}
      <section className="bg-surface border border-line rounded-xl p-6 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-ink">Product Images</h3>
          <p className="text-xs text-muted mt-0.5">
            Add external <span className="font-mono-data">https://</span> image URLs. The first image is used as the main catalog thumbnail.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="url"
            aria-label="Product HTTPS image URL"
            placeholder="https://example.com/product-photo.jpg"
            value={newImageUrlInput}
            onChange={(e) => {
              setNewImageUrlInput(e.target.value);
              if (imageError) setImageError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAddImageUrl();
              }
            }}
            className="flex-1 px-3 py-2 rounded-lg border border-line bg-input text-xs font-mono-data text-ink focus:border-brand focus:outline-none"
          />
          <button
            type="button"
            onClick={handleAddImageUrl}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg border border-line bg-elevated hover:bg-recessed text-xs font-semibold text-ink whitespace-nowrap transition-colors"
          >
            <ImagePlus className="w-4 h-4 text-brand-text" />
            <span>Add Image URL</span>
          </button>
        </div>

        {imageError && (
          <p className="text-xs text-error-text">{imageError}</p>
        )}

        {images.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {images.map((imgUrl, idx) => (
              <div
                key={`${imgUrl}-${idx}`}
                className={`rounded-xl border p-2.5 space-y-2 bg-elevated ${
                  idx === 0 ? 'border-brand' : 'border-line'
                }`}
              >
                <div className="aspect-square rounded-lg border border-line bg-recessed overflow-hidden relative">
                  <img
                    src={imgUrl}
                    alt={`Product preview ${idx + 1}`}
                    className="w-full h-full object-cover"
                  />
                  {idx === 0 && (
                    <span className="absolute top-1.5 left-1.5 px-2 py-0.5 rounded bg-brand text-white text-[10px] font-semibold">
                      Main
                    </span>
                  )}
                </div>

                <div className="flex items-center justify-between gap-1">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={idx === 0}
                      onClick={() => handleMoveImage(idx, -1)}
                      aria-label={`Move image ${idx + 1} left`}
                      className="p-1 rounded border border-line bg-surface hover:bg-recessed text-ink-secondary disabled:opacity-35"
                    >
                      <ArrowLeft className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={idx === images.length - 1}
                      onClick={() => handleMoveImage(idx, 1)}
                      aria-label={`Move image ${idx + 1} right`}
                      className="p-1 rounded border border-line bg-surface hover:bg-recessed text-ink-secondary disabled:opacity-35"
                    >
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                    {idx > 0 && (
                      <button
                        type="button"
                        onClick={() => handleSetMainImage(idx)}
                        title="Set as main image"
                        className="p-1 rounded border border-line bg-surface hover:bg-recessed text-brand-text"
                      >
                        <Star className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => handleRemoveImage(idx)}
                    aria-label={`Remove image ${idx + 1}`}
                    className="p-1 rounded border border-error-border bg-error-soft text-error-text"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Section 3: Optional Product Variations */}
      <section className="bg-surface border border-line rounded-xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-ink">
              Product Variations (Optional)
            </h3>
            <p className="text-xs text-muted mt-0.5">
              Configure custom options such as Color, Style, Size, or Design with optional per-variant pricing and image URLs.
            </p>
          </div>

          <button
            type="button"
            disabled={options.length >= MAX_PRODUCT_OPTIONS}
            onClick={() => handleAddOption('')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line bg-elevated hover:bg-recessed text-xs font-semibold text-ink disabled:opacity-40 transition-colors"
          >
            <Plus className="w-3.5 h-3.5 text-brand-text" />
            <span>Add Option</span>
          </button>
        </div>

        {options.length === 0 ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>Quick add option:</span>
            {OPTION_PRESET_SUGGESTIONS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => handleAddOption(preset)}
                className="px-2.5 py-1 rounded-lg border border-line bg-elevated hover:bg-recessed text-ink-secondary hover:text-ink transition-colors"
              >
                + {preset}
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {options.map((opt, idx) => (
              <div
                key={opt.id}
                className="p-4 rounded-xl border border-line bg-recessed space-y-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex-1 min-w-[200px]">
                    <label className="block text-[11px] font-semibold text-muted mb-1">
                      Option Name #{idx + 1}
                    </label>
                    <input
                      type="text"
                      maxLength={60}
                      placeholder="e.g., Design, Size, Style..."
                      value={opt.name}
                      onChange={(e) => handleRenameOption(opt.id, e.target.value)}
                      className="w-full px-3 py-1.5 rounded-lg border border-line bg-input text-xs font-semibold text-ink focus:border-brand focus:outline-none"
                    />
                  </div>

                  <div className="flex items-center gap-1 pt-4">
                    <button
                      type="button"
                      disabled={idx === 0}
                      onClick={() => handleMoveOption(idx, -1)}
                      aria-label={`Move option ${opt.name || idx + 1} up`}
                      className="p-1.5 rounded-lg border border-line bg-surface hover:bg-elevated text-ink-secondary disabled:opacity-35"
                    >
                      <ArrowUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={idx === options.length - 1}
                      onClick={() => handleMoveOption(idx, 1)}
                      aria-label={`Move option ${opt.name || idx + 1} down`}
                      className="p-1.5 rounded-lg border border-line bg-surface hover:bg-elevated text-ink-secondary disabled:opacity-35"
                    >
                      <ArrowDown className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemoveOption(opt.id)}
                      aria-label={`Remove option ${opt.name || idx + 1}`}
                      className="p-1.5 rounded-lg border border-error-border bg-error-soft text-error-text"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Option Values */}
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-1.5">
                    {opt.values.map((val) => (
                      <span
                        key={val}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface border border-line text-xs text-ink"
                      >
                        <span>{val}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveOptionValue(opt.id, val)}
                          aria-label={`Remove value ${val}`}
                          className="text-muted hover:text-error-text"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>

                  {/* Quick Preset Value Buttons */}
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted pt-0.5">
                    <span className="font-medium text-ink-secondary">Quick populate:</span>
                    <button
                      type="button"
                      onClick={() => handleAddMultipleOptionValues(opt.id, ALPHABET_A_TO_Z)}
                      className="px-2 py-0.5 rounded border border-line bg-surface hover:bg-elevated text-ink hover:text-brand font-medium transition-colors"
                    >
                      + A–Z (26 Letters)
                    </button>
                    <button
                      type="button"
                      onClick={() => handleAddMultipleOptionValues(opt.id, POPULAR_COLORS)}
                      className="px-2 py-0.5 rounded border border-line bg-surface hover:bg-elevated text-ink hover:text-brand font-medium transition-colors"
                    >
                      + Multi-Colors (10)
                    </button>
                    <button
                      type="button"
                      onClick={() => handleAddMultipleOptionValues(opt.id, NUMBERS_0_TO_9)}
                      className="px-2 py-0.5 rounded border border-line bg-surface hover:bg-elevated text-ink hover:text-brand font-medium transition-colors"
                    >
                      + 0–9 Numbers
                    </button>
                  </div>

                  <div className="flex gap-2">
                    <input
                      type="text"
                      maxLength={80}
                      placeholder="Add option value or paste comma-separated values (e.g., A, B, C or Red, Blue)..."
                      value={newOptionValueByOptId[opt.id] || ''}
                      onChange={(e) =>
                        setNewOptionValueByOptId((prev) => ({
                          ...prev,
                          [opt.id]: e.target.value,
                        }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddOptionValue(opt.id);
                        }
                      }}
                      className="flex-1 px-3 py-1.5 rounded-lg border border-line bg-input text-xs text-ink focus:border-brand focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => handleAddOptionValue(opt.id)}
                      className="px-3 py-1.5 rounded-lg border border-line bg-surface hover:bg-elevated text-xs font-semibold text-ink whitespace-nowrap transition-colors"
                    >
                      + Add Value
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Variant Override Matrix */}
        {variants.length > 0 && (
          <div className="space-y-2 pt-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-semibold text-ink">
              <span>Variant Pricing &amp; Image Overrides ({variants.length})</span>
              {variants.length >= MAX_PRODUCT_VARIANTS && (
                <span className="text-[11px] font-normal text-amber-500">
                  Combinations capped at {MAX_PRODUCT_VARIANTS} to prevent excessive explosion.
                </span>
              )}
            </div>
            <div className="border border-line rounded-xl overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-recessed border-b border-line text-muted">
                    <th className="py-2.5 px-3 font-medium">Variant</th>
                    <th className="py-2.5 px-3 font-medium w-36">
                      Price (MYR · Optional)
                    </th>
                    <th className="py-2.5 px-3 font-medium">
                      Variant Image URL (HTTPS · Optional)
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {variants.map((v) => (
                    <tr key={v.id} className="bg-surface">
                      <td className="py-2 px-3 font-semibold text-ink">
                        {v.label}
                      </td>
                      <td className="py-2 px-3">
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          placeholder={priceInput || '0.00'}
                          value={v.priceMyr !== null ? String(v.priceMyr) : ''}
                          onChange={(e) =>
                            handleUpdateVariantPrice(v.id, e.target.value)
                          }
                          className="w-full px-2.5 py-1.5 rounded-lg border border-line bg-input text-xs font-mono-data text-ink focus:border-brand focus:outline-none"
                        />
                      </td>
                      <td className="py-2 px-3">
                        <input
                          type="url"
                          placeholder="https://example.com/variant.jpg"
                          value={v.imageUrl || ''}
                          onChange={(e) =>
                            handleUpdateVariantImage(v.id, e.target.value)
                          }
                          className="w-full px-2.5 py-1.5 rounded-lg border border-line bg-input text-xs font-mono-data text-ink focus:border-brand focus:outline-none"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {formError && (
        <div className="p-4 rounded-xl border border-error-border bg-error-soft text-xs font-medium text-error-text">
          {formError}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-3">
        {editingProduct && (
          <button
            type="button"
            onClick={onCancelEdit}
            className="px-4 py-2.5 rounded-lg border border-line bg-surface hover:bg-elevated text-xs font-medium text-ink transition-colors"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={isSaving}
          className="px-5 py-2.5 rounded-lg bg-brand hover:bg-brand-hover disabled:opacity-50 text-white text-xs font-semibold transition-colors"
        >
          {isSaving
            ? 'Saving to Cloud Firestore...'
            : editingProduct
            ? 'Save Product Changes'
            : 'Save Product to Catalog'}
        </button>
      </div>
    </form>
  );
};
