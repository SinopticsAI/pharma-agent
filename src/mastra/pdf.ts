/**
 * A PDF on its way to a model that takes only images and text.
 *
 * Studio's contour accepts two content parts and no more: `text`, and an
 * `image_url` whose data URI starts with `data:image/`. A PDF sent as
 * `data:application/pdf`, as `file` or as `input_file` comes back 400. So a
 * digital PDF travels as its own text, and a scanned one as rendered pages.
 *
 * PDF.js and the canvas are imported lazily: a photo is the common case and
 * must not pay for them, and the extract tests read the pure modules without
 * these dependencies installed.
 */

import { type VisionPayload } from './extract-schemas';
import { EdgeError } from './tools/edge';

/** Below this a page is a picture of text, not text. Measured: digital invoices give 500+. */
const TEXT_MIN_CHARS = 200;
/** A read licence is around 600 characters; this leaves an IFU room without crowding out the answer. */
const TEXT_MAX_CHARS = 20_000;
/**
 * Two rendered pages read reliably and the key fields live on the first ones.
 * More pages only enlarge the request without adding anything the card needs.
 */
const MAX_PAGES = 2;
/** 1.5 keeps a 900x1200 page: enough for a stamp, ~130 KB as jpeg. */
const RENDER_SCALE = 1.5;
const JPEG_QUALITY = 80;

function mergedText(text: string | string[]): string {
  return (Array.isArray(text) ? text.join('\n') : text).trim();
}

/**
 * unpdf renders to PNG. A scanned page is a photograph, and as PNG it costs
 * megabytes where jpeg costs ~130 KB, so it is re-encoded through the canvas
 * we already depend on for rendering.
 */
async function toJpeg(png: ArrayBuffer): Promise<Uint8Array> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const image = await loadImage(Buffer.from(png));
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext('2d').drawImage(image, 0, 0);
  return new Uint8Array(await canvas.encode('jpeg', JPEG_QUALITY));
}

/** Text when the PDF carries it, the first pages as jpeg when it does not. */
export async function preparePdf(bytes: Uint8Array): Promise<VisionPayload> {
  // unpdf's own build, not pdfjs-dist: the official build of PDF.js 6 calls
  // Uint8Array.prototype.toHex, which neither Node 22 in the image nor Node 24
  // has, and every page fails with «hashOriginal.toHex is not a function».
  // Rendering through the bundled build is byte-identical to the legacy one.
  const { extractText, getDocumentProxy, renderPageAsImage } = await import('unpdf');

  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(bytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new EdgeError(415, 'wrong_format', `PDF could not be opened: ${detail.slice(0, 120)}`);
  }

  const { text } = await extractText(pdf, { mergePages: true });
  const readable = mergedText(text);
  if (readable.length >= TEXT_MIN_CHARS) {
    return { kind: 'text', text: readable.slice(0, TEXT_MAX_CHARS) };
  }

  const pages: Uint8Array[] = [];
  const last = Math.min(pdf.numPages, MAX_PAGES);
  for (let page = 1; page <= last; page += 1) {
    const png = await renderPageAsImage(pdf, page, {
      canvasImport: () => import('@napi-rs/canvas'),
      scale: RENDER_SCALE,
    });
    pages.push(await toJpeg(png as ArrayBuffer));
  }

  if (!pages.length) {
    throw new EdgeError(415, 'wrong_format', 'the PDF has no text and no page to render');
  }
  return { kind: 'images', mime: 'image/jpeg', pages };
}
