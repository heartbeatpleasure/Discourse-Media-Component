// javascripts/discourse/components/media-gallery-page.js
import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { action } from "@ember/object";
import { htmlSafe } from "@ember/template";
import { inject as service } from "@ember/service";
import { ajax } from "discourse/lib/ajax";
import { iconNode } from "discourse-common/lib/icon-library";
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

// ---- HLS helpers (milestone 1) ---------------------------------------------

const HLS_MIME = "application/vnd.apple.mpegurl";

const _loadedScripts = new Map();
function loadScriptOnce(url) {
  const u = String(url || "").trim();
  if (!u) return Promise.resolve(false);
  if (_loadedScripts.has(u)) return _loadedScripts.get(u);

  const p = new Promise((resolve, reject) => {
    try {
      if (document.querySelector(`script[src="${u}"]`)) {
        resolve(true);
        return;
      }
    } catch {
      // ignore
    }

    const s = document.createElement("script");
    s.src = u;
    s.async = true;
    s.onload = () => resolve(true);
    s.onerror = () => reject(new Error(`failed_to_load_script: ${u}`));
    document.head.appendChild(s);
  });

  _loadedScripts.set(u, p);
  return p;
}

function canPlayNativeHls(videoEl) {
  try {
    return !!videoEl?.canPlayType && videoEl.canPlayType(HLS_MIME) !== "";
  } catch {
    return false;
  }
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


// Player icon fallbacks (FontAwesome 5/6 naming differences across Discourse versions)
const FULLSCREEN_ENTER_ICON_CANDIDATES = ["maximize", "expand"];
const FULLSCREEN_EXIT_ICON_CANDIDATES = ["minimize", "compress"];
const VOLUME_ON_ICON_CANDIDATES = ["volume-high", "volume-up"];
const VOLUME_OFF_ICON_CANDIDATES = ["volume-xmark", "volume-mute"];

function iconAvailable(name) {
  if (!name) return false;
  try {
    const n = iconNode(name);
    if (!n) return false;
    const html = typeof n === "string" ? n : (n?.toString?.() || n?.outerHTML || "");
    // When the icon is missing, Discourse typically returns a fallback icon.
    // In that case the requested icon name will not match the class or sprite reference.
    return html.includes(`d-icon-${name}`) || html.includes(`#${name}`);
  } catch {
    return false;
  }
}

export default class MediaGalleryPage extends Component {
  @service currentUser;
  @service("theme-settings") themeSettings;

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
  @tracked previewStreamLoading = false;
  @tracked previewRetryCount = 0;
  @tracked previewAspect = null;
  @tracked previewAr = 1;
  @tracked previewPlayerMaxW = null;
  // True after the first frame has loaded for video/audio. Used to keep the poster visible
  // until playback data is available, preventing a white flash / layout jump.
  @tracked previewHasLoadedData = false;

  // Preview player state (custom controls)
  @tracked previewIsPlaying = false;
  @tracked previewCurrentTime = 0;
  @tracked previewDuration = 0;
  @tracked previewMuted = false;
  @tracked previewIsFullscreen = false;
  @tracked previewPseudoFullscreen = false;

  // Delete confirmation modal
  @tracked deleteOpen = false;
  @tracked deleteItem = null;
  @tracked deleteBusy = false;

  _pollTimer = null;
  _boundDocClick = null;
  _boundKeydown = null;
  _boundResize = null;
  _boundFullscreenChange = null;
  _previewMeasureRaf = null;

  _previewMediaEl = null;
  _previewPlayerEl = null;
  _previewLastVolume = 1;

  _previewStreamToken = null;
  _previewSecurity = null;
  _previewHeartbeatTimer = null;
  _previewRevokePromise = null;

  _previewHls = null;
  _previewSourceAttached = false;
  _previewIsHls = false;


  // Cache the first available icon name for this Discourse instance
  _playerIconCache = new Map();

  _destroyed = false;

  // Thumbnail retry/failure state (keyed by public_id)
  _thumbRetryById = new Map();
  _thumbFailures = new Set();

  // Some endpoints may 500 when receiving a tags parameter. Track per endpoint
  // to avoid repeated failing requests (and noisy console/network errors).
  _tagsBrokenByEndpoint = new Map();

  // Media items from the backend have historically used different keys/values
  // for type (media_type/type/etc). Normalize once to keep templates robust.
  _normalizeMediaType(raw) {
    const s = String(raw || "")
      .trim()
      .toLowerCase();

    if (!s) return "";
    if (s === "img") return "image";

    // Be permissive for future backend variations.
    if (s.includes("audio")) return "audio";
    if (s.includes("video")) return "video";
    if (s.includes("image") || s.includes("photo") || s.includes("picture")) return "image";
    return s;
  }

  _decorateItem(item) {
    if (!item || typeof item !== "object") return item;
    const mt = this._normalizeMediaType(item.media_type || item.type || item.mediaType);

    // Reset playback hardening state
    this._stopPreviewHeartbeat();
    this._previewSecurity = null;
    this._previewStreamToken = null;
    return { ...item, _hb_media_type: mt };
  }

  get previewMediaType() {
    return this.previewItem?._hb_media_type || this._normalizeMediaType(this.previewItem?.media_type || this.previewItem?.type);
  }

  constructor() {
    super(...arguments);

    this._boundDocClick = (e) => this.onDocumentClick(e);
    document.addEventListener("click", this._boundDocClick);

    // Best-effort devtools shortcut blocking while the preview modal is open.
    // NOTE: This can always be bypassed by determined users.
    this._boundKeydown = (e) => this.onDocumentKeydown(e);
    document.addEventListener("keydown", this._boundKeydown, true);

    this._boundResize = () => this.onWindowResize();
    window.addEventListener("resize", this._boundResize);

    this._boundFullscreenChange = () => this.onFullscreenChange();
    document.addEventListener("fullscreenchange", this._boundFullscreenChange);
    document.addEventListener("webkitfullscreenchange", this._boundFullscreenChange);

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

    if (this._boundKeydown) {
      document.removeEventListener("keydown", this._boundKeydown, true);
      this._boundKeydown = null;
    }

    if (this._boundResize) {
      window.removeEventListener("resize", this._boundResize);
      this._boundResize = null;
    }

    if (this._boundFullscreenChange) {
      document.removeEventListener("fullscreenchange", this._boundFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", this._boundFullscreenChange);
      this._boundFullscreenChange = null;
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

  // Like the general formatter, but returns 0:00 instead of blank for 0.
  formatPlaybackTime(seconds) {
    const out = formatDurationSeconds(seconds);
    return out || "0:00";
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
  // Best-effort shortcut blocking (preview modal)
  // -----------------------
  onDocumentKeydown(e) {
    if (!this.previewOpen) return;

    // Do not interfere with typing in form fields.
    const t = e?.target;
    const tag = (t?.tagName || "").toLowerCase();
    const isEditable = tag === "input" || tag === "textarea" || t?.isContentEditable;
    if (isEditable) return;

    // ESC should exit pseudo-fullscreen (our CSS-based fullscreen fallback)
    if (e?.key === "Escape" && this.previewPseudoFullscreen) {
      e?.preventDefault?.();
      e?.stopPropagation?.();
      this.previewPseudoFullscreen = false;
      // Re-measure to restore normal sizing
      setTimeout(() => this._schedulePreviewMeasure(), 50);
      return false;
    }

    const key = String(e?.key || "").toLowerCase();

    // F12
    const isF12 = e?.key === "F12" || e?.keyCode === 123;

    // Ctrl/Cmd + Shift + (I/J/C/K) are common devtools shortcuts (Chrome/Edge/Firefox).
    const ctrlOrCmd = !!(e?.ctrlKey || e?.metaKey);
    const isCtrlShiftDevtools = ctrlOrCmd && !!e?.shiftKey && ["i", "j", "c", "k"].includes(key);

    // Cmd + Option + (I/J/C) (macOS)
    const isCmdOptDevtools = !!e?.metaKey && !!e?.altKey && ["i", "j", "c"].includes(key);

    if (isF12 || isCtrlShiftDevtools || isCmdOptDevtools) {
      e?.preventDefault?.();
      e?.stopPropagation?.();
      return false;
    }

    return true;
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
  // Provide numeric aspect ratio to CSS so the player can size itself perfectly for any media.
  const ar = Number(this.previewAr);
  const safeAr = Number.isFinite(ar) && ar > 0 ? Math.min(Math.max(ar, 0.2), 5) : 1;

  let style = `--hb-media-ar: ${safeAr};`;

  if (this.previewPlayerMaxW) {
    style += ` --hb-player-max-w: ${this.previewPlayerMaxW}px;`;
  }

  // For images we add an "ambient" blurred background behind the media
  if (this.previewMediaType === "image" && this.previewStreamUrl) {
    const safeUrl = String(this.previewStreamUrl).replace(/"/g, '\\"');
    style += ` --hb-preview-bg: url("${safeUrl}");`;
  }

  return htmlSafe(style);
}

  get previewFullscreenActive() {
    return !!(this.previewIsFullscreen || this.previewPseudoFullscreen);
  }


  _pickPlayerIcon(cacheKey, candidates, fallback) {
    const key = cacheKey || (candidates || []).join("|") || fallback || "";
    if (this._playerIconCache?.has(key)) {
      return this._playerIconCache.get(key);
    }

    let found = fallback;
    for (const c of candidates || []) {
      if (iconAvailable(c)) {
        found = c;
        break;
      }
    }

    this._playerIconCache?.set(key, found);
    return found;
  }

  get fullscreenEnterIcon() {
    return this._pickPlayerIcon("fsEnter", FULLSCREEN_ENTER_ICON_CANDIDATES, "expand");
  }

  get fullscreenExitIcon() {
    return this._pickPlayerIcon("fsExit", FULLSCREEN_EXIT_ICON_CANDIDATES, "compress");
  }

  get volumeOnIcon() {
    return this._pickPlayerIcon("volOn", VOLUME_ON_ICON_CANDIDATES, "volume-up");
  }

  get volumeOffIcon() {
    return this._pickPlayerIcon("volOff", VOLUME_OFF_ICON_CANDIDATES, "volume-mute");
  }

_setPreviewAspect(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;

  const ratio = w / h;
  this.previewAr = ratio;

  // A little fuzzy on purpose so "almost square" doesn't jump around
  if (ratio > 1.12) this.previewAspect = "landscape";
  else if (ratio < 0.88) this.previewAspect = "portrait";
  else this.previewAspect = "square";
}


  _schedulePreviewMeasure() {
    if (!this.previewOpen) return;

    if (this._previewMeasureRaf) {
      cancelAnimationFrame(this._previewMeasureRaf);
      this._previewMeasureRaf = null;
    }

    this._previewMeasureRaf = requestAnimationFrame(() => {
      this._previewMeasureRaf = null;
      this._measurePreviewPlayerMaxW();
    });
  }

  _measurePreviewPlayerMaxW() {
    // Measure the available width for the media column so the player never overlaps the right panel.
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    // When the player is in fullscreen, the surrounding modal layout may report 0px widths.
    // Avoid writing a tiny max-width (e.g. 240px) that would persist after exiting fullscreen.
    if (fsEl && (fsEl.classList?.contains("hb-media-preview__player") || fsEl.closest?.(".hb-media-library-modal"))) {
      return;
    }

    const previewEl = document.querySelector(".hb-media-library-modal .hb-media-preview");
    const mediaEl = previewEl?.querySelector?.(".hb-media-preview__media");
    if (!previewEl || !mediaEl) return;

    const panelEl = previewEl.querySelector(".hb-media-preview__panel");
    const previewRect = previewEl.getBoundingClientRect();
    if (!previewRect || previewRect.width < 200) return;
    const previewStyle = window.getComputedStyle(previewEl);
    const gap = parseFloat(previewStyle.columnGap) || 0;

    let availableW = previewRect.width;

    // If we're in two-column layout, subtract the panel width.
    if (panelEl) {
      const panelRect = panelEl.getBoundingClientRect();
      const cols = (previewStyle.gridTemplateColumns || "").trim().split(/\s+/);

      if (cols.length > 1 && panelRect.width > 0) {
        availableW = Math.max(240, Math.floor(previewRect.width - panelRect.width - gap));
      }
    }

    const mediaStyle = window.getComputedStyle(mediaEl);
    const padLeft = parseFloat(mediaStyle.paddingLeft) || 0;
    const padRight = parseFloat(mediaStyle.paddingRight) || 0;

    const maxW = Math.max(240, Math.floor(availableW - padLeft - padRight));

    if (this.previewPlayerMaxW !== maxW) {
      this.previewPlayerMaxW = maxW;
    }
  }


  @action
  onWindowResize() {
    if (!this.previewOpen) return;
    this._schedulePreviewMeasure();
  }

@action
onPreviewImageLoad(e) {
  const img = e?.target;
  // Cache player wrapper so fullscreen toggling works for images too.
  this._previewPlayerEl = img?.closest?.(".hb-media-preview__player") || null;
  this._setPreviewAspect(img?.naturalWidth, img?.naturalHeight);
  this._schedulePreviewMeasure();
}

@action
onPreviewPosterLoad(e) {
  // Used for video posters: set the aspect ratio from the thumbnail so the player
  // size matches BEFORE the user presses play.
  const img = e?.target;
  if (!img) return;
  this._setPreviewAspect(img?.naturalWidth, img?.naturalHeight);
  this._schedulePreviewMeasure();
}

@action
onPreviewLoadedData() {
  // After the first frame is available, we can hide the poster permanently.
  this.previewHasLoadedData = true;
}

@action
onPreviewVideoMeta(e) {
  const v = e?.target;
    this._previewMediaEl = v || null;
    this._previewPlayerEl = v?.closest?.(".hb-media-preview__player") || null;

  this._setPreviewAspect(v?.videoWidth, v?.videoHeight);
    this.previewDuration = Number.isFinite(v?.duration) ? v.duration : 0;
    this.previewCurrentTime = Number.isFinite(v?.currentTime) ? v.currentTime : 0;
    this.previewMuted = !!v?.muted || v?.volume === 0;
    const vv = Number(v?.volume);
    if (Number.isFinite(vv) && vv > 0) {
      this._previewLastVolume = vv;
    }
    this.previewIsPlaying = !v?.paused;
  this._schedulePreviewMeasure();
}

  @action
  onPreviewAudioMeta(e) {
    const a = e?.target;
    this._previewMediaEl = a || null;
    this._previewPlayerEl = a?.closest?.(".hb-media-preview__player") || null;
    // Audio has no intrinsic dimensions; keep preview consistent with thumbnails (16:9)
    // so the placeholder artwork fits nicely.
    this._setPreviewAspect(16, 9);
    this._schedulePreviewMeasure();
    this.previewDuration = Number.isFinite(a?.duration) ? a.duration : 0;
    this.previewCurrentTime = Number.isFinite(a?.currentTime) ? a.currentTime : 0;
    this.previewMuted = !!a?.muted || a?.volume === 0;
    const av = Number(a?.volume);
    if (Number.isFinite(av) && av > 0) {
      this._previewLastVolume = av;
    }
    this.previewIsPlaying = !a?.paused;
  }

  get previewHasDuration() {
    return Number.isFinite(this.previewDuration) && this.previewDuration > 0;
  }

  @action
  onPreviewTimeUpdate(e) {
    const el = e?.target;
    if (!el) return;
    // Only update from the element if it matches the current preview media.
    if (this._previewMediaEl && el !== this._previewMediaEl) return;
    this.previewCurrentTime = Number.isFinite(el.currentTime) ? el.currentTime : 0;
    if (Number.isFinite(el.duration)) {
      this.previewDuration = el.duration;
    }
  }

  @action
  onPreviewPlay() {
    this.previewIsPlaying = true;
    this._startPreviewHeartbeat();
  }

  @action
  onPreviewPause() {
    this.previewIsPlaying = false;
    this._stopPreviewHeartbeat();
  }

  @action
  onPreviewEnded() {
    this.previewIsPlaying = false;
    this._stopPreviewHeartbeat();

    // Best-effort: revoke the token at the end so it can't be reused for casual downloading.
    this._previewRevokePromise = this._revokePreviewToken();

    // Clear the stream URL so pressing play again will request a fresh token.
    this.previewStreamUrl = null;
    this._previewStreamToken = null;

    try {
      const el = this._previewMediaEl;
      if (el) {
        el.removeAttribute?.("src");
        el.src = "";
        el.load?.();
      }
    } catch {
      // ignore
    }

    this.previewCurrentTime = 0;
    this.previewHasLoadedData = false;
  }

  @action
  onPreviewVolumeChange(e) {
    const el = e?.target;
    if (!el) return;
    if (this._previewMediaEl && el !== this._previewMediaEl) return;
    this.previewMuted = !!el.muted || el.volume === 0;
  }

  
@action
async togglePreviewPlayback(e) {
  e?.preventDefault?.();
  e?.stopPropagation?.();

  const el = this._previewMediaEl;
  if (!el) return;

  const mt = this.previewMediaType;

  // Treat "ended" as a replay request: restart from 0 and always request a fresh token.
  // We don't change the label (still "Play"), but behavior is "Replay".
  const replayRequested =
    !!el.ended ||
    (this.previewHasDuration &&
      this.previewDuration > 0 &&
      this.previewCurrentTime >= this.previewDuration - 0.05);

  if (replayRequested) {
    this.previewIsPlaying = false;
    this.previewCurrentTime = 0;
    this.previewHasLoadedData = false;

    // Make sure the element isn't stuck at the end.
    try {
      el.pause?.();
    } catch {
      // ignore
    }
    try {
      el.currentTime = 0;
    } catch {
      // ignore
    }

    // Force a new token for audio/video replays.
    if (mt === "video" || mt === "audio") {
      this.previewStreamUrl = null;
      this._previewStreamToken = null;

      // Also clear any previous src so the next play definitely uses the new token.
      try {
        this._clearPreviewMediaSource();
      } catch {
        // ignore
      }
    }
  }

  // Pause/Play toggle
  if (!el.paused && !el.ended) {
    try {
      el.pause?.();
    } catch {
      // ignore
    }
    return;
  }

  // For audio/video: delay token creation until the user explicitly presses Play.
  if ((mt === "video" || mt === "audio") && !this.previewStreamUrl) {
    if (this.previewStreamLoading) return;

    this.previewStreamLoading = true;
    this.errorMessage = null;

    // If we just revoked a previous token (ended/close), wait briefly so
    // max-active-token limits don't spuriously block the new token.
    try {
      const p = this._previewRevokePromise;
      if (p && typeof p.then === "function") {
        await Promise.race([p, new Promise((r) => setTimeout(r, 1200))]);
      }
    } catch {
      // ignore
    }

    try {
      await this.fetchPreviewStreamUrl({ resetRetry: true });
    } catch (err) {
      const status = err?.jqXHR?.status;
      const msg =
        err?.jqXHR?.responseJSON?.errors?.join(", ") || err?.message || "Error";

      if (status === 429) {
        // Keep UI consistent: show as a notice (English messages come from the server).
        this.noticeMessage =
          msg ||
          "Playback blocked: too many active sessions. Close another player and try again.";
        this.previewStreamUrl = null;
        this._previewStreamToken = null;
      } else {
        this.errorMessage = msg;
      }
    } finally {
      this.previewStreamLoading = false;
    }
  }

  // Attach the stream URL to the element after the explicit user gesture.
  if (mt === "video" || mt === "audio") {
    if (!this.previewStreamUrl) return;

    // HLS: use native support when available, otherwise hls.js.
    if (mt === "video" && this._isHlsUrl(this.previewStreamUrl)) {
      if (!this._previewSourceAttached) {
        try {
          await this._attachHlsToPreview(this.previewStreamUrl);
        } catch {
          // ignore
        }
      }
    } else {

      try {
        const current = el.currentSrc || el.getAttribute?.("src") || "";

        // currentSrc can remain populated even after clearing/removing src.
        // Compare tokens rather than raw strings because currentSrc can be absolute.
        const currentToken = this._extractTokenFromStreamUrl(current);
        const desiredToken =
          this._previewStreamToken || this._extractTokenFromStreamUrl(this.previewStreamUrl);

        if (!current || !currentToken || !desiredToken || currentToken !== desiredToken) {
          el.src = this.previewStreamUrl;
          this._previewSourceAttached = true;
          // Reset the element state so replay is reliable across browsers.
          try {
            el.currentTime = 0;
          } catch {
            // ignore
          }
          el.load?.();
        }
      } catch {
        // ignore
      }
    }
  }

  try {
    const p = el.play?.();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {
    // ignore
  }
}

@action
seekPreview(e) {
    const el = this._previewMediaEl;
    if (!el) return;
    const v = Number(e?.target?.value);
    if (!Number.isFinite(v)) return;
    try {
      el.currentTime = Math.max(0, v);
      this.previewCurrentTime = el.currentTime;
    } catch {
      // ignore
    }
  }

  @action
  togglePreviewMute(e) {
    e?.preventDefault?.();
    e?.stopPropagation?.();

    const el = this._previewMediaEl;
    if (!el) return;

    try {
      const isMuted = !!el.muted || el.volume === 0;

      if (isMuted) {
        // Unmute
        el.muted = false;

        const restore =
          Number.isFinite(this._previewLastVolume) && this._previewLastVolume > 0
            ? this._previewLastVolume
            : 1;

        if (el.volume === 0) {
          el.volume = restore;
        }

        // Some browsers keep muted after volume changes, so force it off.
        el.muted = false;
      } else {
        // Mute (store last non-zero volume so we can restore later)
        const v = Number(el.volume);
        if (Number.isFinite(v) && v > 0) {
          this._previewLastVolume = v;
        }
        el.muted = true;
      }

      this.previewMuted = !!el.muted || el.volume === 0;
    } catch {
      // ignore
    }
  }

  _getFullscreenElement() {
    const doc = document;
    return doc.fullscreenElement || doc.webkitFullscreenElement || doc.mozFullScreenElement || doc.msFullscreenElement;
  }

  async _requestFullscreen(target) {
    if (!target) return false;

    const fn =
      target.requestFullscreen ||
      target.webkitRequestFullscreen ||
      target.mozRequestFullScreen ||
      target.msRequestFullscreen;

    if (typeof fn !== "function") return false;

    try {
      const res = fn.call(target);
      if (res && typeof res.catch === "function") {
        await res.catch(() => {});
      }
      return true;
    } catch {
      return false;
    }
  }

  @action
  async togglePreviewFullscreen(e) {
    e?.preventDefault?.();
    e?.stopPropagation?.();

    const doc = document;
    const fsEl = this._getFullscreenElement();

    // Exit fullscreen (real or pseudo)
    if (fsEl || this.previewPseudoFullscreen) {
      if (fsEl) {
        const exit =
          doc.exitFullscreen ||
          doc.webkitExitFullscreen ||
          doc.mozCancelFullScreen ||
          doc.msExitFullscreen;

        try {
          exit?.call(doc);
        } catch {
          // ignore
        }
      }

      this.previewPseudoFullscreen = false;
      return;
    }

    const media = this._previewMediaEl;

    // iOS Safari uses a separate API for fullscreen video.
    if (media?.webkitEnterFullscreen) {
      try {
        media.webkitEnterFullscreen();
        return;
      } catch {
        // ignore
      }
    }

    // Prefer fullscreening the preview player wrapper (so we can style :fullscreen reliably)
    const player = this._previewPlayerEl || media?.closest?.(".hb-media-preview__player") || null;

    const candidates = [player, media].filter(Boolean);

    for (const target of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await this._requestFullscreen(target);
      if (ok) return;
    }

    // If Fullscreen API is not available/denied, fall back to CSS-based pseudo fullscreen.
    this.previewPseudoFullscreen = true;
    setTimeout(() => this._schedulePreviewMeasure(), 50);
  }

  @action
  onFullscreenChange() {
    const doc = document;
    const fsEl = this._getFullscreenElement();
    const wasFullscreen = this.previewIsFullscreen;
    this.previewIsFullscreen = !!fsEl;
    if (this.previewIsFullscreen) {
      this.previewPseudoFullscreen = false;
    }

    // After exiting fullscreen (ESC), re-measure available space so the player snaps back.
    if (wasFullscreen && !this.previewIsFullscreen) {
      setTimeout(() => this._schedulePreviewMeasure(), 50);
    }
  }

  @action
  onOverlayKeydown(e) {
    const k = e?.key;
    if (k === "Enter" || k === " ") {
      this.togglePreviewPlayback(e);
    }
  }

  @action
  stopEvent(e) {
    e?.stopPropagation?.();
  }

  @action
  blockContextMenu(e) {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    return false;
  }

  @action
  blockRightMouseDown(e) {
    // button === 2 is right click.
    if (e?.button === 2) {
      e?.preventDefault?.();
      e?.stopPropagation?.();
      return false;
    }
    return true;
  }

@action
toggleImageFullscreen(e) {
  // Reuse the shared fullscreen logic (includes pseudo-fullscreen fallback).
  return this.togglePreviewFullscreen(e);
}

  _extractTokenFromStreamUrl(url) {
    if (!url) return null;

    const u = String(url);

    // Stream style: /media/stream/<token>
    let m = u.match(/\/media\/stream\/([^/?#]+)/);
    if (m) return m[1];

    // HLS style: ?token=<token>
    m = u.match(/[?&]token=([^&#]+)/);
    if (m) {
      try {
        return decodeURIComponent(m[1]);
      } catch {
        return m[1];
      }
    }

    return null;
  }

  _isHlsUrl(url) {
    return /\.m3u8(\?|$)/i.test(String(url || ""));
  }

  _getThemeSetting(key, fallback = null) {
    try {
      const v = this.themeSettings?.getSetting?.(key);
      if (v === undefined || v === null || String(v).trim?.() === "") return fallback;
      return v;
    } catch {
      return fallback;
    }
  }

  _destroyPreviewHls() {
    if (this._previewHls) {
      try {
        this._previewHls.destroy?.();
      } catch {
        // ignore
      }
    }
    this._previewHls = null;
  }

  _clearPreviewMediaSource() {
    this._destroyPreviewHls();
    const el = this._previewMediaEl;
    if (el) {
      try {
        el.pause?.();
      } catch {
        // ignore
      }

      try {
        el.removeAttribute?.("src");
        el.src = "";
        el.load?.();
      } catch {
        // ignore
      }
    }

    this._previewSourceAttached = false;
    this._previewIsHls = false;
  }

  async _attachHlsToPreview(url) {
    const el = this._previewMediaEl;
    if (!el || !url) return false;

    const preferNative = !!this._getThemeSetting("hls_prefer_native", true);
    if (preferNative && canPlayNativeHls(el)) {
      // Safari/iOS
      this._destroyPreviewHls();
      el.src = url;
      this._previewSourceAttached = true;
      return true;
    }

    // Load hls.js for browsers without native support.
    const hlsUrl = this._getThemeSetting("hls_js_url", "");
    if (hlsUrl) {
      try {
        await loadScriptOnce(hlsUrl);
      } catch {
        // ignore
      }
    }

    const Hls = window?.Hls;
    if (!Hls || !Hls.isSupported?.()) {
      // Fallback: try native anyway.
      el.src = url;
      this._previewSourceAttached = true;
      return true;
    }

    const debug = !!this._getThemeSetting("hls_debug", false);

    this._destroyPreviewHls();
    const hls = new Hls({ debug });
    this._previewHls = hls;

    hls.attachMedia(el);
    hls.on(Hls.Events.MEDIA_ATTACHED, () => {
      try {
        hls.loadSource(url);
      } catch {
        // ignore
      }
    });

    hls.on(Hls.Events.ERROR, (_evt, data) => {
      // If fatal, destroy and let the user retry.
      if (data?.fatal) {
        this._destroyPreviewHls();
      }
    });

    this._previewSourceAttached = true;
    return true;
  }

  async _sendPreviewHeartbeat() {
    if (!this.previewOpen) return;
    if (!this._previewStreamToken) return;

    const sec = this._previewSecurity || {};
    if (!sec.heartbeat_enabled) return;

    try {
      await ajax("/media/heartbeat", {
        type: "POST",
        data: { token: this._previewStreamToken },
      });
    } catch (e) {
      const status = e?.jqXHR?.status;

      if (status === 429) {
        // Session limit exceeded. Revoke this token and stop playback, but keep the overlay open.
        try {
          this._previewRevokePromise = this._revokePreviewToken();
          await this._previewRevokePromise;
        } catch {
          // ignore
        }

        try {
          this._previewMediaEl?.pause?.();
        } catch {
          // ignore
        }

        // Remove the stream source so the user can press Play again to request a new token.
        try {
          this._clearPreviewMediaSource();
        } catch {
          // ignore
        }

        this.previewIsPlaying = false;
        this.previewHasLoadedData = false;
        this.previewStreamUrl = null;
        this._previewStreamToken = null;

        this.noticeMessage =
          e?.jqXHR?.responseJSON?.errors?.join(", ") ||
          "Playback blocked: too many active sessions. Close another player and try again.";
      }
    }
  }

  _startPreviewHeartbeat() {
    if (this._previewHeartbeatTimer) return;
    if (!this.previewOpen) return;
    if (!this._previewStreamToken) return;

    const sec = this._previewSecurity || {};
    if (!sec.heartbeat_enabled) return;

    const intervalSec = Number(sec.heartbeat_interval_seconds);
    const intervalMs = Math.max(5000, (Number.isFinite(intervalSec) ? intervalSec : 15) * 1000);

    // First beat immediately, then interval.
    this._sendPreviewHeartbeat();
    this._previewHeartbeatTimer = setInterval(() => this._sendPreviewHeartbeat(), intervalMs);
  }

  _stopPreviewHeartbeat() {
    if (this._previewHeartbeatTimer) {
      clearInterval(this._previewHeartbeatTimer);
      this._previewHeartbeatTimer = null;
    }
  }

  async _revokePreviewToken() {
    const sec = this._previewSecurity || {};
    if (!sec.revoke_enabled) return;
    if (!this._previewStreamToken) return;

    try {
      await ajax("/media/revoke", {
        type: "POST",
        data: { token: this._previewStreamToken },
      });
    } catch {
      // ignore
    }
  }


  async fetchPreviewStreamUrl({ resetRetry } = { resetRetry: false }) {
    if (!this.previewItem?.public_id) return;

    const publicId = this.previewItem.public_id;

    if (resetRetry) this.previewRetryCount = 0;

    const res = await ajax(`/media/${publicId}/play`, { type: "GET" });

    // If the preview was closed/switched while awaiting the request, ignore the response.
    if (!this.previewOpen || this.previewItem?.public_id !== publicId) return;

    const url = res?.stream_url || null;
    const hlsUrl = res?.hls_master_url || null;
    const playbackUrl = hlsUrl || url;
    this.previewStreamUrl = playbackUrl;

    // Store security flags + extracted token for heartbeat/revocation.
    this._previewSecurity = res?.security || null;
    this._previewStreamToken = res?.token || this._extractTokenFromStreamUrl(playbackUrl);
    this._previewIsHls = !!hlsUrl;

    return playbackUrl;
  }

  @action
  registerPreviewMedia(el) {
    if (!el) return;
    this._previewMediaEl = el;
    this._previewPlayerEl = el?.closest?.(".hb-media-preview__player") || null;

    // Ensure we have a sensible default aspect ratio before metadata is available.
    if (this.previewMediaType === "video" || this.previewMediaType === "audio") {
      if (!Number.isFinite(this.previewAr) || this.previewAr === 1) {
        this._setPreviewAspect(16, 9);
      }
    }
  }

  @action
  async openPreview(item) {
    if (!item?.public_id) return;
    if (item.playable === false) return;

    const mt = this._normalizeMediaType(item.media_type || item.type || item.mediaType);

    this.previewOpen = true;
    this.previewItem = item;
    this.previewStreamUrl = null;
    this._destroyPreviewHls();
    this._previewSourceAttached = false;
    this._previewIsHls = false;
    // Images need the URL immediately to display. For audio/video we defer token creation
    // until the user explicitly presses Play.
    this.previewLoading = mt === "image";
    this.previewStreamLoading = false;
    this.previewRetryCount = 0;
    this.previewAspect = null;
    this.previewAr = 1;
    this.previewPlayerMaxW = null;
    this.previewHasLoadedData = false;
    this.previewHasLoadedData = false;
    this.previewIsPlaying = false;
    this.previewCurrentTime = 0;
    this.previewDuration = 0;
    this.previewMuted = false;
    this.previewIsFullscreen = false;
    this.previewPseudoFullscreen = false;

    this._previewMediaEl = null;
    this._previewPlayerEl = null;
    this.errorMessage = null;

    // Provide a stable, best-effort ratio for audio/video so the layout doesn't jump.
    // For video we try to use any dimensions the backend may provide, otherwise we fall back
    // to 16:9 until the poster thumbnail loads.
    if (mt === "video") {
      const w =
        item.width ||
        item.video_width ||
        item.media_width ||
        item.thumbnail_width ||
        item.thumb_width ||
        item.thumb_w;
      const h =
        item.height ||
        item.video_height ||
        item.media_height ||
        item.thumbnail_height ||
        item.thumb_height ||
        item.thumb_h;

      if (Number.isFinite(Number(w)) && Number.isFinite(Number(h))) {
        this._setPreviewAspect(Number(w), Number(h));
      } else {
        this._setPreviewAspect(16, 9);
      }
    } else if (mt === "audio") {
      this._setPreviewAspect(16, 9);
    }

    this._schedulePreviewMeasure();

    if (mt === "image") {
      try {
        await this.fetchPreviewStreamUrl({ resetRetry: true });
      } catch (e) {
        this.errorMessage = e?.jqXHR?.responseJSON?.errors?.join(", ") || e?.message || "Error";
      } finally {
        this.previewLoading = false;
        this._schedulePreviewMeasure();
      }
    } else {
      // For audio/video: show the player instantly, token will be requested on Play.
      this.previewLoading = false;
      this._schedulePreviewMeasure();
    }
  }

  @action
  closePreview() {
    try {
      this._previewMediaEl?.pause?.();
    } catch {
      // ignore
    }

    // Stop heartbeat and revoke the current token (best-effort)
    this._stopPreviewHeartbeat();
    this._previewRevokePromise = this._revokePreviewToken();
    this._previewSecurity = null;
    this._previewStreamToken = null;

    // Clear src to avoid leaving a stream URL in the DOM after closing.
    try {
      this._clearPreviewMediaSource();
    } catch {
      // ignore
    }

    try {
      const doc = document;
      const fsEl = this._getFullscreenElement();
      if (fsEl) {
        doc.exitFullscreen?.() ||
          doc.webkitExitFullscreen?.() ||
          doc.mozCancelFullScreen?.() ||
          doc.msExitFullscreen?.();
      }
    } catch {
      // ignore
    }

    this.previewOpen = false;
    this.previewItem = null;
    this.previewStreamUrl = null;
    this.previewLoading = false;
    this.previewStreamLoading = false;
    this.previewRetryCount = 0;
    this.previewAspect = null;
    this.previewAr = 1;
    this.previewPlayerMaxW = null;

    this.previewIsPlaying = false;
    this.previewCurrentTime = 0;
    this.previewDuration = 0;
    this.previewMuted = false;
    this.previewIsFullscreen = false;
    this.previewPseudoFullscreen = false;

    this._previewMediaEl = null;
    this._previewPlayerEl = null;

    if (this._previewMeasureRaf) {
      cancelAnimationFrame(this._previewMeasureRaf);
      this._previewMeasureRaf = null;
    }
  }

  @action
  stopBackdropClick(e) {
    e?.stopPropagation?.();
  }

  @action
  async onPlayerError() {
    if (!this.previewOpen || !this.previewItem?.public_id) return;

    // If we haven't requested a token yet (audio/video before first play), ignore.
    if (!this.previewStreamUrl) return;

    // Refreshing the token: pause heartbeats while we rotate the stream URL.
    this._stopPreviewHeartbeat();

    if (this.previewRetryCount >= 3) return;
    this.previewRetryCount += 1;

    try {
      await this.fetchPreviewStreamUrl({ resetRetry: false });

      // The template no longer binds `src` for audio/video (to avoid loading
      // anything until the user explicitly presses Play), so we must re-attach
      // the refreshed stream URL directly to the element.
      const el = this._previewMediaEl;
      if (el && this.previewStreamUrl) {
        try {
          // Replace the previous source completely to ensure new token is used.
          this._clearPreviewMediaSource();

          if (this._isHlsUrl(this.previewStreamUrl)) {
            await this._attachHlsToPreview(this.previewStreamUrl);
          } else {
            el.src = this.previewStreamUrl;
            this._previewSourceAttached = true;
            el.load?.();
          }
          if (this.previewIsPlaying) {
            const p = el.play?.();
            if (p && typeof p.catch === "function") p.catch(() => {});
          }
          if (this.previewIsPlaying) {
            this._startPreviewHeartbeat();
          }
        } catch {
          // ignore
        }
      }
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

      // Normalize per-item media type once (used throughout templates).
      media = (media || []).map((m) => this._decorateItem(m));

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