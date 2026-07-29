// ==UserScript==
// @name         ChatGPT Web Enhanced: Copy & Bookmark
// @namespace    https://831.moe/
// @version      0.6.6
// @description  Copy selected text as Markdown, bookmark selections, and jump to them later. Works on ChatGPT Web.
// @author       cgluWxh
// @match        https://chat.openai.com/*
// @match        https://chatgpt.com/*
// @match        https://www.chatgpt.com/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/cgluWxh/GPTWeb-Enhanced/main/GPTWeb-Enhanced.user.js
// ==/UserScript==

(() => {
  'use strict';

  const SCROLL_ROOT_SELECTOR = 'div[data-scroll-root]';
  const STORAGE_PREFIX = 'tm-text-bookmarks:';
  const DATA_VERSION_KEY = `${STORAGE_PREFIX}data-version`;
  const DATA_VERSION = 1;
  const MESSAGE_SELECTOR = '[data-message-id]';
  const IGNORED_TEXT_SELECTOR = [
    'script', 'style', 'noscript', 'textarea', 'input', 'select',
    'button', 'svg', '[aria-hidden="true"]', '.select-none',
    // KaTeX renders the same formula twice. Keep the visible .katex-html only.
    '.katex-mathml',
  ].join(',');

  const MAX_TITLE_LENGTH = 100;
  const CONTEXT_LENGTH = 80;

  migrateBookmarkData();

  let currentUrlKey = getUrlKey();
  let bookmarks = loadBookmarks(currentUrlKey);
  let pendingSelection = null;

  let bookmarkButton = null;
  let bookmarkWindow = null;
  let bookmarkList = null;
  let emptyMessage = null;

  let highlightCleanupTimer = null;
  let autoExpandTimer = null;
  const replyTurnMonitorTimers = new Set();

  init();

  function init() {
    injectStyles();
    createBookmarkButton();
    createBookmarkWindow();

    document.addEventListener('mouseup', handleSelectionEnd, true);
    document.addEventListener('keyup', handleKeyboardSelection, true);
    document.addEventListener('mousedown', handleDocumentMouseDown, true);
    document.addEventListener('selectionchange', handleSelectionChange);
    document.addEventListener('copy', handleGlobalCopy, true);
    installUrlChangeListener();

    renderBookmarks();
    syncWindowCollapsedAfterUrlSettles();
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
      .querySelector('annotation[encoding="application/x-tex"]')
      ?.textContent
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
      if (replyContent) {
        existingBookmark.replyContent = replyContent.trim();
        existingBookmark.replyTurnID = replyTurnID;
      }
      bookmarks.unshift(existingBookmark);
      saveBookmarks();
      renderBookmarks();

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

      text: selectionInfo.text,
      formulaLatex: selectionInfo.formulaLatex,
      replyContent: replyContent.trim() || null,
      turnID: selectionInfo.turnID,
      replyTurnID,

      rootIndex: selectionInfo.rootIndex,

      start: selectionInfo.start,
      end: selectionInfo.end,

      prefix: selectionInfo.prefix,
      suffix: selectionInfo.suffix,
      messageId: selectionInfo.messageId,
      messageRole: selectionInfo.messageRole,
      messageStart: selectionInfo.messageStart,
      messageEnd: selectionInfo.messageEnd,

      startPath: selectionInfo.startPath,
      startOffset: selectionInfo.startOffset,
      endPath: selectionInfo.endPath,
      endOffset: selectionInfo.endOffset,
    };

    bookmarks.unshift(bookmark);
    saveBookmarks();
    renderBookmarks();

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

  function jumpToBookmark(bookmark) {
    discardInvalidTurnID(bookmark, 'turnID');

    if (isValidTurnID(bookmark.turnID)) {
      const turnContainer = findTurnContainer(bookmark.turnID);

      if (!turnContainer) {
        showToast('Cannot find the corresponding Turn, content may not be loaded yet');
        return;
      }

      turnContainer.scrollIntoView({
        behavior: 'instant',
        block: 'center',
      });
      setTimeout(() => performBookmarkJump(bookmark, true), 100);
      return;
    }

    performBookmarkJump(bookmark, false);
  }

  function performBookmarkJump(bookmark, retryOnFailure) {
    const scrollRoot = resolveScrollRoot(bookmark);

    if (!scrollRoot) {
      showToast('Cannot find data-scroll-root');
      return;
    }

    const range = locateBookmarkRange(scrollRoot, bookmark);

    if (!range) {
      if (retryOnFailure) {
        setTimeout(() => performBookmarkJump(bookmark, false), 500);
        return;
      }
      showToast('Cannot find this text, the page content may have changed');
      return;
    }

    const targetElement = getParentElement(range.startContainer);

    if (!targetElement) {
      showToast('Cannot locate the target element, the page content may have changed');
      return;
    }

    backfillTurnID(bookmark, 'turnID', targetElement);
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
  }

  function jumpToReply(bookmark) {
    const replyContent = normalizeText(bookmark.replyContent);

    if (!replyContent) {
      showToast('Cannot find the Reply content for this Bookmark');
      return;
    }

    discardInvalidTurnID(bookmark, 'replyTurnID');

    if (isValidTurnID(bookmark.replyTurnID)) {
      const turnContainer = findTurnContainer(bookmark.replyTurnID);

      if (!turnContainer) {
        showToast('Cannot find the corresponding Reply Turn, content may not be loaded yet');
        return;
      }

      turnContainer.scrollIntoView({
        behavior: 'instant',
        block: 'center',
      });
      setTimeout(() => {
        if (!performReplyJump(bookmark, turnContainer, false)) {
          setTimeout(() => {
            const freshTurn = findTurnContainer(bookmark.replyTurnID);
            performReplyJump(bookmark, freshTurn, true);
          }, 500);
        }
      }, 100);
      return;
    }

    performReplyJump(bookmark, document, true);
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

    backfillTurnID(bookmark, 'replyTurnID', targetMessage);

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

  function backfillTurnID(bookmark, field, targetElement) {
    if (isValidTurnID(bookmark[field])) {
      return;
    }

    const turnID = getTurnIndex(targetElement);

    if (!isValidTurnID(turnID)) {
      delete bookmark[field];
      return;
    }

    bookmark[field] = turnID;
    saveBookmarks();
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
    return [...document.querySelectorAll(
      'div[data-turn-id-container]'
    )].filter(
      element =>
        element.getAttribute('data-turn-id-container') !==
        'client-created-root'
    );
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
      let replyTurnID = null;

      for (let index = newTurns.length - 1; index >= 0; index--) {
        const match = findReplyMatch(newTurns[index], replyContent);

        if (match) {
          replyTurnID = getTurnIndex(match.targetMessage);
          break;
        }
      }

      if (isValidTurnID(replyTurnID)) {
        createBookmarkFromPendingSelection(
          replyContent,
          selectionInfo,
          replyTurnID
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
        .querySelector('annotation[encoding="application/x-tex"]')
        ?.textContent?.trim();
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
          .querySelector('annotation[encoding="application/x-tex"]')
          ?.textContent?.trim();

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

    const controls = document.createElement('div');
    controls.className = 'tm-bookmark-controls';

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

    controls.appendChild(collapseButton);
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

      if (event.target.closest('button')) {
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

      handle.setPointerCapture?.(event.pointerId);
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

  function getStorageKey(urlKey = currentUrlKey) {
    return `${STORAGE_PREFIX}${urlKey}`;
  }

  function loadBookmarks(urlKey = currentUrlKey) {
    try {
      const parsed = JSON.parse(localStorage.getItem(getStorageKey(urlKey)));

      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveBookmarks() {
    try {
      localStorage.setItem(
        getStorageKey(),
        JSON.stringify(bookmarks)
      );
    } catch (error) {
      console.error('[Text Bookmarks] Save failed:', error);
      showToast('Bookmark save failed: localStorage error');
    }
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
      currentUrlKey = nextUrlKey;
      bookmarks = loadBookmarks(currentUrlKey);
      renderBookmarks();
      syncWindowCollapsedAfterUrlSettles();
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
      }
    `;

    document.documentElement.appendChild(style);
  }
})();
