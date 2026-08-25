// ==UserScript==
// @name         ChatGPT Web Enhanced: Copy & Bookmark
// @namespace    https://831.moe/
// @version      1.2.0
// @description  Copy selected text as Markdown, bookmark selections, and jump to them later. Works on ChatGPT Web.
// @author       cgluWxh
// @match        https://chat.openai.com/*
// @match        https://chatgpt.com/*
// @match        https://www.chatgpt.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-start
// @connect      app.831.moe
// @require      https://app.831.moe/console/moengine-sdk.global.js
// @updateURL    https://raw.githubusercontent.com/cgluWxh/GPTWeb-Enhanced/main/GPTWeb-Enhanced.user.js
// ==/UserScript==

(() => {
  'use strict';

  const interceptedChatGptAuth = {
    token: '',
    accountId: '',
  };

  installChatGptFetchInterceptor();
  const fetchInterceptorGuard = setInterval(
    installChatGptFetchInterceptor,
    1000
  );
  setTimeout(() => clearInterval(fetchInterceptorGuard), 30000);

  const appendCss = (css) => {
    const style = document.createElement('style');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  };

  appendCss(`
    div.\\[position-visibility\\:anchors-visible\\][popover] {
      display: none !important;
    }
  `);

  function installChatGptFetchInterceptor() {
    const pageWindow =
      typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const nativeFetch = pageWindow.fetch;

    if (
      typeof nativeFetch !== 'function' ||
      nativeFetch.__tmBookmarkAuthInterceptor
    ) {
      return;
    }

    const wrappedFetch = function (input, init) {
      try {
        const rawUrl =
          typeof input === 'string' || input instanceof URL
            ? String(input)
            : input?.url || '';
        const url = new URL(rawUrl, location.origin);

        if (
          url.origin === location.origin &&
          url.pathname.startsWith('/backend-api/')
        ) {
          captureChatGptAuthHeaders(input?.headers);
          captureChatGptAuthHeaders(init?.headers);
        }
      } catch {
        // Authentication capture must never interfere with ChatGPT requests.
      }

      return nativeFetch.apply(this, arguments);
    };

    try {
      Object.defineProperty(wrappedFetch, '__tmBookmarkAuthInterceptor', {
        value: true,
      });
      Object.defineProperty(wrappedFetch, 'name', { value: 'fetch' });
      wrappedFetch.toString = nativeFetch.toString.bind(nativeFetch);
      pageWindow.fetch = wrappedFetch;
    } catch (error) {
      console.debug('[Text Bookmarks] Unable to wrap page fetch:', error);
    }
  }

  function captureChatGptAuthHeaders(headers) {
    if (!headers) return;

    const authorization = readHeaderValue(headers, 'authorization');
    const accountId = readHeaderValue(headers, 'chatgpt-account-id');
    let captured = false;

    if (/^Bearer\s+\S+/i.test(authorization)) {
      interceptedChatGptAuth.token = authorization.replace(
        /^Bearer\s+/i,
        ''
      );
      captured = true;
    }
    if (accountId) {
      interceptedChatGptAuth.accountId = accountId;
      captured = true;
    }
    if (captured && !interceptedChatGptAuth.reported) {
      interceptedChatGptAuth.reported = true;
      console.debug('[Text Bookmarks] Captured ChatGPT request authentication');
    }
  }

  function readHeaderValue(headers, name) {
    try {
      if (typeof headers.get === 'function') {
        return headers.get(name) || '';
      }

      if (Array.isArray(headers)) {
        const entry = headers.find(
          item =>
            Array.isArray(item) &&
            String(item[0]).toLowerCase() === name
        );
        return entry ? String(entry[1]) : '';
      }

      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === name) return String(value);
      }
    } catch {
      // Cross-realm Request/Headers objects can occasionally reject access.
    }

    return '';
  }

  const SCROLL_ROOT_SELECTOR = 'div[data-scroll-root]';
  const STORAGE_PREFIX = 'tm-text-bookmarks:';
  const DATA_VERSION_KEY = `${STORAGE_PREFIX}data-version`;
  const DATA_VERSION = 2;
  const MESSAGE_SELECTOR = '[data-message-id]';
  const TURN_CONTAINER_SELECTOR =
    'div[data-turn-id-container]:not([data-turn-id-container="client-created-root"])';
  const CONVERSATION_PAGE_SIZE = 10;
  const MAX_CONVERSATION_PAGES = 50;
  const DOM_PAGE_LOAD_TIMEOUT = 5000;
  const MESSAGE_MOUNT_TIMEOUT = 5000;
  const IGNORED_TEXT_SELECTOR = [
    'script', 'style', 'noscript', 'textarea', 'input', 'select',
    'button', 'svg', '[aria-hidden="true"]', '.select-none',
    // KaTeX renders the same formula twice. Keep the visible .katex-html only.
    '.katex-mathml',
  ].join(',');

  const MAX_TITLE_LENGTH = 100;
  const CONTEXT_LENGTH = 80;

  // Cloud sync (MoEngine). Set CLOUD_BASE_URL to your engine's public origin.
  // The engine must be reachable with the same scheme as this page (https).
  const CLOUD_BASE_URL = 'https://app.831.moe';
  const CLOUD_APP_ID = 'gptweb';
  const CLOUD_TOKEN_KEY = 'tm-bookmarks:cloud:token';
  const CLOUD_COLLECTION = 'bookmarks';
  const CLOUD_DB_NAME = 'moengine-gptweb';

  let cloudClient = null;
  let cloudKv = null;
  let bookmarkImportInput = null;

  migrateBookmarkData();

  let currentUrlKey = getUrlKey();
  let bookmarks = [];
  let pendingSelection = null;

  let bookmarkButton = null;
  let bookmarkWindow = null;
  let bookmarkList = null;
  let emptyMessage = null;

  let highlightCleanupTimer = null;
  let autoExpandTimer = null;
  const replyTurnMonitorTimers = new Set();
  const conversationApiCache = new Map();
  const persistentHighlightRanges = new Map();
  const observedTurnContainers = new WeakSet();
  const intersectingTurnContainers = new Set();
  let persistentBookmarkHighlight = null;
  let persistentReplyHighlight = null;
  let persistentHighlightObserver = null;
  let persistentHighlightMutationObserver = null;
  let persistentHighlightRefreshTimer = null;

  init();

  function init() {
    injectStyles();
    createBookmarkButton();
    createBookmarkWindow();

    document.addEventListener('mouseup', handleSelectionEnd, true);
    document.addEventListener('keyup', handleKeyboardSelection, true);
    document.addEventListener('mousedown', handleDocumentMouseDown, true);
    document.addEventListener('selectionchange', handleSelectionChange);
    // document.addEventListener('copy', handleGlobalCopy, true);
    installUrlChangeListener();
    initializePersistentHighlights();

    renderBookmarks();
    syncWindowCollapsedAfterUrlSettles();
    void initializeBookmarks();
  }

  /**
   * Cloud sync / MoEngine adapter
   */

  function isCloudLoggedIn() {
    return Boolean(localStorage.getItem(CLOUD_TOKEN_KEY));
  }

  function getCloudClient() {
    if (typeof MoEngine === 'undefined') {
      throw new Error('MoEngine SDK not loaded');
    }
    if (cloudClient === null) {
      const gmFetch =
        typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function'
          ? MoEngine.createGmFetch(details => GM.xmlHttpRequest(details))
          : undefined;
      cloudClient = MoEngine.createMoEngineClient({
        baseUrl: CLOUD_BASE_URL,
        appId: CLOUD_APP_ID,
        accessToken: () => localStorage.getItem(CLOUD_TOKEN_KEY),
        ...(gmFetch ? { fetch: gmFetch } : {}),
      });
    }
    return cloudClient;
  }

  async function ensureCloudKv() {
    if (cloudKv !== null) return cloudKv;
    const client = getCloudClient();
    cloudKv = await client.openKv({
      collection: CLOUD_COLLECTION,
      storage: new MoEngine.IndexedDbKvStorage({
        dbName: CLOUD_DB_NAME,
        storeName: CLOUD_COLLECTION,
      }),
    });
    return cloudKv;
  }

  async function cloudLoad(urlKey) {
    const kv = await ensureCloudKv();
    const value = await kv.getItem(urlKey);
    return Array.isArray(value) ? value : [];
  }

  async function cloudSave(urlKey, storedBookmarks) {
    const kv = await ensureCloudKv();
    await kv.setItem(urlKey, storedBookmarks);
  }

  async function loadBookmarks(urlKey = currentUrlKey) {
    if (isCloudLoggedIn()) {
      try {
        const cloud = await cloudLoad(urlKey);
        return Array.isArray(cloud) ? cloud : [];
      } catch (error) {
        console.error('[Text Bookmarks] Cloud load failed, falling back to local:', error);
      }
    }
    try {
      const parsed = JSON.parse(localStorage.getItem(getStorageKey(urlKey)));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async function saveBookmarks() {
    try {
      if (isCloudLoggedIn()) {
        await cloudSave(currentUrlKey, bookmarks);
        return;
      }
      localStorage.setItem(getStorageKey(), JSON.stringify(bookmarks));
    } catch (error) {
      console.error('[Text Bookmarks] Save failed:', error);
      showToast('Bookmark save failed');
    }
  }

  async function refreshBookmarks(urlKey) {
    bookmarks = await loadBookmarks(urlKey);
    renderBookmarks();
    syncWindowCollapsedAfterUrlSettles();
    resetPersistentHighlights();
    schedulePersistentHighlightRefresh();
  }

  async function initializeBookmarks() {
    if (!isCloudLoggedIn()) {
      await refreshBookmarks(currentUrlKey);
      return;
    }

    try {
      await getCloudClient().auth.me();
      await refreshBookmarks(currentUrlKey);
    } catch (error) {
      if (error?.status === 401) {
        localStorage.removeItem(CLOUD_TOKEN_KEY);
        cloudClient = null;
        cloudKv = null;
        showToast('Cloud login expired. Please log in again.');
        return;
      }
      console.error('[Text Bookmarks] Cloud login check failed:', error);
      showToast('Unable to verify cloud login');
    }
  }

  async function ssoLogin() {
    if (typeof MoEngine === 'undefined') {
      showToast('MoEngine SDK is not loaded');
      return;
    }
    const client = getCloudClient();
    const state = crypto.randomUUID();
    const engineOrigin = new URL(CLOUD_BASE_URL).origin;
    // 回调落在引擎自带的固定中继页（全局窄放行），页面把 code/state 经
    // postMessage 交回主窗口；主窗口再用 GM 运输层做 exchange，避免被
    // ChatGPT SPA 清参、也绕开页面 CORS/混合内容。
    const callbackUrl = `${engineOrigin}/console/sso-callback.html`;
    const ssoUrl = client.auth.buildSsoLoginUrl(callbackUrl, state);
    const popup = window.open(ssoUrl, 'moengine-sso', 'width=460,height=640');

    if (!popup) {
      showToast('Popup blocked: allow popups for SSO login');
      return;
    }

    const result = await new Promise(resolve => {
      const deadline = Date.now() + 120000;
      const onMessage = event => {
        const data = event.data;

        if (
          data &&
          data.type === 'moengine:sso' &&
          data.state === state &&
          event.origin === engineOrigin
        ) {
          window.removeEventListener('message', onMessage);
          resolve(data);
        }
      };
      window.addEventListener('message', onMessage);

      const poll = setInterval(() => {
        if (popup.closed || Date.now() > deadline) {
          clearInterval(poll);
          window.removeEventListener('message', onMessage);
          resolve(null);
        }
      }, 500);
    });

    if (!popup.closed) popup.close();

    if (!result || !result.code) {
      showToast('SSO login cancelled or timed out');
      return;
    }

    try {
      const grant = await client.auth.exchange({
        code: result.code,
        callbackUrl,
        deviceName: 'GPTWebEnhanced',
      });
      localStorage.setItem(CLOUD_TOKEN_KEY, grant.access_token);
      cloudClient = null;
      cloudKv = null;
      await migrateLocalToCloud();
      await refreshBookmarks(currentUrlKey);
      showToast('Logged in & synced to cloud');
    } catch (error) {
      console.error('[Text Bookmarks] SSO exchange or cloud sync failed:', error);
      showToast(`SSO login failed: ${error?.message || 'exchange error'}`);
    }
  }

  async function cloudLogout() {
    const client = cloudClient;
    if (client && isCloudLoggedIn()) {
      try {
        await client.auth.logout();
      } catch {
        // Best-effort; token is revoked locally regardless.
      }
    }
    localStorage.removeItem(CLOUD_TOKEN_KEY);
    cloudClient = null;
    cloudKv = null;
    await refreshBookmarks(currentUrlKey);
    showToast('Logged out, using local storage');
  }

  async function migrateLocalToCloud() {
    const entries = [];

    for (let index = 0; index < localStorage.length; index++) {
      const storageKey = localStorage.key(index);

      if (
        !storageKey?.startsWith(STORAGE_PREFIX) ||
        storageKey === DATA_VERSION_KEY
      ) {
        continue;
      }

      const urlKey = storageKey.slice(STORAGE_PREFIX.length);

      if (!urlKey) continue;

      let storedBookmarks;

      try {
        storedBookmarks = JSON.parse(localStorage.getItem(storageKey));
      } catch {
        continue;
      }

      if (Array.isArray(storedBookmarks) && storedBookmarks.length) {
        entries.push([urlKey, storedBookmarks]);
      }
    }

    for (const [urlKey, storedBookmarks] of entries) {
      await cloudSave(urlKey, storedBookmarks);
    }

    if (entries.length) {
      showToast(`Uploaded ${entries.length} bookmark lists to cloud`);
    }
  }

  function showCloudMenu(x, y) {
    removeCloudMenu();

    const loggedIn = isCloudLoggedIn();
    const menu = document.createElement('div');
    menu.id = 'tm-cloud-menu';

    const addItem = (label, fn) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.textContent = label;
      item.addEventListener('click', () => {
        removeCloudMenu();
        void fn();
      });
      menu.appendChild(item);
      return item;
    };

    const authLabel = loggedIn
      ? 'Cloud Sync: Logout'
      : `Cloud Sync: SSO Login (${CLOUD_BASE_URL})`;
    addItem(authLabel, async () => {
      if (loggedIn) {
        await cloudLogout();
      } else {
        await ssoLogin();
      }
    });
    addItem('Export backup', exportBookmarkBackup);
    addItem('Import backup', () => bookmarkImportInput?.click());

    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - 180))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - 140))}px`;
    document.documentElement.appendChild(menu);

    const closeOnOutside = event => {
      if (!menu.contains(event.target)) {
        removeCloudMenu();
        document.removeEventListener('mousedown', closeOnOutside);
      }
    };
    setTimeout(() => {
      document.addEventListener('mousedown', closeOnOutside);
    }, 0);
  }

  function removeCloudMenu() {
    document.querySelector('#tm-cloud-menu')?.remove();
  }

  /**
   * Selection handling
   */

  function handleSelectionEnd(event) {
    // Wait for the selection to be updated before checking it.
    requestAnimationFrame(() => {
      showBookmarkButtonForCurrentSelection(event.clientX, event.clientY);
    });
  }

  function handleKeyboardSelection(event) {
    if (
      event.key === 'Shift' ||
      event.key.startsWith('Arrow') ||
      event.key === 'Home' ||
      event.key === 'End' ||
      event.key === 'PageUp' ||
      event.key === 'PageDown'
    ) {
      requestAnimationFrame(() => {
        showBookmarkButtonForCurrentSelection();
      });
    }
  }

  function handleSelectionChange() {
    const selection = window.getSelection();

    if (!selection || selection.isCollapsed || !selection.toString().trim()) {
      hideBookmarkButton();
    }
  }

  function handleDocumentMouseDown(event) {
    if (
      bookmarkButton?.contains(event.target) ||
      bookmarkWindow?.contains(event.target)
    ) {
      return;
    }

    hideBookmarkButton();
  }

  function handleGlobalCopy(event) {
    const selection = window.getSelection();

    if (
      !selection ||
      selection.rangeCount === 0 ||
      selection.isCollapsed
    ) {
      return;
    }

    const range = selection.getRangeAt(0);
    const scrollRoot = getContainingScrollRoot(range);

    if (
      !scrollRoot ||
      !scrollRoot.contains(range.startContainer) ||
      !scrollRoot.contains(range.endContainer)
    ) {
      return;
    }

    const container = document.createElement('div');
    container.appendChild(range.cloneContents());
    const markdown = domSelectionToMarkdown(container, range);

    if (!markdown || !event.clipboardData) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    event.clipboardData.setData('text/plain', markdown);
    event.clipboardData.setData('text/markdown', markdown);
    showToast('Markdown Copied');
  }

  function showBookmarkButtonForCurrentSelection(fallbackX, fallbackY) {
    const selectionInfo = getCurrentSelectionInfo();

    if (!selectionInfo) {
      hideBookmarkButton();
      return;
    }

    pendingSelection = selectionInfo;

    const rangeRect = getUsefulRangeRect(selectionInfo.range);

    let x;
    let y;

    if (rangeRect) {
      x = rangeRect.right;
      y = rangeRect.bottom + 8;
    } else if (
      Number.isFinite(fallbackX) &&
      Number.isFinite(fallbackY)
    ) {
      x = fallbackX;
      y = fallbackY + 10;
    } else {
      x = window.innerWidth / 2;
      y = window.innerHeight / 2;
    }

    bookmarkButton.style.display = 'flex';

    requestAnimationFrame(() => {
      const buttonRect = bookmarkButton.getBoundingClientRect();
      const margin = 8;

      const boundedX = Math.min(
        Math.max(margin, x),
        window.innerWidth - buttonRect.width - margin
      );

      const boundedY = Math.min(
        Math.max(margin, y),
        window.innerHeight - buttonRect.height - margin
      );

      bookmarkButton.style.left = `${boundedX}px`;
      bookmarkButton.style.top = `${boundedY}px`;
    });
  }

  function getCurrentSelectionInfo() {
    const selection = window.getSelection();

    if (
      !selection ||
      selection.rangeCount === 0 ||
      selection.isCollapsed
    ) {
      return null;
    }

    const text = selection.toString().trim();

    if (!text) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const scrollRoot = getContainingScrollRoot(range);

    if (!scrollRoot) {
      return null;
    }

    // Prevent selections that span outside the scroll root, which can happen
    if (
      !scrollRoot.contains(range.startContainer) ||
      !scrollRoot.contains(range.endContainer)
    ) {
      return null;
    }

    const selectedFormulas = getIntersectedKatexElements(scrollRoot, range);
    const selectedFormula =
      selectedFormulas.length === 1 &&
      isRangeInsideKatex(range, selectedFormulas[0])
        ? selectedFormulas[0]
        : null;
    const formulaLatex = selectedFormula
      ? getKatexLatex(selectedFormula)
      : '';
    const absoluteOffsets =
      getCanonicalRangeOffsets(scrollRoot, range) ||
      (selectedFormulas.length ? { start: 0, end: 0 } : null);

    if (!absoluteOffsets) {
      return null;
    }

    const fullText = getCanonicalRootText(scrollRoot);
    const start = absoluteOffsets.start;
    const end = absoluteOffsets.end;
    const selectedLatexText = selectedFormulas
      .map(getKatexMarkdown)
      .filter(Boolean)
      .join(' ');
    const canonicalText =
      (formulaLatex ? `$${formulaLatex}$` : '') ||
      fullText.slice(start, end).trim() ||
      selectedLatexText ||
      text;

    if (!canonicalText) {
      return null;
    }
    const message = getParentElement(range.commonAncestorContainer)
      ?.closest(MESSAGE_SELECTOR);
    const turnID = getTurnIndex(
      getParentElement(range.commonAncestorContainer)
    );
    const turnContainer = getParentElement(range.commonAncestorContainer)
      ?.closest(TURN_CONTAINER_SELECTOR);
    const messageOffsets = message
      ? getCanonicalRangeOffsets(message, range)
      : null;

    return {
      range: range.cloneRange(),
      scrollRoot,
      text: canonicalText,
      formulaLatex: formulaLatex || null,
      turnID,
      start,
      end,
      prefix: fullText.slice(
        Math.max(0, start - CONTEXT_LENGTH),
        start
      ),
      suffix: fullText.slice(
        end,
        Math.min(fullText.length, end + CONTEXT_LENGTH)
      ),
      rootIndex: getScrollRootIndex(scrollRoot),
      messageId: message?.getAttribute('data-message-id') ?? null,
      messageRole: message?.getAttribute('data-message-author-role') ?? null,
      conversationId: getConversationId(),
      turnContainerId:
        turnContainer?.getAttribute('data-turn-id-container') ?? null,
      messageStart: messageOffsets?.start ?? null,
      messageEnd: messageOffsets?.end ?? null,
      startPath: getNodePath(scrollRoot, range.startContainer),
      startOffset: range.startOffset,
      endPath: getNodePath(scrollRoot, range.endContainer),
      endOffset: range.endOffset,
    };
  }

  function getContainingScrollRoot(range) {
    const startElement = getParentElement(range.startContainer);
    const endElement = getParentElement(range.endContainer);

    const startRoot = startElement?.closest(SCROLL_ROOT_SELECTOR);
    const endRoot = endElement?.closest(SCROLL_ROOT_SELECTOR);

    if (!startRoot || startRoot !== endRoot) {
      return null;
    }

    return startRoot;
  }

  function getIntersectedKatexElements(root, range) {
    return [...root.querySelectorAll('.katex')].filter(element => {
      try {
        return range.intersectsNode(element);
      } catch {
        return false;
      }
    });
  }

  function getKatexMarkdown(element) {
    const rawTex = getKatexLatex(element);

    return rawTex
      ? `$${rawTex}$`
      : '';
  }

  function getKatexLatex(element) {
    return element
      .closest('[data-math-source]')
      ?.getAttribute('data-math-source')
      ?.trim() ?? '';
  }

  function isRangeInsideKatex(range, katexElement) {
    return (
      getParentElement(range.startContainer)?.closest('.katex') ===
        katexElement &&
      getParentElement(range.endContainer)?.closest('.katex') ===
        katexElement
    );
  }

  function getParentElement(node) {
    if (!node) return null;
    return node.nodeType === Node.ELEMENT_NODE
      ? node
      : node.parentElement;
  }

  /**
   * Bookmark creation
   */

  function createBookmarkFromPendingSelection(
    replyContent = '',
    selectionInfo = pendingSelection,
    replyTurnID = null
  ) {
    if (!selectionInfo) {
      hideBookmarkButton();
      return false;
    }

    const existingIndex = bookmarks.findIndex(bookmark =>
      isSameBookmarkLocation(bookmark, selectionInfo)
    );

    if (existingIndex !== -1) {
      const [existingBookmark] = bookmarks.splice(existingIndex, 1);
      existingBookmark.createdAt = Date.now();
      if (isValidTurnID(selectionInfo.turnID)) {
        existingBookmark.turnID = selectionInfo.turnID;
      }
      backfillSelectionLocator(existingBookmark, selectionInfo);
      if (replyContent) {
        existingBookmark.replyContent = replyContent.trim();
        applyReplyLocator(existingBookmark, replyTurnID);
      }
      bookmarks.unshift(existingBookmark);
      saveBookmarks();
      void enrichBookmarkLocators(existingBookmark);
      renderBookmarks();
      setPersistentHighlightRange(
        existingBookmark.id,
        'target',
        selectionInfo.range.cloneRange()
      );
      schedulePersistentHighlightRefresh();

      hideBookmarkButton();
      clearBrowserSelection();
      setWindowCollapsed(false);
      flashWindow();
      showToast('Bookmark Updated');
      return {
        status: 'updated',
        bookmark: existingBookmark,
      };
    }

    const bookmark = {
      id: crypto.randomUUID?.() ?? createFallbackId(),
      createdAt: Date.now(),
      locatorVersion: 2,

      text: selectionInfo.text,
      formulaLatex: selectionInfo.formulaLatex,
      replyContent: replyContent.trim() || null,
      turnID: selectionInfo.turnID,
      replyTurnID: isValidTurnID(replyTurnID)
        ? replyTurnID
        : replyTurnID?.turnID ?? null,

      rootIndex: selectionInfo.rootIndex,

      start: selectionInfo.start,
      end: selectionInfo.end,

      prefix: selectionInfo.prefix,
      suffix: selectionInfo.suffix,
      messageId: selectionInfo.messageId,
      messageRole: selectionInfo.messageRole,
      conversationId: selectionInfo.conversationId || getConversationId(),
      turnContainerId: selectionInfo.turnContainerId,
      turnContainerIds: selectionInfo.turnContainerId
        ? [selectionInfo.turnContainerId]
        : [],
      messageStart: selectionInfo.messageStart,
      messageEnd: selectionInfo.messageEnd,

      startPath: selectionInfo.startPath,
      startOffset: selectionInfo.startOffset,
      endPath: selectionInfo.endPath,
      endOffset: selectionInfo.endOffset,
    };

    applyReplyLocator(bookmark, replyTurnID);
    bookmarks.unshift(bookmark);
    saveBookmarks();
    void enrichBookmarkLocators(bookmark);
    renderBookmarks();
    setPersistentHighlightRange(
      bookmark.id,
      'target',
      selectionInfo.range.cloneRange()
    );
    schedulePersistentHighlightRefresh();

    hideBookmarkButton();
    clearBrowserSelection();

    setWindowCollapsed(false);
    flashWindow();
    return {
      status: 'added',
      bookmark,
    };
  }

  function isSameBookmarkLocation(bookmark, selectionInfo) {
    if (
      bookmark.messageId &&
      bookmark.messageId === selectionInfo.messageId &&
      hasNonEmptyOffsets(bookmark.messageStart, bookmark.messageEnd) &&
      hasNonEmptyOffsets(
        selectionInfo.messageStart,
        selectionInfo.messageEnd
      ) &&
      bookmark.messageStart === selectionInfo.messageStart &&
      bookmark.messageEnd === selectionInfo.messageEnd
    ) {
      return true;
    }

    if (
      bookmark.rootIndex === selectionInfo.rootIndex &&
      hasNonEmptyOffsets(bookmark.start, bookmark.end) &&
      hasNonEmptyOffsets(selectionInfo.start, selectionInfo.end) &&
      bookmark.start === selectionInfo.start &&
      bookmark.end === selectionInfo.end
    ) {
      return true;
    }

    return (
      bookmark.rootIndex === selectionInfo.rootIndex &&
      bookmark.startOffset === selectionInfo.startOffset &&
      bookmark.endOffset === selectionInfo.endOffset &&
      areNodePathsEqual(bookmark.startPath, selectionInfo.startPath) &&
      areNodePathsEqual(bookmark.endPath, selectionInfo.endPath)
    );
  }

  function backfillSelectionLocator(bookmark, selectionInfo) {
    bookmark.locatorVersion = 2;
    bookmark.locatorUpdatedAt = Date.now();
    bookmark.conversationId =
      selectionInfo.conversationId ||
      bookmark.conversationId ||
      getConversationId();
    bookmark.messageId = selectionInfo.messageId || bookmark.messageId;
    bookmark.messageRole = selectionInfo.messageRole || bookmark.messageRole;

    if (selectionInfo.turnContainerId) {
      bookmark.turnContainerId = selectionInfo.turnContainerId;
      bookmark.turnContainerIds = mergeUniqueIds(
        bookmark.turnContainerIds,
        [selectionInfo.turnContainerId]
      );
    }
  }

  function applyReplyLocator(bookmark, locator) {
    if (isValidTurnID(locator)) {
      bookmark.replyTurnID = locator;
      return;
    }

    if (!locator || typeof locator !== 'object') {
      return;
    }

    if (isValidTurnID(locator.turnID)) {
      bookmark.replyTurnID = locator.turnID;
    }
    if (locator.messageId) {
      bookmark.replyMessageId = locator.messageId;
    }
    if (locator.messageRole) {
      bookmark.replyMessageRole = locator.messageRole;
    }
    if (locator.turnContainerId) {
      bookmark.replyTurnContainerId = locator.turnContainerId;
      bookmark.replyTurnContainerIds = mergeUniqueIds(
        bookmark.replyTurnContainerIds,
        [locator.turnContainerId]
      );
    }
  }

  function hasNonEmptyOffsets(start, end) {
    return (
      Number.isInteger(start) &&
      Number.isInteger(end) &&
      end > start
    );
  }

  function areNodePathsEqual(left, right) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  }

  /**
   * Jumping and locating
   */

  async function jumpToBookmark(bookmark) {
    if (performBookmarkJump(bookmark, false)) {
      void enrichBookmarkLocators(bookmark);
      return;
    }

    showToast('Locating Bookmark…');

    try {
      const mounted = await ensureLocatorMounted(bookmark, 'target');
      if (mounted) await wait(100);
      if (performBookmarkJump(bookmark, false)) {
        return;
      }

      // Legacy numeric indices are only a last-resort hint. The text must
      // still match before any recovered locator is persisted.
      discardInvalidTurnID(bookmark, 'turnID');
      const legacyTurn = findTurnContainer(bookmark.turnID);

      if (legacyTurn) {
        legacyTurn.scrollIntoView({ behavior: 'instant', block: 'center' });
        await wait(500);
        if (performBookmarkJump(bookmark, false)) {
          return;
        }
      }
    } catch (error) {
      console.error('[Text Bookmarks] Bookmark recovery failed:', error);
    }

    showToast('Cannot find this text, the page content may have changed');
  }

  function performBookmarkJump(bookmark, showFailure = true) {
    const scrollRoot = resolveScrollRoot(bookmark);

    if (!scrollRoot) {
      if (showFailure) showToast('Cannot find data-scroll-root');
      return false;
    }

    const range = locateBookmarkRange(scrollRoot, bookmark);

    if (!range) {
      if (showFailure) {
        showToast('Cannot find this text, the page content may have changed');
      }
      return false;
    }

    const targetElement = getParentElement(range.startContainer);

    if (!targetElement) {
      showToast('Cannot locate the target element, the page content may have changed');
      return false;
    }

    backfillMountedLocator(bookmark, 'target', targetElement);
    scrollRangeToCenter(scrollRoot, range);
    highlightRange(range);

    // ChatGPT may virtualize or re-render messages in response to the first
    // scroll. In the next macrotask, resolve both the root and Range again
    // instead of reusing DOM nodes that may already be detached.
    setTimeout(() => {
      const freshScrollRoot = resolveScrollRoot(bookmark);

      if (!freshScrollRoot) {
        return;
      }

      const freshRange = locateBookmarkRange(freshScrollRoot, bookmark);

      if (!freshRange) {
        return;
      }

      scrollRangeToCenter(freshScrollRoot, freshRange);
      highlightRange(freshRange);
    }, 500);
    return true;
  }

  async function jumpToReply(bookmark) {
    const replyContent = normalizeText(bookmark.replyContent);

    if (!replyContent) {
      showToast('Cannot find the Reply content for this Bookmark');
      return;
    }

    if (performReplyJump(bookmark, document, false)) {
      void enrichBookmarkLocators(bookmark);
      return;
    }

    showToast('Locating Reply…');

    try {
      const mounted = await ensureLocatorMounted(bookmark, 'reply');
      if (mounted) await wait(100);
      if (performReplyJump(bookmark, document, false)) return;

      discardInvalidTurnID(bookmark, 'replyTurnID');
      const legacyTurn = findTurnContainer(bookmark.replyTurnID);

      if (legacyTurn) {
        legacyTurn.scrollIntoView({ behavior: 'instant', block: 'center' });
        await wait(500);
        if (performReplyJump(bookmark, legacyTurn, false)) return;
      }
    } catch (error) {
      console.error('[Text Bookmarks] Reply recovery failed:', error);
    }

    showToast('Cannot find the corresponding Reply');
  }

  function performReplyJump(bookmark, searchRoot, showFailure) {
    if (!searchRoot) {
      if (showFailure) {
        showToast('Cannot find the corresponding Reply Turn, content may not be loaded yet');
      }
      return false;
    }

    const match = findReplyMatch(searchRoot, bookmark.replyContent);

    if (!match) {
      if (showFailure) {
        showToast('Cannot find the corresponding Reply, the message may not have been sent yet');
      }
      return false;
    }

    const {
      targetMessage,
      targetRange,
    } = match;

    backfillMountedLocator(bookmark, 'reply', targetMessage);

    const scrollRoot =
      targetMessage.closest(SCROLL_ROOT_SELECTOR) ||
      resolveScrollRoot(bookmark);

    if (scrollRoot) {
      scrollRangeToCenter(scrollRoot, targetRange);
    } else {
      targetMessage.scrollIntoView({
        behavior: 'instant',
        block: 'center',
      });
    }

    highlightRange(targetRange);
    return true;
  }

  async function ensureLocatorMounted(bookmark, kind) {
    const fields = getLocatorFields(kind);
    const existingMessage = findMessageById(bookmark[fields.messageId]);

    if (existingMessage) {
      backfillMountedLocator(bookmark, kind, existingMessage);
      return true;
    }

    let candidates = getBookmarkContainerIds(bookmark, kind);
    let container = findTurnContainerByIds(candidates);

    if (container) {
      container.scrollIntoView({ behavior: 'instant', block: 'center' });
      const mounted = await waitForLocatorMessage(bookmark, kind);
      if (mounted || !bookmark[fields.messageId]) return true;
    }

    await resolveBookmarkApiLocator(bookmark, kind);
    candidates = getBookmarkContainerIds(bookmark, kind);
    container = findTurnContainerByIds(candidates);

    if (!container && candidates.length) {
      container = await loadEarlierDomUntilFound(candidates);
    }

    if (!container) {
      return false;
    }

    bookmark[fields.containerId] =
      container.getAttribute('data-turn-id-container');
    void saveBookmarks();
    container.scrollIntoView({ behavior: 'instant', block: 'center' });

    const mounted = await waitForLocatorMessage(bookmark, kind);
    return Boolean(mounted || !bookmark[fields.messageId]);
  }

  async function enrichBookmarkLocators(bookmark) {
    try {
      await resolveBookmarkApiLocator(bookmark, 'target');
      if (bookmark.replyContent) {
        await resolveBookmarkApiLocator(bookmark, 'reply');
      }
      await saveBookmarks();
    } catch (error) {
      // New bookmarks already contain their currently working DOM anchor.
      // API enrichment is deliberately best-effort and retries on a jump.
      console.debug('[Text Bookmarks] Locator enrichment deferred:', error);
    }
  }

  async function resolveBookmarkApiLocator(bookmark, kind) {
    const conversationId =
      bookmark.conversationId || getConversationId();

    if (!conversationId) return null;

    bookmark.conversationId = conversationId;
    const fields = getLocatorFields(kind);
    const wantedMessageId = bookmark[fields.messageId];
    const wantedText = kind === 'reply'
      ? bookmark.replyContent
      : bookmark.text;
    const wantedRole = kind === 'reply'
      ? 'user'
      : bookmark.messageRole;

    let message = await findConversationMessage(
      conversationId,
      apiMessage => {
        if (wantedMessageId) {
          return apiMessage.id === wantedMessageId;
        }

        return apiMessageMatchesText(
          apiMessage,
          wantedText,
          wantedRole
        );
      }
    );

    // A message id can disappear after branch edits or frontend migrations.
    // Once the available pages have been searched, recover by content and
    // only then replace the stale id.
    if (!message && wantedMessageId && wantedText) {
      const cache = conversationApiCache.get(conversationId);
      message = findBestApiTextMatch(
        cache?.messages || [],
        wantedText,
        wantedRole,
        kind === 'target' ? bookmark.prefix : '',
        kind === 'target' ? bookmark.suffix : ''
      );
      if (message) bookmark.locatorRecovery = 'text';
    }

    if (!message) return null;

    const cache = conversationApiCache.get(conversationId);
    const exchangeId = message.metadata?.turn_exchange_id || null;
    const exchangeMessages = exchangeId
      ? cache.messages.filter(
          item => item.metadata?.turn_exchange_id === exchangeId
        )
      : [message];
    const messageRole = message.author?.role || wantedRole || null;
    const navigationMessages = messageRole === 'user'
      ? exchangeMessages.filter(item => item.author?.role === 'user')
      : exchangeMessages.filter(item => item.author?.role !== 'user');
    const candidateIds = (navigationMessages.length
      ? navigationMessages
      : [message])
      .map(item => item.id)
      .filter(Boolean);

    bookmark[fields.messageId] = message.id;
    bookmark[fields.messageRole] = messageRole;
    bookmark[fields.exchangeId] = exchangeId;
    bookmark[fields.containerIds] = mergeUniqueIds(
      bookmark[fields.containerIds],
      candidateIds
    );
    bookmark.locatorVersion = 2;
    bookmark.locatorUpdatedAt = Date.now();

    return message;
  }

  async function findConversationMessage(conversationId, predicate) {
    const cache = getConversationCache(conversationId);

    for (let page = 0; page < MAX_CONVERSATION_PAGES; page++) {
      const existing = cache.messages.find(predicate);
      if (existing) return existing;
      if (cache.exhausted) return null;

      if (!cache.loading) {
        cache.loading = fetchNextConversationPage(conversationId, cache)
          .finally(() => {
            cache.loading = null;
          });
      }
      await cache.loading;
    }

    return cache.messages.find(predicate) || null;
  }

  function getConversationCache(conversationId) {
    let cache = conversationApiCache.get(conversationId);

    if (!cache) {
      cache = {
        messages: [],
        messageIds: new Set(),
        initialized: false,
        nextBefore: null,
        exhausted: false,
        loading: null,
      };
      conversationApiCache.set(conversationId, cache);
    }

    return cache;
  }

  async function fetchNextConversationPage(conversationId, cache) {
    const base = `/backend-api/conversations/${encodeURIComponent(
      conversationId
    )}`;
    const url = cache.initialized
      ? `${base}/messages?before=${encodeURIComponent(
          cache.nextBefore
        )}&include_has_versions=true&num_turns=${CONVERSATION_PAGE_SIZE}`
      : `${base}?include_has_versions=true&num_turns=${CONVERSATION_PAGE_SIZE}`;
    const session = await waitForChatGptRequestAuth();
    if (!session.token) {
      throw new Error(
        'ChatGPT request token has not been captured; reload the page and try again'
      );
    }
    const response = await fetch(url, {
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(session.token
          ? { Authorization: `Bearer ${session.token}` }
          : {}),
        ...(session.accountId
          ? { 'chatgpt-account-id': session.accountId }
          : {}),
      },
    });

    if (!response.ok) {
      throw new Error(`Conversation API returned ${response.status}`);
    }

    const data = await response.json();
    const pageMessages = Array.isArray(data.messages) ? data.messages : [];

    for (const message of pageMessages) {
      if (!message?.id || cache.messageIds.has(message.id)) continue;
      cache.messageIds.add(message.id);
      cache.messages.push(message);
    }

    cache.initialized = true;
    cache.nextBefore = data.page_info?.start_cursor || null;
    cache.exhausted =
      !data.page_info?.has_previous_page ||
      !cache.nextBefore ||
      pageMessages.length === 0;
  }

  async function waitForChatGptRequestAuth(timeout = 3000) {
    const deadline = Date.now() + timeout;

    while (!interceptedChatGptAuth.token && Date.now() < deadline) {
      await wait(50);
    }

    return interceptedChatGptAuth;
  }

  function apiMessageMatchesText(message, text, role) {
    if (role && message.author?.role !== role) return false;

    const needle = normalizeText(text);
    if (!needle) return false;

    return normalizeText(getApiMessageText(message)).includes(needle);
  }

  function findBestApiTextMatch(
    messages,
    text,
    role,
    expectedPrefix,
    expectedSuffix
  ) {
    const needle = normalizeText(text);
    if (!needle) return null;

    let best = null;
    let bestScore = -Infinity;
    let ambiguous = false;

    for (const message of messages) {
      if (role && message.author?.role !== role) continue;

      const content = normalizeText(getApiMessageText(message));
      const index = content.indexOf(needle);
      if (index === -1) continue;

      const end = index + needle.length;
      const score =
        needle.length +
        commonSuffixLength(
          content.slice(Math.max(0, index - CONTEXT_LENGTH), index),
          normalizeText(expectedPrefix)
        ) +
        commonPrefixLength(
          content.slice(end, end + CONTEXT_LENGTH),
          normalizeText(expectedSuffix)
        ) +
        (content === needle ? 1000 : 0);

      if (score > bestScore) {
        best = message;
        bestScore = score;
        ambiguous = false;
      } else if (score === bestScore) {
        ambiguous = true;
      }
    }

    return ambiguous ? null : best;
  }

  function getApiMessageText(message) {
    const parts = message?.content?.parts;
    if (!Array.isArray(parts)) return '';

    return parts
      .filter(part => typeof part === 'string')
      .join('\n');
  }

  async function loadEarlierDomUntilFound(candidateIds) {
    for (let page = 0; page < MAX_CONVERSATION_PAGES; page++) {
      const existing = findTurnContainerByIds(candidateIds);
      if (existing) return existing;

      const loaded = await triggerPreviousDomPage();
      const found = findTurnContainerByIds(candidateIds);
      if (found) return found;
      if (!loaded) break;
    }

    return null;
  }

  async function triggerPreviousDomPage() {
    const before = getTurnContainers().map(
      element => element.getAttribute('data-turn-id-container')
    );
    const firstTurn = getTurnContainers()[0];

    if (!firstTurn) return false;

    const oldFirstId = before[0];
    const scrollHost =
      firstTurn.closest(SCROLL_ROOT_SELECTOR) ||
      findScrollableAncestor(firstTurn) ||
      document.scrollingElement;

    firstTurn.scrollIntoView({ behavior: 'instant', block: 'start' });

    const changed = waitForCondition(() => {
      const now = getTurnContainers().map(
        element => element.getAttribute('data-turn-id-container')
      );
      return now[0] !== oldFirstId || now.length > before.length;
    }, DOM_PAGE_LOAD_TIMEOUT);

    await nextAnimationFrames(2);
    const currentTop = scrollHost.scrollTop;
    scrollHost.scrollTop = currentTop > 0
      ? Math.max(0, currentTop - 200)
      : 1;
    await nextAnimationFrames(1);
    scrollHost.scrollTop = Math.max(0, scrollHost.scrollTop - 1);
    scrollHost.dispatchEvent(new Event('scroll', { bubbles: true }));
    window.dispatchEvent(new Event('scroll', { bubbles: true }));

    return changed;
  }

  function findScrollableAncestor(element) {
    let current = element?.parentElement;

    while (current) {
      const style = getComputedStyle(current);
      if (
        /(auto|scroll|overlay)/.test(style.overflowY) &&
        current.scrollHeight > current.clientHeight
      ) {
        return current;
      }
      current = current.parentElement;
    }

    return null;
  }

  async function waitForLocatorMessage(bookmark, kind) {
    const fields = getLocatorFields(kind);
    const messageId = bookmark[fields.messageId];

    if (!messageId) return null;

    const message = await waitForCondition(
      () => findMessageById(messageId),
      MESSAGE_MOUNT_TIMEOUT
    );

    if (message) backfillMountedLocator(bookmark, kind, message);
    return message;
  }

  function waitForCondition(predicate, timeout) {
    const immediate = predicate();
    if (immediate) return Promise.resolve(immediate);

    return new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(value);
      };
      const observer = new MutationObserver(() => {
        const value = predicate();
        if (value) finish(value);
      });
      const timer = setTimeout(() => finish(predicate() || false), timeout);

      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  function nextAnimationFrames(count) {
    return new Promise(resolve => {
      const next = () => {
        if (--count <= 0) {
          resolve();
        } else {
          requestAnimationFrame(next);
        }
      };
      requestAnimationFrame(next);
    });
  }

  function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  function findReplyMatch(searchRoot, replyContent) {
    const normalizedReplyContent = normalizeText(replyContent);

    if (!searchRoot || !normalizedReplyContent) {
      return null;
    }

    const messages = [
      ...(searchRoot.matches?.(MESSAGE_SELECTOR) ? [searchRoot] : []),
      ...searchRoot.querySelectorAll(MESSAGE_SELECTOR),
    ];
    const userMessages = messages.filter(
      message =>
        message.getAttribute('data-message-author-role') === 'user'
    );
    const candidates = userMessages.length ? userMessages : messages;

    for (let index = candidates.length - 1; index >= 0; index--) {
      const message = candidates[index];
      const range = locateByNormalizedText(message, {
        text: normalizedReplyContent,
      });

      if (range) {
        return {
          targetMessage: message,
          targetRange: range,
        };
      }
    }

    return null;
  }

  function findTurnContainer(turnID) {
    if (!isValidTurnID(turnID)) {
      return null;
    }

    return getTurnContainers()[turnID] ?? null;
  }

  function findTurnContainerByIds(ids) {
    const wanted = new Set((ids || []).filter(Boolean));
    if (!wanted.size) return null;

    return getTurnContainers().find(container =>
      wanted.has(container.getAttribute('data-turn-id-container'))
    ) || null;
  }

  function findMessageById(messageId) {
    if (!messageId) return null;

    return [...document.querySelectorAll(MESSAGE_SELECTOR)].find(
      message => message.getAttribute('data-message-id') === messageId
    ) || null;
  }

  function getLocatorFields(kind) {
    return kind === 'reply'
      ? {
          messageId: 'replyMessageId',
          messageRole: 'replyMessageRole',
          exchangeId: 'replyTurnExchangeId',
          containerId: 'replyTurnContainerId',
          containerIds: 'replyTurnContainerIds',
          legacyTurnId: 'replyTurnID',
        }
      : {
          messageId: 'messageId',
          messageRole: 'messageRole',
          exchangeId: 'turnExchangeId',
          containerId: 'turnContainerId',
          containerIds: 'turnContainerIds',
          legacyTurnId: 'turnID',
        };
  }

  function getBookmarkContainerIds(bookmark, kind) {
    const fields = getLocatorFields(kind);
    return mergeUniqueIds(
      bookmark[fields.containerId]
        ? [bookmark[fields.containerId]]
        : [],
      bookmark[fields.containerIds]
    );
  }

  function backfillMountedLocator(bookmark, kind, targetElement) {
    const fields = getLocatorFields(kind);
    const message = targetElement.matches?.(MESSAGE_SELECTOR)
      ? targetElement
      : targetElement.closest?.(MESSAGE_SELECTOR);
    const container = targetElement.closest?.(TURN_CONTAINER_SELECTOR);
    const containerId = container?.getAttribute('data-turn-id-container');
    const turnID = getTurnIndex(targetElement);

    if (message?.getAttribute('data-message-id')) {
      bookmark[fields.messageId] = message.getAttribute('data-message-id');
      bookmark[fields.messageRole] =
        message.getAttribute('data-message-author-role') ||
        bookmark[fields.messageRole] ||
        null;
    }
    if (containerId) {
      bookmark[fields.containerId] = containerId;
      bookmark[fields.containerIds] = mergeUniqueIds(
        bookmark[fields.containerIds],
        [containerId]
      );
    }
    if (isValidTurnID(turnID)) {
      bookmark[fields.legacyTurnId] = turnID;
    }
    bookmark.conversationId = bookmark.conversationId || getConversationId();
    bookmark.locatorVersion = 2;
    bookmark.locatorUpdatedAt = Date.now();
    void saveBookmarks();
  }

  function mergeUniqueIds(...groups) {
    return [...new Set(
      groups
        .flatMap(group => Array.isArray(group) ? group : [])
        .filter(value => typeof value === 'string' && value)
    )];
  }

  function isValidTurnID(turnID) {
    return Number.isInteger(turnID) && turnID >= 0;
  }

  function discardInvalidTurnID(bookmark, field) {
    if (bookmark[field] != null && !isValidTurnID(bookmark[field])) {
      delete bookmark[field];
      saveBookmarks();
    }
  }

  function getTurnContainers() {
    return [...document.querySelectorAll(TURN_CONTAINER_SELECTOR)];
  }

  function getTurnIndex(targetElement) {
    const turnContainers = getTurnContainers();
    let current = targetElement;

    while (current) {
      const index = turnContainers.indexOf(current);

      if (index !== -1) {
        return index;
      }

      current = current.parentElement;
    }

    return null;
  }

  function monitorPendingReply(selectionInfo, replyContent) {
    const initialTurns = getTurnContainers();
    const initialTurnCount = initialTurns.length;

    const timer = setInterval(() => {
      const currentTurns = getTurnContainers();
      const currentTurnCount = currentTurns.length;

      if (currentTurnCount === initialTurnCount) {
        return;
      }

      clearInterval(timer);
      replyTurnMonitorTimers.delete(timer);

      const newTurns = currentTurns.slice(initialTurnCount);
      let replyLocator = null;

      for (let index = newTurns.length - 1; index >= 0; index--) {
        const match = findReplyMatch(newTurns[index], replyContent);

        if (match) {
          const replyContainer = match.targetMessage.closest(
            TURN_CONTAINER_SELECTOR
          );
          replyLocator = {
            turnID: getTurnIndex(match.targetMessage),
            messageId: match.targetMessage.getAttribute('data-message-id'),
            messageRole: match.targetMessage.getAttribute(
              'data-message-author-role'
            ),
            turnContainerId: replyContainer?.getAttribute(
              'data-turn-id-container'
            ) || null,
          };
          break;
        }
      }

      if (isValidTurnID(replyLocator?.turnID)) {
        createBookmarkFromPendingSelection(
          replyContent,
          selectionInfo,
          replyLocator
        );
        showToast('Reply has been sent and Bookmark added');
      }
    }, 250);

    replyTurnMonitorTimers.add(timer);
  }

  function clearReplyTurnMonitors() {
    for (const timer of replyTurnMonitorTimers) {
      clearInterval(timer);
    }
    replyTurnMonitorTimers.clear();
  }

  function locateBookmarkRange(scrollRoot, bookmark) {
    return (
      locateInMessage(bookmark) ||
      locateByDomPath(scrollRoot, bookmark) ||
      locateByAbsoluteOffsets(scrollRoot, bookmark) ||
      locateKatexFormula(scrollRoot, bookmark) ||
      locateByTextContext(scrollRoot, bookmark)
    );
  }

  function locateKatexFormula(root, bookmark) {
    const formulaLatex =
      bookmark.formulaLatex ||
      (/^\$([\s\S]+)\$$/.exec(bookmark.text)?.[1] ?? '');

    if (!formulaLatex) {
      return null;
    }

    const formula = [...root.querySelectorAll('.katex')].find(
      element => getKatexLatex(element) === formulaLatex
    );
    const visibleFormula = formula?.querySelector('.katex-html') || formula;

    if (!visibleFormula) {
      return null;
    }

    const range = document.createRange();
    range.selectNodeContents(visibleFormula);
    return range;
  }

  function locateInMessage(bookmark) {
    if (!bookmark.messageId) {
      return null;
    }

    const messages = [...document.querySelectorAll(MESSAGE_SELECTOR)];
    const message = messages.find(
      item => item.getAttribute('data-message-id') === bookmark.messageId
    );

    if (!message) {
      return null;
    }

    if (
      Number.isInteger(bookmark.messageStart) &&
      Number.isInteger(bookmark.messageEnd)
    ) {
      const range = createRangeFromTextOffsets(
        message,
        bookmark.messageStart,
        bookmark.messageEnd
      );

      if (
        range &&
        normalizeText(getCanonicalRangeText(message, range)) ===
          normalizeText(bookmark.text)
      ) {
        return range;
      }
    }

    // Message ids are stable across re-renders; contextual text search inside
    // one message is much safer than searching the entire conversation.
    return (
      locateKatexFormula(message, bookmark) ||
      locateByTextContext(message, bookmark)
    );
  }

  function resolveScrollRoot(bookmark) {
    const roots = [...document.querySelectorAll(SCROLL_ROOT_SELECTOR)];

    if (!roots.length) {
      return null;
    }

    if (
      Number.isInteger(bookmark.rootIndex) &&
      roots[bookmark.rootIndex]
    ) {
      return roots[bookmark.rootIndex];
    }

    return roots[0];
  }

  function locateByDomPath(scrollRoot, bookmark) {
    if (
      !Array.isArray(bookmark.startPath) ||
      !Array.isArray(bookmark.endPath)
    ) {
      return null;
    }

    const startNode = resolveNodePath(scrollRoot, bookmark.startPath);
    const endNode = resolveNodePath(scrollRoot, bookmark.endPath);

    if (!startNode || !endNode) {
      return null;
    }

    try {
      const range = document.createRange();

      range.setStart(
        startNode,
        clampOffset(startNode, bookmark.startOffset)
      );

      range.setEnd(
        endNode,
        clampOffset(endNode, bookmark.endOffset)
      );

      const currentText = getCanonicalRangeText(scrollRoot, range).trim();

      if (normalizeText(currentText) !== normalizeText(bookmark.text)) {
        return null;
      }

      return range;
    } catch {
      return null;
    }
  }

  function locateByAbsoluteOffsets(scrollRoot, bookmark) {
    if (
      !Number.isInteger(bookmark.start) ||
      !Number.isInteger(bookmark.end)
    ) {
      return null;
    }

    const range = createRangeFromTextOffsets(
      scrollRoot,
      bookmark.start,
      bookmark.end
    );

    if (!range) {
      return null;
    }

    if (
      normalizeText(getCanonicalRangeText(scrollRoot, range).trim()) !==
      normalizeText(bookmark.text)
    ) {
      return null;
    }

    return range;
  }

  function locateByTextContext(scrollRoot, bookmark) {
    const textNodes = collectTextNodes(scrollRoot);
    const fullText = textNodes.map(({ text }) => text).join('');

    if (!fullText || !bookmark.text) {
      return null;
    }

    const candidates = findAllOccurrences(fullText, bookmark.text);

    if (!candidates.length) {
      // If no exact matches are found, try a fuzzy search that ignores consecutive whitespace differences.
      return locateByNormalizedText(scrollRoot, bookmark);
    }

    let bestCandidate = null;
    let bestScore = -Infinity;

    for (const start of candidates) {
      const end = start + bookmark.text.length;

      const actualPrefix = fullText.slice(
        Math.max(0, start - CONTEXT_LENGTH),
        start
      );

      const actualSuffix = fullText.slice(
        end,
        Math.min(fullText.length, end + CONTEXT_LENGTH)
      );

      const score =
        commonSuffixLength(actualPrefix, bookmark.prefix ?? '') +
        commonPrefixLength(actualSuffix, bookmark.suffix ?? '') -
        Math.abs(start - (bookmark.start ?? start)) * 0.001;

      if (score > bestScore) {
        bestScore = score;
        bestCandidate = { start, end };
      }
    }

    if (!bestCandidate) {
      return null;
    }

    return createRangeFromTextOffsets(
      scrollRoot,
      bestCandidate.start,
      bestCandidate.end
    );
  }

  function locateByNormalizedText(scrollRoot, bookmark) {
    const mapping = buildNormalizedTextMapping(scrollRoot);
    const normalizedNeedle = normalizeText(bookmark.text);

    if (!normalizedNeedle) {
      return null;
    }

    const normalizedIndex = mapping.text.indexOf(normalizedNeedle);

    if (normalizedIndex === -1) {
      return null;
    }

    const normalizedEnd =
      normalizedIndex + normalizedNeedle.length - 1;

    const originalStart = mapping.originalOffsets[normalizedIndex];
    const originalEnd =
      mapping.originalOffsets[normalizedEnd] + 1;

    return createRangeFromTextOffsets(
      scrollRoot,
      originalStart,
      originalEnd
    );
  }

  function scrollRangeToCenter(scrollRoot, range) {
    const rect = getUsefulRangeRect(range);

    if (!rect) {
      getParentElement(range.startContainer)?.scrollIntoView({
        behavior: 'instant',
        block: 'center',
      });
      return;
    }

    const rootRect = scrollRoot.getBoundingClientRect();
    const rootStyle = getComputedStyle(scrollRoot);

    const isScrollable =
      scrollRoot.scrollHeight > scrollRoot.clientHeight &&
      ['auto', 'scroll', 'overlay'].includes(rootStyle.overflowY);

    if (!isScrollable) {
      getParentElement(range.startContainer)?.scrollIntoView({
        behavior: 'instant',
        block: 'center',
      });
      return;
    }

    const rangeCenterInsideRoot =
      rect.top -
      rootRect.top +
      scrollRoot.scrollTop +
      rect.height / 2;

    const targetScrollTop =
      rangeCenterInsideRoot - scrollRoot.clientHeight / 2;

    // Direct assignment is synchronous and cannot inherit a site's
    // scroll-behavior: smooth CSS.
    scrollRoot.scrollTop = Math.max(0, targetScrollTop);
  }

  /**
   * Highlighting
   */

  function initializePersistentHighlights() {
    if (!CSS.highlights || typeof Highlight === 'undefined') return;

    persistentBookmarkHighlight = new Highlight();
    persistentReplyHighlight = new Highlight();
    CSS.highlights.set(
      'tm-bookmark-persistent',
      persistentBookmarkHighlight
    );
    CSS.highlights.set('tm-reply-persistent', persistentReplyHighlight);

    persistentHighlightObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          intersectingTurnContainers.add(entry.target);
        } else {
          intersectingTurnContainers.delete(entry.target);
        }
      }
      schedulePersistentHighlightRefresh();
    }, {
      root: null,
      rootMargin: '800px 0px',
    });

    persistentHighlightMutationObserver = new MutationObserver(mutations => {
      let needsRefresh = false;

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            observeTurnContainers(node);
          }
          needsRefresh = true;
        }
        if (mutation.type === 'characterData') needsRefresh = true;
        if (mutation.removedNodes.length) needsRefresh = true;
      }

      if (needsRefresh) schedulePersistentHighlightRefresh();
    });

    persistentHighlightMutationObserver.observe(document.documentElement, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    observeTurnContainers(document);
  }

  function observeTurnContainers(root) {
    if (!persistentHighlightObserver) return;

    const containers = [
      ...(root.matches?.(TURN_CONTAINER_SELECTOR) ? [root] : []),
      ...root.querySelectorAll(TURN_CONTAINER_SELECTOR),
    ];

    for (const container of containers) {
      if (observedTurnContainers.has(container)) continue;
      observedTurnContainers.add(container);
      persistentHighlightObserver.observe(container);
    }
  }

  function schedulePersistentHighlightRefresh() {
    if (!persistentHighlightObserver || persistentHighlightRefreshTimer) {
      return;
    }
    persistentHighlightRefreshTimer = setTimeout(
      refreshPersistentHighlights,
      120
    );
  }

  function refreshPersistentHighlights() {
    persistentHighlightRefreshTimer = null;
    prunePersistentHighlightRanges();

    for (const container of [...intersectingTurnContainers]) {
      if (!container.isConnected) {
        intersectingTurnContainers.delete(container);
        continue;
      }
      highlightBookmarksInContainer(container);
    }
  }

  function highlightBookmarksInContainer(container) {
    if (!container.querySelector(MESSAGE_SELECTOR)) return;

    for (const bookmark of bookmarks) {
      const targetRange = locatePersistentBookmarkRange(container, bookmark);
      if (targetRange) {
        setPersistentHighlightRange(bookmark.id, 'target', targetRange);
      }

      if (bookmark.replyContent) {
        const replyMatch = findReplyMatch(container, bookmark.replyContent);
        if (replyMatch) {
          setPersistentHighlightRange(
            bookmark.id,
            'reply',
            replyMatch.targetRange
          );
        }
      }
    }
  }

  function locatePersistentBookmarkRange(container, bookmark) {
    if (!bookmark?.text) return null;

    // Use the strongest locator first, but only accept it when it belongs to
    // this visible turn. Old records then fall through to local text/context
    // recovery without scanning the rest of the conversation.
    const messageRange = locateInMessage(bookmark);
    if (
      messageRange &&
      container.contains(messageRange.startContainer) &&
      container.contains(messageRange.endContainer)
    ) {
      return messageRange;
    }

    return (
      locateKatexFormula(container, bookmark) ||
      locateByTextContext(container, bookmark)
    );
  }

  function setPersistentHighlightRange(bookmarkId, kind, range) {
    const key = `${bookmarkId}:${kind}`;
    const highlight = kind === 'reply'
      ? persistentReplyHighlight
      : persistentBookmarkHighlight;
    const previous = persistentHighlightRanges.get(key);

    if (!highlight || previous?.range === range) return;
    if (previous) previous.highlight.delete(previous.range);

    highlight.add(range);
    persistentHighlightRanges.set(key, { highlight, range });
  }

  function prunePersistentHighlightRanges() {
    for (const [key, entry] of persistentHighlightRanges) {
      const startElement = getParentElement(entry.range.startContainer);
      const endElement = getParentElement(entry.range.endContainer);

      if (!startElement?.isConnected || !endElement?.isConnected) {
        entry.highlight.delete(entry.range);
        persistentHighlightRanges.delete(key);
      }
    }
  }

  function removePersistentBookmarkRanges(bookmarkId) {
    for (const kind of ['target', 'reply']) {
      const key = `${bookmarkId}:${kind}`;
      const entry = persistentHighlightRanges.get(key);
      if (!entry) continue;
      entry.highlight.delete(entry.range);
      persistentHighlightRanges.delete(key);
    }
  }

  function resetPersistentHighlights() {
    for (const entry of persistentHighlightRanges.values()) {
      entry.highlight.delete(entry.range);
    }
    persistentHighlightRanges.clear();
  }

  function highlightRange(range) {
    clearCurrentHighlight();

    if (CSS.highlights && typeof Highlight !== 'undefined') {
      const highlight = new Highlight(range);
      CSS.highlights.set('tm-bookmark-highlight', highlight);

      highlightCleanupTimer = window.setTimeout(() => {
        CSS.highlights.delete('tm-bookmark-highlight');
      }, 2500);

      return;
    }

    // Use the Selection API as a fallback for browsers that don't support CSS.highlights.
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    highlightCleanupTimer = window.setTimeout(() => {
      selection?.removeAllRanges();
    }, 2500);
  }

  function clearCurrentHighlight() {
    if (highlightCleanupTimer) {
      clearTimeout(highlightCleanupTimer);
      highlightCleanupTimer = null;
    }

    CSS.highlights?.delete('tm-bookmark-highlight');
  }

  /**
   * DOM/text position utilities
   */

  function getCanonicalRangeOffsets(root, selectedRange) {
    const nodes = collectTextNodes(root);
    let start = null;
    let end = null;

    for (const item of nodes) {
      // This works for ordinary text as well as deeply nested KaTeX and
      // CodeMirror spans. It also avoids compareBoundaryPoints direction
      // mistakes that can reject every node in a valid selection.
      try {
        if (!selectedRange.intersectsNode(item.node)) {
          continue;
        }
      } catch {
        continue;
      }

      let localStart = 0;
      let localEnd = item.text.length;

      if (selectedRange.startContainer === item.node) {
        localStart = clampOffset(item.node, selectedRange.startOffset);
      }
      if (selectedRange.endContainer === item.node) {
        localEnd = clampOffset(item.node, selectedRange.endOffset);
      }

      if (start === null) start = item.start + localStart;
      end = item.start + localEnd;
    }

    return start === null || end === null ? null : { start, end };
  }

  function getCanonicalRangeText(root, range) {
    const offsets = getCanonicalRangeOffsets(root, range);
    return offsets
      ? getCanonicalRootText(root).slice(offsets.start, offsets.end)
      : '';
  }

  function createRangeFromTextOffsets(root, start, end) {
    if (start < 0 || end < start) {
      return null;
    }

    const textNodes = collectTextNodes(root);

    let startPoint = null;
    let endPoint = null;

    for (const item of textNodes) {
      const nodeStart = item.start;
      const nodeEnd = item.end;

      if (
        !startPoint &&
        start >= nodeStart &&
        start <= nodeEnd
      ) {
        startPoint = {
          node: item.node,
          offset: start - nodeStart,
        };
      }

      if (
        !endPoint &&
        end >= nodeStart &&
        end <= nodeEnd
      ) {
        endPoint = {
          node: item.node,
          offset: end - nodeStart,
        };
      }

      if (startPoint && endPoint) {
        break;
      }
    }

    if (!startPoint || !endPoint) {
      return null;
    }

    try {
      const range = document.createRange();
      range.setStart(
        startPoint.node,
        clampOffset(startPoint.node, startPoint.offset)
      );
      range.setEnd(
        endPoint.node,
        clampOffset(endPoint.node, endPoint.offset)
      );
      return range;
    } catch {
      return null;
    }
  }

  function collectTextNodes(root) {
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!node.nodeValue) {
            return NodeFilter.FILTER_REJECT;
          }

          const parent = node.parentElement;

          if (
            !parent ||
            parent.closest(IGNORED_TEXT_SELECTOR)
          ) {
            return NodeFilter.FILTER_REJECT;
          }

          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    const result = [];
    let offset = 0;
    let node;

    while ((node = walker.nextNode())) {
      const text = node.nodeValue;

      result.push({
        node,
        text,
        start: offset,
        end: offset + text.length,
      });

      offset += text.length;
    }

    return result;
  }

  function getCanonicalRootText(root) {
    return collectTextNodes(root)
      .map(({ text }) => text)
      .join('');
  }

  function getNodePath(root, node) {
    const path = [];
    let current = node;

    while (current && current !== root) {
      const parent = current.parentNode;

      if (!parent) {
        return null;
      }

      path.unshift([...parent.childNodes].indexOf(current));
      current = parent;
    }

    return current === root ? path : null;
  }

  function resolveNodePath(root, path) {
    let current = root;

    for (const index of path) {
      current = current?.childNodes?.[index];

      if (!current) {
        return null;
      }
    }

    return current;
  }

  function clampOffset(node, offset) {
    const max =
      node.nodeType === Node.TEXT_NODE
        ? node.nodeValue.length
        : node.childNodes.length;

    return Math.min(Math.max(0, Number(offset) || 0), max);
  }

  function getScrollRootIndex(root) {
    return [...document.querySelectorAll(SCROLL_ROOT_SELECTOR)]
      .indexOf(root);
  }

  function getUsefulRangeRect(range) {
    const boundingRect = range.getBoundingClientRect();

    if (boundingRect.width || boundingRect.height) {
      return boundingRect;
    }

    const rects = [...range.getClientRects()];
    return rects.find(rect => rect.width || rect.height) ?? null;
  }

  function findAllOccurrences(haystack, needle) {
    const results = [];
    let index = 0;

    while (index <= haystack.length - needle.length) {
      const found = haystack.indexOf(needle, index);

      if (found === -1) {
        break;
      }

      results.push(found);
      index = found + Math.max(1, needle.length);
    }

    return results;
  }

  function commonPrefixLength(a, b) {
    const max = Math.min(a.length, b.length);
    let count = 0;

    while (count < max && a[count] === b[count]) {
      count++;
    }

    return count;
  }

  function commonSuffixLength(a, b) {
    const max = Math.min(a.length, b.length);
    let count = 0;

    while (
      count < max &&
      a[a.length - 1 - count] === b[b.length - 1 - count]
    ) {
      count++;
    }

    return count;
  }

  function normalizeText(text) {
    return String(text ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function buildNormalizedTextMapping(root) {
    const originalText = getCanonicalRootText(root);

    let normalized = '';
    const originalOffsets = [];
    let previousWasWhitespace = false;

    for (let i = 0; i < originalText.length; i++) {
      const char = originalText[i];
      const isWhitespace = /\s/.test(char);

      if (isWhitespace) {
        if (!previousWasWhitespace && normalized.length > 0) {
          normalized += ' ';
          originalOffsets.push(i);
        }

        previousWasWhitespace = true;
      } else {
        normalized += char;
        originalOffsets.push(i);
        previousWasWhitespace = false;
      }
    }

    return {
      text: normalized.trim(),
      originalOffsets,
    };
  }

  /**
   * Bookmark window
   */

  function createBookmarkButton() {
    bookmarkButton = document.createElement('div');
    bookmarkButton.id = 'tm-bookmark-selection-button';

    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.textContent = 'Bookmark';
    addButton.addEventListener('click', () => {
      createBookmarkFromPendingSelection();
    });

    const markdownButton = document.createElement('button');
    markdownButton.type = 'button';
    markdownButton.textContent = 'Copy Markdown';
    markdownButton.addEventListener('click', copyPendingSelectionAsMarkdown);

    const replyButton = document.createElement('button');
    replyButton.type = 'button';
    replyButton.textContent = 'Reply';
    replyButton.addEventListener('click', replyToPendingSelection);

    bookmarkButton.append(addButton, markdownButton, replyButton);
    bookmarkButton.addEventListener(
      'mousedown',
      event => event.preventDefault()
    );

    document.documentElement.appendChild(bookmarkButton);
  }

  async function copyPendingSelectionAsMarkdown() {
    const range = pendingSelection?.range;

    if (!range) {
      hideBookmarkButton();
      return;
    }

    const container = document.createElement('div');
    container.appendChild(range.cloneContents());
    const markdown = domSelectionToMarkdown(container, range);

    if (!markdown) {
      showToast('No content to copy as Markdown');
      return;
    }

    try {
      await navigator.clipboard.writeText(markdown);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = markdown;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.documentElement.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand('copy');
      textarea.remove();

      if (!copied) {
        showToast('Copy failed, please check clipboard permissions');
        return;
      }
    }

    hideBookmarkButton();
    clearBrowserSelection();
    showToast('Markdown Copied');
  }

  function replyToPendingSelection() {
    const selectionInfo = pendingSelection;

    if (!selectionInfo?.messageId) {
      showToast('Reply failed: no message ID found for the selection');
      return;
    }

    const message = [...document.querySelectorAll(MESSAGE_SELECTOR)].find(
      item =>
        item.getAttribute('data-message-id') === selectionInfo.messageId
    );

    if (!message) {
      showToast('Cannot find the message for the selection');
      return;
    }

    const replySelection = getReplySelectionData(
      message,
      selectionInfo.range
    );

    if (!replySelection) {
      showToast('Cannot determine the selected text for reply');
      return;
    }

    const {
      messageText,
      selectionStart,
      selectionEnd,
    } = replySelection;
    const selectedText = normalizeReplyText(
      messageText.slice(selectionStart, selectionEnd)
    );
    const beforeText = normalizeReplyText(
      messageText.slice(0, selectionStart)
    );
    const afterText = normalizeReplyText(
      messageText.slice(selectionEnd)
    );

    if (!selectedText) {
      showToast('No text selected for reply');
      return;
    }

    const before = takeReplyContext(beforeText, 15, 'before');
    const after = takeReplyContext(afterText, 15, 'after');
    const quote = [
      '> ',
      before,
      before ? ' ' : '',
      '→ ',
      selectedText,
      ' ←',
      after ? ` ${after}` : '',
      '\n\n',
    ].join('');

    if (!insertPlainTextIntoPrompt(quote)) {
      showToast('Cannot find the ChatGPT input field');
      return;
    }

    hideBookmarkButton();
    clearBrowserSelection();
    monitorPendingReply(selectionInfo, quote);
    showToast('Bookmark will be added after sending');
  }

  function getReplySelectionData(message, range) {
    const entries = collectReplyTextEntries(message);
    let messageText = '';
    let selectionStart = null;
    let selectionEnd = null;

    for (const entry of entries) {
      const entryStart = messageText.length;
      messageText += entry.text;

      try {
        if (!range.intersectsNode(entry.node)) {
          continue;
        }
      } catch {
        continue;
      }

      let localStart = 0;
      let localEnd = entry.text.length;

      // KaTeX is deliberately atomic: selecting any rendered part captures
      // the complete annotation rather than fragmented visual spans.
      if (entry.type === 'text') {
        if (range.startContainer === entry.node) {
          localStart = clampOffset(entry.node, range.startOffset);
        }
        if (range.endContainer === entry.node) {
          localEnd = clampOffset(entry.node, range.endOffset);
        }

        // A zero-width boundary at an adjacent text node is not content.
        if (localStart === localEnd) {
          continue;
        }
      }

      if (selectionStart === null) {
        selectionStart = entryStart + localStart;
      }
      selectionEnd = entryStart + localEnd;
    }

    if (selectionStart === null || selectionEnd === null) {
      return null;
    }

    return {
      messageText,
      selectionStart,
      selectionEnd,
    };
  }

  function collectReplyTextEntries(root) {
    const entries = [];

    function visit(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.nodeValue) {
          entries.push({
            type: 'text',
            node,
            text: node.nodeValue,
          });
        }
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        return;
      }

      const element = node;

      if (element.matches('.katex')) {
        const latex = getKatexMarkdown(element);

        if (latex) {
          entries.push({
            type: 'latex',
            node: element,
            text: latex,
          });
        }
        return;
      }

      if (
        element !== root &&
        element.matches(IGNORED_TEXT_SELECTOR)
      ) {
        return;
      }

      for (const child of element.childNodes) {
        visit(child);
      }
    }

    visit(root);
    return entries;
  }

  function normalizeReplyText(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim();
  }

  function takeReplyContext(text, length, direction) {
    const characters = Array.from(text);

    if (!characters.length) {
      return '';
    }

    if (direction === 'before') {
      const excerpt = characters.slice(-length).join('');
      return characters.length > length ? `…${excerpt}` : excerpt;
    }

    const excerpt = characters.slice(0, length).join('');
    return characters.length > length ? `${excerpt}…` : excerpt;
  }

  function insertPlainTextIntoPrompt(text) {
    const editor = document.querySelector(
      '#prompt-textarea.ProseMirror[contenteditable="true"], ' +
      '.ProseMirror[contenteditable="true"][role="textbox"]'
    );

    if (!editor) {
      return false;
    }

    editor.focus();

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);

    const prefix = editor.textContent.trim() ? '\n\n' : '';
    const value = `${prefix}${text}`;

    try {
      if (document.execCommand('insertText', false, value)) {
        return true;
      }
    } catch {
      // Continue with the plain-text DOM fallback below.
    }

    // Fallback for browsers that disable execCommand. This still inserts a
    // text node (never HTML) and notifies ProseMirror through a bubbling input.
    const textNode = document.createTextNode(value);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    editor.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: value,
    }));
    return true;
  }

  function domSelectionToMarkdown(container, sourceRange) {
    const startElement = getParentElement(sourceRange.startContainer);
    const endElement = getParentElement(sourceRange.endContainer);
    const startFormula = startElement?.closest('.katex');
    const endFormula = endElement?.closest('.katex');
    const startPre = startElement?.closest('pre');
    const endPre = endElement?.closest('pre');
    const startCode = startElement?.closest('code');
    const endCode = endElement?.closest('code');

    // cloneContents() intentionally omits unselected ancestors. Restore the
    // semantic wrapper when a selection lives wholly inside a formula or code
    // block, otherwise a partial code/formula selection would become plain text.
    if (startFormula && startFormula === endFormula) {
      const tex = startFormula
        .closest('[data-math-source]')
        ?.getAttribute('data-math-source')
        ?.trim() ?? '';
      if (tex) return `$${tex.replace(/\$/g, '\\$')}$`;
    }

    if (startPre && startPre === endPre) {
      const selectedCode = sourceRange.toString().replace(/^\n|\n$/g, '');
      const fence = selectedCode.includes('```') ? '````' : '```';
      return `${fence}\n${selectedCode}\n${fence}`;
    }

    if (startCode && startCode === endCode) {
      const selectedCode = sourceRange.toString();
      const fence = selectedCode.includes('`') ? '``' : '`';
      return `${fence}${selectedCode}${fence}`;
    }

    const renderChildren = node =>
      [...node.childNodes].map(renderNode).join('');

    function renderNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return escapeMarkdownText(node.nodeValue);
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        return '';
      }

      const element = node;

      if (element.matches('script, style, noscript, button, svg, textarea')) {
        return '';
      }

      if (element.matches('.katex-display, .katex')) {
        const tex = element
          .closest('[data-math-source]')
          ?.getAttribute('data-math-source')
          ?.trim() ?? '';

        if (tex) {
          const formula = `$${tex.replace(/\$/g, '\\$')}$`;
          return element.matches('.katex-display')
            ? `\n\n${formula}\n\n`
            : formula;
        }
      }

      if (
        element.matches(
          '.katex-mathml, .katex-html, [aria-hidden="true"], .select-none'
        )
      ) {
        return '';
      }

      const tag = element.tagName.toLowerCase();

      if (tag === 'pre') {
        const codeElement = element.querySelector(
          '.cm-content code, code'
        );
        const code = (codeElement?.textContent ?? element.textContent)
          .replace(/^\n|\n$/g, '');
        const language =
          [...element.querySelectorAll('[class*="language-"]')]
            .map(item =>
              [...item.classList]
                .find(name => name.startsWith('language-'))
                ?.slice(9)
            )
            .find(Boolean) ?? '';
        const fence = code.includes('```') ? '````' : '```';
        return `\n\n${fence}${language}\n${code}\n${fence}\n\n`;
      }

      if (tag === 'code') {
        const code = element.textContent;
        const fence = code.includes('`') ? '``' : '`';
        return `${fence}${code}${fence}`;
      }

      if (/^h[1-6]$/.test(tag)) {
        return `\n\n${'#'.repeat(Number(tag[1]))} ${renderChildren(element).trim()}\n\n`;
      }

      if (tag === 'p') {
        return `\n\n${renderChildren(element).trim()}\n\n`;
      }

      if (tag === 'br') {
        return '\n';
      }

      if (tag === 'strong' || tag === 'b') {
        return `**${renderChildren(element)}**`;
      }

      if (tag === 'em' || tag === 'i') {
        return `*${renderChildren(element)}*`;
      }

      if (tag === 'del' || tag === 's') {
        return `~~${renderChildren(element)}~~`;
      }

      if (tag === 'a') {
        const label = renderChildren(element).trim();
        const href = element.getAttribute('href');
        return href ? `[${label}](${href})` : label;
      }

      if (tag === 'blockquote') {
        return `\n\n${renderChildren(element)
          .trim()
          .split('\n')
          .map(line => `> ${line}`)
          .join('\n')}\n\n`;
      }

      if (tag === 'ul' || tag === 'ol') {
        const ordered = tag === 'ol';
        const items = [...element.children].filter(
          child => child.tagName === 'LI'
        );
        return `\n\n${items
          .map((item, index) => {
            const marker = ordered ? `${index + 1}.` : '-';
            return `${marker} ${renderChildren(item).trim()}`;
          })
          .join('\n')}\n\n`;
      }

      if (tag === 'li') {
        return renderChildren(element);
      }

      if (tag === 'hr') {
        return '\n\n---\n\n';
      }

      return renderChildren(element);
    }

    const markdown = renderChildren(container)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return restoreSharedMarkdownContext(
      markdown,
      startElement,
      endElement
    );
  }

  function restoreSharedMarkdownContext(markdown, startElement, endElement) {
    if (!markdown) return '';

    const shared = selector => {
      const start = startElement?.closest(selector);
      return start && start === endElement?.closest(selector) ? start : null;
    };

    let result = markdown;
    const strong = shared('strong, b');
    const emphasis = shared('em, i');
    const deleted = shared('del, s');
    const link = shared('a[href]');
    const heading = shared('h1, h2, h3, h4, h5, h6');
    const quote = shared('blockquote');

    if (strong) result = `**${result}**`;
    if (emphasis) result = `*${result}*`;
    if (deleted) result = `~~${result}~~`;
    if (link) result = `[${result}](${link.getAttribute('href')})`;
    if (heading) {
      result = `${'#'.repeat(Number(heading.tagName[1]))} ${result}`;
    }
    if (quote) {
      result = result.split('\n').map(line => `> ${line}`).join('\n');
    }

    return result;
  }

  function escapeMarkdownText(text) {
    return String(text ?? '').replace(/([\\`*_[\]<>])/g, '\\$1');
  }

  function createBookmarkWindow() {
    bookmarkWindow = document.createElement('aside');
    bookmarkWindow.id = 'tm-bookmark-window';

    const header = document.createElement('div');
    header.className = 'tm-bookmark-header';

    const title = document.createElement('div');
    title.className = 'tm-bookmark-title';
    title.textContent = 'Bookmarks';
    title.title = 'Right-click: cloud sync / export / import';
    title.addEventListener('contextmenu', event => {
      event.preventDefault();
      showCloudMenu(event.clientX, event.clientY);
    });

    const controls = document.createElement('div');
    controls.className = 'tm-bookmark-controls';

    const importInput = document.createElement('input');
    importInput.type = 'file';
    importInput.accept = 'application/json,.json';
    importInput.style.position = 'fixed';
    importInput.style.width = '1px';
    importInput.style.height = '1px';
    importInput.style.overflow = 'hidden';
    importInput.style.clip = 'rect(0 0 0 0)';
    importInput.style.clipPath = 'inset(50%)';
    importInput.style.whiteSpace = 'nowrap';
    bookmarkImportInput = importInput;
    importInput.addEventListener('change', async () => {
      const file = importInput.files?.[0];

      if (file) {
        await importBookmarkBackup(file);
      }

      importInput.value = '';
    });
    document.documentElement.appendChild(importInput);

    const collapseButton = document.createElement('button');
    collapseButton.type = 'button';
    collapseButton.className = 'tm-bookmark-icon-button';
    collapseButton.title = 'Collapse';
    collapseButton.textContent = '−';

    collapseButton.addEventListener('click', () => {
      const collapsed =
        bookmarkWindow.dataset.collapsed === 'true';

      setWindowCollapsed(!collapsed);
    });

    controls.append(collapseButton);
    header.append(title, controls);

    const body = document.createElement('div');
    body.className = 'tm-bookmark-body';

    bookmarkList = document.createElement('div');
    bookmarkList.className = 'tm-bookmark-list';

    emptyMessage = document.createElement('div');
    emptyMessage.className = 'tm-bookmark-empty';
    emptyMessage.textContent = 'No Bookmark';

    body.append(emptyMessage, bookmarkList);
    bookmarkWindow.append(header, body);

    enableWindowDragging(bookmarkWindow, header);

    document.documentElement.appendChild(bookmarkWindow);
    setWindowCollapsed(true);
  }

  function renderBookmarks() {
    bookmarkList.replaceChildren();

    emptyMessage.style.display =
      bookmarks.length === 0 ? 'block' : 'none';

    for (const bookmark of bookmarks) {
      const item = document.createElement('div');
      item.className = 'tm-bookmark-item';

      const jumpButton = document.createElement('button');
      jumpButton.type = 'button';
      jumpButton.className = 'tm-bookmark-jump';
      jumpButton.title = bookmark.title || bookmark.text;

      const text = document.createElement('div');
      text.className = 'tm-bookmark-item-text';
      text.textContent = truncate(
        bookmark.title || bookmark.text,
        MAX_TITLE_LENGTH
      );

      const meta = document.createElement('div');
      meta.className = 'tm-bookmark-item-meta';
      meta.textContent = formatDate(bookmark.createdAt);

      jumpButton.append(text, meta);
      jumpButton.addEventListener('click', () => {
        jumpToBookmark(bookmark);
      });

      const replyJumpButton = document.createElement('button');
      replyJumpButton.type = 'button';
      replyJumpButton.className = 'tm-bookmark-reply-jump';
      replyJumpButton.title = ' Jump to Reply';
      replyJumpButton.setAttribute('aria-label', ' Jump to Reply');
      replyJumpButton.textContent = '↪';
      replyJumpButton.addEventListener('click', event => {
        event.stopPropagation();
        jumpToReply(bookmark);
      });

      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'tm-bookmark-delete';
      deleteButton.title = ' Delete';
      deleteButton.setAttribute('aria-label', 'Delete Bookmark');
      deleteButton.textContent = '×';

      deleteButton.addEventListener('click', event => {
        event.stopPropagation();
        deleteBookmark(bookmark.id);
      });

      item.append(jumpButton);
      if (bookmark.replyContent) {
        item.append(replyJumpButton);
      }
      item.append(deleteButton);
      item.addEventListener('contextmenu', event => {
        event.preventDefault();
        renameBookmark(bookmark);
      });
      bookmarkList.appendChild(item);
    }
  }

  function renameBookmark(bookmark) {
    const value = prompt(
      'Please enter the Bookmark title; leave empty to restore the selected text:',
      bookmark.title || bookmark.text
    );

    if (value === null) {
      return;
    }

    const title = value.trim();

    if (title && title !== bookmark.text) {
      bookmark.title = title;
    } else {
      delete bookmark.title;
    }

    saveBookmarks();
    renderBookmarks();
  }

  function deleteBookmark(id) {
    bookmarks = bookmarks.filter(bookmark => bookmark.id !== id);
    saveBookmarks();
    renderBookmarks();
    removePersistentBookmarkRanges(id);
    schedulePersistentHighlightRefresh();
  }

  function setWindowCollapsed(collapsed) {
    bookmarkWindow.dataset.collapsed = String(collapsed);

    const collapseButton = bookmarkWindow.querySelector(
      '.tm-bookmark-icon-button'
    );

    if (collapseButton) {
      collapseButton.textContent = collapsed ? '+' : '−';
      collapseButton.title = collapsed ? 'Expand' : 'Collapse';
    }
  }

  function syncWindowCollapsedAfterUrlSettles(time = 5000) {
    clearTimeout(autoExpandTimer);
    autoExpandTimer = null;

    if (bookmarks.length === 0) {
      setWindowCollapsed(true);
      return;
    }

    autoExpandTimer = setTimeout(() => {
      autoExpandTimer = null;
      setWindowCollapsed(false);
    }, time);
  }

  function flashWindow() {
    bookmarkWindow.classList.remove('tm-bookmark-window-flash');

    requestAnimationFrame(() => {
      bookmarkWindow.classList.add('tm-bookmark-window-flash');

      setTimeout(() => {
        bookmarkWindow.classList.remove(
          'tm-bookmark-window-flash'
        );
      }, 500);
    });
  }

  function enableWindowDragging(windowElement, handle) {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    handle.addEventListener('mousedown', event => {
      if (event.button !== 0) {
        return;
      }

      if (event.target.closest('button, label, input')) {
        return;
      }

      const rect = windowElement.getBoundingClientRect();

      dragging = true;
      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;

      windowElement.style.right = 'auto';
      windowElement.style.bottom = 'auto';
      windowElement.style.left = `${rect.left}px`;
      windowElement.style.top = `${rect.top}px`;

      event.preventDefault();
    });

    document.addEventListener('mousemove', event => {
      if (!dragging) {
        return;
      }

      const rect = windowElement.getBoundingClientRect();
      const margin = 8;

      const left = Math.min(
        Math.max(margin, event.clientX - offsetX),
        window.innerWidth - rect.width - margin
      );

      const top = Math.min(
        Math.max(margin, event.clientY - offsetY),
        window.innerHeight - rect.height - margin
      );

      windowElement.style.left = `${left}px`;
      windowElement.style.top = `${top}px`;
    });

    document.addEventListener('mouseup', () => {
      dragging = false;
    });
  }

  /**
   * Persistence
   */

  function getUrlKey() {
    return getLastPathPart(location.pathname);
  }

  function getConversationId() {
    const parts = location.pathname.split('/').filter(Boolean);
    const conversationMarker = parts.lastIndexOf('c');
    return conversationMarker !== -1
      ? parts[conversationMarker + 1] || ''
      : '';
  }

  function getLastPathPart(pathOrUrl) {
    try {
      const pathname = new URL(pathOrUrl, location.origin).pathname;
      return pathname.split('/').filter(Boolean).at(-1) ?? '';
    } catch {
      return String(pathOrUrl ?? '')
        .split(/[?#]/, 1)[0]
        .split('/')
        .filter(Boolean)
        .at(-1) ?? '';
    }
  }

  function migrateBookmarkData() {
    const storedVersion =
      Number.parseInt(localStorage.getItem(DATA_VERSION_KEY), 10) || 0;

    if (storedVersion >= DATA_VERSION) {
      return;
    }

    try {
      const sourceKeys = [];
      const mergedByUrlKey = new Map();

      for (let index = 0; index < localStorage.length; index++) {
        const storageKey = localStorage.key(index);

        if (
          !storageKey?.startsWith(STORAGE_PREFIX) ||
          storageKey === DATA_VERSION_KEY
        ) {
          continue;
        }

        const oldUrlKey = storageKey.slice(STORAGE_PREFIX.length);
        const newUrlKey = getLastPathPart(oldUrlKey);

        if (!newUrlKey) {
          continue;
        }

        let storedBookmarks;

        try {
          storedBookmarks = JSON.parse(localStorage.getItem(storageKey));
        } catch {
          continue;
        }

        if (!Array.isArray(storedBookmarks)) {
          continue;
        }

        sourceKeys.push(storageKey);

        const mergedBookmarks = mergedByUrlKey.get(newUrlKey) ?? [];
        mergedBookmarks.push(...storedBookmarks);
        mergedByUrlKey.set(newUrlKey, mergedBookmarks);
      }

      const destinationKeys = new Set();

      for (const [urlKey, mergedBookmarks] of mergedByUrlKey) {
        const destinationKey = `${STORAGE_PREFIX}${urlKey}`;
        destinationKeys.add(destinationKey);
        localStorage.setItem(
          destinationKey,
          JSON.stringify(mergedBookmarks)
        );
      }

      for (const sourceKey of sourceKeys) {
        if (!destinationKeys.has(sourceKey)) {
          localStorage.removeItem(sourceKey);
        }
      }

      localStorage.setItem(DATA_VERSION_KEY, String(DATA_VERSION));
    } catch (error) {
      console.error('[Text Bookmarks] Migration failed:', error);
    }
  }

  function exportBookmarkBackup() {
    try {
      const bookmarkData = {};

      for (let index = 0; index < localStorage.length; index++) {
        const storageKey = localStorage.key(index);

        if (
          !storageKey?.startsWith(STORAGE_PREFIX) ||
          storageKey === DATA_VERSION_KEY
        ) {
          continue;
        }

        const urlKey = storageKey.slice(STORAGE_PREFIX.length);
        const storedBookmarks = JSON.parse(
          localStorage.getItem(storageKey)
        );

        if (urlKey && Array.isArray(storedBookmarks)) {
          bookmarkData[urlKey] = storedBookmarks;
        }
      }

      const backup = {
        format: 'gptweb-enhanced-bookmarks',
        dataVersion: DATA_VERSION,
        exportedAt: new Date().toISOString(),
        bookmarks: bookmarkData,
      };
      const blob = new Blob(
        [JSON.stringify(backup, null, 2)],
        { type: 'application/json' }
      );
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const date = new Date().toISOString().slice(0, 10);

      link.href = downloadUrl;
      link.download = `gptweb-bookmarks-backup-${date}.json`;
      document.documentElement.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 0);
      showToast('Bookmark backup exported');
    } catch (error) {
      console.error('[Text Bookmarks] Export failed:', error);
      showToast('Bookmark backup export failed');
    }
  }

  async function importBookmarkBackup(file) {
    try {
      const backup = JSON.parse(await file.text());

      if (
        backup?.format !== 'gptweb-enhanced-bookmarks' ||
        !backup.bookmarks ||
        typeof backup.bookmarks !== 'object' ||
        Array.isArray(backup.bookmarks)
      ) {
        throw new Error('Invalid backup format');
      }

      const entries = Object.entries(backup.bookmarks);

      if (
        entries.some(
          ([urlKey, value]) =>
            !urlKey ||
            !Array.isArray(value)
        )
      ) {
        throw new Error('Invalid bookmark data');
      }

      for (const [urlKey, storedBookmarks] of entries) {
        if (isCloudLoggedIn()) {
          await cloudSave(urlKey, storedBookmarks);
        } else {
          localStorage.setItem(
            `${STORAGE_PREFIX}${urlKey}`,
            JSON.stringify(storedBookmarks)
          );
        }
      }

      localStorage.setItem(DATA_VERSION_KEY, String(DATA_VERSION));
      await refreshBookmarks(currentUrlKey);
      showToast(`Imported ${entries.length} bookmark lists`);
    } catch (error) {
      console.error('[Text Bookmarks] Import failed:', error);
      showToast('Bookmark backup import failed');
    }
  }

  function getStorageKey(urlKey = currentUrlKey) {
    return `${STORAGE_PREFIX}${urlKey}`;
  }

  function installUrlChangeListener() {
    const notify = () => window.dispatchEvent(new Event('tm:urlchange'));

    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      history[method] = function (...args) {
        const result = original.apply(this, args);
        notify();
        return result;
      };
    }

    window.addEventListener('popstate', notify);
    window.addEventListener('hashchange', notify);
    window.addEventListener('tm:urlchange', handleUrlChange);
  }

  function handleUrlChange() {
    clearTimeout(autoExpandTimer);
    autoExpandTimer = null;
    clearReplyTurnMonitors();

    // history events may fire before location has settled in some frameworks.
    queueMicrotask(() => {
      const nextUrlKey = getUrlKey();

      if (nextUrlKey === currentUrlKey) {
        syncWindowCollapsedAfterUrlSettles();
        return;
      }

      hideBookmarkButton();
      clearCurrentHighlight();
      resetPersistentHighlights();
      currentUrlKey = nextUrlKey;
      void refreshBookmarks(currentUrlKey);
    });
  }

  /**
   * Misc
   */

  function hideBookmarkButton() {
    pendingSelection = null;

    if (bookmarkButton) {
      bookmarkButton.style.display = 'none';
    }
  }

  function clearBrowserSelection() {
    window.getSelection()?.removeAllRanges();
  }

  function truncate(text, maxLength) {
    const normalized = normalizeText(text);

    if (normalized.length <= maxLength) {
      return normalized;
    }

    return `${normalized.slice(0, maxLength)}…`;
  }

  function formatDate(timestamp) {
    if (!timestamp) {
      return '';
    }

    return new Intl.DateTimeFormat(undefined, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(timestamp);
  }

  function createFallbackId() {
    return [
      Date.now().toString(36),
      Math.random().toString(36).slice(2),
    ].join('-');
  }

  function showToast(message) {
    const oldToast = document.querySelector('#tm-bookmark-toast');
    oldToast?.remove();

    const toast = document.createElement('div');
    toast.id = 'tm-bookmark-toast';
    toast.textContent = message;

    document.documentElement.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.add('tm-bookmark-toast-visible');
    });

    setTimeout(() => {
      toast.classList.remove('tm-bookmark-toast-visible');

      setTimeout(() => {
        toast.remove();
      }, 200);
    }, 1800);
  }

  /**
   * Styles
   */

  function injectStyles() {
    const style = document.createElement('style');

    style.textContent = `
      #tm-bookmark-selection-button {
        all: initial;
        position: fixed;
        z-index: 2147483647;
        display: none;
        box-sizing: border-box;
        align-items: stretch;
        overflow: hidden;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 8px;
        background: rgba(25, 25, 28, 0.96);
        box-shadow:
          0 8px 28px rgba(0, 0, 0, 0.28),
          0 2px 8px rgba(0, 0, 0, 0.2);
        user-select: none;
        backdrop-filter: blur(12px);
      }

      #tm-bookmark-selection-button > button {
        all: initial;
        box-sizing: border-box;
        padding: 8px 11px;
        color: #fff;
        font: 500 13px/1.2
          system-ui,
          -apple-system,
          BlinkMacSystemFont,
          "Segoe UI",
          sans-serif;
        cursor: pointer;
        user-select: none;
      }

      #tm-bookmark-selection-button > button + button {
        border-left: 1px solid rgba(255, 255, 255, 0.16);
      }

      #tm-bookmark-selection-button > button:hover {
        background: rgba(62, 62, 68, 0.98);
      }

      #tm-bookmark-selection-button > button:active {
        transform: translateY(1px);
      }

      #tm-bookmark-window {
        all: initial;
        position: fixed;
        z-index: 2147483646;
        top: 12px;
        left: calc(var(--sidebar-width, 340px) * 0.2);
        display: flex;
        width: min(var(--sidebar-width, 340px), calc(100vw - 36px));
        max-height: min(580px, calc(100vh - 120px));
        flex-direction: column;
        overflow: hidden;
        border: 1px solid rgba(127, 127, 127, 0.25);
        border-radius: 12px;
        background: rgba(248, 248, 250, 0.96);
        color: #1d1d1f;
        box-shadow:
          0 18px 55px rgba(0, 0, 0, 0.18),
          0 4px 14px rgba(0, 0, 0, 0.1);
        font-family:
          system-ui,
          -apple-system,
          BlinkMacSystemFont,
          "Segoe UI",
          sans-serif;
        backdrop-filter: blur(18px);
      }

      #tm-bookmark-window[data-collapsed="true"] {
        width: auto;
      }

      #tm-bookmark-window[data-collapsed="true"]
      .tm-bookmark-body {
        display: none;
      }

      .tm-bookmark-header {
        display: flex;
        min-height: 42px;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        box-sizing: border-box;
        padding: 8px 9px 8px 13px;
        border-bottom: 1px solid rgba(127, 127, 127, 0.18);
        cursor: move;
        user-select: none;
      }

      #tm-bookmark-window[data-collapsed="true"]
      .tm-bookmark-header {
        border-bottom: 0;
      }

      .tm-bookmark-title {
        overflow: hidden;
        font-size: 14px;
        font-weight: 650;
        line-height: 1.2;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .tm-bookmark-controls {
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .tm-bookmark-icon-button {
        all: unset;
        display: grid;
        width: 27px;
        height: 27px;
        place-items: center;
        border-radius: 7px;
        color: inherit;
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
      }

      .tm-bookmark-icon-button:hover {
        background: rgba(127, 127, 127, 0.14);
      }

      .tm-bookmark-body {
        min-height: 0;
        overflow: auto;
        overscroll-behavior: contain;
      }

      .tm-bookmark-list {
        display: flex;
        flex-direction: column;
        padding: 6px;
      }

      .tm-bookmark-empty {
        padding: 28px 18px;
        color: rgba(60, 60, 67, 0.6);
        font-size: 13px;
        text-align: center;
      }

      .tm-bookmark-item {
        display: flex;
        align-items: stretch;
        gap: 4px;
        border-radius: 8px;
      }

      .tm-bookmark-item:hover {
        background: rgba(127, 127, 127, 0.1);
      }

      .tm-bookmark-jump {
        all: unset;
        display: block;
        min-width: 0;
        flex: 1;
        box-sizing: border-box;
        padding: 9px 8px 9px 9px;
        cursor: pointer;
      }

      .tm-bookmark-item-text {
        display: -webkit-box;
        overflow: hidden;
        color: inherit;
        font-size: 13px;
        font-weight: 500;
        line-height: 1.42;
        overflow-wrap: anywhere;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 3;
      }

      .tm-bookmark-item-meta {
        margin-top: 4px;
        color: rgba(60, 60, 67, 0.55);
        font-size: 10px;
        line-height: 1.2;
      }

      .tm-bookmark-reply-jump,
      .tm-bookmark-delete {
        all: unset;
        align-self: center;
        display: grid;
        width: 28px;
        height: 28px;
        flex: 0 0 auto;
        place-items: center;
        margin-right: 4px;
        border-radius: 7px;
        color: rgba(60, 60, 67, 0.55);
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
      }

      .tm-bookmark-reply-jump {
        margin-right: 0;
        color: rgba(37, 99, 235, 0.72);
        font-size: 17px;
      }

      .tm-bookmark-reply-jump:hover {
        background: rgba(37, 99, 235, 0.12);
        color: rgb(37, 99, 235);
      }

      .tm-bookmark-delete:hover {
        background: rgba(220, 38, 38, 0.12);
        color: rgb(190, 25, 25);
      }

      #tm-bookmark-toast {
        all: initial;
        position: fixed;
        z-index: 2147483647;
        left: 50%;
        top: 26px;
        box-sizing: border-box;
        max-width: min(420px, calc(100vw - 32px));
        padding: 9px 14px;
        transform: translate(-50%, 12px);
        border-radius: 9px;
        background: rgba(25, 25, 28, 0.94);
        color: #fff;
        opacity: 0;
        box-shadow: 0 10px 35px rgba(0, 0, 0, 0.25);
        font: 500 13px/1.4
          system-ui,
          -apple-system,
          BlinkMacSystemFont,
          "Segoe UI",
          sans-serif;
        pointer-events: none;
        transition:
          opacity 160ms ease,
          transform 160ms ease;
        backdrop-filter: blur(12px);
      }

      #tm-bookmark-toast.tm-bookmark-toast-visible {
        opacity: 1;
        transform: translate(-50%, 0);
      }

      #tm-bookmark-window.tm-bookmark-window-flash {
        animation: tm-bookmark-window-flash 500ms ease;
      }

      ::highlight(tm-bookmark-highlight) {
        background: rgba(255, 210, 40, 0.65);
        color: inherit;
      }

      ::highlight(tm-bookmark-persistent) {
        background: rgba(250, 204, 21, 0.25);
        color: inherit;
        text-decoration: underline rgba(234, 179, 8, 0.7) 1px;
        text-underline-offset: 2px;
      }

      ::highlight(tm-reply-persistent) {
        background: rgba(96, 165, 250, 0.22);
        color: inherit;
        text-decoration: underline rgba(59, 130, 246, 0.7) 1px;
        text-underline-offset: 2px;
      }

      @keyframes tm-bookmark-window-flash {
        0% {
          box-shadow:
            0 0 0 0 rgba(65, 120, 255, 0.45),
            0 18px 55px rgba(0, 0, 0, 0.18);
        }

        100% {
          box-shadow:
            0 0 0 12px rgba(65, 120, 255, 0),
            0 18px 55px rgba(0, 0, 0, 0.18);
        }
      }

      #tm-cloud-menu {
        all: initial;
        position: fixed;
        z-index: 2147483647;
        display: flex;
        min-width: 168px;
        flex-direction: column;
        box-sizing: border-box;
        padding: 5px;
        border: 1px solid rgba(127, 127, 127, 0.3);
        border-radius: 10px;
        background: rgba(248, 248, 250, 0.97);
        box-shadow: 0 12px 38px rgba(0, 0, 0, 0.24);
        font-family:
          system-ui,
          -apple-system,
          BlinkMacSystemFont,
          "Segoe UI",
          sans-serif;
        backdrop-filter: blur(14px);
      }

      #tm-cloud-menu > button {
        all: unset;
        box-sizing: border-box;
        padding: 7px 10px;
        border-radius: 7px;
        color: #1d1d1f;
        font-size: 12px;
        font-weight: 500;
        line-height: 1.3;
        text-align: left;
        cursor: pointer;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      #tm-cloud-menu > button:hover {
        background: rgba(37, 99, 235, 0.12);
        color: rgb(37, 99, 235);
      }

      @media (prefers-color-scheme: dark) {
        #tm-bookmark-window {
          border-color: rgba(255, 255, 255, 0.14);
          background: rgba(31, 31, 34, 0.94);
          color: rgba(255, 255, 255, 0.92);
        }

        .tm-bookmark-header {
          border-bottom-color: rgba(255, 255, 255, 0.1);
        }

        .tm-bookmark-empty,
        .tm-bookmark-item-meta,
        .tm-bookmark-delete {
          color: rgba(235, 235, 245, 0.55);
        }

        .tm-bookmark-item:hover,
        .tm-bookmark-icon-button:hover {
          background: rgba(255, 255, 255, 0.08);
        }

        .tm-bookmark-delete:hover {
          background: rgba(255, 70, 70, 0.15);
          color: rgb(255, 115, 115);
        }

        #tm-cloud-menu {
          border-color: rgba(255, 255, 255, 0.16);
          background: rgba(31, 31, 34, 0.97);
        }

        #tm-cloud-menu > button {
          color: rgba(255, 255, 255, 0.92);
        }

        #tm-cloud-menu > button:hover {
          background: rgba(79, 140, 255, 0.22);
          color: rgb(140, 175, 255);
        }
      }
    `;

    document.documentElement.appendChild(style);
  }
})();
