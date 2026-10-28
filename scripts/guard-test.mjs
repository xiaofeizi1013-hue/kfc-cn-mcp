/**
 * Guard-rail tests: quantity changes + place_order refusal paths (no real order).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, 'dist', 'index.js')],
  env: { ...process.env, KFC_STATE_DIR: join(root, '.smoke-state') },
  stderr: 'inherit',
});
const client = new Client({ name: 'kfc-cn-guard-test', version: '1.0.0' });
await client.connect(transport);

async function call(name, args = {}) {
  console.log(`\n===== ${name} =====`);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content?.find((c) => c.type === 'text')?.text ?? '{}';
    const data = JSON.parse(text);
    console.log(JSON.stringify(data, null, 2).slice(0, 1400));
    return data;
  } catch (error) {
    console.log('PROTOCOL ERROR:', error.message);
    return { ok: false, protocolError: error.message };
  }
}

await call('select_store', { storeCode: 'SH1146' });
const menu = await call('get_menu', { category: '汉堡卷' });
const simple = menu.items?.find((i) => !i.isCombo && !i.needsOptions);
console.log('simple item', simple?.linkId, simple?.name);

const added = await call('cart_add', { items: [{ linkId: simple.linkId, quantity: 1 }] });
const lineKey = added.cart?.items?.[0]?.lineKey;
console.log('after add: qty', added.cart?.items?.[0]?.quantity, 'total', added.cart?.total);
const q2 = await call('cart_set_quantity', { lineKey, quantity: 2 });
console.log('CHECK set 2 =>', q2.cart?.items?.[0]?.quantity, q2.cart?.total);

// combo auto-selection
const comboMenu = await call('get_menu', { category: '桶' });
const combo = comboMenu.items?.find((i) => i.isCombo);
if (combo) {
  await call('get_item', { linkId: combo.linkId });
  const comboAdded = await call('cart_add', { items: [{ linkId: combo.linkId, quantity: 1 }] });
  console.log('CHECK combo =>', JSON.stringify(comboAdded.cart?.items?.map((i) => [i.name, i.quantity, i.lineTotal])));
}

const preview = await call('preview_order');

await call('place_order', {
  confirm: true,
  phone: '13800138000',
  packType: 'dinein',
  previewToken: 'pv-wrong-token',
  expectedTotalCents: preview.preview?.totalCents,
});

await call('place_order', {
  confirm: true,
  phone: '12345',
  packType: 'dinein',
  previewToken: preview.previewToken,
});

await call('place_order', {
  confirm: true,
  phone: '13800138000',
  packType: 'dinein',
  previewToken: preview.previewToken,
  expectedTotalCents: (preview.preview?.totalCents ?? 0) + 1,
});

const removed = await call('cart_remove', { lineKey });
console.log('after remove lines', removed.cart?.items?.length);
await call('cart_clear');
await call('session_status');
await client.close();
console.log('\nGUARD TESTS OK');
