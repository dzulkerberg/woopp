import React, { useMemo, useState } from 'react';
import { FolderTree, Package, PlusCircle } from 'lucide-react';
import {
  createOrDuplicateCatalogProductInFirestore,
  reorderProductCategoriesInFirestore,
  saveProductCategoryToFirestore,
  updateCatalogProductInFirestore,
} from '../../services/productStudioService';
import { CatalogProduct, ProductCategory } from '../../types';
import { AllProductsTab } from './AllProductsTab';
import { CategoryManagerTab } from './CategoryManagerTab';
import { ProductDetailModal } from './ProductDetailModal';
import { ProductFormTab } from './ProductFormTab';

export type ProductStudioSubTab = 'all-products' | 'add-product' | 'categories';

interface ProductStudioViewProps {
  ownerId: string;
  timezone?: string;
  categories: readonly ProductCategory[];
  products: readonly CatalogProduct[];
  catalogLoading: boolean;
  catalogError: string | null;
  rulesDeploymentNeeded: boolean;
  onAlert: (message: string, title?: string) => void;
  onConfirm: (
    message: string,
    onConfirm: () => void,
    title?: string,
    confirmLabel?: string
  ) => void;
  onSendProductToPlanner: (
    product: CatalogProduct,
    variantId?: string | null
  ) => void;
}

