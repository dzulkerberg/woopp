import React, { useMemo, useState } from 'react';
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Edit3,
  Plus,
  RotateCcw,
} from 'lucide-react';
import {
  CatalogProduct,
  CategoryIconName,
  ProductCategory,
} from '../../types';
import { validateHttpsImageUrl } from '../../utils/catalogValidation';
import { formatDateDDMMYYYY } from '../../utils/dateFormat';
import { CATEGORY_ICON_OPTIONS, CategoryIcon } from './CategoryIcon';

interface CategoryManagerTabProps {
  ownerId: string;
  categories: readonly ProductCategory[];
  products: readonly CatalogProduct[];
  onSaveCategory: (category: ProductCategory) => Promise<void>;
  onReorderCategories: (ordered: ProductCategory[]) => Promise<void>;
  onRequestArchiveCategory: (category: ProductCategory) => void;
  onRestoreCategory: (category: ProductCategory) => Promise<void>;
}

const SUGGESTED_CATEGORY_NAMES = [
  'Alphabet Keycaps',
  'Charm Keycaps',
  'Clicker Base',
  'Keychains',
  'Custom Gifts',
  'Seasonal Editions',
] as const;

export const CategoryManagerTab: React.FC<CategoryManagerTabProps> = ({
  ownerId,
  categories,
  products,
  onSaveCategory,
  onReorderCategories,
  onRequestArchiveCategory,
  onRestoreCategory,
}) => {
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'archived'>('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [imageUrl, setImageUrl] = useState<string>('');
  const [iconName, setIconName] = useState<CategoryIconName>('tag');
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [busyCategoryId, setBusyCategoryId] = useState<string | null>(null);

  const productCountByCategory = useMemo(() => {
    const counts = new Map<string, { active: number; total: number }>();
    for (const p of products) {
      const prev = counts.get(p.categoryId) || { active: 0, total: 0 };
      prev.total += 1;
      if (p.status === 'active') prev.active += 1;
      counts.set(p.categoryId, prev);
    }
    return counts;
  }, [products]);

  const filteredCategories = useMemo(() => {
    return categories.filter((c) => {
      if (statusFilter === 'active') return c.status === 'active';
      if (statusFilter === 'archived') return c.status === 'archived';
      return true;
    });
  }, [categories, statusFilter]);

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setDescription('');
    setImageUrl('');
    setIconName('tag');
    setFormError(null);
  };

  const handleStartEdit = (cat: ProductCategory) => {
    setEditingId(cat.id);
    setName(cat.name);
    setDescription(cat.description);
    setImageUrl(cat.imageUrl || '');
    setIconName(cat.iconName || 'tag');
    setFormError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving) return;
    setFormError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError('Category name is required.');
      return;
    }

    const duplicate = categories.find(
      (c) =>
        c.id !== editingId &&
        c.name.trim().toLowerCase() === trimmedName.toLowerCase()
    );
    if (duplicate) {
      setFormError(`A category named "${duplicate.name}" already exists.`);
      return;
    }

    const imgValidation = validateHttpsImageUrl(imageUrl);
    if (!imgValidation.valid) {
      setFormError(imgValidation.error || 'Enter a valid https:// category image URL.');
      return;
    }

    const nowIso = new Date().toISOString();
    const existing = editingId ? categories.find((c) => c.id === editingId) : null;

    const categoryPayload: ProductCategory = existing
      ? {
          ...existing,
          name: trimmedName,
          description: description.trim(),
          imageUrl: imgValidation.normalizedUrl,
          iconName,
          updatedAt: nowIso,
        }
      : {
          id: `cat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          ownerId,
          name: trimmedName,
          description: description.trim(),
          imageUrl: imgValidation.normalizedUrl,
          iconName,
          sortOrder: categories.length,
          status: 'active',
          createdAt: nowIso,
          updatedAt: nowIso,
        };

    setIsSaving(true);
    try {
      await onSaveCategory(categoryPayload);
      resetForm();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setFormError(msg);
    } finally {
      setIsSaving(false);
    }
  };

  const handleMove = async (catId: string, direction: -1 | 1) => {
    if (busyCategoryId) return;
    const ordered = [...categories];
    const index = ordered.findIndex((c) => c.id === catId);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= ordered.length) return;

    const [moved] = ordered.splice(index, 1);
    ordered.splice(targetIndex, 0, moved);

    setBusyCategoryId(catId);
    try {
      await onReorderCategories(ordered);
    } finally {
      setBusyCategoryId(null);
    }
  };

  const handleRestoreClick = async (cat: ProductCategory) => {
    if (busyCategoryId) return;
    setBusyCategoryId(cat.id);
    try {
      await onRestoreCategory(cat);
    } finally {
      setBusyCategoryId(null);
    }
  };

  const previewUrlCheck = validateHttpsImageUrl(imageUrl);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      {/* Left Column: Add / Edit Category Form */}
      <section className="lg:col-span-5 bg-surface border border-line rounded-xl p-6 space-y-5 h-fit">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-ink">
              {editingId ? 'Edit Category' : 'Create Category'}
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Products in the same category can share a print plate in Auto Plate Planner.
            </p>
          </div>
          {editingId && (
            <button
              type="button"
              onClick={resetForm}
              className="px-2.5 py-1 text-xs font-medium rounded-lg border border-line bg-elevated text-ink-secondary hover:text-ink transition-colors"
            >
              Cancel Edit
            </button>
          )}
        </div>

        {!editingId && (
          <div className="space-y-1.5">
            <div className="text-[11px] font-medium text-muted">
              Quick name suggestions:
            </div>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTED_CATEGORY_NAMES.filter(
                (sug) =>
                  !categories.some(
                    (c) => c.name.trim().toLowerCase() === sug.toLowerCase()
                  )
              ).map((sug) => (
                <button
                  key={sug}
                  type="button"
                  onClick={() => setName(sug)}
                  className="px-2.5 py-1 rounded-lg border border-line bg-elevated hover:bg-recessed text-xs text-ink-secondary hover:text-ink transition-colors"
                >
                  + {sug}
                </button>
              ))}
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="cat-name-input"
              className="block text-xs font-semibold text-ink-secondary mb-1"
            >
              Category Name *
            </label>
            <input
              id="cat-name-input"
              type="text"
              required
              maxLength={120}
              placeholder="e.g., Charm Keycaps"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-line bg-input text-sm text-ink focus:border-brand focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="cat-desc-input"
              className="block text-xs font-semibold text-ink-secondary mb-1"
            >
              Description (Optional)
            </label>
            <textarea
              id="cat-desc-input"
              rows={2}
              maxLength={1000}
              placeholder="Optional description of items in this category..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-line bg-input text-xs text-ink focus:border-brand focus:outline-none resize-y"
            />
          </div>

          <div>
            <span className="block text-xs font-semibold text-ink-secondary mb-1.5">
              Category Icon
            </span>
            <div className="grid grid-cols-5 gap-1.5">
              {CATEGORY_ICON_OPTIONS.map((opt) => {
                const selected = iconName === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setIconName(opt.id)}
                    title={opt.label}
                    className={`flex flex-col items-center justify-center gap-1 py-2 px-1.5 rounded-lg border text-[10px] font-medium transition-colors ${
                      selected
                        ? 'border-brand bg-brand-soft text-brand-text font-semibold'
                        : 'border-line bg-elevated text-ink-secondary hover:text-ink'
                    }`}
                  >
                    <CategoryIcon name={opt.id} className="w-4 h-4" />
                    <span className="truncate max-w-full">{opt.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label
              htmlFor="cat-img-input"
              className="block text-xs font-semibold text-ink-secondary mb-1"
            >
              Cover Image URL (Optional · HTTPS only)
            </label>
            <input
              id="cat-img-input"
              type="url"
              placeholder="https://example.com/category-cover.jpg"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-line bg-input text-xs text-ink font-mono-data focus:border-brand focus:outline-none"
            />
            {imageUrl.trim().length > 0 && !previewUrlCheck.valid && (
              <p className="text-[11px] text-error-text mt-1">
                {previewUrlCheck.error}
              </p>
            )}
            {previewUrlCheck.valid && previewUrlCheck.normalizedUrl && (
              <div className="mt-2 flex items-center gap-2.5 p-2 rounded-lg border border-line bg-recessed">
                <img
                  src={previewUrlCheck.normalizedUrl}
                  alt="Category cover preview"
                  className="w-10 h-10 rounded-md object-cover border border-line bg-surface shrink-0"
                  onError={(ev) => {
                    (ev.currentTarget as HTMLImageElement).style.visibility = 'hidden';
                  }}
                />
                <span className="text-[11px] text-muted truncate font-mono-data">
                  {previewUrlCheck.normalizedUrl}
                </span>
              </div>
            )}
          </div>

          {formError && (
            <div className="p-3 rounded-lg border border-error-border bg-error-soft text-xs text-error-text">
              {formError}
            </div>
          )}

          <button
            type="submit"
            disabled={isSaving}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-brand hover:bg-brand-hover disabled:opacity-50 text-white text-xs font-semibold transition-colors"
          >
            <Plus className="w-4 h-4" />
            <span>
              {isSaving
                ? 'Saving to Cloud...'
                : editingId
                ? 'Save Category Changes'
                : 'Create Category'}
            </span>
          </button>
        </form>
      </section>

      {/* Right Column: Category List, Reordering & Archive/Restore */}
      <section className="lg:col-span-7 bg-surface border border-line rounded-xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-ink">
              Product Categories ({categories.length})
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Renaming a category preserves its immutable ID so product links and plate rules never break.
            </p>
          </div>

          <div
            role="group"
            aria-label="Filter categories by status"
            className="inline-flex items-center gap-1 p-1 rounded-xl bg-recessed border border-line"
          >
            {(['all', 'active', 'archived'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setStatusFilter(tab)}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold capitalize transition-colors ${
                  statusFilter === tab
                    ? 'bg-brand text-white'
                    : 'text-ink-secondary hover:text-ink'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>

        {filteredCategories.length === 0 ? (
          <div className="p-8 rounded-xl border border-line bg-recessed text-center space-y-1.5">
            <div className="text-sm font-semibold text-ink">
              {categories.length === 0
                ? 'No categories created yet'
                : `No ${statusFilter} categories`}
            </div>
            <p className="text-xs text-muted max-w-md mx-auto">
              {categories.length === 0
                ? 'Create your first product category on the left (for example, "Charm Keycaps" or "Keychains") before adding catalog products.'
                : 'Switch the status filter above to view all categories.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-line border border-line rounded-xl overflow-hidden">
            {filteredCategories.map((cat) => {
              const counts = productCountByCategory.get(cat.id) || {
                active: 0,
                total: 0,
              };
              const fullIndex = categories.findIndex((c) => c.id === cat.id);
              const isBusy = busyCategoryId === cat.id;

              return (
                <div
                  key={cat.id}
                  className={`p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-surface hover:bg-elevated transition-colors ${
                    cat.status === 'archived' ? 'opacity-75' : ''
                  }`}
                >
                  <div className="flex items-start gap-3 min-w-0">
                    {cat.imageUrl ? (
                      <img
                        src={cat.imageUrl}
                        alt={cat.name}
                        className="w-11 h-11 rounded-lg object-cover border border-line bg-recessed shrink-0"
                      />
                    ) : (
                      <div className="w-11 h-11 rounded-lg border border-brand-border bg-brand-soft text-brand-text flex items-center justify-center shrink-0">
                        <CategoryIcon name={cat.iconName} className="w-5 h-5" />
                      </div>
                    )}

                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-ink">
                          {cat.name}
                        </span>
                        <span className="text-xs text-muted">
                          · {counts.active} active / {counts.total} total product(s)
                        </span>
                        {cat.status === 'archived' && (
                          <span className="text-[11px] font-semibold text-warning-text">
                            · Archived
                          </span>
                        )}
                      </div>
                      {cat.description && (
                        <p className="text-xs text-ink-secondary line-clamp-2">
                          {cat.description}
                        </p>
                      )}
                      <div className="text-[11px] font-mono-data text-muted">
                        ID: {cat.id} · Updated {formatDateDDMMYYYY(cat.updatedAt)}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      disabled={isBusy || fullIndex <= 0}
                      onClick={() => void handleMove(cat.id, -1)}
                      aria-label={`Move ${cat.name} up`}
                      title="Move up"
                      className="p-1.5 rounded-lg border border-line bg-surface hover:bg-recessed text-ink-secondary hover:text-ink disabled:opacity-35 transition-colors"
                    >
                      <ArrowUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={isBusy || fullIndex < 0 || fullIndex >= categories.length - 1}
                      onClick={() => void handleMove(cat.id, 1)}
                      aria-label={`Move ${cat.name} down`}
                      title="Move down"
                      className="p-1.5 rounded-lg border border-line bg-surface hover:bg-recessed text-ink-secondary hover:text-ink disabled:opacity-35 transition-colors"
                    >
                      <ArrowDown className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleStartEdit(cat)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-line bg-surface hover:bg-recessed text-xs font-medium text-ink transition-colors"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      <span>Edit</span>
                    </button>
                    {cat.status === 'active' ? (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => onRequestArchiveCategory(cat)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-warning-border bg-warning-soft text-xs font-medium text-warning-text transition-colors"
                      >
                        <Archive className="w-3.5 h-3.5" />
                        <span>Archive</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void handleRestoreClick(cat)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-brand-border bg-brand-soft text-xs font-semibold text-brand-text transition-colors"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>Restore</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
