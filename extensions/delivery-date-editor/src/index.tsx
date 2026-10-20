// Customer account extension for the order status page. Shows the order's delivery date and
// time slot, reading them from the order data and from the app's
// /public/customer-account/order-delivery endpoint (called with a session token) so the block
// is current right after a reschedule.

export default async function renderOrderStatusBlock() {
  const api = (globalThis as unknown as {
    shopify: CustomerAccountOrderStatusApi;
  }).shopify as CustomerAccountOrderStatusApi;

  // Keep both the host-provided order snapshot and our own one-shot backend read
  // because the customer-account page can lag behind immediately after a
  // reschedule save. (A cross-extension storage "handoff" from the reschedule
  // modal used to live here — it was dead code: extension storage is scoped per
  // extension, so this block could never see the modal's marker. Removed
  // 2026-08-25 together with its 1s poll loop.)
  const state = {
    metafields: getSubscribableValue(api.appMetafields) ?? [],
    attributes: getSubscribableValue(api.attributes) ?? [],
    order: getSubscribableValue(api.order),
    latestDelivery: null as OrderDeliverySnapshot | null,
  };

  // ONE persistent root per activation, and the only write this file ever makes to
  // document.body. Everything below re-renders by replacing the children of this
  // container, never the body — so the container query context (and, on the real
  // surface, the block's scroll position) survives every re-render.
  //
  // s-query-container is here for the customer-account redesign: the order-status
  // page is single-column and inline, so its children can size themselves with
  // `@container (inline-size > Npx) wide, narrow` attribute values instead of
  // guessing at a viewport width. It deliberately does NOT introduce columns —
  // the surface is single-column by design.
  const root = document.createElement('s-query-container');
  document.body.replaceChildren(root);

  // Backend-read discipline (2026-08-25 incident: stale tabs streamed 1 req/s of
  // 401s at the backend with no stop condition). One read per order id, one in
  // flight at a time, and the backend is abandoned for the rest of the
  // activation after repeated auth failures or too many errors of any kind —
  // the host metafield/attribute fallback keeps the block rendering regardless.
  let isFetchInFlight = false;
  let lastFetchedOrderId: string | null = null;
  let authFailStreak = 0;
  let totalFailCount = 0;
  let backendDisabled = false;

  const render = () => {
    const metafields = state.metafields;
    const attributes = state.attributes;
    const order = state.order;
    const latestDelivery = state.latestDelivery;

    const attrs: Record<string, string> = {};
    for (const attr of attributes) {
      attrs[attr.key] = attr.value;
    }

    const metaDate = getMetafieldValue(metafields, 'custom', 'date');
    const metaTime = getMetafieldValue(metafields, 'custom', 'time_slot');
    const storedRescheduleStatus = getMetafieldValue(
      metafields,
      '$app',
      'reschedule_status',
    );

    // Prefer the direct server read over the host snapshot so the block reflects
    // a recent reschedule even while Shopify's own order payload lags behind.
    const deliveryDate =
      latestDelivery?.date ?? metaDate ?? attrs['Delivery Date'] ?? null;
    const deliveryTime =
      latestDelivery?.timeSlot ?? metaTime ?? attrs['Delivery Time'] ?? null;
    const cardMessage = attrs['Card Message'] ?? null;

    if (!deliveryDate && !deliveryTime) {
      root.replaceChildren();
      return;
    }

    const rescheduleStatus = latestDelivery?.status ?? storedRescheduleStatus;

    const section = document.createElement('s-section');
    const orderLabel = order?.name ? ` · ${order.name}` : '';
    section.setAttribute('heading', `Delivery Schedule${orderLabel}`);

    // One design-token gap on the parent spaces every labelled value, tightened
    // a step on a narrow container (the inline order-status card on a phone).
    const content = createElement('s-stack', {
      direction: 'block',
      gap: '@container (inline-size > 400px) base, small-300',
    });

    if (deliveryDate) {
      content.append(createLabeledValue('Date', deliveryDate));
    }

    if (deliveryTime) {
      content.append(createLabeledValue('Time slot', deliveryTime));
    }

    if (cardMessage) {
      content.append(createLabeledValue('Card message', cardMessage));
    }

    if (rescheduleStatus === 'confirmed') {
      const badge = createElement('s-badge', { tone: 'neutral' });
      const formattedDate = deliveryDate ? ` to ${formatDisplayDate(deliveryDate)}` : '';
      badge.textContent = `Rescheduled${formattedDate}`;
      content.append(badge);
    }

    section.append(content);
    root.replaceChildren(section);
  };

  const syncLatestDelivery = async () => {
    const orderId = state.order?.id ?? null;

    // The lastFetchedOrderId check is the dedupe: activation and the order
    // subscribable's initial emission both land here, and repeated emissions of
    // the same order must not each cost a network round trip.
    if (
      !orderId ||
      backendDisabled ||
      isFetchInFlight ||
      lastFetchedOrderId === orderId
    ) {
      return;
    }

    isFetchInFlight = true;
    try {
      const result = await fetchLatestOrderDelivery(api, orderId);

      if (result.authFailure) {
        authFailStreak += 1;
      } else {
        authFailStreak = 0;
      }
      if (!result.ok) {
        totalFailCount += 1;
      }
      if (authFailStreak >= AUTH_FAIL_STOP || totalFailCount >= TOTAL_FAIL_STOP) {
        // A dead session never heals within the page's lifetime — stop asking.
        backendDisabled = true;
      }

      if (result.ok) {
        lastFetchedOrderId = orderId;
        if (!isSameOrderDeliverySnapshot(state.latestDelivery, result.delivery)) {
          state.latestDelivery = result.delivery;
          render();
        }
      }
    } finally {
      isFetchInFlight = false;
    }
  };

  subscribeToSubscribable(api.appMetafields, (value) => {
    state.metafields = value ?? [];
    render();
  });
  subscribeToSubscribable(api.attributes, (value) => {
    state.attributes = value ?? [];
    render();
  });
  subscribeToSubscribable(api.order, (value) => {
    state.order = value;
    void syncLatestDelivery();
    render();
  });

  await syncLatestDelivery();

  render();
}

