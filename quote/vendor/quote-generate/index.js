// utils/quote-generate/index.js

const fs = require('fs')
const path = require('path')
const { registerFont } = require('canvas')
const { Telegram } = require('telegraf')

const { drawMultilineText } = require('./text-renderer')
const { drawAvatar } = require('./avatar')
const { downloadMediaImage } = require('./media')
const { drawQuote } = require('./composer')
const { drawWaveform } = require('./waveform')
const { ColorContrast, lightOrDark, colorLuminance } = require('./color')
const { NAME_COLORS_LIGHT, NAME_COLORS_DARK } = require('./constants')

async function loadFonts () {
  const fontsDir = path.resolve(process.cwd(), 'assets', 'quote')

  const explicitFonts = [
    { file: path.join(fontsDir, 'NotoSansCJK-Regular.ttc'), family: 'NotoSans' },
    { file: path.join(fontsDir, 'NotoSansCJK-Regular.ttc'), family: 'Noto Sans' },
    { file: path.join(fontsDir, 'NotoSansCJK-Bold.ttc'), family: 'NotoSans', weight: '600' },
    { file: path.join(fontsDir, 'NotoSansCJK-Bold.ttc'), family: 'Noto Sans', weight: '600' },
    { file: '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf', family: 'Noto Color Emoji' }
  ]

  for (const font of explicitFonts) {
    if (!fs.existsSync(font.file)) continue
    try {
      registerFont(font.file, { family: font.family, weight: font.weight })
    } catch (error) {
      console.warn(`Could not register font ${font.file}: ${error.message}`)
    }
  }

  let files
  try {
    files = await fs.promises.readdir(fontsDir)
  } catch (err) {
    console.warn('Could not read fonts directory:', err.message)
    console.log('Fonts loaded')
    return
  }

  for (const file of files) {
    if (file.startsWith('.')) continue
    try {
      registerFont(path.join(fontsDir, file), { family: file.replace(/\.[^/.]+$/, '') })
    } catch (error) {
      console.warn(`${file} is not a font file`)
    }
  }
  console.log('Fonts loaded')
}

function getStatusId(status) {
  if (!status) return null
  if (typeof status === 'string' || typeof status === 'number' || typeof status === 'bigint') return String(status)
  return status.custom_emoji_id || status.customEmojiId || status.documentId || status.document_id || status.id || null
}

function getStatusBuffer(status) {
  if (!status || typeof status !== 'object') return null
  return status.customEmojiBuffer || status.buffer || null
}

function asObjectEmojiMap (telegram) {
  if (telegram && typeof telegram === 'object' && !telegram.callApi) return telegram
  return {}
}

class QuoteGenerate {
  constructor (botToken) {
    this.telegram = new Telegram(botToken)
  }

