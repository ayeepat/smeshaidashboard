import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

assert.doesNotMatch(app, /(?:localStorage|sessionStorage)\.setItem\([^\n]*(?:token|secret|key)/i,
  'dashboard bearer credentials must never be persisted in Web Storage');
assert.match(app, /let token = '';\s*\nlet modelToken = '';/,
  'both dashboard credentials must start in memory only');
for (const legacyKey of ['smesh_admin_token', 'smesh_stats_token', 'smesh_model_admin_token']) {
  assert.ok(app.includes(`'${legacyKey}'`), `legacy persisted ${legacyKey} must be cleared`);
}
assert.doesNotMatch(html, /rememberToken|Запомнить на этом устройстве/,
  'the UI must not offer unsafe persistence on the shared GitHub Pages origin');
assert.match(app, /activeModels\.find\(\(model\) => \/\^gemini/,
  'dashboard must reject child-restricted Gemini models before saving');
assert.match(app, /d\.key_hint \|\| '—'/,
  'the device drawer must render only the backend-provided license hint');
assert.doesNotMatch(app, /d\.license_key \|\|/,
  'the device drawer must not expect a raw bearer license key');

console.log('dashboard security regression passed');
