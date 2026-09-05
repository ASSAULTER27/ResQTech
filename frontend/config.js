/**
 * ResQTech Frontend Configuration
 * 
 * IMPORTANT SECURITY NOTICE:
 * - SUPABASE_URL: Safe to expose in client-side code.
 * - SUPABASE_PUBLISHABLE_KEY (anon key): Safe to expose in client-side code.
 * - SUPABASE_SERVICE_ROLE_KEY: NEVER expose in client-side JavaScript or HTML!
 * 
 * For Vercel Deployment:
 * Set environment variables in Vercel settings (or inject into config):
 * - SUPABASE_URL
 * - SUPABASE_PUBLISHABLE_KEY (or VITE_SUPABASE_ANON_KEY)
 * - VITE_API_URL (preferred) or VITE_BACKEND_URL
 */

const CONFIG = {
  // Replace these placeholders with your actual Supabase credentials
  SUPABASE_URL: (typeof window !== 'undefined' && window.ENV && window.ENV.SUPABASE_URL)
    ? window.ENV.SUPABASE_URL
    : "https://your-supabase-project.supabase.co",

  SUPABASE_PUBLISHABLE_KEY: (typeof window !== 'undefined' && window.ENV && window.ENV.SUPABASE_PUBLISHABLE_KEY)
    ? window.ENV.SUPABASE_PUBLISHABLE_KEY
    : "your_supabase_publishable_anon_key",

  // This static frontend has no Vite build step, so keep the deployed URL as
  // the production fallback while allowing optional runtime configuration.
  BACKEND_URL: ((typeof window !== 'undefined' && window.ENV && (window.ENV.VITE_API_URL || window.ENV.VITE_BACKEND_URL))
    || "https://resqtech-k5xd.onrender.com").replace(/\/$/, "")
};

// Make config globally available
window.RESQTECH_CONFIG = CONFIG;
