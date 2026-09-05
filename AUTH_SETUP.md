# ResQTech Supabase Auth Setup & Deployment Guide

This guide provides instructions to configure **Supabase Email OTP Authentication** for your ResQTech project and deploy the frontend on **Vercel** with your Render FastAPI backend.

---

## 1. Creating a Supabase Project

1. Go to [https://supabase.com/](https://supabase.com/) and log in / create a free account.
2. Click **New Project**.
3. Select your organization, enter a project name (e.g. `ResQTech-Auth`), and set a strong database password.
4. Choose a region close to your deployment users.
5. Click **Create new project** and wait a few moments for setup to complete.

---

## 2. Finding Supabase Project URL & Anon/Publishable Key

1. In your Supabase Dashboard, navigate to **Project Settings** (gear icon) > **API**.
2. Under **Project API keys**, you will find:
   - **Project URL**: `https://<your-project-ref>.supabase.co`
   - **anon / public key**: `eyJhbGci...` (Publishable Key)

> [!IMPORTANT]
> - **SAFE FOR FRONTEND**: The `Project URL` and `anon / public key` are safe to include in frontend JavaScript and Vercel environment variables.
> - **NEVER EXPOSE**: The `service_role` secret key! Never include the `service_role` key in frontend code, git repositories, or public configs.

---

## 3. Enabling Email OTP Authentication in Supabase

1. In Supabase Dashboard, go to **Authentication** > **Providers**.
2. Click on **Email**.
3. Ensure **Enable Email provider** is turned **ON**.
4. Enable **Confirm Email** or **Enable Email OTP / Magic Link**.
5. (Optional for production) Configure your custom SMTP provider under **Authentication** > **SMTP Settings** if you wish to use custom sender domains instead of default Supabase quota emails.

---

## 4. Configuring Supabase Redirect & Site URL Settings

1. In Supabase Dashboard, go to **Authentication** > **URL Configuration**.
2. Set **Site URL** to your Vercel deployment URL (e.g., `https://resqtech.vercel.app`) or `http://localhost:8000` for local development.
3. Under **Redirect URLs**, add:
   - `http://localhost:8000/**`
   - `http://127.0.0.1:8000/**`
   - `https://your-vercel-domain.vercel.app/**`

---

## 5. Configuring Vercel Environment Variables

When deploying the frontend on Vercel:

1. Import your project repository into Vercel.
2. Go to **Project Settings** > **Environment Variables**.
3. Add the following environment variables:

| Variable Name | Value | Description |
| :--- | :--- | :--- |
| `SUPABASE_URL` | `https://<your-project-ref>.supabase.co` | Your Supabase Project URL |
| `SUPABASE_PUBLISHABLE_KEY` | `eyJhbGci...` | Supabase Anon / Publishable Key |
| `VITE_BACKEND_URL` | `https://your-backend.onrender.com` | Deployed Render FastAPI URL |

---

## 6. Local Development & Testing

### Running locally with python HTTP server or FastAPI:

```bash
# Option A: Run via backend app (Serves frontend static files on http://127.0.0.1:8000)
cd backend
python app.py

# Option B: Serve frontend static files directly
cd frontend
python -m http.server 8000
```

### Local Configuration (`frontend/config.js`):
Update `frontend/config.js` with your active Supabase credentials:

```javascript
const CONFIG = {
  SUPABASE_URL: "https://your-project-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "your_actual_anon_key_here",
  BACKEND_URL: "http://127.0.0.1:8000"
};
```

*Note: If placeholders are left in `config.js`, ResQTech automatically enters **Demo Mode**, allowing you to test the complete UI and enter code `123456` to simulate OTP verification.*

---

## 7. How to Test Auth Operations

1. **Unauthenticated Access Protection**:
   - Open `http://127.0.0.1:8000/`.
   - Verify that the tactical Login authentication card is displayed and the main dashboard is completely hidden.

2. **Sign Up Flow**:
   - Click the **SIGN UP** tab.
   - Enter your email address.
   - Click **CREATE ACCOUNT & SEND OTP**.
   - Check your email inbox for the 6-digit verification code.

3. **6-Digit OTP Verification**:
   - Enter the 6 digits into the separate digit boxes.
   - Observe auto-focus advance on digit entry, backspace navigation support, and paste support.
   - Verification will automatically trigger upon entering the 6th digit (or by clicking **VERIFY & ENTER COMMAND CENTER**).

4. **Dashboard Access & Session Persistence**:
   - Upon successful verification, you are redirected to the ResQTech Tactical Dashboard.
   - Refresh the page ($F5$). Observe that your session persists automatically without asking for login again.

5. **Logout**:
   - Click the red **LOGOUT** button in the header.
   - Your Supabase session is invalidated, and you are returned to the Login screen.
