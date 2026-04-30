// approval-buttons.js — Hermes Web UI Approve/Deny buttons for tool approval
// v2: Rewritten for v0.5.3 DOM structure
(function() {
  'use strict';

  // Detect approval_required patterns in message text
  function hasApprovalContent(text) {
    if (!text || typeof text !== 'string') return false;
    const patterns = [
      /asking.*(?:for|your).*approval/i,
      /approval.*required/i,
      /需要.*(?:审批|批准|确认)/i,
      /请求.*(?:批准|授权)/i,
      /dangerous.*command/i,
      /blocked.*command/i,
      /\u26a0\ufe0f/,
      /请.*确认.*操作/,
      /是否.*允许/,
      /approve|deny/i,
    ];
    return patterns.some(function(p) { return p.test(text); });
  }

  // Send a command (/approve or /deny) through the chat
  function sendApprovalCommand(cmd) {
    var textarea = document.querySelector('textarea.input-textarea');
    if (!textarea) {
      console.warn('[ApprovalButtons] No textarea found');
      return;
    }

    // Set value using native setter so Vue picks it up
    var nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    ).set;
    nativeSetter.call(textarea, cmd);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    // Click the send button after a short delay
    setTimeout(function() {
      var sendBtn = document.querySelector(
        '.n-button--primary-type, ' +
        'button[class*="send"], ' +
        '[aria-label*="send" i], [aria-label*="\u53d1\u9001" i]'
      );
      if (sendBtn && !sendBtn.disabled && !sendBtn.classList.contains('n-button--disabled')) {
        sendBtn.click();
      } else {
        // Fallback: Enter key
        textarea.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', bubbles: true, cancelable: true
        }));
      }
    }, 150);
  }

  // Add Approve/Deny buttons to a message
  function addButtonsToMessage(msgBubble) {
    // Don't add if already there
    if (msgBubble.querySelector('.hermes-approval-bar')) return;

    var markdown = msgBubble.querySelector('.markdown-body');
    if (!markdown) return;

    var text = markdown.textContent || '';
    if (!hasApprovalContent(text)) return;

    // Create button bar
    var bar = document.createElement('div');
    bar.className = 'hermes-approval-bar';
    bar.style.cssText =
      'display:flex;gap:10px;margin-top:10px;margin-bottom:4px;align-items:center;';

    // Approve button
    var approveBtn = document.createElement('button');
    approveBtn.className = 'hermes-approve-btn';
    approveBtn.textContent = '\u2713 Approve';
    approveBtn.style.cssText =
      'padding:6px 20px;border:1px solid #22c55e;border-radius:8px;background:#22c55e;' +
      'color:#fff;cursor:pointer;font-size:13px;font-weight:600;transition:all .15s;';
    approveBtn.onmouseenter = function() { this.style.background = '#16a34a'; };
    approveBtn.onmouseleave = function() { this.style.background = '#22c55e'; };
    approveBtn.onclick = function(e) {
      e.stopPropagation();
      e.preventDefault();
      sendApprovalCommand('/approve');
    };

    // Deny button
    var denyBtn = document.createElement('button');
    denyBtn.className = 'hermes-deny-btn';
    denyBtn.textContent = '\u2715 Deny';
    denyBtn.style.cssText =
      'padding:6px 20px;border:1px solid #ef4444;border-radius:8px;background:#ef4444;' +
      'color:#fff;cursor:pointer;font-size:13px;font-weight:600;transition:all .15s;';
    denyBtn.onmouseenter = function() { this.style.background = '#dc2626'; };
    denyBtn.onmouseleave = function() { this.style.background = '#ef4444'; };
    denyBtn.onclick = function(e) {
      e.stopPropagation();
      e.preventDefault();
      sendApprovalCommand('/deny');
    };

    bar.appendChild(approveBtn);
    bar.appendChild(denyBtn);
    msgBubble.appendChild(bar);

    console.log('[ApprovalButtons] \u2705 Added Approve/Deny buttons');
  }

  // Scan all assistant messages for approval content
  function scanMessages() {
    try {
      var bubbles = document.querySelectorAll('.message.assistant .message-bubble');
      bubbles.forEach(addButtonsToMessage);
    } catch(e) {
      // Silently ignore
    }
  }

  // Watch for new messages via MutationObserver
  function startObserver() {
    var target = document.querySelector('.message-list') ||
                 document.querySelector('.chat-main') ||
                 document.querySelector('#app');
    if (!target) {
      console.warn('[ApprovalButtons] No chat container found, retrying...');
      setTimeout(startObserver, 2000);
      return;
    }

    var observer = new MutationObserver(function() {
      scanMessages();
    });

    observer.observe(target, {
      childList: true,
      subtree: true,
      characterData: true
    });

    console.log('[ApprovalButtons] \u2705 Observer started on', target.className);
  }

  // Initialize
  function init() {
    if (document.getElementById('hermes-approval-init')) return;
    var marker = document.createElement('meta');
    marker.id = 'hermes-approval-init';
    document.head.appendChild(marker);

    var attempts = 0;
    var interval = setInterval(function() {
      attempts++;
      var chatArea = document.querySelector('.message-list');
      if (chatArea || attempts > 30) {
        clearInterval(interval);
        if (chatArea) {
          startObserver();
          // Scan multiple times for delayed rendering
          setTimeout(scanMessages, 500);
          setTimeout(scanMessages, 1500);
          setTimeout(scanMessages, 3000);
        } else {
          console.warn('[ApprovalButtons] Chat area not found');
        }
      }
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
