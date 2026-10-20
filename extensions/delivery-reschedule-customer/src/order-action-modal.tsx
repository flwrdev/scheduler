// Customer account modal to reschedule an order's delivery. Loads the schedule rules from
// /public/customer-account/schedule-rules, lets the customer pick an available date and time
// slot, and submits it to /public/customer-account/reschedule. Both calls carry a session token.

import {
  DEFAULT_DELIVERY_SCHEDULE_RULES,
  cloneDeliveryScheduleRules,
  getMaxSelectableDate,
  getMinSelectableDate,
  getUnavailableDatesInWindow,
  validateDeliveryDate,
  validateDeliverySelection,
  type DeliveryScheduleRules,
  type DeliveryScheduleSlot,
  type DeliverySelectionValidationCode,
} from '../../../app/lib/delivery-availability';

export default async function renderRescheduleModal() {
  const shopifyApi = getShopifyApi();
  const fallbackRules = cloneDeliveryScheduleRules(DEFAULT_DELIVERY_SCHEDULE_RULES);
  const minDate = getMinSelectableDate(fallbackRules);
  const state = {
    date: '',
    timeSlot: '',
    dateError: '',
    timeError: '',
    availabilityMessage: '',
    isLoadingRules: true,
    isSubmitting: false,
    submitError: '',
    confirmedDate: '',
    confirmedSlot: '',
    rules: fallbackRules,
    availableSlots: [] as DeliveryScheduleSlot[],
    minDate,
    maxDate: getMaxSelectableDate(fallbackRules, minDate),
    disallowDates: '' as string,
  };

  // The action shell, the form fields and the buttons are built ONCE and then
  // updated in place — a full rebuild per state change (i.e. per keystroke)
  // would destroy and re-create the s-date-field / s-select the customer is
  // typing in, losing focus and the native date picker mid-entry.
  const rerender = () => {
    view.update();
  };

  const view = buildRescheduleView(state, shopifyApi, rerender);
  document.body.replaceChildren(view.action);

  applyAvailabilityState(state);
  void loadScheduleRules(state, shopifyApi, rerender);
  rerender();
}

const APP_BASE_URL = 'https://delivery-scheduler-1030649952056.us-central1.run.app';
const SCHEDULE_RULES_URL = `${APP_BASE_URL}/public/customer-account/schedule-rules`;
const RESCHEDULE_URL = `${APP_BASE_URL}/public/customer-account/reschedule`;

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

type RescheduleState = {
  date: string;
  timeSlot: string;
  dateError: string;
  timeError: string;
  availabilityMessage: string;
  isLoadingRules: boolean;
  isSubmitting: boolean;
  submitError: string;
  confirmedDate: string;
  confirmedSlot: string;
  rules: DeliveryScheduleRules;
  availableSlots: DeliveryScheduleSlot[];
  minDate: string;
  maxDate: string;
  disallowDates: string;
};

type ShopifyActionApi = {
  close: () => void;
  orderId: string;
  sessionToken: {
    get: () => Promise<string>;
  };
};

function getShopifyApi() {
  return (globalThis as unknown as { shopify: ShopifyActionApi }).shopify;
}

type RescheduleView = {
  action: HTMLElement;
  update: () => void;
};

/**
 * Builds the modal once and hands back an `update()` that reconciles the parts
 * that actually change (intro copy, banners, field errors/disabled/value, the
 * slot options, the confirm button) against the kept element references. No
 * framework here on purpose — this is vanilla DOM, so "reconcile" means direct
 * property writes, guarded so an unchanged value never touches the control.
 */
