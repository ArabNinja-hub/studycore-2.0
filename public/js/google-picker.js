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
// available AND the server config (/api/config → googlePicker) carries a
// valid OAuth Web Client ID, API key and NUMERIC project number. We
// feature-detect the real objects and audit the real values — never just
// the button.
//
// Every failure is surfaced in the dashboard status line AND logged to the
// browser console with the exact error, its full stack trace, and a
// 10-point diagnostic audit answering each checkpoint of the runbook:
//
//   1. api.js loaded            6. OAuth access token returned
//   2. gsi/client loaded        7. GOOGLE_CLIENT_ID loaded + well-formed
//   3. gapi.load('picker') done 8. GOOGLE_API_KEY loaded + well-formed
//   4. google.picker.PickerBuilder  9. GOOGLE_CLOUD_PROJECT_NUMBER loaded +
//   5. google.accounts.oauth2         numeric (and matching the client ID)
//                                    10. Picker only initialized after the
//                                        libraries + config are ready
//
// A "Retry" button appears next to the status line after any failure, so a
// transient network hiccup (or a corrected server env var) can be retried
// without reloading the page.
// =============================================

(function () {
  'use strict';

  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const GAPI_SRC = 'https://apis.google.com/js/api.js';
  const GIS_SRC = 'https://accounts.google.com/gsi/client';
  // OAuth access tokens are 1h; refresh a minute early so a long-lived
  // dashboard session never hands a stale token to the Picker.
  const TOKEN_SAFETY_MARGIN_MS = 60 * 1000;
  // An OAuth Web application Client ID is "<projectNumber>-<suffix>.apps.googleusercontent.com".
  const WEB_CLIENT_ID_RE = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;
  // Google Cloud project NUMBERS are 10-20 digits (the project ID string,
  // e.g. "studycore-abc123", is NOT accepted: setAppId() needs the number).
  const PROJECT_NUMBER_RE = /^[0-9]{10,20}$/;
  const API_KEY_RE = /^AIza[0-9A-Za-z_-]{30,}$/;

  const state = {
    config: null,       // { apiKey, clientId, appId, issues }
    configAudit: null,  // { ok, checks: [{name, ok, detail}] }
    configFetchFailed: false,
    pickerApiLoaded: false,
    gisLoaded: false,
    tokenClient: null,
    accessToken: null,
    tokenExpiresAt: 0,
    failed: false,
    failedStage: null
  };

  function statusEl() { return document.getElementById('caDriveStatus'); }
  function buttonEl() { return document.getElementById('caSelectDriveBtn'); }
  function retryEl() { return document.getElementById('caDriveRetryBtn'); }

  function setStatus(text, kind) {
    const el = statusEl();
    if (!el) return;
    el.textContent = text;
    el.dataset.state = kind || 'loading';
    el.style.color = kind === 'error' ? '#c0392b' : (kind === 'ready' ? 'var(--muted)' : 'var(--muted)');
  }

  // ---- Config audit --------------------------------------------------------
  // Answers "is GOOGLE_CLIENT_ID / GOOGLE_API_KEY / GOOGLE_CLOUD_PROJECT_NUMBER
  // loaded correctly?" from the browser side, with the exact problem named.
  // The server performs the same audit at boot (see server.js) and in
  // /api/config (`googlePicker.issues`); both must agree.

  function auditConfig(pickerCfg) {
    pickerCfg = pickerCfg || {};
    const clientId = String(pickerCfg.clientId || '').trim();
    const apiKey = String(pickerCfg.apiKey || '').trim();
    const appId = String(pickerCfg.appId || '').trim();

    const checks = [];
    function check(name, ok, detail) { checks.push({ name: name, ok: Boolean(ok), detail: detail }); return Boolean(ok); }

    check('GOOGLE_CLIENT_ID', clientId.length > 0,
      clientId
        ? 'present: ' + clientId
        : 'EMPTY — the server environment variable GOOGLE_CLIENT_ID is not set (or /api/config did not return googlePicker)');

    check('Client ID is an OAuth Web application ID', clientId ? WEB_CLIENT_ID_RE.test(clientId) : false,
      clientId
        ? (WEB_CLIENT_ID_RE.test(clientId)
          ? 'valid Web client ID format'
          : 'NOT a Web application client ID ("' + clientId + '"). The Picker needs the OAuth *Web application* Client ID that ends in .apps.googleusercontent.com')
        : 'cannot validate — value is empty');

    check('GOOGLE_CLOUD_PROJECT_NUMBER', appId ? PROJECT_NUMBER_RE.test(appId) : false,
      appId
        ? (PROJECT_NUMBER_RE.test(appId)
          ? 'numeric project number: ' + appId
          : 'NOT the numeric project number (got "' + appId + '"). Use the numeric Google Cloud project number, not the project ID')
        : 'EMPTY — the server environment variable GOOGLE_CLOUD_PROJECT_NUMBER is not set');

    check('GOOGLE_API_KEY', apiKey ? API_KEY_RE.test(apiKey) : false,
      apiKey
        ? (API_KEY_RE.test(apiKey)
          ? 'present (' + apiKey.slice(0, 6) + '…, ' + apiKey.length + ' chars)'
          : 'does not look like a valid API key (expected "AIza…" of ~39 chars)')
        : 'EMPTY — the server environment variable GOOGLE_API_KEY is not set');

    // Classic blank-Picker cause: the Client ID and the App ID (project
    // number) must belong to the SAME Google Cloud project. A Web Client ID
    // starts with its own project number, so the match is checkable here.
    const clientProject = clientId ? clientId.split('-')[0] : '';
    if (clientProject && PROJECT_NUMBER_RE.test(appId)) {
      check('Client ID project ↔ GOOGLE_CLOUD_PROJECT_NUMBER', clientProject === appId,
        clientProject === appId
          ? 'both belong to project ' + appId
          : 'MISMATCH — the Client ID belongs to project ' + clientProject + ' but GOOGLE_CLOUD_PROJECT_NUMBER is ' + appId + '. Both values must come from the same Google Cloud project, otherwise the Picker window opens but shows no files.');
    } else {
      checks.push({ name: 'Client ID project ↔ GOOGLE_CLOUD_PROJECT_NUMBER', ok: false, detail: 'cannot verify — fix the values above first' });
    }

    return { ok: checks.every((c) => c.ok), checks: checks };
  }

  // ---- Diagnostics ---------------------------------------------------------

  function pickerBuilderAvailable() {
    return Boolean(window.google && window.google.picker && window.google.picker.PickerBuilder);
  }
  function gisAvailable() {
    return Boolean(window.google && window.google.accounts && window.google.accounts.oauth2);
  }
  function tokenFresh() {
    return Boolean(state.accessToken) && Date.now() < state.tokenExpiresAt;
  }

  function auditDetail(name) {
    if (!state.configAudit) return 'config not loaded yet';
    const found = state.configAudit.checks.find((c) => c.name === name);
    return found ? (found.ok ? 'PASS — ' + found.detail : 'FAIL — ' + found.detail) : 'n/a';
  }

  // The 10-point runbook audit, printed to the console. Called on every
  // failure and also exposed for manual inspection:
  //   window.__STUDYCORE_PICKER_DIAGNOSTICS__()
  function dumpDiagnostics(context) {
    const rows = [
      ['1.  api.js loaded (gapi defined)', typeof window.gapi !== 'undefined' && typeof window.gapi.load === 'function', 'gapi.' + (typeof window.gapi !== 'undefined' ? 'load available' : 'UNDEFINED after loading ' + GAPI_SRC)],
      ['2.  gsi/client loaded (script executed)', Boolean(window.google && window.google.accounts), window.google && window.google.accounts ? 'google.accounts present' : 'google.accounts UNDEFINED after loading ' + GIS_SRC],
      ["3.  gapi.load('picker', …) completed", state.pickerApiLoaded, state.pickerApiLoaded ? 'callback fired' : 'callback never fired (script error, blocked, or timed out)'],
      ['4.  google.picker.PickerBuilder available', pickerBuilderAvailable(), pickerBuilderAvailable() ? 'constructor present' : 'picker module not defined (gapi.load("picker") did not deliver it)'],
      ['5.  google.accounts.oauth2 available', gisAvailable(), gisAvailable() ? 'initTokenClient present' : 'OAuth2 token client not defined'],
      ['6.  OAuth access token', tokenFresh(), tokenFresh()
        ? 'valid until ' + new Date(state.tokenExpiresAt).toISOString()
        : (state.accessToken ? 'expired at ' + new Date(state.tokenExpiresAt).toISOString() + ' (will be re-requested)' : 'not requested yet')],
      ['7.  GOOGLE_CLIENT_ID loaded correctly', state.configAudit ? state.configAudit.checks.slice(0, 2).every((c) => c.ok) : false, auditDetail('GOOGLE_CLIENT_ID') + ' | ' + auditDetail('Client ID is an OAuth Web application ID')],
      ['8.  GOOGLE_API_KEY loaded correctly', state.configAudit ? state.configAudit.checks[3].ok : false, auditDetail('GOOGLE_API_KEY')],
      ['9.  GOOGLE_CLOUD_PROJECT_NUMBER loaded correctly', state.configAudit ? state.configAudit.checks.slice(2, 3).every((c) => c.ok) : false, auditDetail('GOOGLE_CLOUD_PROJECT_NUMBER') + ' | ' + auditDetail('Client ID project ↔ GOOGLE_CLOUD_PROJECT_NUMBER')],
      ['10. Picker only initializes after libraries + valid config', state.pickerApiLoaded && state.gisLoaded && pickerBuilderAvailable() && gisAvailable() && Boolean(state.configAudit && state.configAudit.ok),
        'bootstrap gate enforces: gapi.load("picker") done + GIS ready + all config values valid before the button is enabled']
    ];

    const out = rows.map(function (row) {
      return '   ' + (row[1] ? 'PASS' : 'FAIL') + '  ' + row[0] + ' — ' + row[2];
    }).join('\n');

    console.error('[StudyCore][GooglePicker] Diagnostics (' + (context || 'manual') + '):\n' + out);
    return { rows: rows, out: out };
  }

  window.__STUDYCORE_PICKER_DIAGNOSTICS__ = dumpDiagnostics;

  // ---- Failure reporting ---------------------------------------------------

  function fail(stage, err) {
    state.failed = true;
    state.failedStage = stage;
    // Exact error + full stack trace, exactly as requested by the runbook.
    const detail = (err && err.stack) ? err.stack : (err && err.message) ? err.message : String(err);
    console.error('[StudyCore][GooglePicker] FAILURE (' + stage + '):', detail);
    dumpDiagnostics('after failure: ' + stage);
    setStatus('Google Drive failed to load — ' + stage + ' (see browser console)', 'error');
    const btn = buttonEl();
    if (btn) btn.disabled = true;
    showRetry();
  }

  function showRetry() {
    const el = retryEl();
    if (!el) return;
    el.hidden = false;
  }
  function hideRetry() {
    const el = retryEl();
    if (el) el.hidden = true;
  }

  // ---- Library loading -----------------------------------------------------

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      const existing = document.querySelector('script[data-sc-src="' + src + '"]');
      if (existing) {
        if (existing.dataset.scLoaded === '1') return resolve();
        if (existing.dataset.scFailed === '1') {
          // A previously failed tag can never fire its load event again;
          // drop it and try a fresh fetch (this is what makes "Retry" work).
          existing.remove();
        } else {
          existing.addEventListener('load', function () { resolve(); });
          existing.addEventListener('error', function () { reject(new Error('Failed to load ' + src)); });
          return;
        }
      }
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.dataset.scSrc = src;
      s.onload = function () { s.dataset.scLoaded = '1'; resolve(); };
      s.onerror = function () {
        s.dataset.scFailed = '1';
        reject(new Error('Failed to load ' + src + ' (network failure, CSP block, or the origin is unreachable)'));
      };
      document.head.appendChild(s);
    });
  }

  // 1. Google API loader → gapi.load('picker', onPickerApiLoad)
  function loadPickerApi() {
    return loadScript(GAPI_SRC).then(function () {
      if (typeof window.gapi === 'undefined' || typeof window.gapi.load !== 'function') {
        throw new Error('gapi is undefined after loading ' + GAPI_SRC + ' — the script loaded but defined nothing (wrong file, blocked by CSP, or ad blocker)');
      }
      return new Promise(function (resolve, reject) {
        const timer = setTimeout(function () {
          reject(new Error("gapi.load('picker') timed out after 20s — the picker module did not arrive from Google (network/CSP issue)"));
        }, 20000);
        try {
          // Only the Picker module is required here; switch to
          // 'client:picker' if the Drive REST client is ever needed.
          window.gapi.load('picker', {
            callback: function onPickerApiLoad() {
              clearTimeout(timer);
              if (!pickerBuilderAvailable()) {
                reject(new Error('google.picker.PickerBuilder is unavailable after gapi.load("picker") completed — the picker module did not define its namespace'));
                return;
              }
              state.pickerApiLoaded = true;
              console.info('[StudyCore][GooglePicker] gapi.load("picker") completed; google.picker.PickerBuilder ready');
              resolve();
            },
            onerror: function (e) { clearTimeout(timer); reject((e && e.message) ? e : new Error('gapi.load("picker") reported onerror')); },
            timeout: 20000,
            ontimeout: function () { clearTimeout(timer); reject(new Error('gapi.load("picker") reported ontimeout')); }
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
      if (!gisAvailable()) {
        throw new Error('google.accounts.oauth2 is undefined after loading ' + GIS_SRC + ' — the script loaded but defined nothing (wrong file, blocked by CSP, or ad blocker)');
      }
      state.gisLoaded = true;
      console.info('[StudyCore][GooglePicker] google.accounts.oauth2 ready');
    });
  }

  // ---- Readiness -----------------------------------------------------------

  function everythingReady() {
    return Boolean(
      state.pickerApiLoaded &&
      state.gisLoaded &&
      window.gapi &&
      typeof window.gapi.load === 'function' &&
      pickerBuilderAvailable() &&
      gisAvailable() &&
      state.config &&
      state.configAudit &&
      state.configAudit.ok
    );
  }

  function readinessProblems() {
    const missing = [];
    if (typeof window.gapi === 'undefined' || typeof window.gapi.load !== 'function') missing.push('api.js did not define gapi');
    if (!state.pickerApiLoaded || !pickerBuilderAvailable()) missing.push("gapi.load('picker') did not deliver google.picker.PickerBuilder");
    if (!state.gisLoaded || !gisAvailable()) missing.push('gsi/client did not define google.accounts.oauth2');
    if (state.configFetchFailed) missing.push('/api/config fetch failed (no googlePicker config at all)');
    if (state.configAudit && !state.configAudit.ok) {
      state.configAudit.checks.filter((c) => !c.ok).forEach((c) => missing.push(c.name + ': ' + c.detail));
    } else if (!state.configAudit) {
      missing.push('config audit never ran (config not received)');
    }
    return missing;
  }

  function enableButton() {
    const btn = buttonEl();
    if (!btn) return;
    btn.disabled = false;
    setStatus('Google Drive ready', 'ready');
  }

  // ---- Picker --------------------------------------------------------------

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

      console.info('[StudyCore][GooglePicker] building Picker with origin=' + window.location.origin +
        ' appId=' + state.config.appId +
        ' developerKey=' + state.config.apiKey.slice(0, 6) + '…' +
        ' token=' + String(accessToken || '').slice(0, 10) + '…');
      const picker = builder.build();
      picker.setVisible(true);
      console.info('[StudyCore][GooglePicker] Picker visible — waiting for a Drive file to be picked');
    } catch (err) {
      fail('Google Picker initialization', err);
    }
  }

  function pickerCallback(data) {
    if (!data || data.action !== google.picker.Action.PICKED) {
      if (data && data.action === google.picker.Action.CANCEL) {
        console.info('[StudyCore][GooglePicker] picker cancelled by user');
      }
      return;
    }
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

  function ensureTokenClient() {
    if (state.tokenClient) return state.tokenClient;
    state.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: state.config.clientId,
      scope: SCOPE,
      callback: function (tokenResponse) {
        if (!tokenResponse || tokenResponse.error) {
          const message = (tokenResponse && (tokenResponse.error_description || tokenResponse.error)) || 'Empty token response';
          fail('OAuth authorization', new Error(message + ' — check that GOOGLE_CLIENT_ID is an OAuth Web client whose authorized JavaScript origins include ' + window.location.origin));
          return;
        }
        state.accessToken = tokenResponse.access_token;
        state.tokenExpiresAt = Date.now() + (Number(tokenResponse.expires_in) || 3599) * 1000 - TOKEN_SAFETY_MARGIN_MS;
        console.info('[StudyCore][GooglePicker] OAuth access token received (expires ' + new Date(state.tokenExpiresAt).toISOString() + ')');
        createPicker(state.accessToken);
      },
      error_callback: function (err) {
        fail('OAuth authorization', err);
      }
    });
    return state.tokenClient;
  }

  function requestTokenAndOpen() {
    // Re-verify at click time — the libraries can be evicted or blocked.
    if (typeof window.gapi === 'undefined') {
      fail('Google API library loading', new Error('gapi is not defined at click time'));
      return;
    }
    if (!pickerBuilderAvailable()) {
      fail('Google Picker initialization', new Error('google.picker.PickerBuilder is not defined at click time'));
      return;
    }
    if (!gisAvailable()) {
      fail('Google Identity Services loading', new Error('google.accounts.oauth2 is not defined at click time'));
      return;
    }
    if (!state.config || !state.config.clientId || !state.config.appId) {
      fail('Project/App ID', new Error('Google Picker config is incomplete (GOOGLE_CLIENT_ID / GOOGLE_CLOUD_PROJECT_NUMBER missing from /api/config)'));
      return;
    }

    try {
      ensureTokenClient();
      if (tokenFresh()) {
        createPicker(state.accessToken);
      } else {
        // No token yet, or the previous one expired (1h lifetime on a
        // long-lived dashboard tab) — ask Google again.
        state.tokenClient.requestAccessToken({ prompt: '' });
      }
    } catch (err) {
      fail('OAuth authorization', err);
    }
  }

  // Kept for backwards compatibility with any inline onclick handlers.
  window.openPicker = requestTokenAndOpen;

  // ---- Bootstrap -----------------------------------------------------------

  function runBootstrap() {
    if (!buttonEl()) return; // Not the Content Admin dashboard.
    state.failed = false;
    state.failedStage = null;
    state.pickerApiLoaded = false;
    state.gisLoaded = false;
    hideRetry();
    setStatus('Loading Google Drive…', 'loading');
    buttonEl().disabled = true;

    const configReady = window.STUDYCORE_CONFIG_READY || Promise.resolve(window.STUDYCORE_CONFIG || {});

    configReady
      .then(function (cfg) {
        const rawPicker = (cfg && cfg.googlePicker) || (window.STUDYCORE_CONFIG && window.STUDYCORE_CONFIG.googlePicker) || null;
        state.configFetchFailed = !rawPicker;
        const picker = rawPicker || {};
        state.config = {
          apiKey: picker.apiKey || '',
          clientId: picker.clientId || '',
          appId: picker.appId || '',
          issues: picker.issues || []
        };
        state.configAudit = auditConfig(state.config);
        const auditLines = state.configAudit.checks.map((c) => (c.ok ? 'PASS' : 'FAIL') + '  ' + c.name + ' — ' + c.detail);
        if (state.configAudit.ok) {
          console.info('[StudyCore][GooglePicker] config audit passed:\n   ' + auditLines.join('\n   '));
        } else {
          console.warn('[StudyCore][GooglePicker] config audit FAILED — exact problems:\n   ' + auditLines.join('\n   '));
          // Surface server-side issues (server.js performs the same audit at
          // boot) verbatim, so the browser console names the env var.
          (state.config.issues || []).forEach(function (issue) {
            console.warn('[StudyCore][GooglePicker] server /api/config reports: ' + issue);
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
            error: new Error('Readiness check failed — not ready: ' + (readinessProblems().join('; ') || 'unknown reason'))
          };
        }
        enableButton();
      })
      .catch(function (wrapped) {
        const stage = (wrapped && wrapped.stage) || 'Google Picker initialization';
        fail(stage, (wrapped && wrapped.error) || wrapped);
      });
  }

  function bootstrap() {
    if (!buttonEl()) return; // Not the Content Admin dashboard.

    // One-shot click wiring; retries re-run runBootstrap() directly.
    buttonEl().addEventListener('click', function (e) {
      e.preventDefault();
      if (buttonEl().disabled) return;
      requestTokenAndOpen();
    });

    // Retry button appears after a failure, right of the status line.
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.id = 'caDriveRetryBtn';
    retry.className = 'btn btn-outline btn-sm';
    retry.hidden = true;
    retry.textContent = 'Retry';
    retry.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      console.info('[StudyCore][GooglePicker] retrying Google Drive bootstrap');
      runBootstrap();
    });
    const status = statusEl();
    if (status && status.parentNode) status.parentNode.insertBefore(retry, status.nextSibling);

    runBootstrap();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
