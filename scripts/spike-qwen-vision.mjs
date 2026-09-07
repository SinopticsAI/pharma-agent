/**
 * Short Studio probe: one data-URI jpeg, thinking off.
 * Usage: node --env-file=.env scripts/spike-qwen-vision.mjs
 */
const BASE = process.env.AI_STUDIO_BASE_URL ?? 'https://llm.api.cloud.yandex.net/v1';
const KEY = process.env.AI_STUDIO_API_KEY ?? '';
const FOLDER = process.env.FOLDER_ID ?? '';
const MODEL = process.env.AGENT_MODEL ?? 'qwen3.6-35b-a3b';
const model = MODEL.includes('://') ? MODEL : FOLDER ? `gpt://${FOLDER}/${MODEL}` : MODEL;

// 1×1 jpeg — enough to see whether Studio accepts image_url as a data URI.
const PIXEL =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGf/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPwB//9k=';

if (!KEY) {
  console.error('AI_STUDIO_API_KEY is empty; skip spike');
  process.exit(2);
}

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
    reasoning_options: { mode: 'DISABLED' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Reply with JSON {"ok":true,"kind":"image"} if you see an image. No markdown.' },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${PIXEL}` } },
        ],
      },
    ],
  }),
});

const text = await response.text();
console.log('status', response.status);
console.log(text.slice(0, 800));
if (!response.ok) process.exit(1);
