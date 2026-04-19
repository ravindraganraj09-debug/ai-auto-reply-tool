const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const Razorpay = require("razorpay");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const paymentConfig = {
  key_id: process.env.KEY_ID || "YOUR_KEY_ID",
  key_secret: process.env.KEY_SECRET || "YOUR_KEY_SECRET",
};

// Keep supporting the old env name so existing deployments don't silently break.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GEMINIAI_API_KEY || "";
const GEMINI_API_URL = process.env.GEMINI_API_URL || "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODELS = (process.env.GEMINI_MODELS || "gemini-2.5-flash,gemini-2.0-flash,gemini-flash-latest")
  .split(",")
  .map((model) => model.trim().replace(/^models\//, ""))
  .filter(Boolean);
const GEMINI_API_AUTH_MODE = process.env.GEMINI_API_AUTH_MODE || "header";

const JWT_SECRET = process.env.JWT_SECRET || "dev_jwt_secret";

const premiumPlan = {
  amount: 19900,
  currency: "INR",
};

const razorpay = new Razorpay({
  key_id: paymentConfig.key_id,
  key_secret: paymentConfig.key_secret,
});

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || "ai_auto_reply";

const mongoClient = new MongoClient(MONGO_URI, {
  serverSelectionTimeoutMS: 5000,
});

let usersCollection = null;

const isDatabaseReady = () => Boolean(usersCollection);

class AiReplyError extends Error {
  constructor(message) {
    super(message);
    this.name = "AiReplyError";
  }
}

async function connectDatabase() {
  try {
    await mongoClient.connect();
    const db = mongoClient.db(MONGO_DB_NAME);
    usersCollection = db.collection("users");

    await usersCollection.createIndex({ email: 1 }, { unique: true });
    console.log("MongoDB connected");
  } catch (error) {
    usersCollection = null;
    console.error("MongoDB connection failed:", error.message);
  }
}

connectDatabase();

function getBearerToken(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

function getUserIdFromToken(req) {
  try {
    const token = getBearerToken(req);
    if (!token) return null;
    const payload = jwt.verify(token, JWT_SECRET);
    return payload.id;
  } catch (_error) {
    return null;
  }
}

function requireAuth(req, res, next) {
  const userId = getUserIdFromToken(req);
  if (!userId || !ObjectId.isValid(userId)) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  req.authUserId = userId;
  next();
}

function toPublicUser(user) {
  const premiumActive = Boolean(user.premium);

  return {
    id: user._id,
    email: user.email,
    premium: premiumActive,
    planName: user.planName || (premiumActive ? "Premium" : "Free"),
    usage: user.usage || 0,
    lastPaymentId: user.lastPaymentId || null,
    lastOrderId: user.lastOrderId || null,
    premiumActivatedAt: user.premiumActivatedAt || null,
    premiumExpiresAt: user.premiumExpiresAt || null,
  };
}

function buildPrompt(message, business) {
  const trimmedMessage = String(message || "").trim();
  const trimmedBusiness = String(business || "").trim();

  if (trimmedBusiness) {
    return [
      "You write customer support replies for a business.",
      "Write one real, ready-to-send reply in plain text.",
      "Keep it professional, warm, and concise.",
      "Do not mention AI, templates, placeholders, or notes.",
      `Business context: ${trimmedBusiness}`,
      `Customer message: ${trimmedMessage}`,
    ].join("\n");
  }

  return [
    "You write customer support replies.",
    "Write one real, ready-to-send reply in plain text.",
    "Keep it professional, warm, and concise.",
    "Do not mention AI, templates, placeholders, or notes.",
    `Customer message: ${trimmedMessage}`,
  ].join("\n");
}

function extractGeneratedText(aiData) {
  const parts = aiData?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .map((part) => part?.text || "")
    .join("\n")
    .trim();
}

function sanitizeGeneratedText(text) {
  return String(text || "")
    .replace(/^["'`\s]+|["'`\s]+$/g, "")
    .trim();
}

async function generateAiReply(message, business) {
  if (!GEMINI_API_KEY) {
    throw new AiReplyError("Gemini API key is not configured.");
  }

  const prompt = buildPrompt(message, business);
  let lastErrorMessage = "Gemini returned no usable text.";

  for (const model of GEMINI_MODELS) {
    const baseUrl = `${GEMINI_API_URL}/${model}:generateContent`;
    const requestUrl = GEMINI_API_AUTH_MODE === "query"
      ? `${baseUrl}?key=${encodeURIComponent(GEMINI_API_KEY)}`
      : baseUrl;

    const requestHeaders = {
      "Content-Type": "application/json",
    };

    if (GEMINI_API_AUTH_MODE === "bearer") {
      requestHeaders.Authorization = `Bearer ${GEMINI_API_KEY}`;
    } else if (GEMINI_API_AUTH_MODE === "header" || !GEMINI_API_AUTH_MODE) {
      requestHeaders["x-goog-api-key"] = GEMINI_API_KEY;
    }

    try {
      const aiResponse = await fetch(requestUrl, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 256,
          },
        }),
      });

      if (!aiResponse.ok) {
        const errorText = await aiResponse.text();
        lastErrorMessage = `Gemini API error (${model}) ${aiResponse.status}: ${errorText}`;
        console.error(lastErrorMessage);
        continue;
      }

      const aiData = await aiResponse.json();
      const generatedText = sanitizeGeneratedText(extractGeneratedText(aiData));

      if (generatedText) {
        return generatedText;
      }

      lastErrorMessage = `Gemini returned an empty reply for model ${model}.`;
      console.error(lastErrorMessage);
    } catch (error) {
      lastErrorMessage = `Gemini request failed for ${model}: ${error.message}`;
      console.error(lastErrorMessage);
    }
  }

  throw new AiReplyError(lastErrorMessage);
}

app.post("/signup", async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ success: false, message: "Database unavailable. Try again." });
    }

    const { email, password } = req.body;

    const strongPassword = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/;
    if (!strongPassword.test(password || "")) {
      return res.status(400).json({ success: false, message: "Password must be 8+ chars with upper, lower, number, and special character." });
    }

    const existingUser = await usersCollection.findOne({ email });
    if (existingUser) {
      return res.status(409).json({ success: false, message: "Email already registered" });
    }

    const hashed = await bcrypt.hash(password, 10);
    await usersCollection.insertOne({
      email,
      password: hashed,
      usage: 0,
      premium: false,
      planName: "Free",
      replyHistory: [],
    });

    res.status(201).json({ success: true, message: "User created successfully. Please login." });
  } catch (_error) {
    res.status(500).json({ success: false, message: "Internal server error." });
  }
});

