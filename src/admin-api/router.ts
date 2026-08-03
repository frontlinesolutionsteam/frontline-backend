import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { getConnectedMerchants } from "../clover/auth/tokenStore";
import { getMerchantMenu, updateItemDescription, updateItemImageUrl } from "./repository";

export const UPLOADS_DIR = path.join(__dirname, "../../uploads");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || ".jpg";
      cb(null, `${req.params.itemId}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype));
  },
});

export const adminApiRouter = Router();

adminApiRouter.get("/merchants", async (_req, res) => {
  const merchants = await getConnectedMerchants();
  res.json(merchants);
});

adminApiRouter.get("/merchants/:merchantId/menu", async (req, res) => {
  const categories = await getMerchantMenu(req.params.merchantId);
  res.json(categories);
});

adminApiRouter.patch("/items/:itemId", async (req, res) => {
  const { description } = req.body as { description?: string };
  if (typeof description !== "string") {
    res.status(400).json({ error: "description must be a string" });
    return;
  }
  await updateItemDescription(req.params.itemId, description);
  res.sendStatus(204);
});

adminApiRouter.post("/items/:itemId/photo", upload.single("photo"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "photo file required (jpeg/png/webp, max 5MB)" });
    return;
  }
  const imageUrl = `/uploads/${req.file.filename}`;
  await updateItemImageUrl(String(req.params.itemId), imageUrl);
  res.json({ imageUrl });
});
