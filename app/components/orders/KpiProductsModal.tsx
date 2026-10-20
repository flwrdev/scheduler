// "Items to prepare" modal opened from the Orders KPI card: the products and quantities to
// prepare for the loaded orders.

import { AppModal } from "../ui/AppModal";

export interface KpiProductsModalProps {
  open: boolean;
  onClose: () => void;
  kpiProducts: [string, number][];
}

// Lists each product name with the quantity to prepare.
export function KpiProductsModal({
  open,
  onClose,
  kpiProducts,
}: KpiProductsModalProps) {
  return (
    <AppModal
      open={open}
      onClose={onClose}
      title="Items to prepare"
      primaryAction={{ content: "Close", onAction: onClose }}
    >
      {kpiProducts.length === 0 ? (
        <s-paragraph color="subdued">No products found.</s-paragraph>
      ) : (
        <s-stack gap="small-200">
          {kpiProducts.map(([name, qty]) => (
            <s-stack
              key={name}
              direction="inline"
              justifyContent="space-between"
              alignItems="center"
            >
              <s-text>{name}</s-text>
              <s-text fontWeight="semibold">× {qty}</s-text>
            </s-stack>
          ))}
        </s-stack>
      )}
    </AppModal>
  );
}
