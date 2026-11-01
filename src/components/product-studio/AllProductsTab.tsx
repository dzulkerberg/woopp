import React, { useMemo, useState } from 'react';
import {
  Archive,
  Edit3,
  Eye,
  Files,
  LayoutGrid,
  List,
  Plus,
  Printer,
  RotateCcw,
  Search,
} from 'lucide-react';
import { CatalogProduct, ProductCategory } from '../../types';
import { formatDateDDMMYYYY } from '../../utils/dateFormat';
import { CategoryIcon } from './CategoryIcon';
import { formatMyrPrice } from './ProductDetailModal';

interface AllProductsTabProps {
  categories: readonly ProductCategory[];
  products: readonly CatalogProduct[];
  busyProductIds: ReadonlySet<string>;
  onOpenAddProduct: () => void;
  onOpenCategoriesTab: () => void;
  onViewProduct: (product: CatalogProduct) => void;
  onEditProduct: (product: CatalogProduct) => void;
  onDuplicateProduct: (product: CatalogProduct) => void;
  onRequestArchiveProduct: (product: CatalogProduct) => void;
  onRestoreProduct: (product: CatalogProduct) => void;
  onSendToPlanner: (product: CatalogProduct) => void;
}

type ProductSortOption =
  | 'updated_desc'
  | 'name_asc'
  | 'price_asc'
  | 'price_desc';

