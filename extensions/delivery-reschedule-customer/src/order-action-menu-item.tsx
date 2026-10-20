// Customer account menu item ("Reschedule Delivery") on an order. It only renders the button;
// the modal opened by Shopify (order-action-modal.tsx) does the work.

export default async function renderRescheduleMenuItem() {
  // Keep the menu item intentionally dumb; the modal owns all delivery validation,
  // schedule loading, and submission logic once Shopify opens the action.
  const button = document.createElement('s-button');
  button.textContent = 'Reschedule Delivery';
  document.body.replaceChildren(button);
}