# 🚀 Complete Beginner's Setup Guide

**Welcome!** This guide will walk you through setting up your own FREE WhatsApp automation system. No coding experience required - just follow along step by step!

---

## 📖 What You're Building

By the end of this guide, you'll have:
- ✅ Your own WhatsApp messaging API (like WhatsApp Business API, but FREE)
- ✅ A dashboard to manage multiple WhatsApp accounts
- ✅ Webhook support to connect with n8n, Make, Zapier, etc.
- ✅ Optional AI chatbot that auto-replies to messages
- ✅ Everything running 24/7 for $0/month

**Time needed:** About 20-30 minutes (first time)

---

## 📋 Table of Contents

1. [What You'll Need (Prerequisites)](#-step-0-what-youll-need)
2. [Create Your Accounts](#-step-1-create-your-free-accounts)
3. [Setup the Database (Supabase)](#-step-2-setup-supabase-database)
4. [Deploy the App (Render)](#-step-3-deploy-to-render)
5. [Keep It Running 24/7 (UptimeRobot)](#-step-4-setup-uptimerobot)
6. [Connect WhatsApp](#-step-5-connect-your-whatsapp)
7. [Send Your First Message](#-step-6-send-your-first-message)
8. [Setup Webhooks (Optional)](#-step-7-setup-webhooks-optional)
9. [Setup AI Chatbot (Optional)](#-step-8-setup-ai-chatbot-optional)
10. [Troubleshooting](#-troubleshooting)

---

## 🛠️ Step 0: What You'll Need

Before we start, make sure you have:

| Item | Why You Need It | Cost |
|------|-----------------|------|
| A computer | To follow this guide | - |
| A smartphone with WhatsApp | To scan QR code and connect | - |
| An email address | To create accounts | - |
| 20-30 minutes | First-time setup | - |

**No credit card required for any of these services!**

---

## 📝 Step 1: Create Your Free Accounts

You need to create accounts on 4 free services. Let's do them one by one:

### 1.1 Create GitHub Account

**What is GitHub?** It's where the code for this app is stored. You'll make your own copy.

1. Open your browser and go to: **[github.com/signup](https://github.com/signup)**

2. Enter your email address and click **Continue**

3. Create a password and click **Continue**

4. Choose a username (this will be public) and click **Continue**

5. Solve the puzzle to verify you're human

6. Click **Create account**

7. Check your email and enter the verification code

8. When asked about personalization, you can skip or answer the questions

✅ **Done!** You now have a GitHub account.

---

### 1.2 Create Supabase Account

**What is Supabase?** It's a free database service. Your WhatsApp sessions and settings will be stored here.

1. Open a new tab and go to: **[supabase.com](https://supabase.com)**

2. Click **Start your project** or **Sign Up**

3. Click **Continue with GitHub** (easiest option!)

4. Click **Authorize Supabase** when asked

5. You might need to verify your email

✅ **Done!** You now have a Supabase account linked to your GitHub.

---

### 1.3 Create Render Account

**What is Render?** It's where your app will run. Think of it as a computer in the cloud.

1. Open a new tab and go to: **[render.com](https://render.com)**

2. Click **Get Started for Free**

3. Click **GitHub** (to sign up with your GitHub account)

4. Click **Authorize Render** when asked

5. Verify your email if required

✅ **Done!** You now have a Render account.

---

### 1.4 Create UptimeRobot Account

**What is UptimeRobot?** It pings your app every 5 minutes to keep it awake (Render's free tier sleeps after 15 min of inactivity).

1. Open a new tab and go to: **[uptimerobot.com](https://uptimerobot.com)**

2. Click **Register for FREE**

3. Enter your email, create a password, and your name

4. Click **Register Now**

5. Check your email and click the verification link

✅ **Done!** You now have all 4 accounts ready!

---

## 🗄️ Step 2: Setup Supabase Database

Now let's set up your database. This is where all your data will be stored.

### 2.1 Fork the Repository (Get Your Own Copy)

1. Make sure you're logged into GitHub

2. Go to: **[github.com/mohit2777/whatsapp-api-free](https://github.com/mohit2777/whatsapp-api-free)**

3. Look at the top-right corner and click the **Fork** button
   ```
   ⭐ Star  |  👁️ Watch  |  🍴 Fork
                              ☝️ Click this!
   ```

4. On the "Create a new fork" page, just click **Create fork**

5. Wait a few seconds... You now have your own copy!

6. You should now be at: `github.com/YOUR-USERNAME/whatsapp-api-free`

✅ **Done!** You have your own copy of the code.

---

### 2.2 Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) and sign in

2. If this is your first project, click **New Project**
   - If you have projects already, click your organization name → **New Project**

3. Fill in the form:
   ```
   Name:             whatsapp-automation
   Database Password: [Click "Generate a password"]
   
   ⚠️ IMPORTANT: Click the COPY icon next to the password and save it 
   somewhere (Notepad, Notes app, etc). You'll need this later!
   
   Region:           [Choose one close to you]
   ```

4. Click **Create new project**

5. Wait 1-2 minutes while Supabase sets up your project (you'll see a loading screen)

✅ **Project created!** Now let's get the connection details.

---

### 2.3 Get Your Supabase Keys (IMPORTANT!)

You need to copy 3 things from Supabase. I recommend opening Notepad/Notes and pasting them there.

#### Get the Project URL and API Keys:

1. In your Supabase project, look at the left sidebar

2. Click **⚙️ Project Settings** (gear icon at the bottom)

3. Click **API** in the submenu

4. You'll see a page with your keys. Copy these:

   | What to Copy | Where to Find It | What It Looks Like |
   |--------------|------------------|-------------------|
   | **Project URL** | Under "Project URL" | `https://abcdefgh.supabase.co` |
   | **anon public key** | Under "Project API keys" | `eyJhbGciOiJIUzI1NiIsInR5cCI6...` (long text) |
   | **service_role key** | Click "Reveal" next to it | `eyJhbGciOiJIUzI1NiIsInR5cCI6...` (long text) |

   📝 **Paste each one into your Notepad with a label like:**
   ```
   Project URL: https://abcdefgh.supabase.co
   Anon Key: eyJhbGciOi...
   Service Role Key: eyJhbGciOi...
   ```

#### Get the Database Connection String:

1. Still in Project Settings, click **Database** in the submenu

2. Scroll down to find **Connection string**

3. Click the **URI** tab

4. You'll see something like:
   ```
   postgresql://postgres.[something]:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres
   ```

5. **IMPORTANT:** This has `[YOUR-PASSWORD]` as a placeholder. You need to replace it with your actual database password (the one you saved earlier!)

6. Copy the connection string and paste it in your Notepad

7. Replace `[YOUR-PASSWORD]` with your actual password

   📝 **Your Notepad should now have:**
   ```
   Project URL: https://abcdefgh.supabase.co
   Anon Key: eyJhbGciOi...
   Service Role Key: eyJhbGciOi...
   Database URL: postgresql://postgres.abcdefgh:MyActualPassword123@aws-0-us-east-1.pooler.supabase.com:6543/postgres
   ```

✅ **Keys saved!** Now let's create the database tables.

---

### 2.4 Create Database Tables

1. In Supabase, look at the left sidebar

2. Click **SQL Editor** (looks like a terminal icon)

3. Click **+ New query**

4. Now you need to get the schema file:
   - Go to your forked repo: `github.com/YOUR-USERNAME/whatsapp-api-free`
   - Find and click on the file: **`supabase-schema.sql`**
   - Click the **Copy raw file** button (looks like two squares, top-right of the code)

5. Go back to Supabase SQL Editor and paste everything (Ctrl+V or Cmd+V)

6. Click the **Run** button (or press Ctrl+Enter)

7. You should see: **"Success. No rows returned"** - this is correct!

   ❌ If you see an error, make sure you copied the ENTIRE file

✅ **Database is ready!**

---

## 🌐 Step 3: Deploy to Render

Now let's put your app on the internet!

### 3.1 Create a New Web Service

1. Go to [render.com](https://render.com) and sign in

2. On your dashboard, click the **New +** button

3. Click **Web Service**

4. Under "Connect a repository", find your forked repo:
   - `your-username/whatsapp-api-free`
   - Click **Connect**

   ❓ **Don't see it?** Click "Configure account" and give Render access to your repositories

5. Fill in the settings:

   | Setting | What to Enter |
   |---------|---------------|
   | **Name** | `whatsapp-api` (or any name you like) |
   | **Region** | Pick one close to you (e.g., Oregon, Frankfurt, Singapore) |
   | **Branch** | `main` |
   | **Root Directory** | Leave empty |
   | **Runtime** | `Node` |
   | **Build Command** | `npm install` |
   | **Start Command** | `node index.js` |

6. Scroll down to **Instance Type** and select **Free**

---

### 3.2 Add Environment Variables

This is the most important part! Scroll down to find **Environment Variables**.

Click **Add Environment Variable** for each of these:

| Key | Value | Notes |
|-----|-------|-------|
| `NODE_ENV` | `production` | Exactly as shown |
| `PORT` | `3000` | Exactly as shown |
| `SUPABASE_URL` | Your Project URL | From your Notepad |
| `SUPABASE_SERVICE_ROLE_KEY` | Your Service Role Key | From your Notepad |
| `DATABASE_URL` | Your Database URL | From your Notepad (with password replaced!) |
| `DASHBOARD_USERNAME` | `admin` | Or choose your own username |
| `DASHBOARD_PASSWORD` | `YourSecurePassword123!` | Choose a strong password |
| `SESSION_SECRET` | (see below) | Random text |
| `SESSION_COOKIE_SECURE` | `true` | Exactly as shown |

#### How to Generate SESSION_SECRET:

Option A - Use a random string generator: Go to [generate.plus/en/base64](https://generate.plus/en/base64), generate a string, and copy it

Option B - Make up a long random string like: `myRandomSecret123abc456def789ghi012jkl345mno678`

---

### 3.3 Deploy Your App

1. Double-check all your environment variables are entered

2. Click **Create Web Service**

3. **Wait for the build** - this takes 2-5 minutes
   - You'll see a log output scrolling
   - Look for "Your service is live 🎉" at the end

4. Once done, you'll see your app URL at the top:
   ```
   https://whatsapp-api-xxxx.onrender.com
   ```

5. **Copy this URL** (you'll need it for the next step!)

6. Click the URL to test - you should see a login page!

   ❌ **See "Application Error"?** Check the logs for errors. Common issues:
   - Typo in environment variables
   - Forgot to replace `[YOUR-PASSWORD]` in DATABASE_URL

✅ **Your app is live!**

---

## ⏰ Step 4: Setup UptimeRobot

**Why?** Render's free tier puts your app to sleep after 15 minutes of no activity. UptimeRobot pings it every 5 minutes to keep it awake!

### 4.1 Add a Monitor

1. Go to [uptimerobot.com](https://uptimerobot.com) and log in

2. Click **+ Add New Monitor**

3. Fill in:

   | Field | Value |
   |-------|-------|
   | Monitor Type | `HTTP(s)` |
   | Friendly Name | `WhatsApp API` |
   | URL | `https://your-render-url.onrender.com/ping` |
   | Monitoring Interval | `5 minutes` |

   ⚠️ **Important:** Add `/ping` at the end of your URL!

4. Click **Create Monitor**

### 4.2 Verify It's Working

1. Go to your Dashboard in UptimeRobot

2. Your monitor should show a **green "Up"** status

3. If it shows "Down", wait 1-2 minutes and refresh

✅ **Your app will now run 24/7!**

---

## 📱 Step 5: Connect Your WhatsApp

Now for the exciting part - connecting your WhatsApp!

### 5.1 Log In to Your Dashboard

1. Go to your Render URL: `https://your-app.onrender.com`

2. Enter your login credentials:
   - **Username:** The `DASHBOARD_USERNAME` you set (e.g., `admin`)
   - **Password:** The `DASHBOARD_PASSWORD` you set

3. Click **Login**

4. You should see the main dashboard!

### 5.2 Create a WhatsApp Account

1. Click the **+ Add Account** button (green button, usually top-right of accounts section)

2. Enter a name for this account:
   - Example: `My WhatsApp` or `Business Account`

3. Click **Create**

4. A QR code will appear on screen!

### 5.3 Scan the QR Code

1. Open **WhatsApp** on your phone

2. Go to **Settings** (⚙️)
   - iPhone: Bottom right corner
   - Android: Three dots menu → Settings

3. Tap **Linked Devices**

4. Tap **Link a Device**

5. Point your phone camera at the QR code on your computer screen

6. Wait a few seconds...

7. The status in your dashboard will change:
   ```
   "QR Ready" → "Connecting..." → "Ready" ✅
   ```

### 5.4 Troubleshooting QR Code Issues

❓ **QR code expired?** Click the "Refresh QR" button

❓ **QR code not appearing?** Wait 30 seconds and refresh the page

❓ **Stuck on "Connecting"?** 
- Check if your phone has internet connection
- Make sure WhatsApp is updated to the latest version

✅ **Your WhatsApp is connected!**

---

## 📤 Step 6: Send Your First Message

Let's test sending a message through the API!

### 6.1 Get Your API Key

1. In your dashboard, find your connected account

2. Click the **🔑 key icon** (API Key button)

3. A modal will pop up showing:
   - **Account ID:** A long UUID like `a1b2c3d4-e5f6-...`
   - **API Key:** Starts with `wak_...`

4. Click **Copy** next to the API Key

### 6.2 Send a Test Message

You can test using the dashboard's built-in API Docs:

1. Click **API Docs** in the left sidebar

2. Expand the **/api/send** section

3. Copy the cURL example

4. Replace:
   - `wak_your_api_key` with your actual API key
   - `919876543210` with a real phone number (with country code, no + sign)
   - Update the message text if you want

5. You can run this in Terminal (Mac/Linux) or Command Prompt (Windows), or use a tool like Postman

### Example:
```bash
curl -X POST https://your-app.onrender.com/api/send \
  -H "Content-Type: application/json" \
  -H "X-API-Key: wak_abc123def456..." \
  -d '{"number": "919876543210", "message": "Hello from my API!"}'
```

If successful, you'll see a response like:
```json
{"success": true, "messageId": "ABC123..."}
```

And the recipient will receive your message on WhatsApp! 🎉

✅ **You can now send messages via API!**

---

## 🔗 Step 7: Setup Webhooks (Optional)

**What are webhooks?** When someone sends YOU a message on WhatsApp, a webhook can automatically notify your server/n8n/Zapier about it.

### 7.1 Add a Webhook

1. In your dashboard, find your account

2. Click the **🔌 plug icon** (Webhooks)

3. Click **Add Webhook**

4. Fill in:

   | Field | Description |
   |-------|-------------|
   | **URL** | Where to send notifications (e.g., your n8n webhook URL) |
   | **Events** | Check "Messages" to receive incoming messages |
   | **Secret** | Optional password to verify the webhook is from your app |

5. Click **Save**

### 7.2 Test Your Webhook

1. Send a WhatsApp message to your connected number from another phone

2. Your webhook URL should receive a POST request with the message data!

---

## 🤖 Step 8: Setup AI Chatbot (Optional)

Want your WhatsApp to automatically reply using AI? Here's how:

### 8.1 Get an AI API Key

You need an API key from one of these providers:

| Provider | Free Tier | Get Key |
|----------|-----------|---------|
| **Google Gemini** | ✅ Yes | [aistudio.google.com](https://aistudio.google.com/) |
| **Groq** | ✅ Yes | [console.groq.com](https://console.groq.com/) |
| **OpenAI** | ❌ Paid | [platform.openai.com](https://platform.openai.com/) |

**Recommended for beginners:** Gemini or Groq (both have free tiers!)

### 8.2 Configure Chatbot in Dashboard

1. In your dashboard, find your account

2. Click the **🤖 robot icon** (AI Chatbot)

3. Toggle **Enable AI Chatbot** to ON

4. Select your **Provider** (e.g., Gemini)

5. Paste your **API Key**

6. Customize the **System Prompt** (tells the AI how to behave):
   ```
   You are a helpful customer service assistant for our company.
   Be friendly, professional, and concise.
   ```

7. Click **Save Configuration**

### 8.3 Test the Chatbot

1. From another phone, send a message to your connected WhatsApp number

2. The AI will automatically reply within a few seconds!

---

## 🔧 Troubleshooting

### Common Issues and Solutions

#### ❌ "Application Error" on Render

1. Go to Render → Your Service → Logs
2. Look for error messages
3. Common causes:
   - Missing environment variables (check all required ones are set)
   - Typo in DATABASE_URL
   - Forgot to run the SQL schema in Supabase

#### ❌ Can't See QR Code

1. Wait 30 seconds and refresh the page
2. Check Render logs for errors
3. Try clicking "Refresh QR" button
4. If still not working, delete the account and create a new one

#### ❌ WhatsApp Keeps Disconnecting

1. This might happen if your session data isn't saving
2. Check that DATABASE_URL is correct
3. Make sure the database tables were created properly
4. Try logging out and reconnecting

#### ❌ Messages Not Sending

1. Make sure the account status is "Ready" (green)
2. Check your API key is correct
3. Ensure the phone number format is correct (country code + number, no spaces or +)
4. Check Render logs for error messages

#### ❌ UptimeRobot Shows "Down"

1. Make sure URL ends with `/ping` (e.g., `https://app.onrender.com/ping`)
2. Wait 2-3 minutes after deploying
3. Check if your Render service is running

---

## 📚 Quick Reference

### Your Important URLs

| What | URL |
|------|-----|
| Your Dashboard | `https://your-app.onrender.com` |
| Send Message API | `POST https://your-app.onrender.com/api/send` |
| Ping (for UptimeRobot) | `https://your-app.onrender.com/ping` |

### Your API Key Format

```
Header: X-API-Key: wak_xxxxxxxxxxxxxx
```

### Phone Number Format

Always use country code, no + sign, no spaces:
- ✅ Correct: `919876543210` (India)
- ✅ Correct: `14155551234` (USA)
- ❌ Wrong: `+91 98765 43210`
- ❌ Wrong: `9876543210` (missing country code)

---

## 🎉 Congratulations!

You did it! You now have your own WhatsApp automation system running for FREE!

### What You've Accomplished:
- ✅ Set up a free database on Supabase
- ✅ Deployed your own app on Render
- ✅ Connected your WhatsApp
- ✅ Can send messages via API
- ✅ Running 24/7 for $0/month

### Next Steps:
- ⭐ Star the repo on GitHub if this helped you!
- 🔗 Set up webhooks to receive messages
- 🤖 Configure AI chatbot for auto-replies
- 📖 Check the API Docs in your dashboard for more features

### Need Help?

- 📝 Create an issue on GitHub
- 📖 Read the main [README.md](README.md) for API documentation

---

**Happy automating! 🚀**
