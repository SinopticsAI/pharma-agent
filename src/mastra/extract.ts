/**
 * Intake OCR outside the chat turn: download the scan from the bucket via
 * Edge, ask Qwen to read it, write the result back through the Plane webhook
 * contract. Bytes never enter /chat.
 */

import {
  extractFailureKind,
  extractFailureReason,
  isDegenerateAnswer,
  type ExtractFailure,
} from './extract-reason';
import {
  isItemType,
  scanKind,
  visionRequestBody,
  type ItemType,
  type VisionPayload,
} from './extract-schemas';
import { normalizeVisionFields, recoverItemType } from './license-fields';
import { MODEL_ID } from './model';
import { preparePdf } from './pdf';
import { edge, EdgeError, type CallContext } from './tools/edge';

const MAX_BYTES = 4 * 1024 * 1024;
/** Container hard-kills at 300s (499). Abort vision earlier so the webhook can close the item. */
export const EXTRACT_VISION_MS = 90_000;

export { scanKind };

export interface ExtractInput {
  organizationId: string;
  itemId: string;
  caller: CallContext;
}

export interface ExtractResult {
  itemId: string;
  status: 'parsed' | 'rejected';
  itemType: string;
  unreadable: boolean;
}

interface OrgItem {
  id: string;
  organizationId: string;
  productId?: string;
  level?: string;
  itemType: string;
  fileName: string;
  status: string;
}

interface DownloadTicket {
  url: string;
  fileName: string;
  expiresIn: number;
}

interface VisionResult {
  itemType: ItemType;
  extracted: Record<string, string | null>;
  unreadable: boolean;
  reason?: string;
}

function asItems(data: unknown): OrgItem[] {
  if (Array.isArray(data)) return data as OrgItem[];
  return [];
}

async function writeItem(
  organizationId: string,
  itemId: string,
  caller: CallContext,
  body: {
    status: 'parsed' | 'rejected';
    itemType?: string;
    parced: Record<string, unknown>;
  },
): Promise<void> {
  await edge(
    `/webhooks/cases/intake-${organizationId}/items/${itemId}/update`,
    {
      method: 'POST',
      body: {
        messageId: `extract-${itemId}-${Date.now()}`,
        status: body.status,
        itemType: body.itemType,
        parced_data: body.parced,
      },
    },
    caller,
  );
}

async function readScan(url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new EdgeError(response.status, 'download_failed', `presigned GET ${response.status}`);
  }
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_BYTES) {
    throw new EdgeError(413, 'too_large', `scan is ${length} bytes; intake extract accepts up to ${MAX_BYTES}`);
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > MAX_BYTES) {
    throw new EdgeError(413, 'too_large', `scan is ${buffer.byteLength} bytes; intake extract accepts up to ${MAX_BYTES}`);
  }
  return {
    bytes: buffer,
    contentType: response.headers.get('content-type') ?? '',
  };
}

function firstJsonObject(raw: string): string {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function messageText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text?: unknown }).text ?? '');
        }
        return '';
      })
      .join('');
  }
  return JSON.stringify(raw ?? {});
}

function parseVision(raw: string): VisionResult {
  const parsed = JSON.parse(firstJsonObject(raw)) as Record<string, unknown>;
  const itemType =
    typeof parsed.itemType === 'string' && isItemType(parsed.itemType) ? parsed.itemType : 'other';
  const { extracted, unreadable } = normalizeVisionFields(parsed);
  return {
    itemType,
    extracted,
    unreadable,
    reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
  };
}

