// The order's line items in the order panel, with the item count.

import { type Order, formatMoney } from "../../../lib/order-utils";

export function ItemsSection({ order }: { order: Order }) {
  const items = order.lineItems?.edges || [];

  const total = order.currentTotalPriceSet
    ? formatMoney(
        order.currentTotalPriceSet.shopMoney.amount,
        order.currentTotalPriceSet.shopMoney.currencyCode,
      )
    : "—";
  const shippingAmount = order.totalShippingPriceSet
    ? parseFloat(order.totalShippingPriceSet.shopMoney.amount)
    : 0;
  const totalAmount = order.currentTotalPriceSet
    ? parseFloat(order.currentTotalPriceSet.shopMoney.amount)
    : 0;
  const currencyCode =
    order.currentTotalPriceSet?.shopMoney.currencyCode ||
    order.totalShippingPriceSet?.shopMoney.currencyCode ||
    "USD";
  const subtotalFormatted = order.currentTotalPriceSet
    ? formatMoney((totalAmount - shippingAmount).toFixed(2), currencyCode)
    : "—";
  const shippingFormatted = order.totalShippingPriceSet
    ? formatMoney(order.totalShippingPriceSet.shopMoney.amount, currencyCode)
    : "—";

  return (
    <s-stack gap="small">
      <s-heading>Items ({items.length})</s-heading>
      {items.length === 0 ? (
        <s-paragraph color="subdued">No items.</s-paragraph>
      ) : (
        <div>
          {items.map((edge, idx) => {
            const item = edge.node;
            const imgUrl = item.image?.url || item.product?.featuredImage?.url;
            const imgAlt =
              item.image?.altText ||
              item.product?.featuredImage?.altText ||
              item.name;
            return (
              <div key={idx} className="odp-item-row">
                {imgUrl ? (
                  <img className="odp-item-thumb" src={imgUrl} alt={imgAlt} />
                ) : (
                  <div className="odp-item-thumb-placeholder" />
                )}
                <div className="odp-item-info">
                  <div className="odp-ellipsis">
                    <s-text fontWeight="medium">{item.name}</s-text>
                  </div>
                  {item.sku && (
                    <s-paragraph color="subdued" fontSize="small">
                      SKU: {item.sku}
                    </s-paragraph>
                  )}
                </div>
                <s-text color="subdued">× {item.quantity}</s-text>
              </div>
            );
          })}
        </div>
      )}
      <div className="odp-totals">
        <div className="odp-totals-row">
          <s-text color="subdued">Subtotal</s-text>
          <s-text>{subtotalFormatted}</s-text>
        </div>
        <div className="odp-totals-row">
          <s-text color="subdued">Shipping fee</s-text>
          <s-text>{shippingFormatted}</s-text>
        </div>
        <div className="odp-totals-row">
          <s-text fontWeight="semibold">Total</s-text>
          <s-text fontWeight="semibold">{total}</s-text>
        </div>
      </div>
    </s-stack>
  );
}
