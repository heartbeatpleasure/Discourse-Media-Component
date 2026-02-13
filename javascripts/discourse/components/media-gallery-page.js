// javascripts/discourse/components/media-gallery-page.js
import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { action } from "@ember/object";
import { htmlSafe } from "@ember/template";
import { inject as service } from "@ember/service";
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

function getSiteSetting(key) {
  return window?.Discourse?.SiteSettings?.[key];
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


function formatDurationSeconds(totalSeconds) {
  const n = Number(totalSeconds);
  if (!Number.isFinite(n) || n <= 0) return null;

  const s = Math.max(0, Math.floor(n));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;

  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }

  return `${m}:${String(sec).padStart(2, "0")}`;
}

function formatDateShort(iso) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;

    const locale = I18n?.locale || document?.documentElement?.lang || undefined;
    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "short",
      day: "2-digit",
    }).format(d);
  } catch (e) {
    return null;
  }
}

// Thumbnail loader limits (to avoid Nginx 429)
const THUMB_RETRY_LIMIT = 3;
const THUMB_RETRY_BASE_DELAY_MS = 500;
const TRANSPARENT_GIF =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

export default class MediaGalleryPage extends Component {
  @service currentUser;

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
  // NOTE: kept as `gender` for backwards compatibility with the plugin API,
  // but used as a "file contains" / subject selector in the UI.
  @tracked uploadGender = "";
  @tracked uploadAuthorized = false;
  @tracked watermarkConfig = null;
  @tracked uploadWatermarkEnabled = true;
  @tracked uploadWatermarkPresetId = "";

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
  @tracked previewAspect = null;

  // Delete confirmation modal
  @tracked deleteOpen = false;
  @tracked deleteItem = null;
  @tracked deleteBusy = false;

  _pollTimer = null;
  _boundDocClick = null;

  _destroyed = false;

  // Thumbnail retry/failure state (keyed by public_id)
  _thumbRetryById = new Map();
  _thumbFailures = new Set();

  // Some endpoints may 500 when receiving a tags parameter. Track per endpoint
  // to avoid repeated failing requests (and noisy console/network errors).
  _tagsBrokenByEndpoint = new Map();

  constructor() {
    super(...arguments);

    this._boundDocClick = (e) => this.onDocumentClick(e);
    document.addEventListener("click", this._boundDocClick);

    this.refresh();
    this.loadMediaConfig();
  }

