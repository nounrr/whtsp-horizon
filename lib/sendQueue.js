'use strict';

const fs = require('fs');
const path = require('path');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toFiniteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

class RateLimitedQueue {
  constructor({
    name = 'queue',
    minIntervalMs = 0,
    maxPerWindow = Infinity,
    windowMs = 0,
    jitterMs = 0,
    longPauseChance = 0,
    longPauseMinMs = 0,
    longPauseMaxMs = 0,
    logger = console,
    storageFile = null, // Path to persist queue
    processor = null,   // Async function(item) -> result
  } = {}) {
    this.name = name;
    this.minIntervalMs = Math.max(0, toFiniteNumber(minIntervalMs, 0));
    this.maxPerWindow = toFiniteNumber(maxPerWindow, Infinity);
    if (!Number.isFinite(this.maxPerWindow) || this.maxPerWindow <= 0) this.maxPerWindow = Infinity;
    this.windowMs = Math.max(0, toFiniteNumber(windowMs, 0));
    this.jitterMs = Math.max(0, toFiniteNumber(jitterMs, 0));
    this.longPauseChance = Math.max(0, Math.min(1, toFiniteNumber(longPauseChance, 0)));
    this.longPauseMinMs = Math.max(0, toFiniteNumber(longPauseMinMs, 0));
    this.longPauseMaxMs = Math.max(this.longPauseMinMs, toFiniteNumber(longPauseMaxMs, this.longPauseMinMs));    this.batchSizeMin = Math.max(1, toFiniteNumber(process.env.WA_BATCH_SIZE_MIN, 10));    this.batchSizeMax = Math.max(this.batchSizeMin, toFiniteNumber(process.env.WA_BATCH_SIZE_MAX, 15));    this.batchPauseMinMs = Math.max(0, toFiniteNumber(process.env.WA_BATCH_PAUSE_MIN_MS, 30000));    this.batchPauseMaxMs = Math.max(this.batchPauseMinMs, toFiniteNumber(process.env.WA_BATCH_PAUSE_MAX_MS, 60000));    this.logger = logger || console;    this.storageFile = storageFile;
    this.processor = processor;

    this._queue = [];
    this._processing = false;
    this._lastStartAt = null;
    this._sentAt = [];

    this._enqueued = 0;
    this._processed = 0;
    this._failed = 0;

    // Load persisted queue if configured
    if (this.storageFile) {
      this._load();
    }
  }

  _load() {
    try {
      if (fs.existsSync(this.storageFile)) {
        const data = fs.readFileSync(this.storageFile, 'utf8');
        const items = JSON.parse(data);
        if (Array.isArray(items)) {
          // Add items back to queue (without promises attached yet)
          items.forEach(item => {
            this._queue.push({ 
              data: item.data, 
              meta: item.meta,
              // Create detached promise for this item since original caller is gone
              resolve: () => {}, 
              reject: (err) => this.logger.error(`[${this.name}] Failed restored item:`, err)
            });
          });
          this.logger.log(`[${this.name}] Restored ${items.length} items from ${this.storageFile}`);
          // Kick processing if we have items
          if (items.length > 0) setTimeout(() => this._kick(), 1000);
        }
      }
    } catch (e) {
      this.logger.error(`[${this.name}] Failed to load queue:`, e);
    }
  }

  _save() {
    if (!this.storageFile) return;
    try {
      // Only save data & meta, not functions/promises
      const items = this._queue.map(q => ({ data: q.data, meta: q.meta }));
      fs.writeFileSync(this.storageFile, JSON.stringify(items, null, 2));
    } catch (e) {
      this.logger.error(`[${this.name}] Failed to save queue:`, e);
    }
  }

  stats() {
    const now = Date.now();
    const recentSent = this._sentAt.filter((t) => (this.windowMs ? t > now - this.windowMs : true));
    return {
      name: this.name,
      queued: this._queue.length,
      processing: this._processing,
      enqueued: this._enqueued,
      processed: this._processed,
      failed: this._failed,
      minIntervalMs: this.minIntervalMs,
      maxPerWindow: this.maxPerWindow,
      windowMs: this.windowMs,
      jitterMs: this.jitterMs,
      longPauseChance: this.longPauseChance,
      longPauseMinMs: this.longPauseMinMs,
      longPauseMaxMs: this.longPauseMaxMs,
      sentInWindow: recentSent.length,
      isPersistent: !!this.storageFile
    };
  }

  /**
   * Add item to queue.
   * Usage 1: enqueue(fn, meta) - non-persistent, backward compatible
   * Usage 2: enqueue(data, meta) - persistent if storageFile & processor configured
   */
  enqueue(item, meta = {}) {
    this._enqueued++;

    return new Promise((resolve, reject) => {
      // If item is function, use it directly (legacy mode)
      // If item is data, wrapped in processor call
      const isFn = typeof item === 'function';
      
      this._queue.push({ 
        fn: isFn ? item : null, 
        data: isFn ? null : item,
        resolve, 
        reject, 
        meta 
      });
      
      if (this.storageFile && !isFn) {
        this._save();
      }
      
      this._kick();
    });
  }

