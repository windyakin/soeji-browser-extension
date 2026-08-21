// Content script for NAI - Soeji Uploader

// Use browser API if available (Firefox), otherwise chrome (Chrome)
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// NAI DOM selectors (no sc-* class dependency).
// See docs/nai-history-dom-behavior.md for details.
const SELECTORS = {
  viewerBar: '.display-grid-bottom',
  canvasTile: '.image-gen-canvas-tile',
  tileImage: 'img.image-grid-image',
  tileIncoming: 'img.image-grid-image-incoming, .image-grid-thumbnail-standin',
  tileSaveBar: '.image-gen-save-bar',
  historyRoot: '#historyContainer',
  historyItem: '[role="button"][aria-label="choose image"]',
  historyDeleteButton: 'button[aria-label="delete image(s)"]'
};

class SoejiUploader {
  constructor() {
    this.observer = null; // MutationObserver on document.body (button injection / state refresh)
    this.historyObserver = null; // MutationObserver on #historyContainer (badge sync / selection change)
    this.processTimeout = null;
    this.historySyncTimeout = null;
    this.stateInterval = null; // periodic safety-net refresh of the button state
    this.config = null;
    // Upload queue management
    this.uploadQueue = []; // { id, blobUrl, historyKey, status }
    this.currentBatchHasError = false; // Track if any error occurred in current batch
    this.resultBadgeTimeout = null; // Timer ID for hiding result badge
    // Store button reference for badge updates (single shared button in the viewer bar)
    this.currentButton = null;
    // History item tracking - Map-based centralized management
    // Key: historyKey (data-group-id of the history item, bgHash fallback), Value: { status }
    // - status: 'pending'|'uploading'|'success'|'duplicate'|'error'|'hidden'
    this.history = new Map();
    this.historyBadgeTimeouts = new Map(); // historyKey -> timeout ID (for auto-hide)
    this.init();
  }

