'use strict';

// Regression tests for the Google Picker bootstrap (public/js/google-picker.js).
//
// The file is browser code in an IIFE, so these tests load the REAL source and
// run it inside a minimal DOM shim rather than re-implementing any of its
// logic. What gets exercised is the shipped requestTokenAndOpen() /
// initTokenClient() / error_callback code path, not a copy of it.
//
// The behaviour under test is the OAuth popup handling:
//   * requestAccessToken() fires exactly once per click, inside the click
//     gesture, and never from a timer or a retry loop;
//   * GIS reporting {type:'popup_closed'} is a user cancel, not a failure -
//     the button stays usable;
//   * {type:'popup_failed_to_open'} and unknown types still hard-fail;
//   * a GIS-incompatible Cross-Origin-Opener-Policy is named in the audit;
//   * a granted token opens the Picker, and picking a file hands the Drive
//     file id + metadata to the Content Admin dashboard.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PICKER_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'google-picker.js'),
  'utf8'
);

const PICKER_CONFIG = {
  googlePicker: {
    apiKey: 'AIzaSyDUMMYKEYFORTESTS0123456789abcdefg',
    clientId: '1076280995038-dummyclientid.apps.googleusercontent.com',
    appId: '1076280995038',
    valid: true,
    issues: []
  }
};

