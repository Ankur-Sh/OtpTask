const express = require("express");
const bodyParser = require("body-parser");
const mongoose = require("mongoose");
const nodemailer = require("nodemailer");
const mailgen = require("mailgen");
const jwt = require("jsonwebtoken");
const dotenv = require("dotenv");
const Mailgen = require("mailgen");

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

// Connecting to MongoDB
mongoose.connect(process.env.MONGO_URL, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
});
const db = mongoose.connection;
db.on("error", console.error.bind(console, "MongoDB connection error:"));

// Define schema for users
const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    otp: String,
    otpTimestamp: String,
    otpUsed: { type: Boolean, default: false }, // New field to track OTP usage
    failedAttempts: { type: Number, default: 0 },
    blockedUntil: String,
});

const User = mongoose.model("User", userSchema);

// Body parser middleware
app.use(bodyParser.json());
app.get("/", (req, res) => {
    res.send("HEllo");
});

// Generate OTP API
app.post("/generate-otp", async (req, res) => {
    const { email } = req.body;

    try {
        // Check if user exists
        let user = await User.findOne({ email });
        const now = new Date();

        if (!user) {
            // Create new user if not exists
            user = new User({ email });
            await user.save();
        } else {
            // Check if the user is blocked
            if (user.blockedUntil && new Date(user.blockedUntil) > now) {
                const blockedUntil = new Date(user.blockedUntil);
                const timeUntilUnblock = blockedUntil - now;
                const minutesUntilUnblock = Math.floor(
                    (timeUntilUnblock % (60 * 60 * 1000)) / (60 * 1000)
                ); // Calculating minutes until unblock
                const secondsUntilUnblock = Math.floor(
                    (timeUntilUnblock % (60 * 1000)) / 1000
                ); // Calculating seconds until unblock
                return res.status(403).json({
                    error: `User is blocked for ${minutesUntilUnblock} minutes ${secondsUntilUnblock} seconds`,
                });
            }
        }

        // Check if enough time has passed since last OTP generation

        const lastGenerated = new Date(user.otpTimestamp) || new Date(0); // Parse string to Date
        const timeDiff = now - lastGenerated;
        const minTimeDiff = 60 * 1000; // 1 minute

        if (timeDiff < minTimeDiff) {
            return res.status(429).json({
                error: "Please wait at least 1 minute before requesting a new OTP",
            });
        }

        // Generate OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        // Update user in the database
        user.otp = otp;
        user.otpTimestamp = now.toLocaleString();
        user.otpUsed = false; // Mark OTP as not used
        await user.save();

        // Send OTP to user's email
        await sendOTPByEmail(email, otp);

        return res.json({ message: "OTP sent successfully" });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Internal server error" });
    }
});

// Login API
app.post("/login", async (req, res) => {
    const { email, otp } = req.body;

    try {
        // Check if user exists
        const user = await User.findOne({ email });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        // Check if user is blocked
        const now = new Date();
        if (user.blockedUntil && new Date(user.blockedUntil) > now) {
            const blockedUntil = new Date(user.blockedUntil);
            const timeUntilUnblock = blockedUntil - now;
            const minutesUntilUnblock = Math.floor(
                (timeUntilUnblock % (60 * 60 * 1000)) / (60 * 1000)
            ); // Calculating minutes until unblock
            const secondsUntilUnblock = Math.floor(
                (timeUntilUnblock % (60 * 1000)) / 1000
            ); // Calculating seconds until unblock
            return res.status(403).json({
                error: `User is blocked for ${minutesUntilUnblock} minutes ${secondsUntilUnblock} seconds`,
            });
        }

        // Check if OTP is valid and not already used
        const otpTimestamp = new Date(user.otpTimestamp) || new Date(0);
        const otpTimeDiff = now - otpTimestamp;
        const otpValidTime = 5 * 60 * 1000; // 5 minutes

        if (otp !== user.otp || otpTimeDiff > otpValidTime || user.otpUsed) {
            // Increment failed attempts and block user if necessary
            user.failedAttempts++;
            if (user.failedAttempts >= 5) {
                user.blockedUntil = new Date(
                    now.getTime() + 60 * 60 * 1000
                ).toString(); // Block for 1 hour
            }
            await user.save();

            return res.status(401).json({ error: "Invalid OTP" });
        }

        // Mark OTP as used
        user.otpUsed = true;
        await user.save();

        // Reset failed attempts if OTP is valid
        user.failedAttempts = 0;
        await user.save();

        // Generate JWT token
        const token = jwt.sign({ email }, "your_secret_key", {
            expiresIn: "1h",
        });

        return res.json({ token });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Internal server error" });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
});

// Function to send OTP by email
async function sendOTPByEmail(email, otp) {
    // Create a nodemailer transporter using SMTP or other transport options
    try {
        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.EMAIL,
                pass: process.env.PASSWORD,
            },
        });

        // Initialize Mailgen
        const mailGenerator = new Mailgen({
            theme: "default",
            product: {
                name: "Mailgen",
                link: "https://mailgen.js/",
            },
        });

        // Generate email content
        const emailTemplate = {
            body: {
                name: email.split("@")[0],
                intro: "Your OTP",
                table: {
                    data: [
                        {
                            item: "OTP",
                            description: otp,
                        },
                    ],
                },
                outro: "OTP",
            },
        };

        // Generate the email
        const emailBody = mailGenerator.generate(emailTemplate);
        const emailText = mailGenerator.generatePlaintext(emailTemplate);

        // Send email with OTP
        await transporter.sendMail({
            from: '"Ankur Sharma" <asblaster100@gmail.com>',
            to: email,
            subject: "Your OTP for login",
            text: emailText,
            html: emailBody,
        });

        console.log("OTP email sent successfully");
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Internal server error" });
    }
}

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