function buildRescheduleView(
  state: RescheduleState,
  shopifyApi: ShopifyActionApi,
  rerender: () => void,
): RescheduleView {
  const action = createElement('s-customer-account-action', {
    heading: 'Reschedule Delivery',
  });

  // The action element itself is the modal chrome (Shopify sizes and slots it),
  // so the query container wraps the CONTENT. It lets the form below respond to
  // the width the modal actually gets — narrow inline panel on the redesigned
  // single-column order page, wider dialog on desktop — without inventing
  // columns the surface does not have.
  const queryContainer = createElement('s-query-container', {});

  const stack = createElement('s-stack', {
    direction: 'block',
    gap: '@container (inline-size > 400px) base, small-300',
  });

  // The one-online-reschedule policy rides inside the intro sentence
  // (merchant decision 2026-07-12: no extra line — avoid vertical clutter).
  // The backend enforces the limit via the `resched` tag; this only sets
  // the expectation before the customer submits.
  const intro = document.createElement('s-text');

  // Both banners are created up front but stay OUT of the DOM until they have
  // something to say, so `querySelector('s-banner')` never finds an empty one.
  const errorBanner = createElement('s-banner', { tone: 'critical' });
  const availabilityBanner = createElement('s-banner', { tone: 'critical' });

  const dateField = createElement('s-date-field', {
    label: 'New delivery date',
  });
  dateField.addEventListener('change', (event) => {
    state.date = getEventValue(event);
    state.dateError = '';
    state.timeError = '';
    state.submitError = '';
    applyAvailabilityState(state);
    rerender();
  });

  const select = createElement('s-select', {
    label: 'Time slot',
  });
  select.addEventListener('change', (event) => {
    state.timeSlot = getEventValue(event);
    state.timeError = '';
    state.submitError = '';
    rerender();
  });

  stack.append(intro, dateField, select);
  queryContainer.append(stack);

  const confirmButton = createElement('s-button', {
    slot: 'primary-action',
  });
  confirmButton.textContent = 'Confirm';
  confirmButton.addEventListener('click', async () => {
    await submitReschedule(state, shopifyApi, rerender);
  });

  const cancelButton = createElement('s-button', {
    slot: 'secondary-actions',
  });
  cancelButton.textContent = 'Cancel';
  cancelButton.addEventListener('click', () => {
    shopifyApi.close();
  });

  action.append(queryContainer, confirmButton, cancelButton);

  // Rebuilding the options resets the select, so only do it when the offered
  // slots (or the placeholder) actually changed.
  let renderedOptionsSignature: string | null = null;
  let isConfirmed = false;

  const syncBanner = (banner: HTMLElement, message: string, before: HTMLElement) => {
    if (!message) {
      banner.remove();
      return;
    }

    banner.textContent = message;
    if (banner.parentNode !== stack) {
      stack.insertBefore(banner, before);
    }
  };

  const syncSlotOptions = () => {
    const placeholder = getTimeSlotPlaceholder(state);
    const signature = JSON.stringify([placeholder, state.availableSlots]);

    if (signature === renderedOptionsSignature) {
      return;
    }

    renderedOptionsSignature = signature;
    select.replaceChildren(
      createOption('', placeholder),
      ...state.availableSlots.map((option) => createOption(option.value, option.display)),
    );
  };

  const showConfirmed = () => {
    if (isConfirmed) {
      return;
    }

    isConfirmed = true;
    action.setAttribute('heading', 'Delivery Rescheduled');

    const successStack = createElement('s-stack', {
      direction: 'block',
      gap: '@container (inline-size > 400px) base, small-300',
    });
    const banner = createElement('s-banner', { tone: 'success' });
    const slotLabel =
      state.rules.slots.find((option) => option.value === state.confirmedSlot)?.display ??
      state.confirmedSlot;
    banner.textContent = `Your delivery has been rescheduled to ${formatDisplayDate(state.confirmedDate)} (${slotLabel}).`;
    successStack.append(banner);

    // The form is done with — swap the whole content, and the form's two
    // buttons, for the confirmation. Focus retention no longer matters here.
    queryContainer.replaceChildren(successStack);
    confirmButton.remove();
    cancelButton.remove();

    const doneButton = createElement('s-button', {
      slot: 'primary-action',
    });
    doneButton.textContent = 'Done';
    doneButton.addEventListener('click', () => {
      shopifyApi.close();
    });
    action.append(doneButton);
  };

  const update = () => {
    if (state.confirmedDate) {
      showConfirmed();
      return;
    }

    intro.textContent = state.isLoadingRules
      ? 'Loading available delivery dates and time slots.'
      : 'Select a new delivery date and time slot. You can reschedule your delivery only once, so please choose carefully.';

    // Banners live between the intro and the date field, submit error first.
    syncBanner(availabilityBanner, state.availabilityMessage, dateField);
    syncBanner(
      errorBanner,
      state.submitError,
      availabilityBanner.parentNode === stack ? availabilityBanner : dateField,
    );

    dateField.setAttribute('allow', `${state.minDate}--${state.maxDate}`);
    setOptionalAttribute(dateField, 'disallow', state.disallowDates);
    setBooleanAttribute(
      dateField,
      'disabled',
      state.isLoadingRules || state.isSubmitting,
    );
    setOptionalAttribute(dateField, 'error', state.dateError);
    setElementValue(dateField, state.date);

    setBooleanAttribute(
      select,
      'disabled',
      state.isLoadingRules ||
        state.isSubmitting ||
        !state.date ||
        !state.availableSlots.length,
    );
    setOptionalAttribute(select, 'error', state.timeError);
    syncSlotOptions();
    setElementValue(select, state.timeSlot);

    const isBusy = state.isSubmitting || state.isLoadingRules;
    setBooleanAttribute(confirmButton, 'loading', isBusy);
    setBooleanAttribute(confirmButton, 'disabled', isBusy);
  };

  return { action, update };
}

