// High-level quote orchestration module for TeleBox.
//
// This is a faithful port of TeleBoxOrg/quote-api `methods/generate.js`
// (the upstream that TeleBox's vendor/ tree was extracted from), adapted for
// in-plugin use:
//   * requires point at ./vendor/* instead of ../utils/*
//   * the pattern asset is resolved from process.cwd()/assets/quote
//     (where quote.ts downloads/stores assets) instead of repo-root /assets
//   * exports the named method `generateQuote` that quote.ts calls, and always
//     returns `image` as a Buffer (quote.ts does fs.writeFileSync(out, image))
//
// Contract expected by quote.ts:
//   generateQuote({ messages, type, format, scale, backgroundColor, emojiBrand })
//     -> { image: Buffer, ext: string, type, width, height }

const path = require("path");
const { QuoteGenerate } = require("./vendor/index.js");
const { createCanvas, loadImage } = require("canvas");
const sharp = require("sharp");
const { parseBackgroundColor, colorLuminance } = require("./vendor/quote-generate/color");
const { brands: emojiBrands } = require("./vendor/emoji-image");

// quote.ts only downloads the CJK font files into assets/quote — it never
// registers them with node-canvas. Font registration MUST happen here (once)
// before any canvas text is drawn, or CJK glyphs render as tofu boxes.
let fontsLoaded = false;
async function ensureFonts() {
  if (fontsLoaded) return;
  try {
    await QuoteGenerate.loadFonts();
  } catch (error) {
    console.warn("quote generate: loadFonts failed", error && error.message);
  }
  fontsLoaded = true;
}

const ALLOWED_EMOJI_BRANDS = new Set(Object.keys(emojiBrands));

const QUOTE_ASSETS_DIR = path.join(process.cwd(), "assets", "quote");

let cachedPatternImage = null;
async function getPatternImage() {
  if (!cachedPatternImage) {
    cachedPatternImage = await loadImage(path.join(QUOTE_ASSETS_DIR, "pattern_02.png"));
  }
  return cachedPatternImage;
}

// quote.ts attaches the sender/reply/forward avatar as a raw Buffer in
// `message.avatarBuffer` (downloaded via client.downloadProfilePhoto and
// normalized to PNG). The vendor renderer, however, only consumes a pre-built
// `message.avatarCanvas` (or falls back to drawAvatar(from, telegram), which
// needs from.photo.url/big_file_id or a telegram client — none of which quote.ts
// provides; from.photo is always {}). So without this bridge the avatar buffer
// is silently dropped and no avatar is drawn. Convert the buffer into a canvas
// here, matching how quote.ts already pre-builds mediaCanvas.
async function avatarBufferToCanvas(buffer) {
  if (!buffer || !buffer.length) return undefined;
  try {
    const img = await loadImage(buffer);
    // The composer draws the avatar canvas as-is (no clipping), so it must be
    // pre-clipped to a circle here — mirroring the vendor's drawAvatar(), which
    // returns a circular canvas. Without this the avatar renders as a square.
    const size = img.naturalHeight || img.height || img.width;
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, size, size);
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2, true);
    ctx.save();
    ctx.clip();
    ctx.closePath();
    ctx.drawImage(img, 0, 0, size, size);
    ctx.restore();
    return canvas;
  } catch (error) {
    console.warn("quote generate: avatar buffer -> canvas failed", error && error.message);
    return undefined;
  }
}

// Bridge avatarBuffer -> avatarCanvas for a message and its reply, if the
// vendor-consumed canvas isn't already set.
async function bridgeAvatar(message) {
  if (!message) return;
  if (!message.avatarCanvas && message.avatarBuffer) {
    const canvas = await avatarBufferToCanvas(message.avatarBuffer);
    if (canvas) {
      message.avatarCanvas = canvas;
      message.avatar = true;
    }
  }
  if (message.replyMessage && !message.replyMessage.avatarCanvas && message.replyMessage.avatarBuffer) {
    const replyCanvas = await avatarBufferToCanvas(message.replyMessage.avatarBuffer);
    if (replyCanvas) {
      message.replyMessage.avatarCanvas = replyCanvas;
      message.replyMessage.avatar = true;
    }
  }
}

const imageAlpha = (image, alpha) => {
  const canvas = createCanvas(image.width, image.height);
  const canvasCtx = canvas.getContext("2d");
  canvasCtx.globalAlpha = alpha;
  canvasCtx.drawImage(image, 0, 0);
  return canvas;
};

