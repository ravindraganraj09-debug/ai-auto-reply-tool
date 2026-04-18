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

const GEMINI_API_KEY = process.env.GEMINIAI_API_KEY || "";
const GEMINI_API_URL = process.env.GEMINIAI_API_URL || "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODELS = (process.env.GEMINI_MODELS || "gemini-2.5-flash,gemini-2.0-flash,gemini-flash-latest")
  .split(",")
  .map((model) => model.trim().replace(/^models\//, ""))
  .filter(Boolean);
const GEMINI_API_AUTH_MODE = process.env.GEMINI_API_AUTH_MODE || "query";

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

// MongoDB connect
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
    planName: premiumActive ? "Premium" : "Free",
    usage: user.usage || 0,
    lastPaymentId: user.lastPaymentId || null,
    lastOrderId: user.lastOrderId || null,
    premiumActivatedAt: user.premiumActivatedAt || null,
    premiumExpiresAt: user.premiumExpiresAt || null,
  };
}

async function generateAiReply(message, business) {
  if (!GEMINI_API_KEY) {
    return business
      ? `Smart reply for "${message}" (${business})`
      : `Smart reply for "${message}"`;
  }

  const prompt = business
    ? `You are a customer support assistant for this business: ${business}. Reply to the customer message professionally and briefly: ${message}`
    : `You are a customer support assistant. Reply to this customer message professionally and briefly: ${message}`;

  try {
    for (const model of GEMINI_MODELS) {
      const baseUrl = `${GEMINI_API_URL}/${model}:generateContent`;
      const requestUrl = GEMINI_API_AUTH_MODE === "bearer"
        ? baseUrl
        : `${baseUrl}?key=${encodeURIComponent(GEMINI_API_KEY)}`;

      const requestHeaders = {
        "Content-Type": "application/json",
      };

      if (GEMINI_API_AUTH_MODE === "bearer") {
        requestHeaders.Authorization = `Bearer ${process.env.GEMINIAI_API_KEY}`;
      }

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
        }),
      });

      if (!aiResponse.ok) {
        const errorText = await aiResponse.text();
        console.error(`Gemini API error (${model}):`, aiResponse.status, errorText);
        continue;
      }

      const aiData = await aiResponse.json();
      const generatedText = aiData?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (generatedText) {
        return generatedText;
      }
    }

    return business
      ? `Smart reply for "${message}" (${business})`
      : `Smart reply for "${message}"`;
  } catch (_error) {
    return business
      ? `Smart reply for "${message}" (${business})`
      : `Smart reply for "${message}"`;
  }
}

// Signup
app.post("/signup", async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const { email, password } = req.body;

    const strongPassword = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/;
    if (!strongPassword.test(password || "")) {
      return res.status(400).json({ message: "Password must be 8+ chars with upper, lower, number, and special character." });
    }

    const existingUser = await usersCollection.findOne({ email });
    if (existingUser) {
      return res.status(409).json({ message: "Email already registered" });
    }

    const hashed = await bcrypt.hash(password, 10);
    await usersCollection.insertOne({
      email,
      password: hashed,
      usage: 0,
      premium: false,
      replyHistory: [],
    });

    res.json({ message: "User created" });
  } catch (error) {
    res.status(500).json({ message: "Internal server error." });
  }
});

// Login
app.post("/login", async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const { email, password } = req.body;

    const user = await usersCollection.findOne({ email });
    if (!user) return res.json({ message: "User not found" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.json({ message: "Wrong password" });

    const token = jwt.sign({ id: user._id.toString() }, JWT_SECRET, { expiresIn: "7d" });

    res.json({ token, user: toPublicUser(user) });
  } catch (error) {
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
  } catch (error) {
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
  } catch (error) {
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
  } catch (error) {
    res.status(500).json({ message: "Internal server error." });
  }
});

app.post("/api/reply", async (req, res) => {
  try {
    const { message, business, userId } = req.body;
    const authenticatedUserId = getUserIdFromToken(req);
    const targetUserId = authenticatedUserId || userId;

    if (!isDatabaseReady()) {
      return res.status(503).json({ reply: "Database unavailable. Try again." });
    }

    if (!ObjectId.isValid(targetUserId)) {
      return res.status(400).json({ reply: "Invalid userId." });
    }

    if (!message || !String(message).trim()) {
      return res.status(400).json({ reply: "Message is required." });
    }

    const user = await usersCollection.findOne({ _id: new ObjectId(targetUserId) });

    if (!user) {
      return res.status(404).json({ reply: "User not found." });
    }

    if (!user.premium && user.usage >= 5) {
      return res.json({ reply: "Limit reached! Upgrade to premium." });
    }

    const reply = await generateAiReply(message, business);

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
  } catch (error) {
    res.status(500).json({ reply: "Internal server error." });
  }
});

app.post("/create-order", async (req, res) => {
  try {
    const authenticatedUserId = getUserIdFromToken(req);
    const { userId } = req.body || {};
    const targetUserId = authenticatedUserId || userId;

    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    if (!ObjectId.isValid(targetUserId)) {
      return res.status(400).json({ message: "Invalid userId." });
    }

    const user = await usersCollection.findOne({ _id: new ObjectId(targetUserId) });
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const order = await razorpay.orders.create({
      amount: premiumPlan.amount,
      currency: premiumPlan.currency,
      receipt: `p_${Date.now()}`,
      notes: {
        userId: targetUserId,
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

app.post("/verify-payment", async (req, res) => {
  try {
    const authenticatedUserId = getUserIdFromToken(req);
    const {
      userId,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body || {};
    const targetUserId = authenticatedUserId || userId;

    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    if (!ObjectId.isValid(targetUserId)) {
      return res.status(400).json({ message: "Invalid userId." });
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
        _id: new ObjectId(targetUserId),
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

app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});