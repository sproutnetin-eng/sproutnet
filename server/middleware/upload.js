const multer = require('multer');

// Memory storage; handlers get req.file = { originalname, mimetype, size, buffer }.
// Route handlers enforce their own size/type rules via server/lib validators,
// mirroring the original get*UploadError helpers.
module.exports = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});
