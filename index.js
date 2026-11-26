const {
  default: makeWASocket,
  useMultiFileAuthState,
  downloadMediaMessage,
  DisconnectReason,
  prepareWAMessageMedia,
  generateWAMessageFromContent,
} = require("@rexxhayanasi/elaina-baileys");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const ffmpegPath = require("ffmpeg-static");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, (err) => (err ? reject(err) : resolve()));
  });
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) qrcode.generate(qr, { small: true });
    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startBot();
    } else if (connection === "open") {
      console.log("Bot siap! Kirim video pakai caption .s");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;

    let content = msg.message;
    if (content.ephemeralMessage) content = content.ephemeralMessage.message;
    if (content.deviceSentMessage) content = content.deviceSentMessage.message;

    const jid = msg.key.remoteJid;
    const videoMsg = content?.videoMessage;
    const caption = videoMsg?.caption?.trim().toLowerCase();

    // Trigger: kirim video dengan caption ".s"
    if (videoMsg && caption === ".s") {
      const id = Date.now();
      const tmpIn = path.join(os.tmpdir(), `in_${id}.mp4`);
      const tmpWebp = path.join(os.tmpdir(), `out_${id}.webp`);
      const tmpOgg = path.join(os.tmpdir(), `out_${id}.ogg`);

      try {
        console.log("1. Download video...");
        const buffer = await downloadMediaMessage(
          { ...msg, message: content },
          "buffer",
          {}
        );
        fs.writeFileSync(tmpIn, buffer);

        console.log("2. Convert ke WebP animasi & Audio OGG...");
        // Crop kotak 1:1, 320x320, 15fps biar ukuran ringan & di bawah batas WA
        await runFFmpeg([
          "-y",
          "-i", tmpIn,
          "-t", "15",
          "-vf", "crop='min(iw,ih)':'min(iw,ih)',scale=320:320,fps=15",
          "-vcodec", "libwebp",
          "-lossless", "0",
          "-q:v", "50",
          "-loop", "0",
          "-an",
          tmpWebp,
        ]);

        // Ekstrak audio ke OGG Opus
        await runFFmpeg([
          "-y",
          "-i", tmpIn,
          "-t", "15",
          "-vn",
          "-c:a", "libopus",
          "-b:a", "48k",
          tmpOgg,
        ]);

        console.log("3. Upload media ke server WA...");
        const stickerMedia = await prepareWAMessageMedia(
          { sticker: fs.readFileSync(tmpWebp) },
          { upload: sock.waUploadToServer }
        );
        const audioMedia = await prepareWAMessageMedia(
          {
            audio: fs.readFileSync(tmpOgg),
            mimetype: "audio/ogg; codecs=opus",
          },
          { upload: sock.waUploadToServer }
        );

        console.log("4. Rakit & kirim audioStickerMessage...");
        const audioStickerPayload = {
          audioStickerMessage: {
            message: {
              stickerMessage: {
                ...stickerMedia.stickerMessage,
                isAnimated: true,
                audioMessage: audioMedia.audioMessage,
              },
            },
          },
        };

        const waMsg = generateWAMessageFromContent(jid, audioStickerPayload, {
          userJid: sock.user.id,
        });

        await sock.relayMessage(jid, waMsg.message, {
          messageId: waMsg.key.id,
        });
        console.log("Berhasil dikirim!");
      } catch (err) {
        console.error("Gagal bikin stiker bersuara:", err);
      } finally {
        [tmpIn, tmpWebp, tmpOgg].forEach((f) => {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        });
      }
    }
  });
}

startBot();