export const ProductStudioView: React.FC<ProductStudioViewProps> = ({
  ownerId,
  timezone,
  categories,
  products,
  catalogLoading,
  catalogError,
  rulesDeploymentNeeded,
  onAlert,
  onConfirm,
  onSendProductToPlanner,
}) => {
  const [subTab, setSubTab] = useState<ProductStudioSubTab>('all-products');
  const [editingProduct, setEditingProduct] = useState<CatalogProduct | null>(null);
  const [viewingProductId, setViewingProductId] = useState<string | null>(null);
  const [busyProductIds, setBusyProductIds] = useState<Set<string>>(
    () => new Set()
  );

  const existingSkus = useMemo(
    () => new Set(products.map((p) => p.sku.toUpperCase())),
    [products]
  );

  const viewingProduct = useMemo(
    () => products.find((p) => p.id === viewingProductId) || null,
    [products, viewingProductId]
  );

  const lockProduct = (id: string) => {
    setBusyProductIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  const unlockProduct = (id: string) => {
    setBusyProductIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  // --- Category Actions ---
  const handleSaveCategory = async (category: ProductCategory) => {
    await saveProductCategoryToFirestore(ownerId, category);
  };

  const handleReorderCategories = async (ordered: ProductCategory[]) => {
    try {
      await reorderProductCategoriesInFirestore(ownerId, ordered);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onAlert(msg, 'Category Reorder Failed');
    }
  };

  const handleRequestArchiveCategory = (category: ProductCategory) => {
    const linkedCount = products.filter((p) => p.categoryId === category.id).length;
    onConfirm(
      `Archive category "${category.name}"?\n\n` +
        `• ${linkedCount} linked catalog product(s) remain intact.\n` +
        `• Existing Print Queue jobs and completed history remain untouched.\n` +
        `• Archived categories cannot create new print plans in Auto Plate Planner until restored.`,
      () => {
        void saveProductCategoryToFirestore(ownerId, {
          ...category,
          status: 'archived',
          updatedAt: new Date().toISOString(),
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          onAlert(msg, 'Archive Category Failed');
        });
      },
      'Archive Category',
      'Archive Category'
    );
  };

  const handleRestoreCategory = async (category: ProductCategory) => {
    try {
      await saveProductCategoryToFirestore(ownerId, {
        ...category,
        status: 'active',
        updatedAt: new Date().toISOString(),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onAlert(msg, 'Restore Category Failed');
    }
  };

  // --- Product Actions ---
  const handleSaveNewProduct = async (
    draft: Omit<CatalogProduct, 'sku'> & { sku?: string }
  ): Promise<CatalogProduct> => {
    return createOrDuplicateCatalogProductInFirestore({
      ownerId,
      operation: 'create',
      draftProduct: draft,
      existingSkus,
    });
  };

  const handleSaveEditedProduct = async (
    existing: CatalogProduct,
    updatedDraft: CatalogProduct
  ): Promise<CatalogProduct> => {
    return updateCatalogProductInFirestore({
      ownerId,
      existingProduct: existing,
      updatedDraft,
    });
  };

  const handleDuplicateProduct = async (source: CatalogProduct) => {
    if (busyProductIds.has(source.id)) return;
    lockProduct(source.id);
    try {
      const nowIso = new Date().toISOString();
      const duplicated = await createOrDuplicateCatalogProductInFirestore({
        ownerId,
        operation: 'duplicate',
        existingSkus,
        sourceProductSku: source.sku,
        draftProduct: {
          id: `prod-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          ownerId,
          name: `${source.name} (Copy)`.slice(0, 160),
          description: source.description,
          categoryId: source.categoryId,
          priceMyr: source.priceMyr,
          images: [...source.images],
          options: source.options.map((o) => ({ ...o, values: [...o.values] })),
          variants: source.variants.map((v) => ({
            ...v,
            optionValues: { ...v.optionValues },
          })),
          status: 'active',
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      });
      onAlert(
        `Created duplicate "${duplicated.name}" with new SKU ${duplicated.sku}.`,
        'Product Duplicated'
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onAlert(msg, 'Duplicate Product Failed');
    } finally {
      unlockProduct(source.id);
    }
  };

  const handleRequestArchiveProduct = (product: CatalogProduct) => {
    onConfirm(
      `Archive product "${product.name}" (${product.sku})?\n\n` +
        `• Archived products are hidden from active Auto Plate Planner selection.\n` +
        `• Existing Print Queue plates and historical completed records remain intact.`,
      () => {
        lockProduct(product.id);
        void updateCatalogProductInFirestore({
          ownerId,
          existingProduct: product,
          updatedDraft: {
            ...product,
            status: 'archived',
          },
        })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            onAlert(msg, 'Archive Product Failed');
          })
          .finally(() => unlockProduct(product.id));
      },
      'Archive Product',
      'Archive Product'
    );
  };

  const handleRestoreProduct = (product: CatalogProduct) => {
    if (busyProductIds.has(product.id)) return;
    lockProduct(product.id);
    void updateCatalogProductInFirestore({
      ownerId,
      existingProduct: product,
      updatedDraft: {
        ...product,
        status: 'active',
      },
    })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        onAlert(msg, 'Restore Product Failed');
      })
      .finally(() => unlockProduct(product.id));
  };

  return (
    <div className="space-y-6">
      {/* Sub-Navigation Header */}
      <div className="bg-surface border border-line rounded-xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          aria-label="Product Studio sections"
          className="inline-flex flex-wrap items-center gap-1 p-1 rounded-xl bg-recessed border border-line"
        >
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'all-products'}
            onClick={() => {
              setEditingProduct(null);
              setSubTab('all-products');
            }}
            className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
              subTab === 'all-products'
                ? 'bg-brand text-white'
                : 'text-ink-secondary hover:text-ink'
            }`}
          >
            <Package className="w-4 h-4" />
            <span>All Products ({products.length})</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'add-product'}
            onClick={() => {
              setEditingProduct(null);
              setSubTab('add-product');
            }}
            className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
              subTab === 'add-product'
                ? 'bg-brand text-white'
                : 'text-ink-secondary hover:text-ink'
            }`}
          >
            <PlusCircle className="w-4 h-4" />
            <span>{editingProduct ? 'Edit Product' : 'Add Product'}</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'categories'}
            onClick={() => {
              setEditingProduct(null);
              setSubTab('categories');
            }}
            className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
              subTab === 'categories'
                ? 'bg-brand text-white'
                : 'text-ink-secondary hover:text-ink'
            }`}
          >
            <FolderTree className="w-4 h-4" />
            <span>Categories ({categories.length})</span>
          </button>
        </div>

        <div className="text-xs text-muted">
          Isolated Cloud Catalog · <span className="font-mono-data">woopp-tracker</span>
        </div>
      </div>

      {/* Firestore Rules / Connection Banner */}
      {catalogError && (
        <div
          className={`p-4 rounded-xl border text-xs space-y-1 ${
            rulesDeploymentNeeded
              ? 'border-warning-border bg-warning-soft text-warning-text'
              : 'border-error-border bg-error-soft text-error-text'
          }`}
        >
          <div className="font-semibold">
            {rulesDeploymentNeeded
              ? 'Cloud Firestore Rules Update Required Before First Save'
              : 'Product Studio Cloud Sync Error'}
          </div>
          <div>{catalogError}</div>
        </div>
      )}

      {catalogLoading ? (
        <div className="bg-surface border border-line rounded-xl p-10 text-center text-xs text-muted">
          Loading Product Studio catalog from Cloud Firestore...
        </div>
      ) : (
        <>
          {subTab === 'all-products' && (
            <AllProductsTab
              categories={categories}
              products={products}
              busyProductIds={busyProductIds}
              onOpenAddProduct={() => {
                setEditingProduct(null);
                setSubTab('add-product');
              }}
              onOpenCategoriesTab={() => {
                setEditingProduct(null);
                setSubTab('categories');
              }}
              onViewProduct={(product) => setViewingProductId(product.id)}
              onEditProduct={(product) => {
                setEditingProduct(product);
                setSubTab('add-product');
              }}
              onDuplicateProduct={(product) => void handleDuplicateProduct(product)}
              onRequestArchiveProduct={handleRequestArchiveProduct}
              onRestoreProduct={handleRestoreProduct}
              onSendToPlanner={(product) =>
                onSendProductToPlanner(product, product.variants[0]?.id ?? null)
              }
            />
          )}

          {subTab === 'add-product' && (
            <ProductFormTab
              ownerId={ownerId}
              categories={categories}
              existingSkus={existingSkus}
              editingProduct={editingProduct}
              onSaveNewProduct={handleSaveNewProduct}
              onSaveEditedProduct={handleSaveEditedProduct}
              onCancelEdit={() => {
                setEditingProduct(null);
                setSubTab('all-products');
              }}
              onOpenCategoriesTab={() => {
                setEditingProduct(null);
                setSubTab('categories');
              }}
              onSavedSuccess={(saved) => {
                const wasEdit = Boolean(editingProduct);
                setEditingProduct(null);
                setSubTab('all-products');
                onAlert(
                  `${wasEdit ? 'Updated' : 'Saved'} "${saved.name}" (${saved.sku}) in Cloud Firestore.`,
                  wasEdit ? 'Product Updated' : 'Product Added to Catalog'
                );
              }}
            />
          )}

          {subTab === 'categories' && (
            <CategoryManagerTab
              ownerId={ownerId}
              categories={categories}
              products={products}
              onSaveCategory={handleSaveCategory}
              onReorderCategories={handleReorderCategories}
              onRequestArchiveCategory={handleRequestArchiveCategory}
              onRestoreCategory={handleRestoreCategory}
            />
          )}
        </>
      )}

      <ProductDetailModal
        product={viewingProduct}
        category={
          viewingProduct
            ? categories.find((c) => c.id === viewingProduct.categoryId) || null
            : null
        }
        timezone={timezone}
        onClose={() => setViewingProductId(null)}
        onEdit={(p) => {
          setEditingProduct(p);
          setSubTab('add-product');
        }}
        onDuplicate={(p) => void handleDuplicateProduct(p)}
        onRequestArchive={handleRequestArchiveProduct}
        onRestore={handleRestoreProduct}
        onSendToPlanner={onSendProductToPlanner}
      />
    </div>
  );
};
