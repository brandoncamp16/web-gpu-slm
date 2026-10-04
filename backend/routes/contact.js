const express = require("express");
const { sendContactEmail } = require("../utils/email");

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const { name, email, phone, message } = req.body;

    if (!name || !email || !message) {
      return res.status(400).json({ message: "Name, email, and message are required" });
    }

    if (phone) {
      const phoneRegex = /^\+?[0-9\s\-()]{7,20}$/;
      if (!phoneRegex.test(String(phone).trim())) {
        return res.status(400).json({ message: "Please enter a valid phone number." });
      }
    }

    await sendContactEmail({
      name,
      email,
      phone,
      message,
      meta: {
        ipAddress: req.ip || req.connection?.remoteAddress,
        userAgent: req.get("User-Agent"),
      },
    });

    res.status(201).json({ message: "Message sent successfully! We will get back to you soon." });
  } catch (error) {
    console.error("Error sending contact message:", error);
    res.status(500).json({ message: "Error sending message. Please try again." });
  }
});

module.exports = router;