async function submitReschedule(
  state: RescheduleState,
  shopifyApi: ShopifyActionApi,
  rerender: () => void,
) {
  let hasError = false;

  // Keep the local form checks aligned with the server rules so we can block empty
  // submissions immediately instead of always waiting for a round trip to fail.
  if (!state.date) {
    state.dateError = 'Please select a delivery date.';
    hasError = true;
  } else {
    state.dateError = '';
  }

  if (!state.timeSlot) {
    state.timeError = 'Please select a time slot.';
    hasError = true;
  } else {
    state.timeError = '';
  }

  if (hasError) {
    rerender();
    return;
  }

  const selectionValidation = validateDeliverySelection(
    state.rules,
    state.date,
    state.timeSlot,
  );
  if (!selectionValidation.ok) {
    applyRuleValidationFailure(state, {
      code: selectionValidation.code,
      message: selectionValidation.message,
      availableSlots: selectionValidation.availableSlots,
      minDate: selectionValidation.minDate,
      maxDate: selectionValidation.maxDate,
    });
    rerender();
    return;
  }

  state.isSubmitting = true;
  state.submitError = '';
  rerender();

  try {
    // Send the write through the app backend so the same auth, ownership, and
    // delivery-rule validation is enforced for every customer-account submission.
    const sessionToken = await getSessionToken(shopifyApi);

    const requestBody = new URLSearchParams({
      orderId: shopifyApi.orderId,
      date: state.date,
      timeSlot: state.timeSlot,
      sessionToken,
    });

    const response = await fetch(RESCHEDULE_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      body: requestBody,
    });

    const responseBody = (await response.json().catch(() => ({}))) as RescheduleErrorBody;
    if (!response.ok) {
      if (response.status === 422) {
        applyRuleValidationFailure(state, {
          code: responseBody.code,
          message: responseBody.error ?? `Request failed (${response.status})`,
          availableSlots: parseAvailableSlots(responseBody.availableSlots),
          minDate: responseBody.minDate,
          maxDate: responseBody.maxDate,
        });
      } else {
        state.submitError = responseBody.error ?? `Request failed (${response.status})`;
      }
      return;
    }

    // Move the modal into success state using the values that just saved instead of
    // waiting for the surrounding customer-account page to re-read the order.
    state.confirmedDate = state.date;
    state.confirmedSlot = state.timeSlot;
  } catch (error) {
    state.submitError =
      (error as Error).message ?? 'Something went wrong. Please try again.';
  } finally {
    state.isSubmitting = false;
    rerender();
  }
}

async function loadScheduleRules(
  state: RescheduleState,
  shopifyApi: ShopifyActionApi,
  rerender: () => void,
) {
  try {
    // Load availability from the backend so the reschedule modal stays aligned with
    // the same capacity and blackout rules used by the rest of the storefront flow.
    state.rules = await fetchScheduleRules(shopifyApi);
  } catch (error) {
    console.warn('Delivery rules fetch failed:', error);
    state.rules = cloneDeliveryScheduleRules(DEFAULT_DELIVERY_SCHEDULE_RULES);
  } finally {
    state.isLoadingRules = false;
    applyAvailabilityState(state);
    rerender();
  }
}

async function fetchScheduleRules(
  shopifyApi: ShopifyActionApi,
): Promise<DeliveryScheduleRules> {
  const sessionToken = await getSessionToken(shopifyApi);
  // Excludes this order's own current booking from the returned capacity
  // counts, same as the reschedule submit path — otherwise a slot this order
  // already occupies can read as "full" in the picker even though picking it
  // back would actually succeed.
  const requestBody = new URLSearchParams({
    sessionToken,
    orderId: shopifyApi.orderId,
  });

  const response = await fetch(SCHEDULE_RULES_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body: requestBody,
  });

  const responseBody = (await response.json().catch(() => ({}))) as {
    error?: string;
    rules?: unknown;
  };

  if (!response.ok) {
    throw new Error(responseBody.error ?? `Rules request failed (${response.status})`);
  }

  if (!isDeliveryScheduleRules(responseBody.rules)) {
    throw new Error('Invalid schedule rules response');
  }

  return cloneDeliveryScheduleRules(responseBody.rules);
}

async function getSessionToken(shopifyApi: ShopifyActionApi): Promise<string> {
  const sessionToken = await shopifyApi.sessionToken.get();

  // If the sandbox bridge is torn down mid-call, get() can resolve undefined;
  // sending that would reach the backend as the literal string "undefined" and
  // land as an unexplained 401 (observed in prod 2026-08-25). Fail loudly here
  // instead so the modal's own error handling reports something actionable.
  if (typeof sessionToken !== 'string' || sessionToken.trim() === '') {
    throw new Error('Session token unavailable. Please refresh the page.');
  }

  return sessionToken;
}

