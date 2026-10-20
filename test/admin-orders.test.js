'use strict';
// Regression test for GET /admin/orders against current Stripe PaymentIntent objects.
// Stripe API version 2022-11-15 removed PaymentIntent.charges and added latest_charge:
// https://docs.stripe.com/changelog/2022-11-15/removes-charges-attribute-paymentintent
// The locked stripe package (14.25.0) sets no older apiVersion, so requests use its pinned
// version, which is later than 2022-11-15.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const path = require('node:path');
const { once } = require('node:events');

const ADMIN_TOKEN = 'test-admin-token';
const BILLING = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: null,
  address: { city: 'London', country: 'GB', line1: '1 Example Street', line2: null, postal_code: 'N1 1AA', state: null },
};

// Test double for the Stripe client, following the documented PaymentIntent shape from
// 2022-11-15: there is no charges property to expand, and latest_charge is a charge ID
// unless the request expands it.
function fakeStripe() {
  return {
    paymentIntents: {
      async list(params = {}) {
        const expand = params.expand || [];
        if (expand.some((field) => field.split('.').includes('charges'))) {
          const error = new Error('Invalid expand: PaymentIntent has no charges property (test double)');
          error.type = 'StripeInvalidRequestError';
          throw error;
        }
        const charge = { id: 'ch_test_1', object: 'charge', billing_details: BILLING };
        return {
          object: 'list',
          data: [{
            id: 'pi_test_1', object: 'payment_intent', amount: 6000, currency: 'gbp',
            status: 'succeeded', created: 1760000000, receipt_email: null, metadata: {},
            description: 'XTC Polo [Black]', shipping: null,
            latest_charge: expand.includes('data.latest_charge') ? charge : charge.id,
          }],
        };
      },
    },
  };
}

// server.js builds its clients and starts listening on import; replace the external
// clients and bind an ephemeral local port instead.
const stubs = {
  stripe: () => fakeStripe(),
  '@supabase/supabase-js': { createClient: () => ({ from() { throw new Error('Supabase is not used here'); } }) },
  ws: function WebSocket() {},
};
const load = Module._load;
Module._load = function (request, ...rest) {
  return Object.hasOwn(stubs, request) ? stubs[request] : load.call(this, request, ...rest);
};
let server;
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function () {
  server = this;
  return listen.call(this, 0, '127.0.0.1');
};
process.env.ADMIN_TOKEN = ADMIN_TOKEN;
require(path.join(__dirname, '..', 'server.js'));
http.Server.prototype.listen = listen;
Module._load = load;

async function getOrders() {
  if (!server.listening) await once(server, 'listening');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/admin/orders`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  return { status: response.status, body: await response.json() };
}

test.after(() => server.close());

test('GET /admin/orders loads orders on Stripe API 2022-11-15 and later', async () => {
  const { status, body } = await getOrders();
  assert.equal(status, 200, `admin orders failed: ${JSON.stringify(body)}`);
  assert.equal(body.orders.length, 1);
  assert.equal(body.orders[0].id, 'pi_test_1');
});

test('GET /admin/orders reads billing details from latest_charge on Stripe API 2022-11-15 and later', async () => {
  const { body } = await getOrders();
  const [order] = body.orders || [];
  assert.equal(order?.receipt_email, BILLING.email);
  assert.deepEqual(order?.billing, BILLING);
});