async function callQwen(
  payload: VisionPayload,
  hintedType: string,
  signal?: AbortSignal,
): Promise<VisionResult> {
  const base = process.env.AI_STUDIO_BASE_URL ?? 'https://llm.api.cloud.yandex.net/v1';
  const key = process.env.AI_STUDIO_API_KEY ?? '';
  if (!key) throw new EdgeError(503, 'not_configured', 'AI_STUDIO_API_KEY must be set');

  const response = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Api-Key ${key}`,
      ...(process.env.FOLDER_ID ? { 'x-folder-id': process.env.FOLDER_ID } : {}),
    },
    body: JSON.stringify(visionRequestBody({ model: MODEL_ID, hintedType, payload })),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new EdgeError(response.status, 'vision_failed', text.slice(0, 400));
  }
  let content = '';
  try {
    const body = JSON.parse(text) as {
      choices?: { message?: { content?: unknown; reasoning_content?: unknown } }[];
    };
    const message = body.choices?.[0]?.message;
    content = messageText(message?.content) || messageText(message?.reasoning_content);
  } catch {
    throw new EdgeError(502, 'vision_failed', text.slice(0, 400));
  }
  if (isDegenerateAnswer(content)) {
    throw new EdgeError(502, 'vision_empty', `model answered with nothing: ${content.slice(0, 120)}`);
  }
  try {
    return parseVision(content);
  } catch {
    throw new EdgeError(502, 'vision_failed', `model did not return JSON: ${content.slice(0, 200)}`);
  }
}

/**
 * The contour degenerates into an empty answer now and then, on a scan it read
 * perfectly a moment earlier. One retry costs a few seconds; treating it as an
 * unreadable document costs the person another upload.
 */
async function askVision(
  payload: VisionPayload,
  hintedType: string,
  signal?: AbortSignal,
): Promise<VisionResult> {
  try {
    return await callQwen(payload, hintedType, signal);
  } catch (error) {
    if (!(error instanceof EdgeError) || error.code !== 'vision_empty') throw error;
    return await callQwen(payload, hintedType, signal);
  }
}

export async function extractDocument(input: ExtractInput): Promise<ExtractResult> {
  const organizationId = input.organizationId.trim();
  const itemId = input.itemId.trim();
  if (!organizationId || !itemId) {
    throw new EdgeError(400, 'missing_id', 'organizationId and itemId are required');
  }

  const items = asItems(await edge(`/organizations/${organizationId}/items`, {}, input.caller));
  const item = items.find((row) => row.id === itemId);
  if (!item) throw new EdgeError(404, 'not_found', `item ${itemId} not found`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXTRACT_VISION_MS);
  try {
    const ticket = await edge<DownloadTicket>(
      `/organizations/${organizationId}/items/${itemId}/download-url`,
      { method: 'POST' },
      input.caller,
    );

    const scan = await readScan(ticket.url);
    const kind = scanKind(item.fileName || ticket.fileName, scan.contentType);
    if (!kind.ok) {
      // Office files and TIFF only. A PDF gets here and is read below.
      throw new EdgeError(415, 'wrong_format', `${item.fileName || ticket.fileName} is not a photo or a PDF`);
    }

    // Studio takes images and text, never PDF bytes: a PDF becomes its own
    // text, or its first pages rendered as jpeg.
    const payload: VisionPayload = kind.pdf
      ? await preparePdf(scan.bytes)
      : { kind: 'images', mime: kind.mime, pages: [scan.bytes] };

    const vision = await askVision(payload, item.itemType, controller.signal);
    const itemType = recoverItemType(item.itemType, vision.extracted, vision.itemType, item.fileName);
    const status = vision.unreadable ? 'rejected' : 'parsed';
    console.log(
      '[EXTRACT]',
      JSON.stringify({
        itemId,
        organizationId,
        mime: kind.mime,
        bytes: scan.bytes.byteLength,
        read: payload.kind === 'text' ? 'pdf-text' : kind.pdf ? 'pdf-pages' : 'photo',
        ...(payload.kind === 'images' && kind.pdf ? { pages: payload.pages.length } : {}),
        itemType,
        unreadable: vision.unreadable,
        keys: Object.keys(vision.extracted),
        reason: vision.reason,
        // The model answered, so a rejection here really is about the scan.
        ...(vision.unreadable ? { failure: 'unreadable' as const } : {}),
        status,
      }),
    );
    await writeItem(organizationId, itemId, input.caller, {
      status,
      itemType,
      parced: {
        case_id: `intake-${organizationId}`,
        item_id: itemId,
        item_type: itemType,
        extracted: vision.extracted,
        ocr_json: vision.extracted,
        status: vision.unreadable ? 'unreadable' : 'ok',
        merge_meta: { source: 'pharma-agent', model: MODEL_ID },
        reason: vision.reason,
        ...(vision.unreadable ? { failure: 'unreadable' as const } : {}),
      },
    });
    return { itemId, status, itemType, unreadable: vision.unreadable };
  } catch (error) {
    const reason = extractFailureReason(error);
    const failure: ExtractFailure = extractFailureKind(error);
    console.log(
      '[EXTRACT]',
      JSON.stringify({
        itemId,
        organizationId,
        unreadable: true,
        keys: [],
        reason,
        failure,
        status: 'rejected',
      }),
    );
    await writeItem(organizationId, itemId, input.caller, {
      status: 'rejected',
      parced: { status: 'rejected', reason, failure },
    });
    return { itemId, status: 'rejected', itemType: item.itemType, unreadable: true };
  } finally {
    clearTimeout(timer);
  }
}

export { extractFailureKind, extractFailureReason };