  async init() {
    console.log('[Soeji] Content script loaded');

    // Get configuration from background script
    await this.loadConfig();

    // Listen for configuration changes from popup
    browserAPI.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local') {
        this.handleConfigChange(changes);
      }
    });

    if (!this.config) {
      console.log('[Soeji] Extension not configured. Click the extension icon to set up.');
      return;
    }

    console.log('[Soeji] Extension initialized');
    this.start();
  }

  start() {
    // Inject button into the viewer bar if it already exists
    this.refresh();

    // Watch for DOM changes (NAI uses dynamic rendering)
    this.startObserver();

    // Watch for history container changes (badge sync / selection change)
    this.startHistoryObserver();

    // Safety net: NAI may change image state without a mutation we observe
    if (!this.stateInterval) {
      this.stateInterval = setInterval(() => this.updateButtonState(), 2000);
    }
  }

  async loadConfig() {
    const response = await this.sendMessage({ type: 'GET_CONFIG' });
    console.log('[Soeji] Configuration:', response);

    if (response.configured) {
      this.config = {
        backendUrl: response.backendUrl,
        apiKey: response.apiKey
      };
    } else {
      this.config = null;
    }
  }

  handleConfigChange(changes) {
    console.log('[Soeji] Configuration changed:', changes);

    // Update config with changed values
    if (changes.backendUrl) {
      if (!this.config) {
        this.config = { backendUrl: '', apiKey: '' };
      }
      this.config.backendUrl = changes.backendUrl.newValue || '';
    }
    if (changes.apiKey) {
      if (!this.config) {
        this.config = { backendUrl: '', apiKey: '' };
      }
      this.config.apiKey = changes.apiKey.newValue || '';
    }

    // If config was previously null and now has backendUrl, initialize
    if (this.config && this.config.backendUrl && !this.observer) {
      console.log('[Soeji] Configuration updated, starting observer');
      this.start();
    }
  }

  async sendMessage(message) {
    try {
      // Chrome MV3 and Firefox both support promise-based sendMessage
      const response = await browserAPI.runtime.sendMessage(message);
      return response || {};
    } catch (error) {
      console.error('[Soeji] Message error:', error);
      return {};
    }
  }

  // ---------------------------------------------------------------------------
  // Observers
  // ---------------------------------------------------------------------------

  refresh() {
    this.injectButton();
    this.updateButtonState();
  }

  startObserver() {
    this.observer = new MutationObserver((mutations) => {
      let relevant = false;
      for (const mutation of mutations) {
        // Ignore mutations on our own elements (button / badges) to avoid feedback loops
        const target = mutation.target;
        if (target.nodeType === Node.ELEMENT_NODE && target.closest('.soeji-button-wrapper, .soeji-history-badge')) continue;
        if (mutation.type === 'attributes' || mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0) {
          relevant = true;
          break;
        }
      }
      if (relevant) {
        // Debounce to avoid excessive processing
        clearTimeout(this.processTimeout);
        this.processTimeout = setTimeout(() => this.refresh(), 100);
      }
    });

    // childList: viewer bar / tiles / images added or removed
    // attributes(class, src): image state changes without node changes
    //   (e.g. incoming -> finished is a class/src swap on the same <img>, which happens
    //   on the first generation after page load)
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'src']
    });
  }

  startHistoryObserver() {
    const root = document.querySelector(SELECTORS.historyRoot);
    if (!root) {
      // Retry after a short delay if container not found yet
      setTimeout(() => this.startHistoryObserver(), 500);
      return;
    }

    this.historyObserver = new MutationObserver((mutations) => {
      // Ignore mutations caused by our own badge insert/remove to avoid feedback loops
      const relevant = mutations.some((mutation) => {
        if (mutation.type === 'attributes') return true;
        const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
        return nodes.some((node) => !(node.nodeType === Node.ELEMENT_NODE && node.classList.contains('soeji-history-badge')));
      });
      if (!relevant) return;

      clearTimeout(this.historySyncTimeout);
      this.historySyncTimeout = setTimeout(() => {
        this.syncHistoryBadges();
        this.updateButtonState();
      }, 50);
    });

    // childList: items added (prepended) / removed
    // attributes(class): selection change (styled-components swaps the class)
    this.historyObserver.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class']
    });

    console.log('[Soeji] History observer started');
  }

  // ---------------------------------------------------------------------------
  // Upload button injection (viewer bar)
  // ---------------------------------------------------------------------------

  injectButton() {
    const container = this.findButtonContainer();
    if (!container) return;

    // Already injected in this container
    if (container.querySelector('.soeji-button-wrapper')) return;

    console.log('[Soeji] Injecting upload button');

    // Create a wrapper div to match NAI's structure: <div style="height: 100%"><button>...</button></div>
    const wrapper = document.createElement('div');
    wrapper.style.height = '100%';
    wrapper.className = 'soeji-button-wrapper';

    // Create upload button matching NAI's button style
    const button = document.createElement('button');
    const existingBtn = container.querySelector('div[style*="height: 100%"] > button');
    button.className = existingBtn ? existingBtn.className + ' soeji-upload-btn' : 'soeji-upload-btn';
    button.title = 'Upload to Soeji';
    button.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleUpload();
    };

    // Create progress badge (top-right)
    const progressBadge = document.createElement('span');
    progressBadge.className = 'soeji-badge soeji-badge-hidden';
    button.appendChild(progressBadge);

    // Create queue count badge (bottom-right)
    const queueBadge = document.createElement('span');
    queueBadge.className = 'soeji-queue-badge soeji-queue-badge-hidden';
    button.appendChild(queueBadge);

    wrapper.appendChild(button);
    container.appendChild(wrapper);

    // Store button reference for badge updates, restore badges (bar may have been re-rendered)
    this.currentButton = button;
    this.updateBadges();
    this.updateButtonState();
  }

  findButtonContainer() {
    // NAI DOM structure (inside .display-grid-bottom > ... > .image-gen-viewer-bar):
    //   [0] measurement copy of the bar (visibility: hidden) - must be skipped
    //   [1] visible bar
    //        left : size / settings / seed button
    //        right: <div>                                   <-- button container we want
    //                 <div style="height: 100%;"><button>pin</button></div>
    //                 <div style="height: 100%;"><button>copy</button></div>
    //                 <div style="height: 100%;"><button>save</button></div>
    //               </div>
    // We look for a visible div that directly contains 2+ "div[height:100%] > button" children.
    const bar = document.querySelector(SELECTORS.viewerBar);
    if (!bar) return null;

    for (const div of bar.querySelectorAll('div')) {
      if (window.getComputedStyle(div).visibility === 'hidden') continue;

      let buttonCount = 0;
      for (const child of div.children) {
        if (child.tagName !== 'DIV') continue;
        const style = child.getAttribute('style') || '';
        if (!style.includes('height: 100%')) continue;
        if (!child.querySelector(':scope > button')) continue;
        buttonCount++;
      }
      if (buttonCount >= 2) return div;
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Canvas tiles (displayed images)
  // ---------------------------------------------------------------------------

  getTiles() {
    return Array.from(document.querySelectorAll(SELECTORS.canvasTile));
  }

  // The selected (current) tile is the only tile WITHOUT the hover save bar overlay.
  // Non-selected tiles have .image-gen-save-bar (pin/copy/save) as an overlay.
  getSelectedTile() {
    const candidates = this.getTiles().filter((tile) => !tile.querySelector(SELECTORS.tileSaveBar));
    if (candidates.length === 1) return candidates[0];
    if (candidates.length === 0) return null;

    // Ambiguous (e.g. transient state during generation): prefer a tile with a finished image
    const finished = candidates.filter((tile) => this.getTileImage(tile) && !this.isGenerating(tile));
    if (finished.length === 1) return finished[0];

    console.log('[Soeji] Ambiguous selected tile, candidates:', candidates.length);
    return null;
  }

  getTileImage(tile) {
    return tile ? tile.querySelector(SELECTORS.tileImage) : null;
  }

  isGenerating(tile) {
    // While generating, the tile holds a stand-in thumbnail and an "incoming" image
    if (tile && tile.querySelector(SELECTORS.tileIncoming)) return true;
    // Also treat the whole canvas as generating if any incoming image exists
    return document.querySelector(SELECTORS.tileIncoming) !== null;
  }

  // ---------------------------------------------------------------------------
  // History items
  // ---------------------------------------------------------------------------

  getHistoryItems() {
    const root = document.querySelector(SELECTORS.historyRoot);
    if (!root) return [];
    return Array.from(root.querySelectorAll(SELECTORS.historyItem));
  }

  // Selected history item has a box-shadow highlight; non-selected items have none
  getSelectedHistoryItem() {
    for (const item of this.getHistoryItems()) {
      const boxShadow = window.getComputedStyle(item).boxShadow;
      if (boxShadow && boxShadow !== 'none') return item;
    }
    return null;
  }

  // Stable identity of a history item: data-group-id (UUID), bgHash fallback
  getHistoryKey(item) {
    if (!item) return null;
    return item.getAttribute('data-group-id') || this.getBackgroundImageHash(item);
  }

  getSelectedHistoryKey() {
    return this.getHistoryKey(this.getSelectedHistoryItem());
  }

  getBackgroundImageHash(element) {
    // Hash the entire background-image style (including base64 data)
    const style = window.getComputedStyle(element);
    const bgImage = style.backgroundImage;
    if (!bgImage || bgImage === 'none') return null;
    return this.hashString(bgImage);
  }

  hashString(str) {
    // djb2 hash algorithm - produces short, consistent hash
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    }
    // Convert to unsigned 32-bit and then to hex string (8 chars)
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  // ---------------------------------------------------------------------------
  // Button state / badges
  // ---------------------------------------------------------------------------

  // Keep NAI's styled-components classes on our button in sync with a sibling NAI button.
  // NAI swaps these classes by state (e.g. dimmed variant while no image is shown), and the
  // classes copied at injection time may be the dimmed ones.
  syncButtonClasses(button) {
    const wrapper = button.closest('.soeji-button-wrapper');
    const container = wrapper ? wrapper.parentElement : null;
    if (!container) return;

    const reference = container.querySelector('div[style*="height: 100%"] > button:not(.soeji-upload-btn)');
    if (!reference) return;

    const naiClasses = reference.className.split(' ').filter(Boolean);
    const ownClasses = Array.from(button.classList).filter((c) => c.startsWith('soeji-'));
    const desired = [...naiClasses, ...ownClasses].join(' ');
    if (button.className !== desired) {
      button.className = desired;
    }
  }

  updateButtonState() {
    const button = this.currentButton;
    if (!button || !button.isConnected) return;

    this.syncButtonClasses(button);

    const tile = this.getSelectedTile();
    const image = this.getTileImage(tile);

    if (!tile || !image || this.isGenerating(tile)) {
      button.disabled = true;
      button.classList.add('soeji-disabled');
      button.classList.remove('soeji-uploaded');
      button.title = this.isGenerating(tile) ? 'Image is generating...' : 'No image selected';
      return;
    }

    button.disabled = false;
    button.classList.remove('soeji-disabled');
    button.title = 'Upload to Soeji';

    // Uploaded state (selected history item is tracked in history Map)
    const historyKey = this.getSelectedHistoryKey();
    if (historyKey && this.history.has(historyKey)) {
      button.classList.add('soeji-uploaded');
    } else {
      button.classList.remove('soeji-uploaded');
    }
  }

  updateBadges() {
    if (!this.currentButton) return;

    const progressBadge = this.currentButton.querySelector('.soeji-badge');
    const queueBadge = this.currentButton.querySelector('.soeji-queue-badge');

    if (!progressBadge || !queueBadge) return;

    const uploadingCount = this.uploadQueue.filter(i => i.status === 'uploading').length;
    const pendingCount = this.uploadQueue.filter(i => i.status === 'pending').length;
    const totalActive = uploadingCount + pendingCount;

    // Update queue count badge (bottom-right)
    if (totalActive > 0) {
      queueBadge.textContent = totalActive.toString();
      queueBadge.classList.remove('soeji-queue-badge-hidden');
    } else {
      queueBadge.classList.add('soeji-queue-badge-hidden');
    }

    // Update progress badge (top-right) - show spinner if uploading
    if (uploadingCount > 0 || pendingCount > 0) {
      // Clear any pending result badge timeout
      if (this.resultBadgeTimeout) {
        clearTimeout(this.resultBadgeTimeout);
        this.resultBadgeTimeout = null;
      }
      this.showProgressBadge(progressBadge, 'uploading');
    }
  }

  showProgressBadge(badge, state) {
    // Remove all state classes
    badge.classList.remove('soeji-badge-hidden', 'soeji-badge-uploading', 'soeji-badge-success', 'soeji-badge-error');

    if (state === 'uploading') {
      badge.classList.add('soeji-badge-uploading');
      // Clear text and add spinner
      badge.textContent = '';
      const spinner = document.createElement('span');
      spinner.className = 'soeji-spinner';
      badge.appendChild(spinner);
    } else if (state === 'success') {
      badge.classList.add('soeji-badge-success');
      badge.textContent = '✓';
    } else if (state === 'error') {
      badge.classList.add('soeji-badge-error');
      badge.textContent = '!';
    } else {
      badge.classList.add('soeji-badge-hidden');
      badge.textContent = '';
    }
  }

  // Sync history badges with current history Map state.
  // Called whenever history state changes or the history DOM changes.
  syncHistoryBadges() {
    for (const item of this.getHistoryItems()) {
      const key = this.getHistoryKey(item);
      const data = key ? this.history.get(key) : null;
      const desiredState = data && data.status !== 'hidden' ? data.status : null;

      // Only touch the DOM when the badge state actually changes
      const existingBadge = item.querySelector('.soeji-history-badge');
      const existingState = existingBadge ? existingBadge.dataset.state : null;
      if (existingState !== desiredState) {
        if (existingBadge) existingBadge.remove();
        if (desiredState) this.createHistoryBadge(item, desiredState);
      }

      // Disable delete button while uploading/pending
      const deleteBtn = item.querySelector(SELECTORS.historyDeleteButton);
      if (deleteBtn) {
        const isUploading = !!data && (data.status === 'uploading' || data.status === 'pending');
        if (deleteBtn.disabled !== isUploading) {
          deleteBtn.disabled = isUploading;
          deleteBtn.style.opacity = isUploading ? '0.3' : '';
          deleteBtn.style.pointerEvents = isUploading ? 'none' : '';
        }
      }
    }
  }

  // Create a badge on a history element with the given state
  createHistoryBadge(historyElement, state) {
    // Ensure history element has position: relative for absolute positioning
    const computedStyle = window.getComputedStyle(historyElement);
    if (computedStyle.position === 'static') {
      historyElement.style.position = 'relative';
    }

    // Create new badge
    const badge = document.createElement('span');
    badge.className = 'soeji-history-badge';
    badge.dataset.state = state;

    if (state === 'uploading' || state === 'pending') {
      badge.classList.add('soeji-history-badge-uploading');
      const spinner = document.createElement('span');
      spinner.className = 'soeji-spinner';
      badge.appendChild(spinner);
    } else if (state === 'success') {
      badge.classList.add('soeji-history-badge-success');
    } else if (state === 'duplicate') {
      badge.classList.add('soeji-history-badge-duplicate');
    } else if (state === 'error') {
      badge.classList.add('soeji-history-badge-error');
    } else {
      badge.classList.add('soeji-history-badge-hidden');
    }

    historyElement.appendChild(badge);
  }

  // Update history item status and sync badges
  updateHistoryStatus(historyKey, status) {
    // Clear any existing timeout for this key
    const existingTimeout = this.historyBadgeTimeouts.get(historyKey);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      this.historyBadgeTimeouts.delete(historyKey);
    }

    // Update status in history Map
    this.history.set(historyKey, { status });

    // Sync badges and button state
    this.syncHistoryBadges();
    this.updateButtonState();

    // Set auto-hide timeout for success/duplicate
    if (status === 'success' || status === 'duplicate') {
      const timeout = setTimeout(() => {
        if (this.history.has(historyKey)) {
          this.history.set(historyKey, { status: 'hidden' });
        }
        this.historyBadgeTimeouts.delete(historyKey);
        this.syncHistoryBadges();
      }, 3000);
      this.historyBadgeTimeouts.set(historyKey, timeout);
    }
  }

  showResultStatus() {
    if (!this.currentButton) return;

    const progressBadge = this.currentButton.querySelector('.soeji-badge');
    if (!progressBadge) return;

    // Show result based on whether there were errors
    if (this.currentBatchHasError) {
      this.showProgressBadge(progressBadge, 'error');
      this.currentButton.title = 'Some uploads failed';
    } else {
      this.showProgressBadge(progressBadge, 'success');
      this.currentButton.title = 'All uploads completed';
    }

    // Reset error flag for next batch
    this.currentBatchHasError = false;

    // Hide badge after 3 seconds
    this.resultBadgeTimeout = setTimeout(() => {
      this.showProgressBadge(progressBadge, 'hidden');
      this.currentButton.title = 'Upload to Soeji';
      this.resultBadgeTimeout = null;
    }, 3000);
  }

  // ---------------------------------------------------------------------------
  // Upload queue
  // ---------------------------------------------------------------------------

  handleUpload() {
    // Resolve the currently selected image at click time (the viewer bar is shared by all tiles)
    const tile = this.getSelectedTile();
    const image = this.getTileImage(tile);
    if (!tile || !image) {
      console.log('[Soeji] No selected image found');
      return;
    }

    // Skip images still being generated
    if (this.isGenerating(tile)) {
      console.log('[Soeji] Skipping generating image');
      return;
    }

    const blobUrl = image.currentSrc || image.src;

    // Identify the selected history item for state tracking
    const historyKey = this.getSelectedHistoryKey();
    console.log('[Soeji] Selected history key:', historyKey);

    // Check if this image is already in the queue (uploading or pending)
    if (historyKey) {
      const isInQueue = this.uploadQueue.some(item => item.historyKey === historyKey);
      if (isInQueue) {
        console.log('[Soeji] Image already in queue:', historyKey);
        return;
      }
    }

    // Add to history map with pending status
    if (historyKey) {
      this.updateHistoryStatus(historyKey, 'pending');
    }

    // Create queue item
    const queueItem = {
      id: crypto.randomUUID(),
      blobUrl: blobUrl,
      historyKey: historyKey,
      status: 'pending'
    };

    // Add to queue
    this.uploadQueue.push(queueItem);
    console.log('[Soeji] Added to queue:', queueItem.id, 'Queue length:', this.uploadQueue.length);

    // Update badges and process queue
    this.updateBadges();
    this.processQueue();
  }

  processQueue() {
    // Find a pending item to process
    const pendingItem = this.uploadQueue.find(item => item.status === 'pending');
    if (!pendingItem) {
      return;
    }

    // Check if we already have an uploading item (process one at a time for simplicity)
    const uploadingItem = this.uploadQueue.find(item => item.status === 'uploading');
    if (uploadingItem) {
      return;
    }

    // Start uploading
    pendingItem.status = 'uploading';
    this.updateBadges();
    this.executeUpload(pendingItem);
  }

  async executeUpload(item) {
    // Update history status to uploading
    if (item.historyKey) {
      this.updateHistoryStatus(item.historyKey, 'uploading');
    }

    try {
      // Extract image blob from blob URL
      const blob = await this.extractImageBlob(item.blobUrl);

      // Upload directly to backend (CORS is configured on backend)
      const result = await this.uploadToBackend(blob);

      if (result.success) {
        if (result.duplicate) {
          item.status = 'duplicate';
          console.log('[Soeji] Duplicate:', item.id);
          if (item.historyKey) {
            this.updateHistoryStatus(item.historyKey, 'duplicate');
          }
        } else {
          item.status = 'success';
          console.log('[Soeji] Success:', item.id);
          if (item.historyKey) {
            this.updateHistoryStatus(item.historyKey, 'success');
          }
        }
      } else {
        item.status = 'error';
        this.currentBatchHasError = true;
        if (item.historyKey) {
          this.updateHistoryStatus(item.historyKey, 'error');
        }
        console.log('[Soeji] Error:', item.id, result.error);
      }
    } catch (error) {
      console.error('[Soeji] Upload error:', error);
      item.status = 'error';
      this.currentBatchHasError = true;
      if (item.historyKey) {
        this.updateHistoryStatus(item.historyKey, 'error');
      }
    }

    // Remove completed item from queue
    const index = this.uploadQueue.findIndex(i => i.id === item.id);
    if (index !== -1) {
      this.uploadQueue.splice(index, 1);
    }

    // Update badges
    this.updateBadges();

    // Check if queue is empty
    const hasActiveItems = this.uploadQueue.some(i => i.status === 'uploading' || i.status === 'pending');
    if (!hasActiveItems) {
      // Queue is complete, show result status
      this.showResultStatus();
    } else {
      // Process next item
      this.processQueue();
    }
  }

  async uploadToBackend(blob) {
    const formData = new FormData();
    formData.append('file', blob, this.generateFilename());

    const headers = {};
    if (this.config.apiKey) {
      headers['X-Watcher-Key'] = this.config.apiKey;
    }

    const response = await fetch(`${this.config.backendUrl}/api/upload`, {
      method: 'POST',
      headers,
      body: formData
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || `HTTP ${response.status}`);
    }

    return {
      success: true,
      duplicate: result.duplicate || false,
      image: result.image || result.existingImage
    };
  }

  async extractImageBlob(blobUrl) {
    if (blobUrl.startsWith('blob:')) {
      const response = await fetch(blobUrl);
      const blob = await response.blob();

      // Verify it's a PNG
      const arrayBuffer = await blob.slice(0, 8).arrayBuffer();
      const signature = new Uint8Array(arrayBuffer);
      const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      const isPng = pngSignature.every((byte, i) => signature[i] === byte);

      if (!isPng) {
        throw new Error('Not a PNG file');
      }

      return blob;
    }

    throw new Error('Could not extract image data (not a blob URL)');
  }

  generateFilename() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `NAI_${timestamp}.png`;
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new SoejiUploader());
} else {
  new SoejiUploader();
}
