// javascripts/discourse/components/media-gallery-page.js
import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { action } from "@ember/object";
import { ajax } from "discourse/lib/ajax";
import I18n from "I18n";

function normalizeListSetting(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);

  const str = String(raw);
  return str
    .split(/[\|\n,]/g)
    .map((t) => t.trim())
    .filter(Boolean);
}

function stripExt(filename) {
  return filename?.replace(/\.[^/.]+$/, "") || filename;
}

function uniqStrings(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr || []) {
    const s = String(v || "").trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function isProcessingStatus(status) {
  return status === "queued" || status === "processing";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Thumbnail loader limits (to avoid Nginx 429)
const THUMB_MAX_CONCURRENCY = 6;
const THUMB_RETRY_LIMIT = 3;
const THUMB_RETRY_BASE_DELAY_MS = 500;

export default class MediaGalleryPage extends Component {
  // Tabs
  @tracked activeTab = "all"; // all | mine

  // Loading / messaging
  @tracked loading = false;
  @tracked errorMessage = null;
  @tracked noticeMessage = null;

  // Data
  @tracked items = [];
  @tracked page = 1;
  @tracked perPage = 24;
  @tracked total = 0;

  // Filters
  @tracked q = "";
  @tracked mediaType = "";
  @tracked gender = "";
  @tracked status = ""; // only for "mine"

  // Tags (filters) - multi-select UI state
  @tracked tagsSelected = [];
  @tracked filterTagsQuery = "";
  @tracked filterTagsOpen = false;

  // Upload UI
  @tracked showUpload = false;
  @tracked uploadBusy = false;
  @tracked uploadFile = null;
  @tracked uploadTitle = "";
  @tracked uploadDescription = "";
  @tracked uploadGender = "";

  // Tags (upload) - multi-select UI state
  @tracked uploadTagsSelected = [];
  @tracked uploadTagsQuery = "";
  @tracked uploadTagsOpen = false;

  // Preview modal
  @tracked previewOpen = false;
  @tracked previewItem = null;
  @tracked previewStreamUrl = null;
  @tracked previewLoading = false;
  @tracked previewRetryCount = 0;

  // Delete confirmation modal
  @tracked deleteOpen = false;
  @tracked deleteItem = null;
  @tracked deleteBusy = false;

  _pollTimer = null;
  _boundDocClick = null;

  _destroyed = false;

  // Thumbnail queue state
  _thumbQueue = [];
  _thumbInFlight = 0;

  constructor() {
    super(...arguments);

    this._boundDocClick = (e) => this.onDocumentClick(e);
    document.addEventListener("click", this._boundDocClick);

    this.refresh();
  }

  willDestroy() {
    super.willDestroy(...arguments);
    this.stopPolling();

    this._destroyed = true;

    if (this._boundDocClick) {
      document.removeEventListener("click", this._boundDocClick);
      this._boundDocClick = null;
    }
  }

  get isMine() {
    return this.activeTab === "mine";
  }

  get totalPages() {
    const pp = this.perPage || 1;
    return Math.max(1, Math.ceil((this.total || 0) / pp));
  }

  get hasPrev() {
    return this.page > 1;
  }

  get hasNext() {
    return this.page < this.totalPages;
  }

  get allowedTags() {
    const raw = window?.Discourse?.SiteSettings?.media_gallery_allowed_tags;
    return normalizeListSetting(raw);
  }

  // -----------------------
  // Multi-select suggestions
  // -----------------------
  get filterTagSuggestions() {
    const q = (this.filterTagsQuery || "").trim().toLowerCase();
    const selected = new Set((this.tagsSelected || []).map((t) => String(t).toLowerCase()));

    if (this.allowedTags.length) {
      return this.allowedTags
        .filter((t) => !selected.has(String(t).toLowerCase()))
        .filter((t) => (q ? String(t).toLowerCase().includes(q) : true))
        .slice(0, 50);
    }

    if (!q) return [];
    if (selected.has(q)) return [];
    return [this.filterTagsQuery.trim()];
  }

  get uploadTagSuggestions() {
    const q = (this.uploadTagsQuery || "").trim().toLowerCase();
    const selected = new Set((this.uploadTagsSelected || []).map((t) => String(t).toLowerCase()));

    if (this.allowedTags.length) {
      return this.allowedTags
        .filter((t) => !selected.has(String(t).toLowerCase()))
        .filter((t) => (q ? String(t).toLowerCase().includes(q) : true))
        .slice(0, 50);
    }

    if (!q) return [];
    if (selected.has(q)) return [];
    return [this.uploadTagsQuery.trim()];
  }

  // -----------------------
  // Document click (close menus)
  // -----------------------
  onDocumentClick(e) {
    const el = e?.target;
    if (!el?.closest) return;

    const inside = el.closest("[data-hb-ms]");
    if (!inside) {
      this.filterTagsOpen = false;
      this.uploadTagsOpen = false;
    }
  }

  // -----------------------
  // Polling
  // -----------------------
  stopPolling() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }

  schedulePollingIfNeeded() {
    this.stopPolling();

    if (!this.isMine) return;

    const hasInFlight = (this.items || []).some((i) => isProcessingStatus(i?.status));
    if (!hasInFlight) return;

    this._pollTimer = setTimeout(() => {
      this.refresh({ silent: true });
    }, 4000);
  }

  // -----------------------
  // Tabs / paging
  // -----------------------
  @action
  switchTab(tab) {
    if (this.activeTab === tab) return;
    this.activeTab = tab;
    this.page = 1;
    this.refresh();
  }

  @action
  goPrev() {
    if (!this.hasPrev) return;
    this.page = this.page - 1;
    this.refresh();
  }

  @action
  goNext() {
    if (!this.hasNext) return;
    this.page = this.page + 1;
    this.refresh();
  }

  // -----------------------
  // Filters
  // -----------------------
  @action setQ(e) { this.q = e.target.value; }
  @action setMediaType(e) { this.mediaType = e.target.value; }
  @action setGender(e) { this.gender = e.target.value; }
  @action setStatus(e) { this.status = e.target.value; }

  @action
  setPerPage(e) {
    const v = parseInt(e.target.value, 10);
    this.perPage = Number.isFinite(v) ? v : 24;
  }

  @action
  clearFilters() {
    this.q = "";
    this.mediaType = "";
    this.gender = "";
    this.tagsSelected = [];
    this.filterTagsQuery = "";
    this.filterTagsOpen = false;
    this.status = "";
    this.page = 1;
    this.refresh();
  }

  @action
  applyFilters() {
    this.page = 1;
    this.refresh();
  }

  // -----------------------
  // Filter tags multi-select actions
  // -----------------------
  @action
  openFilterTags() {
    this.filterTagsOpen = true;
  }

  @action
  onFilterTagsQuery(e) {
    this.filterTagsQuery = e.target.value;
    this.filterTagsOpen = true;
  }

  @action
  addFilterTag(tag) {
    const t = String(tag || "").trim();
    if (!t) return;

    this.tagsSelected = uniqStrings([...(this.tagsSelected || []), t]);
    this.filterTagsQuery = "";
    this.filterTagsOpen = true;
  }

  @action
  removeFilterTag(tag, ev) {
    ev?.stopPropagation?.();
    const t = String(tag || "").trim().toLowerCase();
    this.tagsSelected = (this.tagsSelected || []).filter((x) => String(x).toLowerCase() !== t);
  }

  @action
  onFilterTagsKeydown(e) {
    if (e.key === "Escape") {
      this.filterTagsOpen = false;
      return;
    }

    if (e.key !== "Enter") return;
    e.preventDefault();

    const candidate = (this.filterTagsQuery || "").trim();
    if (!candidate) return;

    if (this.allowedTags.length) {
      const match = this.allowedTags.find((x) => String(x).toLowerCase() === candidate.toLowerCase());
      if (match) this.addFilterTag(match);
      return;
    }

    this.addFilterTag(candidate);
  }

  // -----------------------
  // Upload actions
  // -----------------------
  @action
  toggleUpload() {
    this.showUpload = !this.showUpload;
  }

  @action
  onPickFile(e) {
    const file = e.target.files?.[0];
    this.uploadFile = file || null;
    if (file && !this.uploadTitle) {
      this.uploadTitle = stripExt(file.name);
    }
  }

  @action setUploadTitle(e) { this.uploadTitle = e.target.value; }
  @action setUploadDescription(e) { this.uploadDescription = e.target.value; }
  @action setUploadGender(e) { this.uploadGender = e.target.value; }

  @action
  resetUploadForm() {
    this.uploadFile = null;
    this.uploadTitle = "";
    this.uploadDescription = "";
    this.uploadGender = "";
    this.uploadTagsSelected = [];
    this.uploadTagsQuery = "";
    this.uploadTagsOpen = false;
  }

  // -----------------------
  // Upload tags multi-select actions
  // -----------------------
  @action
  openUploadTags() {
    this.uploadTagsOpen = true;
  }

  @action
  onUploadTagsQuery(e) {
    this.uploadTagsQuery = e.target.value;
    this.uploadTagsOpen = true;
  }

  @action
  addUploadTag(tag) {
    const t = String(tag || "").trim();
    if (!t) return;

    this.uploadTagsSelected = uniqStrings([...(this.uploadTagsSelected || []), t]);
    this.uploadTagsQuery = "";
    this.uploadTagsOpen = true;
  }

  @action
  removeUploadTag(tag, ev) {
    ev?.stopPropagation?.();
    const t = String(tag || "").trim().toLowerCase();
    this.uploadTagsSelected = (this.uploadTagsSelected || []).filter((x) => String(x).toLowerCase() !== t);
  }

  @action
  onUploadTagsKeydown(e) {
    if (e.key === "Escape") {
      this.uploadTagsOpen = false;
      return;
    }

    if (e.key !== "Enter") return;
    e.preventDefault();

    const candidate = (this.uploadTagsQuery || "").trim();
    if (!candidate) return;

    if (this.allowedTags.length) {
      const match = this.allowedTags.find((x) => String(x).toLowerCase() === candidate.toLowerCase());
      if (match) this.addUploadTag(match);
      return;
    }

    this.addUploadTag(candidate);
  }

  // -----------------------
  // Upload flow
  // -----------------------
  @action
  async submitUpload() {
    this.noticeMessage = null;
    this.errorMessage = null;

    if (!this.uploadFile) {
      this.errorMessage = I18n.t("media_gallery.errors.missing_file");
      return;
    }

    if (!this.uploadTitle?.trim()) {
      this.errorMessage = I18n.t("media_gallery.errors.missing_title");
      return;
    }

    if (!this.uploadGender) {
      this.errorMessage = "Please select a gender.";
      return;
    }

    this.uploadBusy = true;

    try {
      const fd = new FormData();
      fd.append("type", "composer");
      fd.append("synchronous", "true");
      fd.append("file", this.uploadFile);

      const uploadRes = await ajax("/uploads.json", {
        type: "POST",
        data: fd,
        processData: false,
        contentType: false,
      });

      const uploadId = uploadRes?.id;
      if (!uploadId) {
        throw new Error(I18n.t("media_gallery.errors.upload_failed"));
      }

      const payload = {
        upload_id: uploadId,
        title: this.uploadTitle.trim(),
        gender: this.uploadGender,
      };

      if (this.uploadDescription?.trim()) payload.description = this.uploadDescription.trim();

      const tags = uniqStrings(this.uploadTagsSelected || []);
      if (tags.length) payload.tags = tags;

      await ajax("/media", { type: "POST", data: payload });

      this.noticeMessage = I18n.t("media_gallery.uploading_notice");
      this.resetUploadForm();

      this.activeTab = "mine";
      this.page = 1;
      await this.refresh();

      this.schedulePollingIfNeeded();
    } catch (e) {
      const status = e?.jqXHR?.status;
      if (status === 404 || status === 403) {
        this.errorMessage = I18n.t("media_gallery.errors.upload_not_allowed");
      } else {
        this.errorMessage =
          e?.jqXHR?.responseJSON?.errors?.join(", ") ||
          e?.message ||
          I18n.t("media_gallery.errors.create_failed");
      }
    } finally {
      this.uploadBusy = false;
    }
  }

  // -----------------------
  // Delete flow (My uploads only)
  // -----------------------
  @action
  openDeleteConfirm(item, ev) {
    ev?.stopPropagation?.();
    if (!this.isMine) return;
    if (!item?.public_id) return;

    if (isProcessingStatus(item.status)) {
      this.noticeMessage = "You can delete this item after processing is complete.";
      return;
    }

    this.errorMessage = null;
    this.noticeMessage = null;

    this.deleteOpen = true;
    this.deleteItem = item;
    this.deleteBusy = false;
  }

  @action
  closeDeleteConfirm() {
    if (this.deleteBusy) return;
    this.deleteOpen = false;
    this.deleteItem = null;
    this.deleteBusy = false;
  }

  @action
  async confirmDelete() {
    if (!this.deleteItem?.public_id) return;

    this.deleteBusy = true;
    this.errorMessage = null;
    this.noticeMessage = null;

    try {
      await ajax(`/media/${this.deleteItem.public_id}`, { type: "DELETE" });

      if (this.previewOpen && this.previewItem?.public_id === this.deleteItem.public_id) {
        this.closePreview();
      }

      this.noticeMessage = "Media item deleted.";
      this.deleteOpen = false;
      this.deleteItem = null;
      this.deleteBusy = false;

      await this.refresh();

      if ((this.items?.length || 0) === 0 && this.page > 1) {
        this.page = this.page - 1;
        await this.refresh();
      }
    } catch (e) {
      this.deleteBusy = false;
      this.errorMessage = e?.jqXHR?.responseJSON?.errors?.join(", ") || e?.message || "Delete failed.";
    }
  }

  // -----------------------
  // Thumbnails (concurrency limited, using DOM <img> load/error events)
  //
  // Why this approach:
  // - Preloading with `new Image()` can load resources (visible in DevTools)
  //   without reliably flipping UI state in some Discourse/Ember setups,
  //   leaving the UI stuck on “Loading thumbnail…”.
  // - Here we control *when* an <img> gets a `src` (max concurrency) and we
  //   rely on the actual DOM `load`/`error` events to mark the thumbnail as
  //   loaded/failed. That keeps the UI and network in sync.
  // -----------------------
  _resetThumbQueue() {
    this._thumbQueue = [];
    this._thumbInFlight = 0;
  }

  _primeThumbState(newItems) {
    // Keep previous UI thumb state if we have it
    const prevById = new Map((this.items || []).map((it) => [it?.public_id, it]));

    for (const it of newItems) {
      const prev = prevById.get(it?.public_id);
      it._thumbSrc = prev?._thumbSrc || null;
      it._thumbLoaded = !!prev?._thumbLoaded;
      it._thumbFailed = !!prev?._thumbFailed;
      it._thumbRetries = prev?._thumbRetries || 0;
      it._thumbQueued = false;
      it._thumbInFlight = false;
    }
  }

  _enqueueThumbLoadsForCurrentItems() {
    // Queue thumbnails for all ready items (concurrency limited)
    for (const item of this.items || []) {
      this._enqueueThumbItem(item);
    }

    this._pumpThumbQueue();
  }

  _enqueueThumbItem(item) {
    if (!item) return;
    if (item.status !== "ready") return;
    if (item._thumbFailed) return;
    if (item._thumbLoaded) return;
    if (!item.thumbnail_url) return;
    if (item._thumbQueued) return;
    if (item._thumbInFlight) return;

    item._thumbQueued = true;
    this._thumbQueue.push(item);
  }

  _pumpThumbQueue() {
    while (this._thumbInFlight < THUMB_MAX_CONCURRENCY && this._thumbQueue.length > 0) {
      const item = this._thumbQueue.shift();
      if (!item || item._thumbLoaded || item._thumbFailed || !item.thumbnail_url) {
        continue;
      }

      this._thumbInFlight += 1;

      item._thumbQueued = false;
      item._thumbInFlight = true;
      item._thumbSrc = item.thumbnail_url;

      // Force rerender (Glimmer doesn't track deep mutations reliably)
      this.items = [...this.items];
    }
  }

  // Called when <img> is inserted; needed for cached images.
  // The browser may complete the load before Ember attaches the "load" listener,
  // leaving the UI stuck in "Loading thumbnail…".
  @action
  onThumbInsert(item, element) {
    if (!item || item._thumbLoaded || item._thumbFailed) return;

    const img = element;
    if (!img) return;

    // If the image is already loaded from cache, `load` may never fire for us.
    if (img.complete && img.naturalWidth > 0) {
      const wasInFlight = !!item._thumbInFlight;
      item._thumbLoaded = true;
      item._thumbInFlight = false;
      item._thumbQueued = false;

      if (wasInFlight) {
        this._thumbInFlight = Math.max(0, this._thumbInFlight - 1);
      }

      this.items = [...this.items];
      this._pumpThumbQueue();
      return;
    }

    // If it's "complete" but broken (naturalWidth = 0), kick the retry path.
    if (img.complete && img.naturalWidth === 0) {
      this.onThumbError(item);
    }
  }

  // Called by <img onload>
  @action
  onThumbLoad(item) {
    if (!item || item._thumbFailed) return;
    if (!item._thumbInFlight) return;

    item._thumbLoaded = true;
    item._thumbInFlight = false;
    item._thumbQueued = false;

    this._thumbInFlight = Math.max(0, this._thumbInFlight - 1);
    this.items = [...this.items];
    this._pumpThumbQueue();
  }

  // Called by <img onerror>
  @action
  onThumbError(item, ev) {
    if (!item || item._thumbFailed) return;
    if (!item._thumbInFlight) return;

    const attempt = parseInt(item._thumbRetries || 0, 10) || 0;
    const nextAttempt = attempt + 1;
    item._thumbRetries = nextAttempt;

    // Always clear src so the broken image never flashes
    item._thumbSrc = null;
    item._thumbLoaded = false;

    // Release slot immediately (lets other thumbs continue) and re-queue after delay
    item._thumbInFlight = false;
    item._thumbQueued = false;
    this._thumbInFlight = Math.max(0, this._thumbInFlight - 1);
    this.items = [...this.items];

    if (nextAttempt <= THUMB_RETRY_LIMIT) {
      const delay = THUMB_RETRY_BASE_DELAY_MS * Math.pow(2, nextAttempt - 1);
      setTimeout(() => {
        // Component might have been destroyed / items changed
        if (this._destroyed) return;
        if (!this.items || !this.items.includes(item)) return;
        if (item._thumbFailed || item._thumbLoaded) return;
        if (item.status !== "ready" || !item.thumbnail_url) return;

        this._enqueueThumbItem(item);
        this._pumpThumbQueue();
      }, delay);
      return;
    }

    // Give up
    item._thumbFailed = true;
    this.items = [...this.items];

    try {
      if (ev?.target) ev.target.src = "";
    } catch {
      // ignore
    }

    this._pumpThumbQueue();
  }

  // -----------------------
  // Like / Unlike
  // -----------------------
  @action
  async toggleLike(item, ev) {
    ev?.stopPropagation?.();
    if (!item?.public_id) return;

    const wasLiked = !!item.liked;
    const endpoint = wasLiked ? `/media/${item.public_id}/unlike` : `/media/${item.public_id}/like`;

    try {
      await ajax(endpoint, { type: "POST" });

      item.liked = !wasLiked;
      const current = parseInt(item.likes_count || 0, 10) || 0;
      item.likes_count = Math.max(0, wasLiked ? current - 1 : current + 1);
      this.items = [...this.items];
    } catch (e) {
      this.errorMessage = e?.jqXHR?.responseJSON?.errors?.join(", ") || e?.message || "Error";
    }
  }

  // -----------------------
  // Preview (token refresh on error)
  // -----------------------
  async fetchPreviewStreamUrl({ resetRetry } = { resetRetry: false }) {
    if (!this.previewItem?.public_id) return;

    if (resetRetry) this.previewRetryCount = 0;

    const res = await ajax(`/media/${this.previewItem.public_id}/play`, { type: "GET" });
    this.previewStreamUrl = res?.stream_url || null;
  }

  @action
  async openPreview(item) {
    if (!item?.public_id) return;
    if (item.playable === false) return;

    this.previewOpen = true;
    this.previewItem = item;
    this.previewStreamUrl = null;
    this.previewLoading = true;
    this.previewRetryCount = 0;
    this.errorMessage = null;

    try {
      await this.fetchPreviewStreamUrl({ resetRetry: true });
    } catch (e) {
      this.errorMessage = e?.jqXHR?.responseJSON?.errors?.join(", ") || e?.message || "Error";
    } finally {
      this.previewLoading = false;
    }
  }

  @action
  closePreview() {
    this.previewOpen = false;
    this.previewItem = null;
    this.previewStreamUrl = null;
    this.previewLoading = false;
    this.previewRetryCount = 0;
  }

  @action
  stopBackdropClick(e) {
    e?.stopPropagation?.();
  }

  @action
  async onPlayerError() {
    if (!this.previewOpen || !this.previewItem?.public_id) return;

    if (this.previewRetryCount >= 3) return;
    this.previewRetryCount += 1;

    try {
      await this.fetchPreviewStreamUrl({ resetRetry: false });
    } catch {
      // ignore
    }
  }

  @action
  async retryProcessing(item, ev) {
    ev?.stopPropagation?.();
    if (!item?.public_id) return;

    try {
      await ajax(`/media/${item.public_id}/retry`, { type: "POST" });
      this.noticeMessage = I18n.t("media_gallery.retry_queued");
      await this.refresh();
    } catch (e) {
      this.errorMessage = e?.jqXHR?.responseJSON?.errors?.join(", ") || e?.message || "Error";
    }
  }

  // -----------------------
  // Data load
  // -----------------------
  async refresh({ silent } = { silent: false }) {
    if (!silent) {
      this.loading = true;
    }
    this.errorMessage = null;

    try {
      const data = {
        page: this.page,
        per_page: this.perPage,
      };

      const tags = uniqStrings(this.tagsSelected || []);
      if (this.mediaType) data.media_type = this.mediaType;
      if (this.gender) data.gender = this.gender;
      if (tags.length) data.tags = tags;

      const endpoint = this.isMine ? "/media/my" : "/media";
      if (this.isMine && this.status) data.status = this.status;

      const res = await ajax(endpoint, { type: "GET", data });

      let media = res?.media_items || [];
      const total = res?.total ?? media.length;

      if (this.q?.trim()) {
        const q = this.q.trim().toLowerCase();
        media = media.filter((m) => {
          const t = (m.title || "").toLowerCase();
          const d = (m.description || "").toLowerCase();
          return t.includes(q) || d.includes(q);
        });
      }

      // Prime thumbnail state and then enqueue loads
      this._primeThumbState(media);
      this._resetThumbQueue();

      this.items = media;
      this.page = res?.page || this.page;
      this.perPage = res?.per_page || this.perPage;
      this.total = total;

      // Start thumbnail loading (this is what fixes "stuck on Loading thumbnail…")
      this._enqueueThumbLoadsForCurrentItems();

      this.schedulePollingIfNeeded();
    } catch (e) {
      const status = e?.jqXHR?.status;
      if (status === 403 || status === 404) {
        this.errorMessage = I18n.t("media_gallery.errors.not_available");
      } else {
        this.errorMessage = e?.jqXHR?.responseJSON?.errors?.join(", ") || e?.message || "Error";
      }
    } finally {
      if (!silent) {
        this.loading = false;
      }
    }
  }
}
