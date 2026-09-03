// Reference implementation: a Shopify Web Pixels API custom pixel covering
// the CHECKOUT stage of the funnel specifically.
//
// This is meant to be pasted into Shopify Admin > Settings > Customer Events
// > Add custom pixel, on a live store, not run by this repo's own app. It's
// kept here as a reference/reusable template.
//
// SCOPE, deliberately narrow: only checkout_started through
// checkout_completed are here. Page views, product views, collection views,
// search, add-to-cart, and cart views all happen on the storefront domain,
// where a normal GTM container reading Shopify's native theme dataLayer
// already sees them fine, subscribing to those again here would double-track
// every one of them through two separate mechanisms.
// The checkout stage is different: Shopify's checkout runs on its own
// separate, locked domain that a theme-injected GTM container can never
// reach at all. That's the one gap this pixel exists to close, not a
// replacement for the storefront tracking that already works.
//
// Standard event names below match Shopify's own Web Pixels API standard
// events as documented at the time this was written — verify against
// Shopify's current docs before deploying, this list can change with
// platform updates. Search "Shopify Web Pixels API standard events" if in
// doubt.

const ENDPOINT = 'https://your-server-container-url.example/pixel-events'; // swap for your real endpoint (e.g. your Stape server container URL)

// One shared sender so every subscription below stays identical in how it
// reports data — change the transport once, not in six places.
function send(eventName, data) {
  try {
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true, // lets the request complete even if the page is navigating away right after
      body: JSON.stringify({
        event_name: eventName,
        occurred_at: data?.timestamp || new Date().toISOString(),
        client_id: analytics?.visitorId, // Shopify's own visitor identifier, available inside the pixel sandbox
        data,
      }),
    }).catch(() => {}); // pixel sandbox: a failed send should never throw and break the storefront
  } catch {
    // same reasoning — never let a tracking call break the page
  }
}

// ---- Checkout funnel (the domain GTM structurally can't reach) ----
analytics.subscribe('checkout_started', (event) => {
  send('checkout_started', { checkout_id: event.data?.checkout?.token, value: event.data?.checkout?.totalPrice?.amount });
});

analytics.subscribe('checkout_contact_info_submitted', (event) => {
  send('checkout_contact_info_submitted', { checkout_id: event.data?.checkout?.token });
});

analytics.subscribe('checkout_address_info_submitted', (event) => {
  send('checkout_address_info_submitted', { checkout_id: event.data?.checkout?.token });
});

analytics.subscribe('checkout_shipping_info_submitted', (event) => {
  send('checkout_shipping_info_submitted', { checkout_id: event.data?.checkout?.token });
});

analytics.subscribe('payment_info_submitted', (event) => {
  send('payment_info_submitted', { checkout_id: event.data?.checkout?.token });
});

// ---- Bottom of funnel — the one event most custom pixels stop at ----
analytics.subscribe('checkout_completed', (event) => {
  const checkout = event.data?.checkout;
  send('checkout_completed', {
    checkout_id: checkout?.token,
    order_id: checkout?.order?.id,
    value: checkout?.totalPrice?.amount,
    currency: checkout?.totalPrice?.currencyCode,
    items: checkout?.lineItems?.map((li) => ({
      product_id: li.variant?.product?.id,
      variant_id: li.variant?.id,
      quantity: li.quantity,
      price: li.variant?.price?.amount,
    })),
  });
});