export const AllProductsTab: React.FC<AllProductsTabProps> = ({
  categories,
  products,
  busyProductIds,
  onOpenAddProduct,
  onOpenCategoriesTab,
  onViewProduct,
  onEditProduct,
  onDuplicateProduct,
  onRequestArchiveProduct,
  onRestoreProduct,
  onSendToPlanner,
}) => {
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'archived'>('active');
  const [sortBy, setSortBy] = useState<ProductSortOption>('updated_desc');
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');

  const categoryById = useMemo(
    () => new Map(categories.map((c) => [c.id, c])),
    [categories]
  );

  const filteredProducts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();

    const list = products.filter((p) => {
      if (statusFilter === 'active' && p.status !== 'active') return false;
      if (statusFilter === 'archived' && p.status !== 'archived') return false;
      if (categoryFilter !== 'ALL' && p.categoryId !== categoryFilter) {
        return false;
      }
      if (!q) return true;
      const catName = categoryById.get(p.categoryId)?.name.toLowerCase() || '';
      const variantMatch = p.variants.some((v) =>
        v.label.toLowerCase().includes(q)
      );
      return (
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        catName.includes(q) ||
        variantMatch
      );
    });

    return list.sort((a, b) => {
      if (sortBy === 'name_asc') {
        return a.name.localeCompare(b.name);
      }
      if (sortBy === 'price_asc') {
        const pa = a.priceMyr ?? Number.POSITIVE_INFINITY;
        const pb = b.priceMyr ?? Number.POSITIVE_INFINITY;
        return pa - pb || a.name.localeCompare(b.name);
      }
      if (sortBy === 'price_desc') {
        const pa = a.priceMyr ?? Number.NEGATIVE_INFINITY;
        const pb = b.priceMyr ?? Number.NEGATIVE_INFINITY;
        return pb - pa || a.name.localeCompare(b.name);
      }
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }, [products, statusFilter, categoryFilter, searchQuery, sortBy, categoryById]);

  const activeCount = useMemo(
    () => products.filter((p) => p.status === 'active').length,
    [products]
  );
  const archivedCount = products.length - activeCount;

  return (
    <div className="space-y-5">
      {/* Top Filter & Actions Toolbar */}
      <section className="bg-surface border border-line rounded-xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div
              role="group"
              aria-label="Catalog status filter"
              className="inline-flex items-center gap-1 p-1 rounded-xl bg-recessed border border-line"
            >
              {(
                [
                  { id: 'active', label: `Active (${activeCount})` },
                  { id: 'archived', label: `Archived (${archivedCount})` },
                  { id: 'all', label: `All (${products.length})` },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setStatusFilter(tab.id)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                    statusFilter === tab.id
                      ? 'bg-brand text-white'
                      : 'text-ink-secondary hover:text-ink'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div
              role="group"
              aria-label="Catalog layout view"
              className="inline-flex items-center gap-1 p-1 rounded-lg bg-recessed border border-line"
            >
              <button
                type="button"
                onClick={() => setViewMode('grid')}
                aria-label="Grid view"
                className={`p-1.5 rounded-md transition-colors ${
                  viewMode === 'grid'
                    ? 'bg-surface text-ink shadow-xs'
                    : 'text-muted hover:text-ink'
                }`}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setViewMode('table')}
                aria-label="Table view"
                className={`p-1.5 rounded-md transition-colors ${
                  viewMode === 'table'
                    ? 'bg-surface text-ink shadow-xs'
                    : 'text-muted hover:text-ink'
                }`}
              >
                <List className="w-3.5 h-3.5" />
              </button>
            </div>

            <button
              type="button"
              onClick={onOpenAddProduct}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-brand hover:bg-brand-hover text-white text-xs font-semibold whitespace-nowrap transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span>Add Product</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
          <div className="sm:col-span-5 relative">
            <Search className="w-4 h-4 text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              placeholder="Search name, WOOPP SKU, variant, or category..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-line bg-input text-xs text-ink focus:border-brand focus:outline-none"
            />
          </div>

          <div className="sm:col-span-4">
            <select
              aria-label="Filter by category"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-line bg-input text-xs text-ink focus:border-brand focus:outline-none"
            >
              <option value="ALL">All Categories</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.status === 'archived' ? ' (Archived)' : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="sm:col-span-3">
            <select
              aria-label="Sort products"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as ProductSortOption)}
              className="w-full px-3 py-2 rounded-lg border border-line bg-input text-xs text-ink focus:border-brand focus:outline-none"
            >
              <option value="updated_desc">Updated: Newest First</option>
              <option value="name_asc">Name: A → Z</option>
              <option value="price_asc">Price: Low → High</option>
              <option value="price_desc">Price: High → Low</option>
            </select>
          </div>
        </div>
      </section>

      {/* Empty States (Strictly Firestore-driven: zero fabricated products) */}
      {products.length === 0 ? (
        <section className="bg-surface border border-line rounded-xl p-10 text-center space-y-3">
          <div className="text-base font-semibold text-ink">
            Your Product Studio Catalog Is Empty
          </div>
          <p className="text-xs text-muted max-w-md mx-auto">
            Create custom categories (such as &ldquo;Charm Keycaps&rdquo; or &ldquo;Keychains&rdquo;) and add your products here. Saved products appear automatically in Auto Plate Planner.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
            {categories.filter((c) => c.status === 'active').length === 0 ? (
              <button
                type="button"
                onClick={onOpenCategoriesTab}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-brand hover:bg-brand-hover text-white text-xs font-semibold transition-colors"
              >
                <Plus className="w-4 h-4" />
                <span>Create First Category</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={onOpenAddProduct}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-brand hover:bg-brand-hover text-white text-xs font-semibold transition-colors"
              >
                <Plus className="w-4 h-4" />
                <span>Add First Product</span>
              </button>
            )}
          </div>
        </section>
      ) : filteredProducts.length === 0 ? (
        <section className="bg-surface border border-line rounded-xl p-8 text-center space-y-1.5">
          <div className="text-sm font-semibold text-ink">
            No catalog products match your current filters
          </div>
          <p className="text-xs text-muted">
            Clear your search query or switch category and status filters above.
          </p>
        </section>
      ) : viewMode === 'grid' ? (
        /* Grid View */
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filteredProducts.map((product) => {
            const category = categoryById.get(product.categoryId) || null;
            const thumb = product.images[0] || null;
            const isBusy = busyProductIds.has(product.id);
            const canPlan =
              product.status === 'active' && category?.status === 'active';

            return (
              <article
                key={product.id}
                className={`bg-surface border border-line rounded-xl overflow-hidden flex flex-col justify-between transition-colors hover:border-brand/50 ${
                  product.status === 'archived' ? 'opacity-75' : ''
                }`}
              >
                <div>
                  <button
                    type="button"
                    onClick={() => onViewProduct(product)}
                    className="w-full aspect-[4/3] bg-recessed border-b border-line flex items-center justify-center overflow-hidden relative text-left"
                  >
                    {thumb ? (
                      <img
                        src={thumb}
                        alt={product.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="text-muted flex flex-col items-center gap-1">
                        <CategoryIcon
                          name={category?.iconName || 'box'}
                          className="w-7 h-7 opacity-60"
                        />
                        <span className="text-[11px]">No image</span>
                      </div>
                    )}
                    {product.status === 'archived' && (
                      <span className="absolute top-2 right-2 px-2 py-0.5 rounded bg-surface/95 border border-warning-border text-[10px] font-semibold text-warning-text">
                        Archived
                      </span>
                    )}
                  </button>

                  <div className="p-4 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => onViewProduct(product)}
                        className="text-sm font-semibold text-ink hover:text-brand-text text-left line-clamp-1"
                      >
                        {product.name}
                      </button>
                      <span className="text-xs font-bold font-mono-data text-ink shrink-0">
                        {formatMyrPrice(product.priceMyr)}
                      </span>
                    </div>

                    <div className="text-[11px] font-mono-data text-muted">
                      {product.sku}
                    </div>

                    <div className="text-xs text-ink-secondary flex flex-wrap items-center gap-1">
                      <span>{category?.name || 'Uncategorized'}</span>
                      {category?.status === 'archived' && (
                        <span className="text-warning-text">(Archived Cat.)</span>
                      )}
                      <span>·</span>
                      <span>
                        {product.variants.length > 0
                          ? `${product.variants.length} variant(s)`
                          : 'Single item'}
                      </span>
                    </div>

                    <div className="text-[11px] font-mono-data text-muted">
                      Updated {formatDateDDMMYYYY(product.updatedAt)}
                    </div>
                  </div>
                </div>

                <div className="px-4 pb-4 pt-2 border-t border-line/60 space-y-2">
                  <button
                    type="button"
                    disabled={!canPlan || isBusy}
                    onClick={() => onSendToPlanner(product)}
                    className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-brand hover:bg-brand-hover disabled:opacity-40 text-white text-xs font-semibold transition-colors"
                  >
                    <Printer className="w-3.5 h-3.5" />
                    <span>Send to Print Planner</span>
                  </button>

                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => onViewProduct(product)}
                        title="View details"
                        className="p-1.5 rounded-lg border border-line bg-elevated hover:bg-recessed text-ink-secondary hover:text-ink transition-colors"
                      >
                        <Eye className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => onEditProduct(product)}
                        title="Edit product"
                        className="p-1.5 rounded-lg border border-line bg-elevated hover:bg-recessed text-ink-secondary hover:text-ink transition-colors"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => onDuplicateProduct(product)}
                        title="Duplicate product with new SKU"
                        className="p-1.5 rounded-lg border border-line bg-elevated hover:bg-recessed text-ink-secondary hover:text-ink transition-colors"
                      >
                        <Files className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {product.status === 'active' ? (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => onRequestArchiveProduct(product)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-warning-border bg-warning-soft text-[11px] font-medium text-warning-text transition-colors"
                      >
                        <Archive className="w-3 h-3" />
                        <span>Archive</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => onRestoreProduct(product)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-brand-border bg-brand-soft text-[11px] font-semibold text-brand-text transition-colors"
                      >
                        <RotateCcw className="w-3 h-3" />
                        <span>Restore</span>
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        /* Table View */
        <div className="bg-surface border border-line rounded-xl overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-recessed border-b border-line text-muted">
                <th className="py-3 px-4 font-medium">Product</th>
                <th className="py-3 px-3 font-medium">SKU</th>
                <th className="py-3 px-3 font-medium">Category</th>
                <th className="py-3 px-3 font-medium text-right">Price (MYR)</th>
                <th className="py-3 px-3 font-medium">Variations</th>
                <th className="py-3 px-3 font-medium">Status</th>
                <th className="py-3 px-3 font-medium">Updated</th>
                <th className="py-3 px-4 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filteredProducts.map((product) => {
                const category = categoryById.get(product.categoryId) || null;
                const thumb = product.images[0] || null;
                const isBusy = busyProductIds.has(product.id);
                const canPlan =
                  product.status === 'active' && category?.status === 'active';

                return (
                  <tr
                    key={product.id}
                    className={`hover:bg-elevated transition-colors ${
                      product.status === 'archived' ? 'opacity-75' : ''
                    }`}
                  >
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-3">
                        {thumb ? (
                          <img
                            src={thumb}
                            alt={product.name}
                            className="w-9 h-9 rounded-lg object-cover border border-line bg-recessed shrink-0"
                          />
                        ) : (
                          <div className="w-9 h-9 rounded-lg border border-line bg-recessed flex items-center justify-center text-muted shrink-0">
                            <CategoryIcon
                              name={category?.iconName || 'box'}
                              className="w-4 h-4"
                            />
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => onViewProduct(product)}
                          className="font-semibold text-ink hover:text-brand-text text-left"
                        >
                          {product.name}
                        </button>
                      </div>
                    </td>
                    <td className="py-3 px-3 font-mono-data text-ink-secondary whitespace-nowrap">
                      {product.sku}
                    </td>
                    <td className="py-3 px-3 text-ink-secondary">
                      {category?.name || 'Uncategorized'}
                      {category?.status === 'archived' ? ' (Archived)' : ''}
                    </td>
                    <td className="py-3 px-3 text-right font-mono-data font-semibold text-ink whitespace-nowrap">
                      {formatMyrPrice(product.priceMyr)}
                    </td>
                    <td className="py-3 px-3 font-mono-data text-ink-secondary">
                      {product.variants.length > 0
                        ? `${product.variants.length} variant(s)`
                        : '—'}
                    </td>
                    <td className="py-3 px-3">
                      <span
                        className={`font-semibold ${
                          product.status === 'active'
                            ? 'text-brand-text'
                            : 'text-warning-text'
                        }`}
                      >
                        {product.status === 'active' ? 'Active' : 'Archived'}
                      </span>
                    </td>
                    <td className="py-3 px-3 font-mono-data text-muted whitespace-nowrap">
                      {formatDateDDMMYYYY(product.updatedAt)}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <div className="inline-flex flex-wrap items-center justify-end gap-1.5">
                        <button
                          type="button"
                          disabled={!canPlan || isBusy}
                          onClick={() => onSendToPlanner(product)}
                          className="px-2.5 py-1 rounded-lg bg-brand hover:bg-brand-hover disabled:opacity-40 text-white text-[11px] font-semibold whitespace-nowrap transition-colors"
                        >
                          Plan Print
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => onEditProduct(product)}
                          className="px-2 py-1 rounded-lg border border-line bg-surface hover:bg-recessed text-[11px] font-medium text-ink transition-colors"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => onDuplicateProduct(product)}
                          className="px-2 py-1 rounded-lg border border-line bg-surface hover:bg-recessed text-[11px] font-medium text-ink transition-colors"
                        >
                          Duplicate
                        </button>
                        {product.status === 'active' ? (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => onRequestArchiveProduct(product)}
                            className="px-2 py-1 rounded-lg border border-warning-border bg-warning-soft text-[11px] font-medium text-warning-text transition-colors"
                          >
                            Archive
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => onRestoreProduct(product)}
                            className="px-2 py-1 rounded-lg border border-brand-border bg-brand-soft text-[11px] font-semibold text-brand-text transition-colors"
                          >
                            Restore
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