  async generate (backgroundColorOne, backgroundColorTwo, message, width, height, scale, emojiBrand, telegram) {
    scale = scale || 2
    if (!Number.isFinite(scale) || scale < 1) scale = 1
    if (scale > 20) scale = 20
    width = Math.max(1, (width || 512) * scale)
    height = Math.max(1, (height || 512) * scale)

    const backStyle = lightOrDark(backgroundColorOne)
    const nameColorArray = backStyle === 'light' ? NAME_COLORS_LIGHT : NAME_COLORS_DARK

    let nameIndex = 1
    if (message.from && message.from.id) nameIndex = Math.abs(message.from.id) % 7

    let nameColor = nameColorArray[nameIndex]

    const colorContrast = new ColorContrast()
    const contrast = colorContrast.getContrastRatio(colorLuminance(backgroundColorOne, 0.55), nameColor)
    if (contrast > 90 || contrast < 30) {
      nameColor = colorContrast.adjustContrast(colorLuminance(backgroundColorTwo, 0.55), nameColor)
    }

    const nameSize = 22 * scale

    let nameCanvas
    if (message.from && message.from.name !== false && (message.from.name || message.from.first_name || message.from.last_name)) {
      let name = message.from.name || `${message.from.first_name || ''} ${message.from.last_name || ''}`.trim()
      if (!name) name = 'User'

      const nameEntities = [{
        type: 'bold',
        offset: 0,
        length: name.length
      }]

      if (message.from.emoji_status) {
        const statusId = getStatusId(message.from.emoji_status)
        const statusBuffer = getStatusBuffer(message.from.emoji_status)
        if (statusId) {
          const statusMap = asObjectEmojiMap(telegram)
          if (statusBuffer && !statusMap[String(statusId)]) statusMap[String(statusId)] = statusBuffer
          name += ' 🙂'
          const offset = name.length - 2
          nameEntities.push({
            type: 'custom_emoji',
            offset,
            length: 2,
            custom_emoji_id: String(statusId),
            customEmojiBuffer: statusBuffer || statusMap[String(statusId)]
          })
        }
      }

      try {
        nameCanvas = await drawMultilineText(
          name, nameEntities, nameSize, nameColor,
          0, nameSize, width, nameSize, emojiBrand, telegram || this.telegram
        )
      } catch (error) {
        console.error('Failed to render name:', error.message, error.stack, { name, nameEntities, emojiStatus: message.from.emoji_status })
        // Retry without entities (drop emoji status etc)
        try {
          const plainName = name.replace(/\s*\uD83E\uDD21$/, '') // strip emoji placeholder
          nameCanvas = await drawMultilineText(
            plainName, [{ type: 'bold', offset: 0, length: plainName.length }],
            nameSize, nameColor, 0, nameSize, width, nameSize, emojiBrand, telegram || this.telegram
          )
        } catch (_) { /* name is optional — continue without it */ }
      }
    }

    const fontSize = 24 * scale
    let textColor = backStyle === 'light' ? '#000' : '#fff'

    let textCanvas
    if (message.text) {
      const text = typeof message.text === 'string' ? message.text : String(message.text)
      try {
        textCanvas = await drawMultilineText(
          text, message.entities, fontSize, textColor,
          0, fontSize, width, height - fontSize, emojiBrand, telegram || this.telegram
        )
      } catch (error) {
        console.error('Failed to render message text:', error.message, error.stack)
        // Retry without entities (plain text fallback)
        try {
          textCanvas = await drawMultilineText(
            text, [], fontSize, textColor,
            0, fontSize, width, height - fontSize, emojiBrand, telegram || this.telegram
          )
        } catch (retryError) {
          console.error('Failed to render plain text fallback:', retryError.message)
          return null
        }
      }
    }

    let avatarCanvas
    if (message.avatarCanvas) {
      avatarCanvas = message.avatarCanvas
    } else if (message.avatar && message.from) {
      try {
        avatarCanvas = await drawAvatar(message.from, telegram || this.telegram)
      } catch (error) {
        console.warn('Error drawing avatar:', error.message)
        avatarCanvas = null
      }
    }

    let replyData = null
    if (message.replyMessage && message.replyMessage.name && message.replyMessage.text) {
      try {
        const chatId = message.replyMessage.chatId || 0
        const replyNameIndex = Math.abs(chatId) % 7
        const replyNameColor = nameColorArray[replyNameIndex]

        const replyName = typeof message.replyMessage.name === 'string' ? message.replyMessage.name : String(message.replyMessage.name)
        const replyText = typeof message.replyMessage.text === 'string' ? message.replyMessage.text : String(message.replyMessage.text)

        const replyNameFontSize = 16 * scale
        const replyNameCanvas = await drawMultilineText(
          replyName, 'bold', replyNameFontSize, replyNameColor,
          0, replyNameFontSize, width * 0.9, replyNameFontSize, emojiBrand, telegram || this.telegram
        )

        const replyTextFontSize = 21 * scale
        const replyTextCanvas = await drawMultilineText(
          replyText, message.replyMessage.entities || [],
          replyTextFontSize, textColor,
          0, replyTextFontSize, width * 0.9, replyTextFontSize, emojiBrand, telegram || this.telegram
        )

        if (replyNameCanvas && replyTextCanvas) {
          replyData = { name: replyNameCanvas, nameColor: replyNameColor, text: replyTextCanvas }
        }
      } catch (error) {
        console.error('Failed to render reply:', error.message, error.stack)
        replyData = null
      }
    }

    let mediaCanvas = null
    let mediaType = null
    let maxMediaSize = null

    if (message.mediaCanvas) {
      mediaCanvas = message.mediaCanvas
      mediaType = message.mediaType || 'photo'
      maxMediaSize = message.mediaMaxSize || width / 3 * scale
      if (message.text && textCanvas && maxMediaSize < textCanvas.width) maxMediaSize = textCanvas.width
    } else if (message.media) {
      let media, type
      let crop = !!message.mediaCrop

      if (message.media.url) {
        type = 'url'
        media = message.media.url
      } else {
        type = 'id'
        if (message.media.length > 1) {
          // BUG FIX: was message.media.pop() which mutated input
          media = crop ? message.media[1] : message.media[message.media.length - 1]
        } else {
          media = message.media[0]
        }
      }

      maxMediaSize = width / 3 * scale
      if (message.text && textCanvas && maxMediaSize < textCanvas.width) maxMediaSize = textCanvas.width

      if (media && media.is_animated) {
        if (media.thumb) {
          media = media.thumb
          maxMediaSize = maxMediaSize / 2
        } else {
          media = null
        }
      }

      try {
        mediaCanvas = await downloadMediaImage(media, maxMediaSize, type, crop, this.telegram)
        if (mediaCanvas) {
          mediaType = message.mediaType
        } else {
          console.warn('Failed to download media image, skipping')
        }
      } catch (error) {
        console.warn('Error downloading media image:', error.message)
      }
    }

    if (message.voice && Array.isArray(message.voice.waveform)) {
      mediaCanvas = drawWaveform(message.voice.waveform)
      maxMediaSize = width / 3 * scale
    }

    // Forward label
    const isForward = !!message.forward
    const forwardLabel = isForward ? (message.forward.label || 'Forwarded message') : null

    // Sender tag (user role in group)
    const senderTag = message.senderTag || null

    // Nothing to render — skip this message
    if (!textCanvas && !nameCanvas && !mediaCanvas && !replyData) {
      return null
    }

    return drawQuote({
      scale,
      background: { colorOne: backgroundColorOne, colorTwo: backgroundColorTwo, textColor },
      avatar: avatarCanvas,
      reply: replyData,
      name: nameCanvas,
      text: textCanvas,
      media: mediaCanvas ? { canvas: mediaCanvas, type: mediaType, maxSize: maxMediaSize } : null,
      isForward,
      forwardLabel,
      nameColor,
      senderTag,
      isQuote: !!message.isQuote
    })
  }
}

module.exports = QuoteGenerate
module.exports.loadFonts = loadFonts