  async loadMediaConfig() {
    try {
      const res = await ajax("/media/config");
      this.watermarkConfig = res?.watermark || null;

      // Defaults for the upload UI
      if (this.watermarkConfig?.enabled) {
        this.uploadWatermarkEnabled = true;

        // Newer plugin versions may return default_choice (string or {value,label}); older versions return default_preset_id.
        const dc = this.watermarkConfig?.default_choice;
        this.uploadWatermarkPresetId =
          (typeof dc === "string" ? dc : dc?.value) || this.watermarkConfig?.default_preset_id || "";
      }
    } catch (e) {
      this.watermarkConfig = null;
    }
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

  get uploadTermsUrl() {
    return String(getSiteSetting("media_gallery_upload_terms_url") || "").trim() || null;
  }

  get uploadSubmitDisabled() {
    if (this.uploadBusy) return true;
    if (!this.uploadFile) return true;
    if (!this.uploadTitle?.trim()) return true;
    if (!this.uploadGender) return true;
    if (!this.uploadAuthorized) return true;
    return false;
  }

  get isVideoUploadSelected() {
    const f = this.uploadFile;
    if (!f) return false;
    const type = String(f.type || "").toLowerCase();
    if (type.startsWith("video/")) return true;
    const name = String(f.name || "").toLowerCase();
    return /\.(mp4|m4v|webm|mkv)$/i.test(name);
  }

  get isImageUploadSelected() {
    const f = this.uploadFile;
    if (!f) return false;
    const type = String(f.type || "").toLowerCase();
    if (type.startsWith("image/")) return true;
    const name = String(f.name || "").toLowerCase();
    return /\.(jpg|jpeg|png|webp|gif|bmp|tif|tiff|avif)$/i.test(name);
  }

  get isWatermarkableUploadSelected() {
    return this.isVideoUploadSelected || this.isImageUploadSelected;
  }

  get isAudioUploadSelected() {
    const f = this.uploadFile;
    if (!f) return false;
    const type = String(f.type || "").toLowerCase();
    if (type.startsWith("audio/")) return true;
    const name = String(f.name || "").toLowerCase();
    return /\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(name);
  }

  get watermarkUiVisible() {
    // NOTE: watermarking is currently applied server-side to processed video/image outputs.
    // We still show the controls as soon as watermarking is enabled so admins/users
    // can see the option immediately, even before selecting a file.
    return !!(
      this.watermarkConfig?.enabled &&
      (this.watermarkConfig.user_can_toggle || this.watermarkConfig.user_can_choose_preset)
    );
  }

  get watermarkUiDisabled() {
    // If a non-visual file is selected, keep the UI visible but disable controls to
    // avoid the impression watermark will apply to audio/other types.
    if (!this.uploadFile) return false;
    return !this.isWatermarkableUploadSelected;
  }

  get watermarkCanToggle() {
    return !!(this.watermarkConfig?.enabled && this.watermarkConfig.user_can_toggle);
  }

  get watermarkCanChoosePreset() {
    return !!(this.watermarkConfig?.enabled && this.watermarkConfig.user_can_choose_preset);
  }

  get watermarkPresets() {
    const wm = this.watermarkConfig || {};

    // Newer plugin versions: `choices` is a simple list of watermark text templates.
    // Older plugin versions: `presets` is an array of { id, label }.
    let list = [];
    if (Array.isArray(wm.choices) && wm.choices.length) {
      list = wm.choices
        .map((c) => {
          if (typeof c === "string") {
            const v = c.trim();
            return { id: v, label: v };
          }
          const v = String(c?.value || "").trim();
          const l = String(c?.label || c?.value || "").trim();
          return { id: v, label: l };
        })
        .filter((x) => x.id);
    } else if (Array.isArray(wm.presets) && wm.presets.length) {
      list = wm.presets
        .map((p) => ({
          id: String(p?.id || "").trim(),
          label: String(p?.label || p?.id || "").trim(),
        }))
        .filter((x) => x.id);
    }

    // Make sure placeholders like {{username}} are user-friendly in the UI.
    const out = [];
    const seen = new Set();
    for (const opt of list) {
      if (!opt?.id) continue;
      if (seen.has(opt.id)) continue;
      seen.add(opt.id);

      out.push({
        id: opt.id,
        label: this._renderWatermarkDisplay(opt.label || opt.id),
      });
    }
    return out;
  }

  get watermarkDefaultLabel() {
    const wm = this.watermarkConfig || {};
    const direct = typeof wm?.default_choice === "object" ? wm?.default_choice?.label : null;
    if (direct) return this._renderWatermarkDisplay(direct);

    const id =
      (typeof wm?.default_choice === "string" ? wm.default_choice : wm?.default_choice?.value) ||
      wm?.default_preset_id;
    if (!id) return null;

    const found = (this.watermarkPresets || []).find((p) => String(p?.id) === String(id));
    return found?.label || this._renderWatermarkDisplay(String(id));
  }

  _renderWatermarkDisplay(raw) {
    const s = String(raw || "");
    if (!s) return "";

    const username = String(this.currentUser?.username || "username");
    const userId = String(this.currentUser?.id || "user_id");

    // Support both modern placeholders and a couple of legacy ones.
    let out = s;
    out = out.split("{{username}}").join(username);
    out = out.split("{{user_id}}").join(userId);
    out = out.split("@{{username}}").join(`@${username}`);
    out = out.split("@{{user_id}}").join(`@${userId}`);
    out = out.split("@username").join(`@${username}`);
    out = out.split("@user_id").join(`@${userId}`);
    out = out.replace(/\s+/g, " ").trim();
    return out;
  }

  // -----------------------
  // Formatting (UI)
  // -----------------------
  formatDuration(seconds) {
    return formatDurationSeconds(seconds);
  }

  formatCreatedAt(iso) {
    return formatDateShort(iso);
  }

  cleanUsername(username) {
    const u = (username || "").trim();
    return u.startsWith("@") ? u.slice(1) : u;
  }

  prettyMediaType(mediaType) {
    const t = String(mediaType || "").trim();
    if (!t) return "";
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  prettyGender(gender) {
    const g = String(gender || "").trim();
    if (!g) return "";
    const key = `media_gallery.genders.${g}`;
    return I18n.exists?.(key) ? I18n.t(key) : g;
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
  // Client-side filtering helpers
  // -----------------------
  _normalizeTags(tags) {
    return (tags || []).map((t) => String(t || "").trim().toLowerCase()).filter(Boolean);
  }

  _itemHasAllTags(item, selectedTagsLower) {
    if (!selectedTagsLower?.length) return true;
    const itemTags = this._normalizeTags(item?.tags || []);
    if (!itemTags.length) return false;
    return selectedTagsLower.every((t) => itemTags.includes(t));
  }

  _applyClientFilters(media) {
    let out = [...(media || [])];

    // Server-side filters *should* handle these, but we apply them again client-side
    // so "my uploads" remains consistent even if the endpoint ignores some params.
    if (this.mediaType) {
      out = out.filter((m) => String(m?.media_type || "") === String(this.mediaType));
    }

    if (this.gender) {
      out = out.filter((m) => String(m?.gender || "") === String(this.gender));
    }

    if (this.isMine && this.status) {
      out = out.filter((m) => String(m?.status || "") === String(this.status));
    }

    const selectedTagsLower = this._normalizeTags(uniqStrings(this.tagsSelected || []));
    if (selectedTagsLower.length) {
      out = out.filter((m) => this._itemHasAllTags(m, selectedTagsLower));
    }

    // Text query is intentionally client-side only (current page)
    if (this.q?.trim()) {
      const q = this.q.trim().toLowerCase();
      out = out.filter((m) => {
        const t = (m.title || "").toLowerCase();
        const d = (m.description || "").toLowerCase();
        return t.includes(q) || d.includes(q);
      });
    }

    return out;
  }

  async _fetchWithTagFallback(endpoint, data, tags) {
    // Some backends crash (500) when tags are passed as an array parameter.
    // We first try sending tags as a single string (comma-separated). If that
    // still fails with 500, we retry without tags and fall back to client-side
    // filtering (within the returned page) to avoid stale/incorrect UI.
    const baseData = { ...data };

    const tagsString = (tags || []).length ? (tags.length === 1 ? tags[0] : tags.join(",")) : null;

    const endpointKey = String(endpoint || "");

    if (!tagsString || this._tagsBrokenByEndpoint.get(endpointKey)) {
      return await ajax(endpoint, { type: "GET", data: baseData });
    }

    try {
      return await ajax(endpoint, { type: "GET", data: { ...baseData, tags: tagsString } });
    } catch (e) {
      const status = e?.jqXHR?.status;
      if (status === 500) {
        // Retry without tags to avoid breaking search; we will filter client-side.
        this._tagsBrokenByEndpoint.set(endpointKey, true);
        this.noticeMessage =
          "Tag filtering caused a server error. The server will be queried without tags; results are filtered client-side.";
        return await ajax(endpoint, { type: "GET", data: baseData });
      }
      throw e;
    }
  }

  // -----------------------
  // Tabs / paging
  // -----------------------
  @action
  switchTab(tab) {
    if (this.activeTab === tab) return;
    this.noticeMessage = null;
    this.errorMessage = null;
    this.activeTab = tab;
    this.page = 1;
    this.refresh();
  }

  @action
  goPrev() {
    if (!this.hasPrev) return;
    this.noticeMessage = null;
    this.errorMessage = null;
    this.page = this.page - 1;
    this.refresh();
  }

  @action
  goNext() {
    if (!this.hasNext) return;
    this.noticeMessage = null;
    this.errorMessage = null;
    this.page = this.page + 1;
    this.refresh();
  }
  
  // -----------------------
  // watermark
  // -----------------------
  @action
  toggleUploadWatermark(e) {
    this.uploadWatermarkEnabled = !!e?.target?.checked;
  }

  @action
  setUploadWatermarkPreset(e) {
    this.uploadWatermarkPresetId = String(e?.target?.value || "");
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
    this.noticeMessage = null;
    this.errorMessage = null;
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
    this.noticeMessage = null;
    this.errorMessage = null;
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
    // Keep a ref to the native file input so we can reliably clear it
    // (otherwise browsers keep showing part of the previous filename).
    this._uploadFileInputEl = e.target;
    const file = e.target.files?.[0];
    this.uploadFile = file || null;
    // Intentionally do NOT auto-fill the title with the filename.
    // Filenames are often random hashes; users must provide a descriptive title.
  }

  @action setUploadTitle(e) { this.uploadTitle = e.target.value; }
  @action setUploadDescription(e) { this.uploadDescription = e.target.value; }
  @action setUploadGender(e) { this.uploadGender = e.target.value; }
  @action setUploadAuthorized(e) { this.uploadAuthorized = !!e.target.checked; }

  @action
  resetUploadForm() {
    this.uploadFile = null;
    this.uploadTitle = "";
    this.uploadDescription = "";
    this.uploadGender = "";
    this.uploadAuthorized = false;
    this.uploadTagsSelected = [];
    this.uploadTagsQuery = "";
    this.uploadTagsOpen = false;

    if (this.watermarkConfig?.enabled) {
      this.uploadWatermarkEnabled = true;
      const dc = this.watermarkConfig?.default_choice;
      this.uploadWatermarkPresetId =
        (typeof dc === "string" ? dc : dc?.value) || this.watermarkConfig?.default_preset_id || "";
    } else {
      this.uploadWatermarkEnabled = true;
      this.uploadWatermarkPresetId = "";
    }

    // Clear native input value so selecting the same file again triggers change
    // and so the browser UI doesn't keep a stale filename.
    try {
      if (this._uploadFileInputEl) {
        this._uploadFileInputEl.value = "";
      }
    } catch {
      // ignore
    }
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
      this.errorMessage = I18n.t("media_gallery.errors.missing_gender");
      return;
    }

    if (!this.uploadAuthorized) {
      this.errorMessage = this.uploadTermsUrl
        ? I18n.t("media_gallery.errors.missing_authorization_with_terms")
        : I18n.t("media_gallery.errors.missing_authorization");
      return;
    }

    this.uploadBusy = true;

    try {
      const fd = new FormData();
      fd.append("upload_type", "composer");
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
        authorized: !!this.uploadAuthorized,
      };

      if (this.uploadDescription?.trim()) payload.description = this.uploadDescription.trim();

      const tags = uniqStrings(this.uploadTagsSelected || []);
      if (tags.length) payload.tags = tags;


      // Watermark payload (video/images only, and only if enabled server-side)
      if (this.watermarkConfig?.enabled && this.isWatermarkableUploadSelected) {
        const watermarkEnabled = this.watermarkCanToggle ? !!this.uploadWatermarkEnabled : true;

        if (this.watermarkCanToggle) {
          payload.watermark_enabled = watermarkEnabled;
        }

        if (this.watermarkCanChoosePreset && watermarkEnabled) {
          const choice = String(this.uploadWatermarkPresetId || "").trim();
          if (choice) {
            // Newer plugin versions accept `watermark_choice`; older ones expect `watermark_preset_id`.
            payload.watermark_choice = choice;
            payload.watermark_preset_id = choice;
          }
        }
      }

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
  // Thumbnails
  //
  // "Outside the box" fix:
  // The previous implementation preloaded thumbnails with `new Image()` and
  // then tried to mirror that state into the template. In practice (especially
  // with list refreshes / polling) the UI state can get out of sync: the network
  // shows thumbnails downloaded, but the UI keeps showing the placeholder.
  //
  // To make this rock-solid:
  // - Render <img> directly from `thumbnail_url` (browser handles caching).
  // - Use native `loading="lazy"` to avoid request floods.
  // - On errors (incl. 429), retry with exponential backoff a few times.
  // - After retry limit, fall back to the placeholder (no broken-image icon).
  //
  // Retry/failure state is stored by `public_id` so it survives refresh().
  // -----------------------
  _applyThumbFailureState(items) {
    for (const it of items || []) {
      const id = it?.public_id;
      it._thumbFailed = !!(id && this._thumbFailures.has(id));
    }
  }

  @action
  onThumbLoad(item) {
    const id = item?.public_id;
    if (!id) return;

    this._thumbRetryById.delete(id);
    if (this._thumbFailures.has(id)) {
      this._thumbFailures.delete(id);
      const current = (this.items || []).find((x) => x?.public_id === id);
      if (current && current._thumbFailed) {
        current._thumbFailed = false;
        this.items = [...this.items];
      }
    }
  }

  // Called by <img onerror>
  @action
  onThumbError(item, ev) {
    const id = item?.public_id;
    const base = ev?.target?.dataset?.thumbBase || item?.thumbnail_url;
    if (!id || !base) return;

    const prev = this._thumbRetryById.get(id) || 0;
    const attempt = prev + 1;
    this._thumbRetryById.set(id, attempt);

    // Hide the broken-image icon immediately
    try {
      if (ev?.target) ev.target.src = TRANSPARENT_GIF;
    } catch {
      // ignore
    }

    if (attempt <= THUMB_RETRY_LIMIT) {
      const delay = THUMB_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      setTimeout(() => {
        if (this._destroyed) return;

        // Try again on the *same* DOM element (if it still exists)
        try {
          if (!ev?.target) return;
          const sep = base.includes("?") ? "&" : "?";
          ev.target.src = `${base}${sep}retry=${Date.now()}`;
        } catch {
          // ignore
        }
      }, delay);
      return;
    }

    // Give up: mark failed for this id so refresh() keeps showing placeholder
    this._thumbFailures.add(id);
    this._thumbRetryById.delete(id);
    const current = (this.items || []).find((x) => x?.public_id === id);
    if (current) {
      current._thumbFailed = true;
      this.items = [...this.items];
    }
  }

  // -----------------------
  // Like / Unlike
  // -----------------------
  _updateItemByPublicId(publicId, updates) {
    if (!publicId || !this.items?.length) return;

    const idx = this.items.findIndex((it) => it?.public_id === publicId);
    if (idx === -1) return;

    const updated = { ...this.items[idx], ...updates };

    // Reassign array to trigger tracking, but keep other row DOM stable (keyed by public_id).
    this.items = [
      ...this.items.slice(0, idx),
      updated,
      ...this.items.slice(idx + 1),
    ];

    // Keep the preview panel in sync (previewItem is a separate tracked reference).
    if (this.previewOpen && this.previewItem?.public_id === publicId) {
      this.previewItem = updated;
    }
  }

  @action
  async toggleLike(item, ev) {
    ev?.stopPropagation?.();

    const publicId = item?.public_id;
    if (!publicId) return;

    if (item?._likePending) return;

    const wasLiked = !!item.liked;
    const wasCount = parseInt(item.likes_count || 0, 10) || 0;

    const nextLiked = !wasLiked;
    const nextCount = Math.max(0, wasLiked ? wasCount - 1 : wasCount + 1);
    const endpoint = wasLiked ? `/media/${publicId}/unlike` : `/media/${publicId}/like`;

    // Optimistic UI update (instant red heart + count change)
    this._updateItemByPublicId(publicId, {
      liked: nextLiked,
      likes_count: nextCount,
      _likePending: true,
    });

    try {
      await ajax(endpoint, { type: "POST" });
      this._updateItemByPublicId(publicId, { _likePending: false });
    } catch (e) {
      // Roll back on error
      this._updateItemByPublicId(publicId, {
        liked: wasLiked,
        likes_count: wasCount,
        _likePending: false,
      });

      this.errorMessage =
        e?.jqXHR?.responseJSON?.errors?.join(", ") || e?.message || "Error";
    }
  }

  // -----------------------
  // Preview (token refresh on error)
  // -----------------------

// Preview sizing + fullscreen helpers
get previewAspectClass() {
  return this.previewAspect ? `is-${this.previewAspect}` : "";
}

get previewPlayerStyle() {
  // For images we add an "ambient" blurred background behind the media
  if (this.previewItem?.media_type === "image" && this.previewStreamUrl) {
    const safeUrl = String(this.previewStreamUrl).replace(/"/g, '\"');
    return htmlSafe(`--hb-preview-bg: url("${safeUrl}");`);
  }
  return null;
}

_setPreviewAspect(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;

  const ratio = w / h;

  // A little fuzzy on purpose so "almost square" doesn't jump around
  if (ratio > 1.12) this.previewAspect = "landscape";
  else if (ratio < 0.88) this.previewAspect = "portrait";
  else this.previewAspect = "square";
}

@action
onPreviewImageLoad(e) {
  const img = e?.target;
  this._setPreviewAspect(img?.naturalWidth, img?.naturalHeight);
}

@action
onPreviewVideoMeta(e) {
  const v = e?.target;
  this._setPreviewAspect(v?.videoWidth, v?.videoHeight);
}

@action
toggleImageFullscreen(e) {
  // Images only: double click zooms fullscreen
  const player = e?.target?.closest?.(".hb-media-preview__player");
  if (!player) return;

  const doc = document;
  const fsEl = doc.fullscreenElement || doc.webkitFullscreenElement;

  if (fsEl) {
    doc.exitFullscreen?.() ||
      doc.webkitExitFullscreen?.() ||
      doc.mozCancelFullScreen?.() ||
      doc.msExitFullscreen?.();
    return;
  }

  player.requestFullscreen?.() ||
    player.webkitRequestFullscreen?.() ||
    player.mozRequestFullScreen?.() ||
    player.msRequestFullscreen?.();
}
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
    this.previewAspect = null;
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
    this.previewAspect = null;
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
    // Notice messages (e.g. upload/delete/retry) are cleared explicitly by user
    // actions (Search/Reset/Tab/Paging) so silent polling doesn't wipe them.

    try {
      const data = {
        page: this.page,
        per_page: this.perPage,
      };

      const tags = uniqStrings(this.tagsSelected || []);
      if (this.mediaType) data.media_type = this.mediaType;
      if (this.gender) data.gender = this.gender;

      const endpoint = this.isMine ? "/media/my" : "/media";
      if (this.isMine && this.status) data.status = this.status;

      const res = await this._fetchWithTagFallback(endpoint, data, tags);

      let media = res?.media_items || [];
      const total = res?.total ?? media.length;

      // Ensure consistent filtering behavior across tabs/endpoints
      media = this._applyClientFilters(media);

      // Apply thumb failure state that survives refresh()
      this._applyThumbFailureState(media);

      this.items = media;
      this.page = res?.page || this.page;
      this.perPage = res?.per_page || this.perPage;
      this.total = total;

      // Thumbnails are rendered directly from `thumbnail_url`.

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