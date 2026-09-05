/**
 * ResQTech Supabase Authentication Module
 * 
 * Handles Email OTP Login, Sign Up, 6-digit verification code UX,
 * session persistence, route protection, and logout functionality.
 */

(function () {
  'use strict';

  let supabaseClient = null;
  let currentEmail = '';
  let authMode = 'login'; // 'login' or 'signup'
  let resendTimerInterval = null;
  let countdownSeconds = 60;
  let isAuthenticated = false;

  // Initialize Supabase Client
  function initSupabase() {
    const config = window.RESQTECH_CONFIG || {};
    const url = config.SUPABASE_URL;
    const key = config.SUPABASE_PUBLISHABLE_KEY;

    const isPlaceholder = !url || url.includes("your-supabase-project") || !key || key.includes("your_supabase_publishable");

    if (isPlaceholder) {
      console.warn("[ResQTech Auth] Supabase configuration is set to placeholders. Auth will run in Demo Mode.");
    }

    if (window.supabase && typeof window.supabase.createClient === 'function') {
      try {
        supabaseClient = window.supabase.createClient(url, key);
      } catch (err) {
        console.error("[ResQTech Auth] Failed to initialize Supabase client:", err);
      }
    } else {
      console.error("[ResQTech Auth] Supabase JS SDK not loaded.");
    }
  }

  // DOM Element Selectors
  function getElements() {
    return {
      authScreen: document.getElementById('auth-screen'),
      dashboardScreen: document.getElementById('dashboard-screen'),
      logoutBtn: document.getElementById('logoutBtn'),
      authModeTitle: document.getElementById('auth-mode-title'),
      authSubtitle: document.getElementById('auth-subtitle'),
      tabLogin: document.getElementById('tab-login'),
      tabSignup: document.getElementById('tab-signup'),
      emailStep: document.getElementById('email-step'),
      otpStep: document.getElementById('otp-step'),
      emailInput: document.getElementById('auth-email'),
      sendOtpBtn: document.getElementById('send-otp-btn'),
      verifyOtpBtn: document.getElementById('verify-otp-btn'),
      resendOtpBtn: document.getElementById('resend-otp-btn'),
      backToEmailBtn: document.getElementById('back-to-email-btn'),
      otpInputs: document.querySelectorAll('.otp-digit-input'),
      maskedEmailSpan: document.getElementById('masked-email'),
      resendTimerSpan: document.getElementById('resend-timer'),
      authAlert: document.getElementById('auth-alert'),
    };
  }

  // Show Alert Banner
  function showAlert(message, type = 'error') {
    const els = getElements();
    if (!els.authAlert) return;

    els.authAlert.textContent = message;
    els.authAlert.className = `auth-alert ${type}`;
    els.authAlert.style.display = 'block';
  }

  function hideAlert() {
    const els = getElements();
    if (els.authAlert) {
      els.authAlert.style.display = 'none';
      els.authAlert.textContent = '';
    }
  }

  // Mask Email for Privacy (e.g., op****or@resqtech.gov)
  function maskEmail(email) {
    if (!email || !email.includes('@')) return email;
    const [name, domain] = email.split('@');
    if (name.length <= 2) {
      return `${name[0]}*@${domain}`;
    }
    const visibleStart = name.slice(0, 2);
    const visibleEnd = name.slice(-1);
    const maskedStars = '*'.repeat(Math.max(2, name.length - 3));
    return `${visibleStart}${maskedStars}${visibleEnd}@${domain}`;
  }

  // Set Auth Mode (Login vs Sign Up)
  function setAuthMode(mode) {
    authMode = mode;
    const els = getElements();
    hideAlert();

    if (mode === 'login') {
      els.tabLogin.classList.add('active');
      els.tabSignup.classList.remove('active');
      els.authModeTitle.textContent = 'COMMAND CENTER LOGIN';
      els.authSubtitle.textContent = 'Enter your email to receive a secure access code';
      els.sendOtpBtn.textContent = 'SEND ACCESS CODE';
    } else {
      els.tabSignup.classList.add('active');
      els.tabLogin.classList.remove('active');
      els.authModeTitle.textContent = 'CREATE RESQTECH ACCOUNT';
      els.authSubtitle.textContent = 'Register email address for rescue operations access';
      els.sendOtpBtn.textContent = 'CREATE ACCOUNT & SEND OTP';
    }
  }

  // Switch between Email Input step and OTP Verification step
  function showStep(step) {
    const els = getElements();
    hideAlert();

    if (step === 'email') {
      els.emailStep.style.display = 'block';
      els.otpStep.style.display = 'none';
      stopResendTimer();
      clearOtpInputs();
    } else if (step === 'otp') {
      els.emailStep.style.display = 'none';
      els.otpStep.style.display = 'block';
      if (els.maskedEmailSpan) {
        els.maskedEmailSpan.textContent = maskEmail(currentEmail);
      }
      startResendTimer();
      focusFirstOtpInput();
    }
  }

  // Clear 6-digit OTP Inputs
  function clearOtpInputs() {
    const els = getElements();
    els.otpInputs.forEach(input => {
      input.value = '';
      input.classList.remove('filled', 'error');
    });
  }

  function focusFirstOtpInput() {
    const els = getElements();
    if (els.otpInputs.length > 0) {
      setTimeout(() => els.otpInputs[0].focus(), 100);
    }
  }

  // Collect 6-digit OTP string from inputs
  function getOtpCode() {
    const els = getElements();
    let code = '';
    els.otpInputs.forEach(input => {
      code += input.value.trim();
    });
    return code;
  }

  // OTP 6-box UX Event Listeners (Auto-advance, backspace, paste)
  function setupOtpInputs() {
    const els = getElements();
    els.otpInputs.forEach((input, index) => {
      // Input event: capture single digit & advance
      input.addEventListener('input', (e) => {
        const value = e.target.value;

        // Strip non-digit characters
        const digit = value.replace(/[^0-9]/g, '');
        input.value = digit ? digit.slice(-1) : '';

        if (input.value) {
          input.classList.add('filled');
          input.classList.remove('error');
          // Auto advance to next field
          if (index < els.otpInputs.length - 1) {
            els.otpInputs[index + 1].focus();
          }
        } else {
          input.classList.remove('filled');
        }

        // Auto verify if all 6 digits entered
        if (getOtpCode().length === 6) {
          handleVerifyOtp();
        }
      });

      // Keydown event: backspace and arrow navigation
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace') {
          if (!input.value && index > 0) {
            els.otpInputs[index - 1].focus();
            els.otpInputs[index - 1].value = '';
            els.otpInputs[index - 1].classList.remove('filled');
          }
        } else if (e.key === 'ArrowLeft' && index > 0) {
          els.otpInputs[index - 1].focus();
        } else if (e.key === 'ArrowRight' && index < els.otpInputs.length - 1) {
          els.otpInputs[index + 1].focus();
        }
      });

      // Paste event: split full OTP string across 6 boxes
      input.addEventListener('paste', (e) => {
        e.preventDefault();
        const clipboardData = (e.clipboardData || window.clipboardData).getData('text');
        const digits = clipboardData.replace(/[^0-9]/g, '').slice(0, 6);

        if (digits) {
          digits.split('').forEach((char, i) => {
            if (els.otpInputs[i]) {
              els.otpInputs[i].value = char;
              els.otpInputs[i].classList.add('filled');
            }
          });

          // Focus last filled box or verify
          const nextFocusIndex = Math.min(digits.length, 5);
          els.otpInputs[nextFocusIndex].focus();

          if (digits.length === 6) {
            handleVerifyOtp();
          }
        }
      });
    });
  }

  // Resend Countdown Timer
  function startResendTimer() {
    stopResendTimer();
    countdownSeconds = 60;
    const els = getElements();
    els.resendOtpBtn.disabled = true;

    updateTimerDisplay();

    resendTimerInterval = setInterval(() => {
      countdownSeconds--;
      updateTimerDisplay();

      if (countdownSeconds <= 0) {
        stopResendTimer();
        els.resendOtpBtn.disabled = false;
        if (els.resendTimerSpan) {
          els.resendTimerSpan.textContent = '';
        }
      }
    }, 1000);
  }

  function stopResendTimer() {
    if (resendTimerInterval) {
      clearInterval(resendTimerInterval);
      resendTimerInterval = null;
    }
  }

  function updateTimerDisplay() {
    const els = getElements();
    if (els.resendTimerSpan && countdownSeconds > 0) {
      els.resendTimerSpan.textContent = ` (${countdownSeconds}s)`;
    }
  }

  // Send OTP Handler
  async function handleSendOtp() {
    const els = getElements();
    hideAlert();

    const email = els.emailInput.value.trim();

    // Validation
    if (!email) {
      showAlert('Please enter your email address.', 'error');
      els.emailInput.focus();
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      showAlert('Please enter a valid email address.', 'error');
      els.emailInput.focus();
      return;
    }

    currentEmail = email;

    // Loading State
    const originalBtnText = els.sendOtpBtn.textContent;
    els.sendOtpBtn.disabled = true;
    els.sendOtpBtn.textContent = 'SENDING OTP...';

    try {
      const config = window.RESQTECH_CONFIG || {};
      const isPlaceholder = !config.SUPABASE_URL || config.SUPABASE_URL.includes("your-supabase-project");

      if (isPlaceholder || !supabaseClient) {
        // Fallback / Demo Mode for testing when Supabase credentials are placeholder
        console.log("[ResQTech Auth] Running in demo mode. OTP code is simulated (e.g. 123456).");
        showAlert('Demo Mode: Security OTP simulated! Use code 123456 to verify.', 'info');
        setTimeout(() => {
          els.sendOtpBtn.disabled = false;
          els.sendOtpBtn.textContent = originalBtnText;
          showStep('otp');
        }, 800);
        return;
      }

      // Supabase signInWithOtp API call
      const { data, error } = await supabaseClient.auth.signInWithOtp({
        email: currentEmail,
        options: {
          shouldCreateUser: authMode === 'signup',
        }
      });

      if (error) {
        let msg = error.message;
        if (msg.includes('rate limit')) {
          msg = 'Too many requests. Please wait a moment before trying again.';
        }
        showAlert(msg, 'error');
      } else {
        showAlert('OTP code sent to your email!', 'success');
        showStep('otp');
      }
    } catch (err) {
      showAlert('Network error sending OTP. Please check connection.', 'error');
      console.error("[ResQTech Auth] Send OTP exception:", err);
    } finally {
      els.sendOtpBtn.disabled = false;
      els.sendOtpBtn.textContent = originalBtnText;
    }
  }

  // Verify OTP Handler
  async function handleVerifyOtp() {
    const els = getElements();
    hideAlert();

    const otpCode = getOtpCode();

    if (!otpCode || otpCode.length < 6) {
      showAlert('Please enter the full 6-digit OTP code.', 'error');
      return;
    }

    // Loading State
    const originalBtnText = els.verifyOtpBtn.textContent;
    els.verifyOtpBtn.disabled = true;
    els.verifyOtpBtn.textContent = 'VERIFYING...';

    try {
      const config = window.RESQTECH_CONFIG || {};
      const isPlaceholder = !config.SUPABASE_URL || config.SUPABASE_URL.includes("your-supabase-project");

      if (isPlaceholder || !supabaseClient) {
        // Fallback / Demo Mode check
        if (otpCode === '123456' || otpCode === '000000') {
          showAlert('OTP Verified Successfully!', 'success');
          setTimeout(() => {
            setAuthenticatedState(true, { user: { email: currentEmail } });
          }, 600);
        } else {
          showAlert('Invalid OTP code. For Demo Mode, enter 123456.', 'error');
          markOtpError();
        }
        els.verifyOtpBtn.disabled = false;
        els.verifyOtpBtn.textContent = originalBtnText;
        return;
      }

      // Supabase verifyOtp API call
      const { data, error } = await supabaseClient.auth.verifyOtp({
        email: currentEmail,
        token: otpCode,
        type: 'email',
      });

      if (error) {
        let errorMsg = error.message;
        if (errorMsg.includes('expired') || errorMsg.includes('Invalid')) {
          errorMsg = 'Invalid or expired OTP code. Please check or request a new code.';
        }
        showAlert(errorMsg, 'error');
        markOtpError();
      } else if (data && data.session) {
        showAlert('Verification successful! Accessing Command Center...', 'success');
        setTimeout(() => {
          setAuthenticatedState(true, data.session);
        }, 500);
      } else {
        // Fallback if session is created via auth state change listener
        showAlert('OTP Verified!', 'success');
        setAuthenticatedState(true);
      }
    } catch (err) {
      showAlert('Error verifying OTP code. Please try again.', 'error');
      console.error("[ResQTech Auth] Verify OTP exception:", err);
      markOtpError();
    } finally {
      els.verifyOtpBtn.disabled = false;
      els.verifyOtpBtn.textContent = originalBtnText;
    }
  }

  function markOtpError() {
    const els = getElements();
    els.otpInputs.forEach(input => input.classList.add('error'));
  }

  // Handle Logout
  async function handleLogout() {
    const els = getElements();
    if (els.logoutBtn) {
      els.logoutBtn.disabled = true;
      els.logoutBtn.textContent = 'LOGGING OUT...';
    }

    try {
      if (supabaseClient) {
        await supabaseClient.auth.signOut();
      }
    } catch (err) {
      console.warn("[ResQTech Auth] Error during sign out:", err);
    } finally {
      if (els.logoutBtn) {
        els.logoutBtn.disabled = false;
        els.logoutBtn.textContent = 'LOGOUT';
      }
      setAuthenticatedState(false);
    }
  }

  // Update Page View state (Show/Hide Dashboard vs Auth Screen)
  function setAuthenticatedState(authed, session = null) {
    isAuthenticated = authed;
    const els = getElements();

    if (authed) {
      if (els.authScreen) els.authScreen.style.display = 'none';
      if (els.dashboardScreen) els.dashboardScreen.style.display = 'block';
      if (els.logoutBtn) els.logoutBtn.style.display = 'inline-flex';

      // Trigger app refresh loop if function exists in app.js
      if (window.startDashboardPolling && typeof window.startDashboardPolling === 'function') {
        window.startDashboardPolling();
      }
    } else {
      if (els.authScreen) els.authScreen.style.display = 'flex';
      if (els.dashboardScreen) els.dashboardScreen.style.display = 'none';
      if (els.logoutBtn) els.logoutBtn.style.display = 'none';

      // Stop refresh loop if unauthenticated
      if (window.stopDashboardPolling && typeof window.stopDashboardPolling === 'function') {
        window.stopDashboardPolling();
      }

      showStep('email');
    }
  }

  // Check initial session & register auth listener
  async function checkInitialSession() {
    if (!supabaseClient) {
      setAuthenticatedState(false);
      return;
    }

    try {
      const { data: { session }, error } = await supabaseClient.auth.getSession();
      if (session && !error) {
        setAuthenticatedState(true, session);
      } else {
        setAuthenticatedState(false);
      }
    } catch (err) {
      console.error("[ResQTech Auth] Session check failed:", err);
      setAuthenticatedState(false);
    }

    // Subscribe to session state changes
    try {
      supabaseClient.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_IN' && session) {
          setAuthenticatedState(true, session);
        } else if (event === 'SIGNED_OUT') {
          setAuthenticatedState(false);
        }
      });
    } catch (err) {
      console.warn("[ResQTech Auth] Could not listen to auth state changes:", err);
    }
  }

  // Initialize event listeners
  function initEventListeners() {
    const els = getElements();

    if (els.tabLogin) {
      els.tabLogin.addEventListener('click', () => setAuthMode('login'));
    }
    if (els.tabSignup) {
      els.tabSignup.addEventListener('click', () => setAuthMode('signup'));
    }
    if (els.sendOtpBtn) {
      els.sendOtpBtn.addEventListener('click', handleSendOtp);
    }
    if (els.verifyOtpBtn) {
      els.verifyOtpBtn.addEventListener('click', handleVerifyOtp);
    }
    if (els.resendOtpBtn) {
      els.resendOtpBtn.addEventListener('click', handleSendOtp);
    }
    if (els.backToEmailBtn) {
      els.backToEmailBtn.addEventListener('click', () => showStep('email'));
    }
    if (els.logoutBtn) {
      els.logoutBtn.addEventListener('click', handleLogout);
    }
    if (els.emailInput) {
      els.emailInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          handleSendOtp();
        }
      });
    }

    setupOtpInputs();
  }

  // Initialize Auth on DOM content loaded
  document.addEventListener('DOMContentLoaded', () => {
    initSupabase();
    initEventListeners();
    checkInitialSession();
  });

  // Expose global auth helper methods
  window.ResQTechAuth = {
    isAuthenticated: () => isAuthenticated,
    logout: handleLogout,
    checkSession: checkInitialSession
  };

})();
