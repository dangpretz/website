const SQUARE_BASE = 'https://connect.squareup.com/v2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    try {
      const body = await request.json();
      const { items, fulfillment, customer } = body;

      // Validate required fields
      if (!items?.length) return json({ error: 'No items in order' }, 400);
      if (!fulfillment?.type) return json({ error: 'Fulfillment type required' }, 400);
      if (!fulfillment?.date || !fulfillment?.time) return json({ error: 'Date and time required' }, 400);
      if (!customer?.name || !customer?.email || !customer?.phone) {
        return json({ error: 'Name, email, and phone required' }, 400);
      }

      // Build order line items from catalog variation IDs
      const lineItems = items.map(item => ({
        catalog_object_id: item.variationId,
        quantity: String(item.quantity),
      }));

      // Add delivery fee if delivery
      if (fulfillment.type === 'delivery') {
        lineItems.push({
          name: 'Delivery Fee',
          quantity: '1',
          base_price_money: { amount: 7500, currency: 'USD' },
        });
      }

      // Build the order note
      const noteLines = [
        `Fulfillment: ${fulfillment.type.toUpperCase()}`,
        `Date/Time: ${fulfillment.date} at ${fulfillment.time}`,
      ];
      if (fulfillment.type === 'delivery' && fulfillment.address) {
        noteLines.push(`Delivery Address: ${fulfillment.address}`);
      }
      if (customer.notes) {
        noteLines.push(`Notes: ${customer.notes}`);
      }

      // Normalize phone to E.164 format for Square
      const phoneDigits = customer.phone.replace(/\D/g, '');
      const e164Phone = phoneDigits.length === 10 ? `+1${phoneDigits}` :
                         phoneDigits.length === 11 && phoneDigits.startsWith('1') ? `+${phoneDigits}` :
                         `+${phoneDigits}`;

      // Create Square Payment Link
      const idempotencyKey = crypto.randomUUID();
      const locationId = env.SQUARE_LOCATION_ID || 'LEJ3PDZ9V6NYN';

      const paymentLinkBody = {
        idempotency_key: idempotencyKey,
        order: {
          location_id: locationId,
          line_items: lineItems,
          note: noteLines.join('\n'),
        },
        checkout_options: {
          allow_tipping: true,
          accepted_payment_methods: {
            apple_pay: true,
            google_pay: true,
            cash_app_pay: true,
          },
          redirect_url: 'https://www.dangerouspretzel.com/v2/catering-confirmed.html',
        },
        pre_populated_data: {
          buyer_email: customer.email,
          buyer_phone_number: e164Phone,
        },
      };

      const sqRes = await fetch(`${SQUARE_BASE}/online-checkout/payment-links`, {
        method: 'POST',
        headers: {
          'Square-Version': '2025-01-23',
          'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(paymentLinkBody),
      });

      const sqData = await sqRes.json();

      if (!sqRes.ok) {
        console.error('Square API error:', JSON.stringify(sqData));
        return json({ error: 'Failed to create checkout', details: sqData.errors }, 500);
      }

      // Extract order ID (may be a string or object with .id)
      const rawOrder = sqData.related_resources?.orders?.[0];
      const orderId = typeof rawOrder === 'string' ? rawOrder : rawOrder?.id || null;

      // Send email alert to the team (fire-and-forget)
      const itemSummary = items.map(i => `${i.name || i.variationId} x${i.quantity}`).join(', ');
      sendOrderAlert({
        customer,
        fulfillment,
        itemSummary,
        checkoutUrl: sqData.payment_link.url,
        orderId: orderId || 'N/A',
      }).catch(err => console.error('Email alert failed:', err));

      return json({
        checkout_url: sqData.payment_link.url,
        order_id: orderId,
      });

    } catch (err) {
      console.error('Worker error:', err);
      return json({ error: 'Internal server error' }, 500);
    }
  },
};

async function sendOrderAlert({ customer, fulfillment, itemSummary, checkoutUrl, orderId }) {
  const formData = new FormData();
  formData.append('_subject', `New Catering Order — ${customer.name}`);
  formData.append('Customer', customer.name);
  formData.append('Email', customer.email);
  formData.append('Phone', customer.phone);
  formData.append('Items', itemSummary);
  formData.append('Fulfillment', fulfillment.type.toUpperCase());
  formData.append('Date/Time', `${fulfillment.date} at ${fulfillment.time}`);
  if (fulfillment.type === 'delivery' && fulfillment.address) {
    formData.append('Delivery Address', fulfillment.address);
  }
  if (customer.notes) {
    formData.append('Notes', customer.notes);
  }
  formData.append('Order ID', orderId);
  formData.append('_template', 'table');

  await fetch('https://formsubmit.co/ajax/info@dangerouspretzel.com', {
    method: 'POST',
    body: formData,
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}