function makeElement(tag, id) {
  return {
    tagName: String(tag || 'div').toUpperCase(),
    id: id || '',
    className: '',
    type: '',
    textContent: '',
    hidden: false,
    disabled: false,
    src: '',
    async: false,
    dataset: {},
    style: {},
    listeners: {},
    children: [],
    parentNode: null,
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
    dispatch(type, event) {
      (this.listeners[type] || []).forEach((fn) => fn(event));
    },
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    insertBefore(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    remove() {
      if (!this.parentNode) return;
      const index = this.parentNode.children.indexOf(this);
      if (index >= 0) this.parentNode.children.splice(index, 1);
      this.parentNode = null;
    }
  };
}

// Boots one fresh instance of google-picker.js.
//   coop: value the server sends for Cross-Origin-Opener-Policy (null = none)
//   userActivation: shape of navigator.userActivation, or null to omit it
async function bootPicker({ coop = 'same-origin-allow-popups', userActivation = null } = {}) {
  const logs = { info: [], warn: [], error: [] };
  const statusEl = makeElement('div', 'caDriveStatus');
  const buttonEl = makeElement('button', 'caSelectDriveBtn');
  const head = makeElement('head');
  const body = makeElement('body');
  statusEl.parentNode = body;
  buttonEl.parentNode = body;
  body.children.push(statusEl, buttonEl);

  const tokenRequests = [];
  const pickers = [];
  let tokenClientConfig = null;
  const fetchUrls = [];

  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.self = sandbox;

  sandbox.document = {
    readyState: 'complete',
    head,
    body,
    getElementById(id) {
      if (id === 'caDriveStatus') return statusEl;
      if (id === 'caSelectDriveBtn') return buttonEl;
      for (const parent of [body, head]) {
        const found = parent.children.find((child) => child.id === id);
        if (found) return found;
      }
      return null;
    },
    createElement(tag) {
      const el = makeElement(tag);
      // A real <script> fires load/error asynchronously once appended.
      const realAppend = (parent) => {
        parent.children.push(el);
        el.parentNode = parent;
        setTimeout(() => { if (typeof el.onload === 'function') el.onload(); }, 0);
        return el;
      };
      el.__attach = realAppend;
      return el;
    },
    querySelector(selector) {
      const match = /^script\[data-sc-src="(.+)"\]$/.exec(selector);
      if (match) return head.children.find((child) => child.dataset.scSrc === match[1]) || null;
      return null;
    },
    addEventListener() {}
  };
  sandbox.document.head.appendChild = function (child) {
    return child.__attach ? child.__attach(head) : head.appendChild(child);
  };

  sandbox.console = {
    info: (...args) => logs.info.push(args.join(' ')),
    warn: (...args) => logs.warn.push(args.join(' ')),
    error: (...args) => logs.error.push(args.join(' ')),
    log: (...args) => logs.info.push(args.join(' '))
  };

  sandbox.location = { protocol: 'https:', host: 'studycore.academy', origin: 'https://studycore.academy' };
  sandbox.navigator = userActivation ? { userActivation } : {};
  sandbox.fetch = function (url) {
    fetchUrls.push(url);
    const value = coop === null ? null : String(coop);
    return Promise.resolve({
      ok: true,
      headers: {
        get(name) {
          return String(name).toLowerCase() === 'cross-origin-opener-policy' ? value : null;
        }
      }
    });
  };
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;

  sandbox.STUDYCORE_CONFIG = PICKER_CONFIG;
  sandbox.STUDYCORE_CONFIG_READY = Promise.resolve(PICKER_CONFIG);

  // gapi.load('picker', {callback}) delivers the picker module synchronously,
  // which is all the bootstrap needs to observe.
  sandbox.gapi = {
    load(_module, options) {
      if (options && typeof options.callback === 'function') options.callback();
    }
  };

  class FakeDocsView {
    constructor(viewId) { this.viewId = viewId; }
    setIncludeFolders() { return this; }
    setSelectFolderEnabled() { return this; }
  }
  class FakeDocsUploadView {}
  class FakePickerBuilder {
    constructor() { this.options = {}; }
    addView() { return this; }
    setOAuthToken(token) { this.options.oauthToken = token; return this; }
    setDeveloperKey(key) { this.options.developerKey = key; return this; }
    setAppId(appId) { this.options.appId = appId; return this; }
    setCallback(callback) { this.options.callback = callback; return this; }
    setOrigin(origin) { this.options.origin = origin; return this; }
    build() {
      const picker = {
        options: this.options,
        visible: null,
        setVisible(value) { this.visible = value; pickers.push(this); }
      };
      return picker;
    }
  }
  sandbox.google = {
    picker: {
      DocsView: FakeDocsView,
      DocsUploadView: FakeDocsUploadView,
      PickerBuilder: FakePickerBuilder,
      ViewId: { DOCS: 'DOCS' },
      Action: { PICKED: 'picked', CANCEL: 'cancel' }
    },
    accounts: {
      oauth2: {
        initTokenClient(config) {
          tokenClientConfig = config;
          return {
            requestAccessToken(override) { tokenRequests.push(override || null); }
          };
        }
      }
    }
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(PICKER_SOURCE, context, { filename: 'google-picker.js' });

  // Let the script load + bootstrap promise chain settle.
  await new Promise((resolve) => setTimeout(resolve, 25));

  function click() {
    buttonEl.dispatch('click', { preventDefault() {} });
  }

  function diagnostics() {
    return sandbox.__STUDYCORE_PICKER_DIAGNOSTICS__('test');
  }

  function row(prefix) {
    const found = diagnostics().rows.find((entry) => entry[0].indexOf(prefix) === 0);
    assert.ok(found, `diagnostics row ${prefix} missing`);
    return { label: found[0], ok: found[1], detail: found[2] };
  }

  return {
    sandbox,
    statusEl,
    buttonEl,
    logs,
    click,
    diagnostics,
    row,
    tokenRequests,
    pickers,
    fetchUrls,
    get tokenClientConfig() { return tokenClientConfig; }
  };
}

test('bootstrap enables the button once the libraries and config are ready', async () => {
  const picker = await bootPicker();
  assert.equal(picker.buttonEl.disabled, false, 'the Drive button must be clickable');
  assert.equal(picker.statusEl.textContent, 'Google Drive ready');
  assert.equal(picker.statusEl.dataset.state, 'ready');
});

test('a single click requests exactly one access token, synchronously in the gesture', async () => {
  const picker = await bootPicker({ userActivation: { hasBeenActive: true, isActive: true } });
  picker.click();
  assert.equal(picker.tokenRequests.length, 1, 'requestAccessToken must be called once per click');
  // The override object is created inside the vm context, so it carries that
  // realm's Object.prototype - compare by value across realms.
  assert.deepEqual(Object.assign({}, picker.tokenRequests[0]), { prompt: '' });
  assert.equal(picker.row('12.').ok, true, picker.row('12.').detail);
  // The token client was built from the audited config.
  assert.equal(picker.tokenClientConfig.client_id, PICKER_CONFIG.googlePicker.clientId);
  assert.equal(picker.tokenClientConfig.scope, 'https://www.googleapis.com/auth/drive.file');
  assert.equal(typeof picker.tokenClientConfig.error_callback, 'function');
});

test('repeated clicks while a popup is open never fire requestAccessToken again', async () => {
  const picker = await bootPicker();
  picker.click();
  picker.click();
  picker.click();
  assert.equal(picker.tokenRequests.length, 1, 'no polling, no duplicate consent popups');
});

test("GIS popup_closed is a user cancel: the button stays usable and nothing is marked failed", async () => {
  const picker = await bootPicker();
  picker.click();
  picker.tokenClientConfig.error_callback({ type: 'popup_closed' });

  assert.equal(picker.buttonEl.disabled, false, 'a cancelled popup must not disable the button');
  assert.equal(/failed to load/i.test(picker.statusEl.textContent), false,
    'a cancelled popup must not be reported as a load failure');
  assert.match(picker.statusEl.textContent, /cancelled/i);
  assert.equal(picker.statusEl.dataset.state, 'ready');

  // And the very next click is a fresh, single attempt.
  picker.click();
  assert.equal(picker.tokenRequests.length, 2);
});

test('popup_failed_to_open and unknown GIS errors still hard-fail with a retry', async () => {
  for (const nonOAuthError of [{ type: 'popup_failed_to_open' }, { type: 'unknown' }, null]) {
    const picker = await bootPicker();
    picker.click();
    picker.tokenClientConfig.error_callback(nonOAuthError);

    assert.equal(picker.buttonEl.disabled, true, `${JSON.stringify(nonOAuthError)} must fail`);
    assert.match(picker.statusEl.textContent, /failed to load — OAuth authorization/);
    assert.equal(picker.statusEl.dataset.state, 'error');
    const retry = picker.sandbox.document.getElementById('caDriveRetryBtn');
    assert.ok(retry, 'a Retry button must be offered after a real failure');
    assert.equal(retry.hidden, false);
  }
});

test('a Cross-Origin-Opener-Policy of same-origin is reported as popup-breaking', async () => {
  const bad = await bootPicker({ coop: 'same-origin' });
  const row = bad.row('11.');
  assert.equal(row.ok, false, 'COOP same-origin must be flagged');
  assert.match(row.detail, /Cross-Origin-Opener-Policy: same-origin/);
  assert.match(row.detail, /same-origin-allow-popups/);
  assert.ok(
    bad.logs.warn.some((line) => line.includes('same-origin-allow-popups')),
    'the incompatible policy must be warned about before the first click'
  );
});

test('same-origin-allow-popups and an absent COOP header both pass the popup audit', async () => {
  for (const coop of ['same-origin-allow-popups', 'unsafe-none', null]) {
    const picker = await bootPicker({ coop });
    const row = picker.row('11.');
    assert.equal(row.ok, true, `COOP ${JSON.stringify(coop)} should be popup-compatible: ${row.detail}`);
  }
});

test('a popup_closed under a popup-breaking COOP names the header as the cause', async () => {
  const picker = await bootPicker({ coop: 'same-origin' });
  picker.click();
  picker.tokenClientConfig.error_callback({ type: 'popup_closed' });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.match(picker.statusEl.textContent, /Cross-Origin-Opener-Policy: same-origin/);
  assert.equal(picker.statusEl.dataset.state, 'error');
  // The button is still usable - fixing the header is the operator's job, and
  // clicking again is how they re-test it.
  assert.equal(picker.buttonEl.disabled, false);
});

test('a granted token opens the Picker with the audited credentials', async () => {
  const picker = await bootPicker();
  picker.click();
  picker.tokenClientConfig.callback({ access_token: 'ya29.test-access-token', expires_in: 3599 });

  assert.equal(picker.pickers.length, 1, 'exactly one Picker must be built');
  const built = picker.pickers[0];
  assert.equal(built.visible, true, 'the Picker must be shown');
  assert.equal(built.options.oauthToken, 'ya29.test-access-token');
  assert.equal(built.options.developerKey, PICKER_CONFIG.googlePicker.apiKey);
  assert.equal(built.options.appId, PICKER_CONFIG.googlePicker.appId);
  assert.equal(built.options.origin, 'https://studycore.academy');
  assert.equal(picker.buttonEl.disabled, false);
});

test('picking a Drive file hands the file id and metadata to the dashboard', async () => {
  const picker = await bootPicker();
  const received = [];
  picker.sandbox.onGoogleDriveFilePicked = (doc) => received.push(doc);

  picker.click();
  picker.tokenClientConfig.callback({ access_token: 'ya29.test-access-token', expires_in: 3599 });

  const doc = {
    id: '1AbCdEfGhIjKlMnOpQrStUvWxYz',
    name: 'Physics Notes.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 24680,
    url: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view'
  };
  picker.pickers[0].options.callback({ action: 'picked', docs: [doc] });

  assert.equal(received.length, 1);
  assert.equal(received[0].id, doc.id);
  assert.equal(received[0].name, doc.name);
  assert.equal(received[0].mimeType, doc.mimeType);
  assert.equal(received[0].sizeBytes, doc.sizeBytes);
});

test('a cancelled Picker does not report a picked file', async () => {
  const picker = await bootPicker();
  const received = [];
  picker.sandbox.onGoogleDriveFilePicked = (doc) => received.push(doc);

  picker.click();
  picker.tokenClientConfig.callback({ access_token: 'ya29.test-access-token', expires_in: 3599 });
  picker.pickers[0].options.callback({ action: 'cancel' });

  assert.equal(received.length, 0);
});

test('an OAuth error response is surfaced with the origin that must be authorized', async () => {
  const picker = await bootPicker();
  picker.click();
  picker.tokenClientConfig.callback({ error: 'access_denied', error_description: 'The user denied access' });

  assert.equal(picker.buttonEl.disabled, true);
  assert.match(picker.statusEl.textContent, /failed to load — OAuth authorization/);
  assert.ok(
    picker.logs.error.some((line) => line.includes('https://studycore.academy')),
    'the console must name the origin that needs authorizing'
  );
});
