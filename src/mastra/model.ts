/**
 * Yandex AI Studio through its OpenAI-compatible endpoint — the same one the
 * Plane pipeline already uses, so there is one model contour and one key.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const BASE_URL = process.env.AI_STUDIO_BASE_URL ?? 'https://llm.api.cloud.yandex.net/v1';
const FOLDER_ID = process.env.FOLDER_ID ?? '';
const MODEL_NAME = process.env.AGENT_MODEL ?? 'qwen3.6-35b-a3b';

const provider = createOpenAICompatible({
  name: 'yandex-ai-studio',
  baseURL: BASE_URL,
  headers: {
    Authorization: `Api-Key ${process.env.AI_STUDIO_API_KEY ?? ''}`,
    ...(FOLDER_ID ? { 'x-folder-id': FOLDER_ID } : {}),
  },
});

/** AI Studio addresses models as gpt://<folder>/<model>. */
function modelUri(name: string): string {
  if (name.includes('://')) return name;
  return FOLDER_ID ? `gpt://${FOLDER_ID}/${name}` : name;
}

export const MODEL = provider(modelUri(MODEL_NAME));
export const MODEL_ID = modelUri(MODEL_NAME);