app.post("/login", async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const { email, password } = req.body;

    const user = await usersCollection.findOne({ email });
    if (!user) {
      return res.json({ message: "User not found" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.json({ message: "Wrong password" });
    }

    const token = jwt.sign({ id: user._id.toString() }, JWT_SECRET, { expiresIn: "7d" });

    res.json({ token, user: toPublicUser(user) });
  } catch (_error) {
    res.status(500).json({ message: "Internal server error." });
  }
});

app.get("/me", requireAuth, async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const user = await usersCollection.findOne({ _id: new ObjectId(req.authUserId) });
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    res.json({ user: toPublicUser(user) });
  } catch (_error) {
    res.status(500).json({ message: "Internal server error." });
  }
});

app.get("/history", requireAuth, async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const user = await usersCollection.findOne(
      { _id: new ObjectId(req.authUserId) },
      { projection: { replyHistory: 1 } }
    );

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const history = (user.replyHistory || []).slice().reverse();
    res.json({ history });
  } catch (_error) {
    res.status(500).json({ message: "Internal server error." });
  }
});

app.post("/change-password", requireAuth, async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "Current and new password are required." });
    }

    const strongPassword = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/;
    if (!strongPassword.test(newPassword || "")) {
      return res.status(400).json({ message: "New password must be 8+ chars with upper, lower, number, and special character." });
    }

    const user = await usersCollection.findOne({ _id: new ObjectId(req.authUserId) });
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Current password is incorrect." });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await usersCollection.updateOne(
      { _id: user._id },
      { $set: { password: hashedPassword } }
    );

    res.json({ message: "Password updated successfully." });
  } catch (_error) {
    res.status(500).json({ message: "Internal server error." });
  }
});

app.post("/api/reply", requireAuth, async (req, res) => {
  try {
    const { message, business } = req.body;

    if (!isDatabaseReady()) {
      return res.status(503).json({ reply: "Database unavailable. Try again." });
    }

    if (!message || !String(message).trim()) {
      return res.status(400).json({ reply: "Message is required." });
    }

    const user = await usersCollection.findOne({ _id: new ObjectId(req.authUserId) });
    if (!user) {
      return res.status(404).json({ reply: "User not found." });
    }

    if (!user.premium && user.usage >= 5) {
      return res.json({ reply: "Limit reached! Upgrade to premium." });
    }

    let reply;
    try {
      reply = await generateAiReply(message, business);
    } catch (error) {
      const publicMessage = error instanceof AiReplyError
        ? "AI reply unavailable right now. Check Gemini API configuration and try again."
        : "Failed to generate AI reply right now. Please try again.";
      return res.status(503).json({ reply: publicMessage });
    }

    await usersCollection.updateOne(
      { _id: user._id },
      {
        $inc: { usage: 1 },
        $push: {
          replyHistory: {
            message,
            business: business || "",
            reply,
            createdAt: new Date(),
          },
        },
      }
    );

    res.json({ reply });
  } catch (_error) {
    res.status(500).json({ reply: "Internal server error." });
  }
});

app.post("/create-order", requireAuth, async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const user = await usersCollection.findOne({ _id: new ObjectId(req.authUserId) });
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const order = await razorpay.orders.create({
      amount: premiumPlan.amount,
      currency: premiumPlan.currency,
      receipt: `p_${Date.now()}`,
      notes: {
        userId: req.authUserId,
      },
    });

    await usersCollection.updateOne(
      { _id: user._id },
      {
        $set: {
          pendingOrderId: order.id,
        },
      }
    );

    res.json({
      key: paymentConfig.key_id,
      amount: order.amount,
      currency: order.currency,
      orderId: order.id,
    });
  } catch (error) {
    console.error("Create order failed:", error);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.post("/verify-payment", requireAuth, async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body || {};

    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ message: "Payment verification data is required." });
    }

    const expectedSignature = crypto
      .createHmac("sha256", paymentConfig.key_secret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ message: "Invalid payment signature." });
    }

    const result = await usersCollection.updateOne(
      {
        _id: new ObjectId(req.authUserId),
        pendingOrderId: razorpay_order_id,
      },
      {
        $set: {
          premium: true,
          planName: "Premium",
          lastPaymentId: razorpay_payment_id,
          lastOrderId: razorpay_order_id,
          premiumActivatedAt: new Date(),
          premiumExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        },
        $unset: {
          pendingOrderId: "",
        },
      }
    );

    if (!result.matchedCount) {
      return res.status(404).json({ message: "User not found or order mismatch." });
    }

    res.json({ message: "Premium activated successfully." });
  } catch (error) {
    console.error("Verify payment failed:", error);
    res.status(500).json({ message: "Internal server error." });
  }
});

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