function normalizeMessage(message) {
  if (!message.from) {
    message.from = { id: 0 };
  }
  if (!message.from.photo) {
    message.from.photo = {};
  }
  if (message.from.name !== false && !message.from.name && (message.from.first_name || message.from.last_name)) {
    message.from.name = [message.from.first_name, message.from.last_name]
      .filter(Boolean)
      .join(" ");
  }
  if (message.replyMessage) {
    if (!message.replyMessage.chatId) {
      message.replyMessage.chatId = message.from.id || 0;
    }
    if (!message.replyMessage.entities) {
      message.replyMessage.entities = [];
    }
    if (!message.replyMessage.from) {
      message.replyMessage.from = {
        name: message.replyMessage.name,
        photo: {},
      };
    } else if (!message.replyMessage.from.photo) {
      message.replyMessage.from.photo = {};
    }
  }
}

async function drawPatternBackground(canvas, colorOne, colorTwo, patternImage, lumOne, lumTwo) {
  const ctx = canvas.getContext("2d");

  const gradient = ctx.createRadialGradient(
    canvas.width / 2, canvas.height / 2, 0,
    canvas.width / 2, canvas.height / 2, canvas.width / 2
  );

  const patternColorOne = colorLuminance(colorOne, lumOne);
  const patternColorTwo = colorLuminance(colorTwo, lumTwo);

  gradient.addColorStop(0, patternColorOne);
  gradient.addColorStop(1, patternColorTwo);

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const pattern = ctx.createPattern(imageAlpha(patternImage, 0.3), "repeat");
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

async function generateQuote(parm) {
  if (!parm) return { error: "query_empty" };
  if (!Array.isArray(parm.messages) || parm.messages.length < 1) return { error: "messages_empty" };

  await ensureFonts();

  const botToken = parm.botToken || process.env.BOT_TOKEN;
  const quoteGenerate = new QuoteGenerate(botToken);
  const rawScale = parseFloat(parm.scale) || 2;
  const scale = Math.min(20, Math.max(1, Number.isFinite(rawScale) ? rawScale : 2));
  const rawBrand = parm.emojiBrand || "apple";
  const emojiBrand = ALLOWED_EMOJI_BRANDS.has(rawBrand) ? rawBrand : "apple";

  const background = parseBackgroundColor(parm.backgroundColor);

  // Normalize all messages first (sync), then bridge avatar buffers into the
  // avatarCanvas the vendor renderer expects (async — loads the image buffer).
  const validMessages = parm.messages.filter(Boolean);
  for (const message of validMessages) {
    normalizeMessage(message);
  }
  await Promise.all(validMessages.map((message) => bridgeAvatar(message)));

  // Generate quotes with concurrency limit to avoid Telegram API rate limits
  const CONCURRENCY = 3;
  const quoteImages = new Array(validMessages.length).fill(null);
  let running = 0;
  let nextIndex = 0;

  await new Promise((resolve) => {
    function runNext() {
      while (running < CONCURRENCY && nextIndex < validMessages.length) {
        const index = nextIndex++;
        running++;

        quoteGenerate.generate(
          background.colorOne,
          background.colorTwo,
          validMessages[index],
          parm.width,
          parm.height,
          scale,
          emojiBrand
        ).then((canvas) => {
          if (canvas) quoteImages[index] = canvas;
          else console.warn("Failed to generate quote for message, skipping");
        }).catch((error) => {
          console.error("Error generating quote for message:", error.message);
        }).finally(() => {
          running--;
          if (nextIndex >= validMessages.length && running === 0) resolve();
          else runNext();
        });
      }
      if (validMessages.length === 0) resolve();
    }
    runNext();
  });

  // Filter nulls (failed messages) while preserving order
  const filteredImages = quoteImages.filter(Boolean);

  if (filteredImages.length === 0) {
    return { error: "empty_messages" };
  }

  let canvasQuote;

  if (filteredImages.length > 1) {
    let width = 0;
    let height = 0;

    for (let index = 0; index < filteredImages.length; index++) {
      if (filteredImages[index].width > width) width = filteredImages[index].width;
      height += filteredImages[index].height;
    }

    const quoteMargin = 5 * scale;

    const canvas = createCanvas(width, height + (quoteMargin * filteredImages.length));
    const canvasCtx = canvas.getContext("2d");

    let imageY = 0;
    for (let index = 0; index < filteredImages.length; index++) {
      canvasCtx.drawImage(filteredImages[index], 0, imageY);
      imageY += filteredImages[index].height + quoteMargin;
    }
    canvasQuote = canvas;
  } else {
    canvasQuote = filteredImages[0];
  }

  let quoteImage;

  let { type, format } = parm;

  if (type !== "image" && type !== "stories" && canvasQuote.height > 1024 * 2) type = "png";

  let ext;

  if (type === "quote") {
    const downPadding = 75;
    const maxWidth = 512;
    const maxHeight = 512;

    const imageQuoteSharp = sharp(canvasQuote.toBuffer());

    if (canvasQuote.height > canvasQuote.width) imageQuoteSharp.resize({ height: maxHeight });
    else imageQuoteSharp.resize({ width: maxWidth });

    const canvasImage = await loadImage(await imageQuoteSharp.toBuffer());

    const canvasPadding = createCanvas(canvasImage.width, canvasImage.height + downPadding);
    const canvasPaddingCtx = canvasPadding.getContext("2d");
    canvasPaddingCtx.drawImage(canvasImage, 0, 0);

    const imageSharp = sharp(canvasPadding.toBuffer());

    if (canvasPadding.height >= canvasPadding.width) imageSharp.resize({ height: maxHeight });
    else imageSharp.resize({ width: maxWidth });

    if (format === "png") {
      quoteImage = await imageSharp.png().toBuffer();
      ext = "png";
    } else {
      quoteImage = await imageSharp.webp({ lossless: true, force: true }).toBuffer();
      ext = "webp";
    }
  } else if (type === "image") {
    const heightPadding = 75 * scale;
    const widthPadding = 95 * scale;

    const canvasPic = createCanvas(canvasQuote.width + widthPadding, canvasQuote.height + heightPadding);
    const canvasPicCtx = canvasPic.getContext("2d");

    const patternImage = await getPatternImage();
    await drawPatternBackground(canvasPic, background.colorTwo, background.colorOne, patternImage, 0.15, 0.15);

    canvasPicCtx.shadowOffsetX = 8;
    canvasPicCtx.shadowOffsetY = 8;
    canvasPicCtx.shadowBlur = 13;
    canvasPicCtx.shadowColor = "rgba(0, 0, 0, 0.5)";

    canvasPicCtx.drawImage(canvasQuote, widthPadding / 2, heightPadding / 2);

    canvasPicCtx.shadowOffsetX = 0;
    canvasPicCtx.shadowOffsetY = 0;
    canvasPicCtx.shadowBlur = 0;
    canvasPicCtx.shadowColor = "rgba(0, 0, 0, 0)";

    canvasPicCtx.fillStyle = "rgba(0, 0, 0, 0.3)";
    canvasPicCtx.font = `${8 * scale}px Noto Sans`;
    canvasPicCtx.textAlign = "right";
    canvasPicCtx.fillText("@QuotLyBot", canvasPic.width - 25, canvasPic.height - 25);

    quoteImage = await sharp(canvasPic.toBuffer()).png({ lossless: true, force: true }).toBuffer();
    ext = "png";
  } else if (type === "stories") {
    const canvasPic = createCanvas(720, 1280);
    const canvasPicCtx = canvasPic.getContext("2d");

    const patternImage = await getPatternImage();
    await drawPatternBackground(canvasPic, background.colorTwo, background.colorOne, patternImage, 0.25, 0.15);

    canvasPicCtx.shadowOffsetX = 8;
    canvasPicCtx.shadowOffsetY = 8;
    canvasPicCtx.shadowBlur = 13;
    canvasPicCtx.shadowColor = "rgba(0, 0, 0, 0.5)";

    const minPadding = 110;
    const maxW = canvasPic.width - minPadding * 2;
    const maxH = canvasPic.height - minPadding * 2;

    let drawSource = canvasQuote;
    if (canvasQuote.width > maxW || canvasQuote.height > maxH) {
      const resizedBuffer = await sharp(canvasQuote.toBuffer()).resize({
        width: maxW,
        height: maxH,
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      }).toBuffer();
      drawSource = await loadImage(resizedBuffer);
    }

    const imageX = (canvasPic.width - drawSource.width) / 2;
    const imageY = (canvasPic.height - drawSource.height) / 2;

    canvasPicCtx.drawImage(drawSource, imageX, imageY);

    canvasPicCtx.shadowOffsetX = 0;
    canvasPicCtx.shadowOffsetY = 0;
    canvasPicCtx.shadowBlur = 0;

    canvasPicCtx.fillStyle = "rgba(0, 0, 0, 0.4)";
    canvasPicCtx.font = `${16 * scale}px Noto Sans`;
    canvasPicCtx.textAlign = "center";
    canvasPicCtx.translate(70, canvasPic.height / 2);
    canvasPicCtx.rotate(-Math.PI / 2);
    canvasPicCtx.fillText("@QuotLyBot", 0, 0);

    quoteImage = await sharp(canvasPic.toBuffer()).png({ lossless: true, force: true }).toBuffer();
    ext = "png";
  } else {
    quoteImage = canvasQuote.toBuffer();
    ext = "png";
  }

  // Always report dimensions from the final encoded image.
  let width, height;
  if (type === "quote" || type === "image" || type === "stories") {
    const imageMetadata = await sharp(quoteImage).metadata();
    width = imageMetadata.width;
    height = imageMetadata.height;
  } else {
    width = canvasQuote.width;
    height = canvasQuote.height;
  }

  // quote.ts consumes `image` as a Buffer (fs.writeFileSync) — always return raw bytes.
  return { image: quoteImage, type, width, height, ext };
}

module.exports = { generateQuote, generate: generateQuote };
