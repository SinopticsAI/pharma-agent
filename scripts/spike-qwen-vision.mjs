/**
 * Short Studio probe: one real scan, thinking off.
 * Usage: node --env-file=.env scripts/spike-qwen-vision.mjs <path-to-scan.jpg>
 *
 * A synthetic 1×1 jpeg is not a valid probe: Studio answers 500 on it, which
 * reads exactly like «the model cannot take images» and cost a day of
 * diagnosis. Point this at a file a person would actually upload.
 */
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

const BASE = process.env.AI_STUDIO_BASE_URL ?? 'https://llm.api.cloud.yandex.net/v1';
const KEY = process.env.AI_STUDIO_API_KEY ?? '';
const FOLDER = process.env.FOLDER_ID ?? '';
const MODEL = process.env.AGENT_MODEL ?? 'qwen3.6-35b-a3b';
const model = MODEL.includes('://') ? MODEL : FOLDER ? `gpt://${FOLDER}/${MODEL}` : MODEL;

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

if (!KEY) {
  console.error('AI_STUDIO_API_KEY is empty; skip spike');
  process.exit(2);
}

const path = process.argv[2];
if (!path) {
  console.error('usage: node scripts/spike-qwen-vision.mjs <path-to-scan.jpg>');
  process.exit(2);
}

const mime = MIME[extname(path).toLowerCase()];
if (!mime) {
  console.error(`${path}: intake takes jpeg, png or webp`);
  process.exit(2);
}

const bytes = readFileSync(path);
console.log(`${path}: ${bytes.byteLength} bytes as ${mime}`);

const started = Date.now();
const response = await fetch(`${BASE.replace(/\/$/, '')}/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Api-Key ${KEY}`,
    ...(FOLDER ? { 'x-folder-id': FOLDER } : {}),
  },
  body: JSON.stringify({
    model,
    temperature: 0,
    max_tokens: 4096,
    // The one switch this endpoint honours. reasoning_options / enable_thinking
    // / extra_body all come back 400, and /no_think in the prompt is ignored.
    reasoning_effort: 'none',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Read this 营业执照 and return JSON with company_name and unified_social_credit_code. No markdown.',
          },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } },
        ],
      },
    ],
  }),
});

const text = await response.text();
console.log('status', response.status, `in ${Date.now() - started}ms`);
if (!response.ok) {
  console.log(text.slice(0, 800));
  process.exit(1);
}

const body = JSON.parse(text);
const message = body.choices?.[0]?.message ?? {};
// Thinking left on shows up here and empties content — that is the failure mode.
console.log('thinking', String(message.reasoning_content ?? '').length, 'chars');
console.log('content', String(message.content ?? '').slice(0, 800));
