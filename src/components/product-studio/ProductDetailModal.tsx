import React, { useState } from 'react';
import {
  Archive,
  Check,
  Copy,
  Edit3,
  Files,
  Printer,
  RotateCcw,
  X,
} from 'lucide-react';
import { CatalogProduct, ProductCategory } from '../../types';
import { formatDateTimeDDMMYYYY } from '../../utils/dateFormat';
import { CategoryIcon } from './CategoryIcon';

interface ProductDetailModalProps {
  product: CatalogProduct | null;
  category: ProductCategory | null;
  timezone?: string;
  onClose: () => void;
  onEdit: (product: CatalogProduct) => void;
  onDuplicate: (product: CatalogProduct) => void;
  onRequestArchive: (product: CatalogProduct) => void;
  onRestore: (product: CatalogProduct) => void;
  onSendToPlanner: (product: CatalogProduct, variantId?: string | null) => void;
}

export function formatMyrPrice(priceMyr: number | null | undefined): string {
  if (typeof priceMyr !== 'number' || !Number.isFinite(priceMyr)) {
    return '—';
  }
  return `RM ${priceMyr.toFixed(2)}`;
}

export const ProductDetailModal: React.FC<ProductDetailModalProps> = ({
  product,
  category,
  timezone,
  onClose,
  onEdit,
  onDuplicate,
  onRequestArchive,
  onRestore,
  onSendToPlanner,
}) => {
  const [selectedImageIdx, setSelectedImageIdx] = useState<number>(0);
  const [copiedSku, setCopiedSku] = useState<boolean>(false);

  if (!product) return null;

  const activeImage =
    product.images[selectedImageIdx] || product.images[0] || null;
  const canSendToPlanner =
    product.status === 'active' && category?.status === 'active';

  const handleCopySku = () => {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(product.sku).then(() => {
        setCopiedSku(true);
        setTimeout(() => setCopiedSku(false), 1500);
      });
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-labelledby="product-detail-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[90vh] overflow-y-auto bg-surface border border-line rounded-2xl shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-line flex items-center justify-between gap-3 sticky top-0 bg-surface z-10">
          <div className="min-w-0">
            <div className="text-[11px] font-mono-data text-muted">
              {product.sku} · {product.status === 'archived' ? 'Archived' : 'Active Catalog Item'}
            </div>
            <h2
              id="product-detail-title"
              className="text-base font-bold text-ink truncate"
            >
              {product.name}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close product details"
            className="p-1.5 rounded-lg border border-line bg-elevated text-ink-secondary hover:text-ink transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
            {/* Image Gallery */}
            <div className="md:col-span-5 space-y-2.5">
              <div className="aspect-square rounded-xl border border-line bg-recessed flex items-center justify-center overflow-hidden">
                {activeImage ? (
                  <img
                    src={activeImage}
                    alt={product.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="text-center p-4 text-muted space-y-1">
                    <CategoryIcon
                      name={category?.iconName || 'box'}
                      className="w-8 h-8 mx-auto opacity-60"
                    />
                    <div className="text-xs">No image configured</div>
                  </div>
                )}
              </div>

              {product.images.length > 1 && (
                <div className="grid grid-cols-5 gap-1.5">
                  {product.images.map((imgUrl, idx) => (
                    <button
                      key={`${imgUrl}-${idx}`}
                      type="button"
                      onClick={() => setSelectedImageIdx(idx)}
                      className={`aspect-square rounded-lg border overflow-hidden ${
                        selectedImageIdx === idx
                          ? 'border-brand ring-1 ring-brand'
                          : 'border-line opacity-75 hover:opacity-100'
                      }`}
                    >
                      <img
                        src={imgUrl}
                        alt={`${product.name} view ${idx + 1}`}
                        className="w-full h-full object-cover"
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Summary Metadata */}
            <div className="md:col-span-7 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-line">
                <div>
                  <div className="text-xs text-muted">Selling Price</div>
                  <div className="text-xl font-bold font-mono-data text-ink mt-0.5">
                    {formatMyrPrice(product.priceMyr)}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleCopySku}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line bg-recessed hover:bg-elevated text-xs font-mono-data text-ink transition-colors"
                >
                  {copiedSku ? (
                    <Check className="w-3.5 h-3.5 text-brand-text" />
                  ) : (
                    <Copy className="w-3.5 h-3.5 text-muted" />
                  )}
                  <span>{product.sku}</span>
                </button>
              </div>

              <div className="space-y-2 text-xs">
                <div className="flex items-center justify-between py-1 border-b border-line/60">
                  <span className="text-muted">Category</span>
                  <span className="font-semibold text-ink inline-flex items-center gap-1.5">
                    {category && (
                      <CategoryIcon name={category.iconName} className="w-3.5 h-3.5 text-brand-text" />
                    )}
                    <span>{category?.name || 'Unknown Category'}</span>
                    {category?.status === 'archived' && (
                      <span className="text-warning-text font-normal">(Archived)</span>
                    )}
                  </span>
                </div>

                <div className="flex items-center justify-between py-1 border-b border-line/60">
                  <span className="text-muted">Catalog Status</span>
                  <span
                    className={`font-semibold ${
                      product.status === 'active' ? 'text-brand-text' : 'text-warning-text'
                    }`}
                  >
                    {product.status === 'active' ? 'Active' : 'Archived'}
                  </span>
                </div>

                <div className="flex items-center justify-between py-1 border-b border-line/60">
                  <span className="text-muted">Variations</span>
                  <span className="font-mono-data text-ink">
                    {product.variants.length > 0
                      ? `${product.variants.length} variant(s)`
                      : 'Standard (Single Item)'}
                  </span>
                </div>

                <div className="flex items-center justify-between py-1">
                  <span className="text-muted">Last Updated</span>
                  <span className="font-mono-data text-ink-secondary">
                    {formatDateTimeDDMMYYYY(new Date(product.updatedAt), timezone)}
                  </span>
                </div>
              </div>

              {product.description && (
                <div className="pt-2">
                  <div className="text-xs font-semibold text-ink-secondary mb-1">
                    Description
                  </div>
                  <p className="text-xs text-ink-secondary whitespace-pre-line leading-relaxed bg-recessed border border-line rounded-xl p-3">
                    {product.description}
                  </p>
                </div>
              )}

              {/* Send to Print Planner Action */}
              <div className="pt-2 space-y-2">
                <button
                  type="button"
                  disabled={!canSendToPlanner}
                  onClick={() => {
                    onClose();
                    onSendToPlanner(product, product.variants[0]?.id ?? null);
                  }}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-brand hover:bg-brand-hover disabled:opacity-45 text-white text-xs font-semibold transition-colors"
                >
                  <Printer className="w-4 h-4" />
                  <span>Send to Print Planner</span>
                </button>
                {!canSendToPlanner && (
                  <p className="text-[11px] text-warning-text">
                    {product.status === 'archived'
                      ? 'Restore this product before sending it to the Print Planner.'
                      : 'Restore this product’s archived category before creating new print plans.'}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Variations Table */}
          {product.variants.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-ink">
                Configured Variations ({product.variants.length})
              </div>
              <div className="border border-line rounded-xl overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-recessed border-b border-line text-muted">
                      <th className="py-2.5 px-3 font-medium">Variant</th>
                      <th className="py-2.5 px-3 font-medium text-right">Price (MYR)</th>
                      <th className="py-2.5 px-3 font-medium text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {product.variants.map((v) => (
                      <tr key={v.id} className="hover:bg-elevated">
                        <td className="py-2.5 px-3 flex items-center gap-2.5">
                          {v.imageUrl && (
                            <img
                              src={v.imageUrl}
                              alt={v.label}
                              className="w-7 h-7 rounded object-cover border border-line shrink-0"
                            />
                          )}
                          <span className="font-medium text-ink">{v.label}</span>
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono-data text-ink">
                          {formatMyrPrice(v.priceMyr ?? product.priceMyr)}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <button
                            type="button"
                            disabled={!canSendToPlanner}
                            onClick={() => {
                              onClose();
                              onSendToPlanner(product, v.id);
                            }}
                            className="text-xs font-semibold text-brand-text hover:underline disabled:opacity-40"
                          >
                            Plan Variant →
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Footer Secondary Actions */}
        <div className="px-6 py-4 border-t border-line bg-recessed flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                onClose();
                onEdit(product);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line bg-surface hover:bg-elevated text-xs font-medium text-ink transition-colors"
            >
              <Edit3 className="w-3.5 h-3.5" />
              <span>Edit Product</span>
            </button>
            <button
              type="button"
              onClick={() => {
                onClose();
                onDuplicate(product);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line bg-surface hover:bg-elevated text-xs font-medium text-ink transition-colors"
            >
              <Files className="w-3.5 h-3.5" />
              <span>Duplicate (New SKU)</span>
            </button>
          </div>

          {product.status === 'active' ? (
            <button
              type="button"
              onClick={() => {
                onClose();
                onRequestArchive(product);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-warning-border bg-warning-soft text-xs font-medium text-warning-text transition-colors"
            >
              <Archive className="w-3.5 h-3.5" />
              <span>Archive Product</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                onClose();
                onRestore(product);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-brand-border bg-brand-soft text-xs font-semibold text-brand-text transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Restore Product</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
