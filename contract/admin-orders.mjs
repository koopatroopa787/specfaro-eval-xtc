// Behaviour contract for GET /admin/orders, separate from the regression test.
// From Stripe API version 2022-11-15 a PaymentIntent has no charges property and exposes
// latest_charge, which is null until a payment is attempted:
// https://docs.stripe.com/changelog/2022-11-15/removes-charges-attribute-paymentintent
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Module, { createRequire } from 'node:module';
import { once } from 'node:events';

const require = createRequire(import.meta.url);
const ADMIN_TOKEN = 'contract-admin-token';
const requests = [];

// Stripe client test double with the 2022-11-15 PaymentIntent shape: one paid intent and
// one intent that has not been paid yet (latest_charge null).
const fakeStripe = () => ({
  paymentIntents: {
    async list(params = {}) {
      requests.push(params);
      const expand = params.expand || [];
      if (expand.some((field) => field.split('.').includes('charges'))) {
        throw new Error('Invalid expand: PaymentIntent has no charges property (test double)');
      }
      const charge = { id: 'ch_contract_1', object: 'charge', billing_details: { name: 'Grace Hopper', email: 'grace@example.com', phone: null, address: null } };
      const intent = (id, status, latest) => ({
        id, object: 'payment_intent', amount: 6000, currency: 'gbp', status, created: 1760000000,
        receipt_email: null, metadata: {}, description: 'XTC Polo [White]', shipping: null, latest_charge: latest,
      });
      return {
        object: 'list',
        data: [
          intent('pi_paid', 'succeeded', expand.includes('data.latest_charge') ? charge : charge.id),
          intent('pi_unpaid', 'requires_payment_method', null),
        ],
      };
    },
  },
});

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
require('../server.js');
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

test('order listing expands latest_charge and never requests the removed charges field', async () => {
  requests.length = 0;
  await getOrders();
  const expand = requests.flatMap((params) => params.expand || []);
  assert.ok(expand.includes('data.latest_charge'), `expand was ${JSON.stringify(expand)}`);
  assert.ok(!expand.some((field) => field.split('.').includes('charges')), `expand was ${JSON.stringify(expand)}`);
});

test('an unpaid PaymentIntent without a charge is still listed', async () => {
  const { status, body } = await getOrders();
  assert.equal(status, 200, `admin orders failed: ${JSON.stringify(body)}`);
  const unpaid = body.orders.find((order) => order.id === 'pi_unpaid');
  assert.equal(unpaid?.billing, null);
  assert.equal(unpaid?.receipt_email, '');
  assert.equal(body.orders.find((order) => order.id === 'pi_paid')?.billing?.name, 'Grace Hopper');
});
