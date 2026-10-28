/**
 * End-to-end smoke test against the real KFC China API (read-only + cart).
 * It never calls place_order.
 *
 *   node scripts/smoke.mjs
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
  env: {
    ...process.env,
    KFC_STATE_DIR: join(root, '.smoke-state'),
    KFC_CITY_CODE: process.env.KFC_CITY_CODE || '310100',
  },
  stderr: 'inherit',
});

const client = new Client({ name: 'kfc-cn-smoke', version: '1.0.0' });

function text(result) {
  const first = result.content?.find((c) => c.type === 'text');
  return first ? JSON.parse(first.text) : result;
}

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const data = text(result);
  console.log(`\n===== ${name} =====`);
  console.log(JSON.stringify(data, null, 2).slice(0, 2200));
  return data;
}

await client.connect(transport);
const tools = await client.listTools();
console.log('TOOLS:', tools.tools.map((t) => t.name).join(', '));

await call('session_status');
const stores = await call('find_stores', { keyword: '淮海路', cityCode: '310100', limit: 3 });
const storeCode = stores.stores?.[0]?.storeCode ?? process.argv[2];
if (!storeCode) throw new Error('no store found');
await call('select_store', { storeCode });
const menu = await call('get_menu', { category: '汉堡卷' });
const firstItem = menu.items?.[0];
if (firstItem) {
  await call('get_item', { linkId: firstItem.linkId });
  await call('cart_add', { items: [{ linkId: firstItem.linkId, quantity: 1 }] });
  await call('cart_view');
  await call('preview_order');
  await call('cart_clear');
}
await call('session_status');
await client.close();
console.log('\nSMOKE OK');