function applyAvailabilityState(state: RescheduleState) {
  state.minDate = getMinSelectableDate(state.rules);
  state.maxDate = getMaxSelectableDate(state.rules, state.minDate);
  state.disallowDates = getUnavailableDatesInWindow(state.rules).join(',');
  state.availabilityMessage = '';

  if (!state.date) {
    state.availableSlots = [];
    state.timeSlot = '';
    return;
  }

  const dateValidation = validateDeliveryDate(state.rules, state.date);
  if (dateValidation.ok) {
    state.availableSlots = dateValidation.availableSlots;
    if (!dateValidation.availableSlots.some((slot) => slot.value === state.timeSlot)) {
      state.timeSlot = '';
    }
    return;
  }

  state.availableSlots = dateValidation.availableSlots;
  state.timeSlot = '';
  state.availabilityMessage = dateValidation.message;

  if (dateValidation.code !== 'no_slots_available') {
    state.date = '';
  }
}

function applyRuleValidationFailure(
  state: RescheduleState,
  failure: {
    code?: DeliverySelectionValidationCode;
    message: string;
    availableSlots?: DeliveryScheduleSlot[];
    minDate?: string;
    maxDate?: string;
  },
) {
  if (failure.minDate) {
    state.minDate = failure.minDate;
  }
  if (failure.maxDate) {
    state.maxDate = failure.maxDate;
  }

  state.submitError = '';
  state.availabilityMessage = failure.message;

  if (failure.code === 'slot_unknown' || failure.code === 'slot_unavailable') {
    state.availableSlots = failure.availableSlots ?? state.availableSlots;
    state.timeSlot = '';
    return;
  }

  if (failure.code === 'no_slots_available') {
    state.availableSlots = [];
    state.timeSlot = '';
    return;
  }

  state.availableSlots = [];
  state.date = '';
  state.timeSlot = '';
}

function getTimeSlotPlaceholder(state: RescheduleState) {
  if (state.isLoadingRules) {
    return 'Loading time slots...';
  }

  if (!state.date) {
    return 'Select a delivery date first';
  }

  if (!state.availableSlots.length) {
    return 'No time slots available';
  }

  return 'Select a time slot';
}

type RescheduleErrorBody = {
  error?: string;
  code?: DeliverySelectionValidationCode;
  minDate?: string;
  maxDate?: string;
  availableSlots?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDeliveryScheduleRules(value: unknown): value is DeliveryScheduleRules {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.timezone === 'string' &&
    typeof value.cutoffHour === 'number' &&
    typeof value.prepHours === 'number' &&
    typeof value.maxDays === 'number' &&
    Array.isArray(value.slots) &&
    Array.isArray(value.disabledDates) &&
    isRecord(value.disabledSlots) &&
    isRecord(value.slotCapacity)
  );
}

function parseAvailableSlots(value: unknown): DeliveryScheduleSlot[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((slot) => {
    if (!isRecord(slot)) {
      return [];
    }

    if (typeof slot.display !== 'string' || typeof slot.value !== 'string') {
      return [];
    }

    return [{ display: slot.display, value: slot.value }];
  });
}

function createElement(tagName: string, attributes: Record<string, string>) {
  const element = document.createElement(tagName) as HTMLElement;
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  return element;
}

function createOption(value: string, label: string) {
  const option = createElement('s-option', { value });
  option.textContent = label;
  return option;
}

function setBooleanAttribute(element: HTMLElement, name: string, on: boolean) {
  // The customer-account sandbox's remote-DOM elements implement setAttribute /
  // removeAttribute but NOT the standard boolean-toggle DOM method — calling it
  // throws and takes the whole action modal down (prod incident 2026-08-25;
  // enforced repo-wide by test/extension-sandbox-dom-guard.test.ts).
  if (on) {
    element.setAttribute(name, '');
    return;
  }
  element.removeAttribute(name);
}

function setOptionalAttribute(element: HTMLElement, name: string, value: string) {
  if (value) {
    element.setAttribute(name, value);
    return;
  }

  // Update-in-place: the element outlives the state that set the attribute,
  // so an empty value has to clear it explicitly.
  element.removeAttribute(name);
}

function setElementValue(element: HTMLElement, value: string) {
  const control = element as HTMLElement & { value?: string };

  // Only touch the control when it genuinely differs — an update triggered by
  // another field must not rewrite (and so reset) the one being typed in.
  if (control.value !== value) {
    control.value = value;
  }

  if (value) {
    if (element.getAttribute('value') !== value) {
      element.setAttribute('value', value);
    }
    return;
  }

  element.removeAttribute('value');
}

function getEventValue(event: Event) {
  const target =
    (event.currentTarget as { value?: string } | null) ??
    (event.target as { value?: string } | null);

  return (target?.value ?? '').toString();
}