  _kick() {
    if (this._processing) return;
    this._processing = true;
    this._run().catch((e) => {
      this._processing = false;
      this.logger?.error?.(`[${this.name}] queue runner crashed`, e);
    });
  }

  async _run() {
    while (this._queue.length > 0) {
      // Peek first
      const item = this._queue[0];
      if (!item) {
        this._queue.shift(); 
        continue;
      }

      try {
        await this._waitForSlot();
        this._lastStartAt = Date.now();
        
        // Execute
        let result;
        if (item.fn) {
           result = await item.fn();
        } else if (this.processor) {
           result = await this.processor(item.data);
        } else {
           throw new Error('No processor for data item');
        }

        this._processed++;
        this._recordSent();
        
        // Remove from queue ONLY after success
        this._queue.shift();
        if (this.storageFile && !item.fn) this._save();

        item.resolve(result);
      } catch (e) {
        this._failed++;
        
        // Remove from queue on error to prevent blocking? 
        // Or keep retrying? For now remove to avoid stuck queue.
        this._queue.shift();
        if (this.storageFile && !item.fn) this._save();
        
        item.reject(e);
      }
    }

    this._processing = false;
  }


  _recordSent() {
    const now = Date.now();
    this._sentAt.push(now);

    if (this.windowMs > 0) {
      const cutoff = now - this.windowMs;
      while (this._sentAt.length && this._sentAt[0] <= cutoff) {
        this._sentAt.shift();
      }
    }
  }

  async _waitForSlot() {
    const now = Date.now();

    let waitMs = 0;

    // Smooth sending with a minimum interval
    if (this._lastStartAt !== null && this.minIntervalMs > 0) {
      const since = now - this._lastStartAt;
      if (since < this.minIntervalMs) {
        waitMs = Math.max(waitMs, this.minIntervalMs - since);
      }
    }

    // Gestion de l'envoi par lot (Batch logic)
    if (!this._consecutiveSends) this._consecutiveSends = 0;
    if (!this._nextBatchSize) {
      const bMin = Math.max(1, toFiniteNumber(process.env.WA_BATCH_SIZE_MIN, 10));
      const bMax = Math.max(bMin, toFiniteNumber(process.env.WA_BATCH_SIZE_MAX, 15));
      this._nextBatchSize = bMin + Math.floor(Math.random() * (bMax - bMin + 1));
    }
    
    this._consecutiveSends++;
    
    // Si on a atteint la limite du lot, on impose la pause longue
    if (this._consecutiveSends >= this._nextBatchSize) {
      const pMin = Math.max(0, toFiniteNumber(process.env.WA_BATCH_PAUSE_MIN_MS, 30000));
      const pMax = Math.max(pMin, toFiniteNumber(process.env.WA_BATCH_PAUSE_MAX_MS, 60000));
      
      const batchPause = pMin + Math.floor(Math.random() * (pMax - pMin + 1));
      waitMs = Math.max(waitMs, batchPause);
      
      this.logger.log(`[${this.name}] Limite du lot atteinte (${this._consecutiveSends} msgs). Pause de ${batchPause}ms...`);
      
      // Réinitialiser pour le prochain lot
      this._consecutiveSends = 0;
      const bMin = Math.max(1, toFiniteNumber(process.env.WA_BATCH_SIZE_MIN, 10));
      const bMax = Math.max(bMin, toFiniteNumber(process.env.WA_BATCH_SIZE_MAX, 15));
      this._nextBatchSize = bMin + Math.floor(Math.random() * (bMax - bMin + 1));
    }

    // Hard cap per sliding window
    if (this.windowMs > 0 && Number.isFinite(this.maxPerWindow) && this.maxPerWindow !== Infinity) {
      const cutoff = now - this.windowMs;
      this._sentAt = this._sentAt.filter((t) => t > cutoff);

      if (this._sentAt.length >= this.maxPerWindow) {
        const oldest = this._sentAt[0];
        const until = oldest + this.windowMs;
        waitMs = Math.max(waitMs, Math.max(0, until - now));
      }
    }

    if (this.jitterMs > 0) {
      waitMs += Math.floor(Math.random() * (this.jitterMs + 1));
    }

    // Optional occasional long pause to mimic human sending patterns
    if (this.longPauseChance > 0 && this.longPauseMaxMs > 0) {
      if (Math.random() < this.longPauseChance) {
        const span = Math.max(0, this.longPauseMaxMs - this.longPauseMinMs);
        const extra = this.longPauseMinMs + (span > 0 ? Math.floor(Math.random() * (span + 1)) : 0);
        waitMs += extra;
      }
    }

    if (waitMs > 0) {
      await sleep(waitMs);
    }
  }
}

module.exports = { RateLimitedQueue };