const APP_BASE_URL = 'https://delivery-scheduler-1030649952056.us-central1.run.app';
const ORDER_DELIVERY_URL = `${APP_BASE_URL}/public/customer-account/order-delivery`;
const AUTH_FAIL_STOP = 3;
const TOTAL_FAIL_STOP = 20;

type OrderDeliverySnapshot = {
  date: string | null;
  timeSlot: string | null;
  status: string | null;
};

type OrderDeliveryFetchResult = {
  ok: boolean;
  authFailure: boolean;
  delivery: OrderDeliverySnapshot | null;
};

type CustomerAccountOrderStatusApi = {
  appMetafields: ExtensionSubscribable<
    Array<{ metafield: { namespace: string; key: string; value?: unknown } }>
  >;
  attributes: ExtensionSubscribable<Array<{ key: string; value: string }> | undefined>;
  order: ExtensionSubscribable<{ id?: string | null; name?: string | null } | undefined>;
  sessionToken: {
    get: () => Promise<string>;
  };
};

type ExtensionSubscribable<T> = {
  value?: T;
  current?: T;
  subscribe?: (subscriber: (value: T) => void) => (() => void) | void;
};

function getMetafieldValue(
  metafields: Array<{ metafield: { namespace: string; key: string; value?: unknown } }>,
  namespace: string,
  key: string,
): string | null {
  const metafield = metafields.find(
    (entry) =>
      entry.metafield.namespace === namespace && entry.metafield.key === key,
  );
  return metafield?.metafield.value?.toString() ?? null;
}

function getSubscribableValue<T>(subscribable: ExtensionSubscribable<T>): T | undefined {
  return subscribable.current ?? subscribable.value;
}

function subscribeToSubscribable<T>(
  subscribable: ExtensionSubscribable<T>,
  onValue: (value: T) => void,
) {
  subscribable.subscribe?.((value) => {
    onValue(value);
  });
}

async function fetchLatestOrderDelivery(
  api: CustomerAccountOrderStatusApi,
  orderId: string,
): Promise<OrderDeliveryFetchResult> {
  try {
    const sessionToken = await api.sessionToken.get();

    // If the sandbox bridge dies mid-call, get() can resolve undefined; sending
    // that reaches the backend as the literal string "undefined" and lands as an
    // unexplained 401 (observed in prod 2026-08-25). Count it as an auth failure
    // locally instead of shipping garbage.
    if (typeof sessionToken !== 'string' || sessionToken.trim() === '') {
      return { ok: false, authFailure: true, delivery: null };
    }

    const requestBody = new URLSearchParams({ orderId, sessionToken });

    const response = await fetch(ORDER_DELIVERY_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      body: requestBody,
    });

    const responseBody = (await response.json().catch(() => ({}))) as {
      delivery?: OrderDeliverySnapshot;
      error?: string;
    };

    if (!response.ok) {
      console.warn(
        'Order delivery request failed:',
        responseBody.error ?? response.status,
      );
      return {
        ok: false,
        authFailure: response.status === 401 || response.status === 403,
        delivery: null,
      };
    }

    if (!isOrderDeliverySnapshot(responseBody.delivery)) {
      return { ok: true, authFailure: false, delivery: null };
    }

    return { ok: true, authFailure: false, delivery: responseBody.delivery };
  } catch (error) {
    console.warn('Failed to fetch latest order delivery:', error);
    return { ok: false, authFailure: false, delivery: null };
  }
}

function isOrderDeliverySnapshot(value: unknown): value is OrderDeliverySnapshot {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    (candidate.date === null || typeof candidate.date === 'string') &&
    (candidate.timeSlot === null || typeof candidate.timeSlot === 'string') &&
    (candidate.status === null || typeof candidate.status === 'string')
  );
}

function isSameOrderDeliverySnapshot(
  left: OrderDeliverySnapshot | null,
  right: OrderDeliverySnapshot | null,
) {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.date === right.date &&
    left.timeSlot === right.timeSlot &&
    left.status === right.status
  );
}

function formatDisplayDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  // Pinned to English per the brand's English-first voice (merchant decision
  // 2026-08-25) — a Filipino-locale browser would otherwise render "Biyernes".
  return date.toLocaleDateString('en-PH', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function createElement(
  tagName: string,
  attributes: Record<string, string>,
) {
  const element = document.createElement(tagName) as HTMLElement;
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  return element;
}

function createLabeledValue(label: string, value: string) {
  // Typography and color are the design system's job — never pin a literal
  // color here: a hard-coded black reads as invisible text on a dark
  // customer-account theme. `color="subdued"` on the label and the default
  // tone on the value give the visual hierarchy while
  // following the surface's own palette.
  const group = createElement('s-stack', {
    direction: 'block',
    gap: 'small-100',
  });

  const labelText = createElement('s-text', { color: 'subdued' });
  labelText.textContent = label;

  const valueText = document.createElement('s-text');
  valueText.textContent = value;
  // No design-system equivalent, so this is the file's only inline style.
  // Applied to every value; it matters for the free-text card message, which
  // can carry a long unbroken string that would otherwise widen the block past
  // the card on a narrow container.
  valueText.setAttribute('style', 'overflow-wrap:anywhere');

  group.append(labelText, valueText);
  return group;
}
