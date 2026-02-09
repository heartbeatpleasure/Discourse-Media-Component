// javascripts/discourse/components/media-gallery-page.js
import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { action } from "@ember/object";
import { ajax } from "discourse/lib/ajax";
import I18n from "I18n";

function normalizeListSetting(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);

  // Discourse "list" site settings often come through as pipe-separated strings.
  const str = String(raw);
  return str
    .split(/[\|\n,]/g)
    .map((t) => t.trim())
    .filter(Boolean);
}

function normalizeTagsFromText(input) {
  return (input || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function stripExt(filename) {
  return filename?.replace(/\.[^/.]+$/, "") || filename;
}

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
  @tracked tagsRaw = "";
  @tracked tagsSelected = [];
  @tracked status = ""; // only for "mine"

  // Upload UI
  @tracked showUpload = false;
  @tracked uploadBusy = false;
  @tracked uploadFile = null;
  @tracked uploadTitle = "";
  @tracked uploadDescription = "";
  @tracked uploadTagsRaw = "";
  @tracked uploadTagsSelected = [];
  @tracked uploadGender = "";

  // Preview modal
  @tracked previewOpen = false;
  @tracked previewItem = null;
  @tracked previewStreamUrl = null;
  @tracked previewLoading = false;
  @tracked previewRetryCount = 0;

  _pollTimer = null;

  constructor() {
    super(...arguments);
    this.refresh();
  }

  willDestroy() {
    super.willDestroy(...arguments);
    this.stopPolling();
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

  get filterTags() {
    if (this.allowedTags.length) return this.tagsSelected;
    return normalizeTagsFromText(this.tagsRaw);
  }

  get uploadTags() {
    if (this.allowedTags.length) return this.uploadTagsSelected;
    return normalizeTagsFromText(this.uploadTagsRaw);
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

    // Only poll on "My uploads", and only if there are in-flight items.
    if (!this.isMine) return;

    const hasInFlight = (this.items || []).some((i) => i?.status === "queued" || i?.status === "processing");
    if (!hasInFlight) return;

    this._pollTimer = setTimeout(() => {
      // Silent refresh to avoid flicker/spinner while polling.
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
  @action setTagsRaw(e) { this.tagsRaw = e.target.value; }
  @action setStatus(e) { this.status = e.target.value; }

  @action
  setTagsSelected(e) {
    this.tagsSelected = Array.from(e.target.selectedOptions || []).map((o) => o.value);
  }

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
    this.tagsRaw = "";
    this.tagsSelected = [];
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
  // Upload
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
  @action setUploadTagsRaw(e) { this.uploadTagsRaw = e.target.value; }
  @action setUploadGender(e) { this.uploadGender = e.target.value; }

  @action
  setUploadTagsSelected(e) {
    this.uploadTagsSelected = Array.from(e.target.selectedOptions || []).map((o) => o.value);
  }

  @action
  resetUploadForm() {
    this.uploadFile = null;
    this.uploadTitle = "";
    this.uploadDescription = "";
    this.uploadTagsRaw = "";
    this.uploadTagsSelected = [];
    this.uploadGender = "";
  }

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

    // Gender is required for upload (per your UX requirement).
    if (!this.uploadGender) {
      this.errorMessage = "Please select a gender.";
      return;
    }

    this.uploadBusy = true;

    try {
      // 1) Upload raw file to Discourse
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

      // 2) Register in media gallery plugin
      const payload = {
        upload_id: uploadId,
        title: this.uploadTitle.trim(),
        gender: this.uploadGender,
      };

      if (this.uploadDescription?.trim()) payload.description = this.uploadDescription.trim();

      const tags = this.uploadTags;
      if (tags.length) payload.tags = tags;

      const createRes = await ajax("/media", { type: "POST", data: payload });

      this.noticeMessage = I18n.t("media_gallery.uploading_notice");
      this.resetUploadForm();

      // Switch to "My uploads" and refresh.
      this.activeTab = "mine";
      this.page = 1;
      await this.refresh();

      // Ensure polling starts immediately after creating an item.
      // (Processing can take a while; this keeps the UI updating without manual refresh.)
      this.schedulePollingIfNeeded();

      // Optional: if createRes has public_id/status, we could highlight it later.
      void createRes;
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
  // Thumbnail fallback (client-side)
  // -----------------------
  @action
  onThumbError(item, ev) {
    // Avoid infinite error loops
    if (!item || item._thumbFailed) return;
    item._thumbFailed = true;

    // Force rerender
    this.items = [...this.items];

    // Also stop the browser from retrying endlessly
    try {
      if (ev?.target) ev.target.src = "";
    } catch {
      // ignore
    }
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

      // Optimistic update (API returns only success: true)
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
    // Fix: sometimes the first token/stream fetch can fail while the file becomes available.
    // Retry by requesting a fresh token a few times.
    if (!this.previewOpen || !this.previewItem?.public_id) return;

    if (this.previewRetryCount >= 3) return;
    this.previewRetryCount += 1;

    try {
      await this.fetchPreviewStreamUrl({ resetRetry: false });
    } catch {
      // Ignore; user can close/open if needed.
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

      const tags = this.filterTags;
      if (this.mediaType) data.media_type = this.mediaType;
      if (this.gender) data.gender = this.gender;
      if (tags.length) data.tags = tags;

      const endpoint = this.isMine ? "/media/my" : "/media";
      if (this.isMine && this.status) data.status = this.status;

      const res = await ajax(endpoint, { type: "GET", data });

      let media = res?.media_items || [];
      const total = res?.total ?? media.length;

      // Server-side doesn't support q yet; filter client-side for MVP
      if (this.q?.trim()) {
        const q = this.q.trim().toLowerCase();
        media = media.filter((m) => {
          const t = (m.title || "").toLowerCase();
          const d = (m.description || "").toLowerCase();
          return t.includes(q) || d.includes(q);
        });
      }

      this.items = media;
      this.page = res?.page || this.page;
      this.perPage = res?.per_page || this.perPage;
      this.total = total;

      // Poll if needed (only on My uploads with in-flight items)
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
