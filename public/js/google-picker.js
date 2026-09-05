// =============================================
// StudyCore — Google Picker bootstrap
// ---------------------------------------------
// Loads the two official Google libraries used by the Picker:
//
//   1. Google API loader ....... https://apis.google.com/js/api.js
//   2. Google Identity Services  https://accounts.google.com/gsi/client
//
// The "Select from Google Drive" button in the existing Content Admin
// Dashboard stays disabled until BOTH the Picker API (gapi.load('picker'))
// and Google Identity Services (google.accounts.oauth2) are genuinely
// available — we feature-detect the real objects, never just the button.
//
// Every failure is surfaced in the dashboard status line AND logged to the
// browser console with the underlying error so it can be diagnosed.
// =============================================

(function () {
  'use strict';

  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const GAPI_SRC = 'https://apis.google.com/js/api.js';
  const GIS_SRC = 'https://accounts.google.com/gsi/client';

  const state = {
    pickerApiLoaded: false,
    gisLoaded: false,
    config: null,
    tokenClient: null,
    accessToken: null,
    failed: false
  };

  function statusEl() { return document.getElementById('caDriveStatus'); }
  function buttonEl() { return document.getElementById('caSelectDriveBtn'); }

  function setStatus(text, kind) {
    const el = statusEl();
    if (!el) return;
    el.textContent = text;
    el.dataset.state = kind || 'loading';
    el.style.color = kind === 'error' ? '#c0392b' : (kind === 'ready' ? 'var(--muted)' : 'var(--muted)');
  }

  function fail(stage, err) {
    state.failed = true;
    // Stage names map 1:1 to the diagnostic categories used in the runbook.
    console.error('[StudyCore][GooglePicker] FAILURE (' + stage + '):', err);
    setStatus('Google Drive failed to load — ' + stage + ' (see browser console)', 'error');
    const btn = buttonEl();
    if (btn) btn.disabled = true;
  }

  // ---- Library loading -------------------------------------------------

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      const existing = document.querySelector('script[data-sc-src="' + src + '"]');
      if (existing) {
        if (existing.dataset.scLoaded === '1') return resolve();
        existing.addEventListener('load', function () { resolve(); });
        existing.addEventListener('error', function () { reject(new Error('Failed to load ' + src)); });
        return;
      }
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.defer = true;
      s.dataset.scSrc = src;
      s.onload = function () { s.dataset.scLoaded = '1'; resolve(); };
      s.onerror = function () { reject(new Error('Failed to load ' + src + ' (network/CSP/blocked)')); };
      document.head.appendChild(s);
    });
  }

  // 1. Google API loader → gapi.load('picker', onPickerApiLoad)
  function loadPickerApi() {
    return loadScript(GAPI_SRC).then(function () {
      if (typeof window.gapi === 'undefined' || typeof window.gapi.load !== 'function') {
        throw new Error('gapi is undefined after loading ' + GAPI_SRC);
      }
      return new Promise(function (resolve, reject) {
        const timer = setTimeout(function () {
          reject(new Error("gapi.load('picker') timed out after 20s"));
        }, 20000);
        try {
          // Only the Picker module is required here; switch to
          // 'client:picker' if the Drive REST client is ever needed.
          window.gapi.load('picker', {
            callback: function onPickerApiLoad() {
              clearTimeout(timer);
              if (!window.google || !window.google.picker || !window.google.picker.PickerBuilder) {
                reject(new Error('google.picker is unavailable after gapi.load("picker")'));
                return;
              }
              state.pickerApiLoaded = true;
              console.info('[StudyCore][GooglePicker] google.picker ready');
              resolve();
            },
            onerror: function (e) { clearTimeout(timer); reject(e || new Error('gapi.load("picker") onerror')); },
            timeout: 20000,
            ontimeout: function () { clearTimeout(timer); reject(new Error('gapi.load("picker") ontimeout')); }
          });
        } catch (e) {
          clearTimeout(timer);
          reject(e);
        }
      });
    });
  }

  // 2. Google Identity Services → google.accounts.oauth2
  function loadIdentityServices() {
    return loadScript(GIS_SRC).then(function () {
      if (!window.google || !window.google.accounts || !window.google.accounts.oauth2) {
        throw new Error('google.accounts.oauth2 is undefined after loading ' + GIS_SRC);
      }
      state.gisLoaded = true;
      console.info('[StudyCore][GooglePicker] google.accounts.oauth2 ready');
    });
  }

  // ---- Readiness -------------------------------------------------------

  function everythingReady() {
    return Boolean(
      state.pickerApiLoaded &&
      state.gisLoaded &&
      window.gapi &&
      window.google &&
      window.google.picker &&
      window.google.picker.PickerBuilder &&
      window.google.accounts &&
      window.google.accounts.oauth2 &&
      state.config &&
      state.config.clientId &&
      state.config.apiKey
    );
  }

  function enableButton() {
    const btn = buttonEl();
    if (!btn) return;
    btn.disabled = false;
    setStatus('Google Drive ready', 'ready');
  }

  // ---- Picker ----------------------------------------------------------

  function createPicker(accessToken) {
    try {
      const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(false);

      const builder = new google.picker.PickerBuilder()
        .addView(view)
        .addView(new google.picker.DocsUploadView())
        .setOAuthToken(accessToken)
        .setDeveloperKey(state.config.apiKey)
        .setAppId(state.config.appId)
        .setCallback(pickerCallback)
        .setOrigin(window.location.protocol + '//' + window.location.host);

      const picker = builder.build();
      picker.setVisible(true);
    } catch (err) {
      fail('Google Picker initialization', err);
    }
  }

  function pickerCallback(data) {
    if (!data || data.action !== google.picker.Action.PICKED) return;
    const doc = (data.docs && data.docs[0]) || null;
    if (!doc) return;
    console.info('[StudyCore][GooglePicker] file picked:', doc.id, doc.name);
    // Hand the Drive file off to the existing Content Admin dashboard code.
    if (typeof window.onGoogleDriveFilePicked === 'function') {
      window.onGoogleDriveFilePicked(doc);
    } else {
      console.warn('[StudyCore][GooglePicker] onGoogleDriveFilePicked handler missing');
    }
  }

  function requestTokenAndOpen() {
    // Re-verify at click time — the libraries can be evicted or blocked.
    if (typeof window.gapi === 'undefined') {
      fail('Google API library loading', new Error('gapi is not defined at click time'));
      return;
    }
    if (!window.google || !window.google.picker) {
      fail('Google Picker initialization', new Error('google.picker is not defined at click time'));
      return;
    }
    if (!window.google.accounts || !window.google.accounts.oauth2) {
      fail('Google Identity Services loading', new Error('google.accounts.oauth2 is not defined at click time'));
      return;
    }
    if (!state.config || !state.config.clientId) {
      fail('Project/App ID', new Error('GOOGLE_CLIENT_ID is missing from /api/config'));
      return;
    }

    try {
      if (!state.tokenClient) {
        state.tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: state.config.clientId,
          scope: SCOPE,
          callback: function (tokenResponse) {
            if (!tokenResponse || tokenResponse.error) {
              fail('OAuth authorization', tokenResponse || new Error('Empty token response'));
              return;
            }
            state.accessToken = tokenResponse.access_token;
            createPicker(state.accessToken);
          },
          error_callback: function (err) {
            fail('OAuth authorization', err);
          }
        });
      }
      if (state.accessToken) {
        createPicker(state.accessToken);
      } else {
        state.tokenClient.requestAccessToken({ prompt: '' });
      }
    } catch (err) {
      fail('OAuth authorization', err);
    }
  }

  // Kept for backwards compatibility with any inline onclick handlers.
  window.openPicker = requestTokenAndOpen;

  // ---- Bootstrap -------------------------------------------------------

  function bootstrap() {
    if (!buttonEl()) return; // Not the Content Admin dashboard.
    setStatus('Loading Google Drive…', 'loading');
    buttonEl().disabled = true;
    buttonEl().addEventListener('click', function (e) {
      e.preventDefault();
      requestTokenAndOpen();
    });

    const configReady = window.STUDYCORE_CONFIG_READY || Promise.resolve(window.STUDYCORE_CONFIG || {});

    configReady
      .then(function (cfg) {
        const picker = (cfg && cfg.googlePicker) || (window.STUDYCORE_CONFIG && window.STUDYCORE_CONFIG.googlePicker) || {};
        state.config = {
          apiKey: picker.apiKey || '',
          clientId: picker.clientId || '',
          appId: picker.appId || ''
        };
        if (!state.config.apiKey || !state.config.clientId || !state.config.appId) {
          console.warn('[StudyCore][GooglePicker] Missing config values:', {
            hasApiKey: Boolean(state.config.apiKey),
            hasClientId: Boolean(state.config.clientId),
            hasAppId: Boolean(state.config.appId)
          });
        }
        return Promise.all([
          loadPickerApi().catch(function (e) { throw { stage: 'Google API library loading', error: e }; }),
          loadIdentityServices().catch(function (e) { throw { stage: 'Google Identity Services loading', error: e }; })
        ]);
      })
      .then(function () {
        if (!everythingReady()) {
          throw {
            stage: 'Google Picker initialization',
            error: new Error('Readiness check failed: ' + JSON.stringify({
              gapi: typeof window.gapi !== 'undefined',
              picker: Boolean(window.google && window.google.picker),
              gis: Boolean(window.google && window.google.accounts && window.google.accounts.oauth2),
              clientId: Boolean(state.config && state.config.clientId),
              apiKey: Boolean(state.config && state.config.apiKey)
            }))
          };
        }
        enableButton();
      })
      .catch(function (wrapped) {
        const stage = (wrapped && wrapped.stage) || 'Google Picker initialization';
        fail(stage, (wrapped && wrapped.error) || wrapped);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
